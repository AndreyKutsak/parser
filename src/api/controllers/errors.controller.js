const ErrorLog = require('../../db/models/error-log.model');

const PERIODS = { '1h': 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };

const sinceFor = (period) => new Date(Date.now() - (PERIODS[period] || PERIODS['24h']));
// Бакети погодинні, тому для фільтра беремо початок години, у яку потрапляє межа періоду
const hourFloor = (d) => { const h = new Date(d); h.setUTCMinutes(0, 0, 0); return h; };

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Кількість помилок за 1 год / 24 год / 7 днів (для карток і бейджа в меню). */
const summary = async () => {
  const now = Date.now();
  const [row] = await ErrorLog.aggregate([
    { $match: { lastAt: { $gte: new Date(now - PERIODS['7d']) } } },
    {
      $group: {
        _id: null,
        h1:  { $sum: { $cond: [{ $gte: ['$hour', hourFloor(now - PERIODS['1h'])] }, '$count', 0] } },
        h24: { $sum: { $cond: [{ $gte: ['$hour', hourFloor(now - PERIODS['24h'])] }, '$count', 0] } },
        d7:  { $sum: '$count' },
      },
    },
  ]);
  return { h1: row?.h1 || 0, h24: row?.h24 || 0, d7: row?.d7 || 0 };
};

/**
 * GET /api/errors?period=24h&process=app&q=redis
 * Згруповані помилки за період: кількість, перша/остання поява, процеси, останній приклад.
 * ?summaryOnly=1 — лише лічильники (для бейджа в меню).
 */
exports.list = async (req, res, next) => {
  try {
    if (req.query.summaryOnly) return res.json({ success: true, summary: await summary() });

    const period = PERIODS[req.query.period] ? req.query.period : '24h';
    const match = { hour: { $gte: hourFloor(sinceFor(period)) } };
    if (req.query.process) match.process = String(req.query.process);
    if (req.query.q) match.message = { $regex: escapeRegex(String(req.query.q).slice(0, 100)), $options: 'i' };

    const [groups, processes, sum] = await Promise.all([
      ErrorLog.aggregate([
        { $match: match },
        { $sort: { lastAt: 1 } },
        {
          $group: {
            _id: '$fingerprint',
            message:   { $first: '$message' },
            count:     { $sum: '$count' },
            firstAt:   { $min: '$firstAt' },
            lastAt:    { $max: '$lastAt' },
            processes: { $addToSet: '$process' },
            lastSample: { $last: { $arrayElemAt: ['$samples', -1] } },
          },
        },
        { $sort: { lastAt: -1 } },
        { $limit: 200 },
      ]),
      ErrorLog.distinct('process'),
      summary(),
    ]);

    res.json({
      success: true,
      period,
      summary: sum,
      processes,
      groups: groups.map((g) => ({ fingerprint: g._id, ...g, _id: undefined })),
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

/** DELETE /api/errors — очистити всі помилки. */
exports.clear = async (req, res, next) => {
  try {
    const { deletedCount } = await ErrorLog.deleteMany({});
    res.json({ success: true, deleted: deletedCount });
  } catch (err) {
    next(err);
  }
};
