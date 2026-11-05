const ErrorLog = require('../../db/models/error-log.model');

const PERIODS = { '1h': 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };
const KINDS = ['server', 'site', 'api'];

const sinceFor = (period) => new Date(Date.now() - (PERIODS[period] || PERIODS['24h']));
// Бакети погодинні, тому для фільтра беремо початок години, у яку потрапляє межа періоду
const hourFloor = (d) => { const h = new Date(d); h.setUTCMinutes(0, 0, 0); return h; };

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Записи до появи поля kind — це помилки сервера ($in з null ловить відсутнє поле)
const kindMatch = (kind) => (kind === 'server' ? { $in: ['server', null] } : kind);

/** Кількість подій за 1 год / 24 год / 7 днів — загалом і по кожному типу. */
const summary = async () => {
  const now = Date.now();
  const rows = await ErrorLog.aggregate([
    { $match: { lastAt: { $gte: new Date(now - PERIODS['7d']) } } },
    {
      $group: {
        _id: { $ifNull: ['$kind', 'server'] },
        h1:  { $sum: { $cond: [{ $gte: ['$hour', hourFloor(now - PERIODS['1h'])] }, '$count', 0] } },
        h24: { $sum: { $cond: [{ $gte: ['$hour', hourFloor(now - PERIODS['24h'])] }, '$count', 0] } },
        d7:  { $sum: '$count' },
      },
    },
  ]);
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { h1: 0, h24: 0, d7: 0 }]));
  rows.forEach((r) => { byKind[r._id] = { h1: r.h1, h24: r.h24, d7: r.d7 }; });
  const total = (f) => KINDS.reduce((n, k) => n + byKind[k][f], 0);
  return { h1: total('h1'), h24: total('h24'), d7: total('d7'), byKind };
};

const buildMatch = (query, defaultPeriod = '24h') => {
  const period = PERIODS[query.period] ? query.period : defaultPeriod;
  const match = { hour: { $gte: hourFloor(sinceFor(period)) } };
  if (KINDS.includes(query.kind)) match.kind = kindMatch(query.kind);
  if (query.process) match.process = String(query.process);
  if (query.domain) match.domain = String(query.domain);
  if (query.q) {
    const rx = { $regex: escapeRegex(String(query.q).slice(0, 100)), $options: 'i' };
    match.$or = [{ message: rx }, { domain: rx }];
  }
  return { period, match };
};

/**
 * GET /api/errors?period=24h&kind=site&process=app&domain=detels.com.ua&q=429
 * Згруповані події за період: кількість, перша/остання поява, процеси, останній приклад.
 * ?summaryOnly=1 — лише лічильники (для бейджа в меню).
 */
exports.list = async (req, res, next) => {
  try {
    if (req.query.summaryOnly) return res.json({ success: true, summary: await summary() });

    const { period, match } = buildMatch(req.query);

    const [groups, processes, sum] = await Promise.all([
      ErrorLog.aggregate([
        { $match: match },
        { $sort: { lastAt: 1 } },
        {
          $group: {
            _id: '$fingerprint',
            kind:      { $first: { $ifNull: ['$kind', 'server'] } },
            domain:    { $first: '$domain' },
            status:    { $first: '$status' },
            message:   { $first: '$message' },
            count:     { $sum: '$count' },
            firstAt:   { $min: '$firstAt' },
            lastAt:    { $max: '$lastAt' },
            processes: { $addToSet: '$process' },
            lastSample: { $last: { $arrayElemAt: ['$samples', -1] } },
          },
        },
        { $sort: { lastAt: -1 } },
        { $limit: 300 },
      ]),
      ErrorLog.distinct('process'),
      summary(),
    ]);

    res.json({
      success: true,
      period,
      summary: sum,
      processes,
      groups: groups.map(({ _id, ...g }) => ({ fingerprint: _id, ...g })),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/errors/sites?period=24h
 * Зведення по сайтах: скільки помилок на кожному домені й з якими кодами.
 * Головне питання — де нас блокують (403/429/таймаути).
 */
exports.sites = async (req, res, next) => {
  try {
    const { period, match } = buildMatch({ ...req.query, kind: 'site' });
    const rows = await ErrorLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: { domain: '$domain', code: { $ifNull: [{ $toString: '$status' }, { $arrayElemAt: ['$samples.meta.code', -1] }] } },
          count:  { $sum: '$count' },
          lastAt: { $max: '$lastAt' },
        },
      },
      {
        $group: {
          _id: '$_id.domain',
          total:  { $sum: '$count' },
          lastAt: { $max: '$lastAt' },
          codes:  { $push: { code: '$_id.code', count: '$count' } },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 200 },
    ]);

    res.json({
      success: true,
      period,
      sites: rows.map((r) => ({
        domain: r._id,
        total: r.total,
        lastAt: r.lastAt,
        codes: r.codes.sort((a, b) => b.count - a.count),
      })),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/errors/:fingerprint?period=7d
 * Деталі групи: погодинна гістограма та останні приклади (з meta і stack).
 */
exports.get = async (req, res, next) => {
  try {
    const period = PERIODS[req.query.period] ? req.query.period : '7d';
    const docs = await ErrorLog.find({
      fingerprint: req.params.fingerprint,
      hour: { $gte: hourFloor(sinceFor(period)) },
    }).sort({ hour: -1 }).lean();

    if (!docs.length) return res.status(404).json({ success: false, message: 'Помилку не знайдено' });

    const samples = docs
      .flatMap((d) => d.samples.map((s) => ({ ...s, process: d.process })))
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 20);

    res.json({
      success: true,
      fingerprint: req.params.fingerprint,
      message: docs[docs.length - 1].message,
      count: docs.reduce((n, d) => n + d.count, 0),
      hourly: docs.map((d) => ({ hour: d.hour, process: d.process, count: d.count })),
      samples,
    });
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/errors/:fingerprint — позначити групу як розібрану (видалити). */
exports.remove = async (req, res, next) => {
  try {
    const { deletedCount } = await ErrorLog.deleteMany({ fingerprint: req.params.fingerprint });
    res.json({ success: true, deleted: deletedCount });
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/errors?kind=site — очистити всі події (або лише одного типу). */
exports.clear = async (req, res, next) => {
  try {
    const filter = KINDS.includes(req.query.kind) ? { kind: kindMatch(req.query.kind) } : {};
    const { deletedCount } = await ErrorLog.deleteMany(filter);
    res.json({ success: true, deleted: deletedCount });
  } catch (err) {
    next(err);
  }
};
