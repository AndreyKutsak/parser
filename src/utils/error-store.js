/**
 * Спільне сховище подій для сторінки "Помилки" (колекція errorlogs).
 *
 * kind:
 *   'server' — внутрішні помилки нашого сервера (logger.error)
 *   'site'   — сайт, який ми парсимо, повернув 4xx/5xx або не відповів (таймаут, відмова з'єднання)
 *   'api'    — наш API відмовив клієнту через перевищення ліміту запитів (429)
 *
 * Важливо: модуль НІКОЛИ не пише через logger (рекурсія) і ніколи не кидає.
 * Якщо Mongo недоступна — подія просто не потрапляє в монітор.
 */
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');

const MAX_SAMPLES = 5;
const MAX_STR = 4000;

const processName = () => process.env.name || path.basename(process.argv[1] || 'node', '.js');
const PROC = processName();

const firstLine = (s) => String(s || '').split('\n')[0].trim();
const truncate = (v) => (typeof v === 'string' && v.length > MAX_STR ? v.slice(0, MAX_STR) + '…' : v);

/** Прибирає змінні частини, щоб однакові за суттю помилки групувались разом. */
const normalize = (s) =>
  firstLine(s)
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{24}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/(["'])(?:(?!\1).){1,200}\1/g, '<str>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .slice(0, 300);

/** JSON-безпечна копія meta з обрізаними довгими рядками. */
const cleanMeta = (meta) => {
  try {
    const json = JSON.stringify(meta, (k, v) => truncate(v));
    if (!json || json === '{}') return undefined;
    return json.length > MAX_STR * 2 ? { _truncated: json.slice(0, MAX_STR * 2) } : JSON.parse(json);
  } catch {
    return undefined;
  }
};

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

const statusText = (status) => `HTTP ${status}${http.STATUS_CODES[status] ? ' ' + http.STATUS_CODES[status] : ''}`;

/**
 * Записати подію. key — рядок, за яким події групуються (з нього рахується fingerprint).
 */
const record = ({ kind = 'server', key, message, level = 'error', meta, stack, domain = null, status = null }) => {
  try {
    // Mongo ще не підключена / відключилась — пропускаємо, щоб mongoose не буферизував записи.
    if (mongoose.connection.readyState !== 1) return;

    const fingerprint = crypto.createHash('sha1').update(`${kind}|${key}`).digest('hex').slice(0, 16);
    const now = new Date();
    const hour = new Date(now);
    hour.setUTCMinutes(0, 0, 0);

    const m = cleanMeta(meta);
    if (m?.stack) delete m.stack;
    const sample = { at: now, message: truncate(String(message || '')), meta: m, stack: truncate(stack) };

    const ErrorLog = require('../db/models/error-log.model');
    ErrorLog.updateOne(
      { fingerprint, hour, process: PROC },
      {
        $inc: { count: 1 },
        $set: { lastAt: now },
        $setOnInsert: { kind, level, domain, status, message: firstLine(message).slice(0, 500), firstAt: now },
        $push: { samples: { $each: [sample], $slice: -MAX_SAMPLES } },
      },
      { upsert: true },
    ).catch(() => {});
  } catch { /* ніколи не ламаємо виклик */ }
};

/** Внутрішня помилка сервера з winston info. */
const recordServerError = (info) => {
  const { level, message, timestamp, stack, ...rest } = info;
  const meta = cleanMeta(rest);
  const errText = meta?.error || meta?.message || meta?.reason || '';
  // Для "Unhandled error" повідомлення однакове — додаємо шлях запиту (з <id>) у ключ групування.
  const key = [normalize(message), normalize(errText), meta?.method || '', normalize(meta?.path || '')].join('|');
  record({ kind: 'server', key, message, level, meta, stack: stack || meta?.stack });
};

/** Мережеві/таймаут-помилки → короткий код для групування. */
const networkCode = (err) => {
  const msg = err?.message || '';
  if (err?.name === 'TimeoutError' || /timeout/i.test(msg) || err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') return 'TIMEOUT';
  if (err?.code) return err.code;
  const net = /net::(ERR_[A-Z_]+)/.exec(msg);
  if (net) return net[1];
  return 'ERROR';
};

const NETWORK_LABELS = {
  TIMEOUT: 'Таймаут — сайт не відповів вчасно',
  ECONNREFUSED: "Сайт відхилив з'єднання (ECONNREFUSED)",
  ECONNRESET: "З'єднання розірвано сайтом (ECONNRESET)",
  ENOTFOUND: 'Домен не знайдено (ENOTFOUND)',
  EAI_AGAIN: 'Помилка DNS (EAI_AGAIN)',
};

/**
 * Помилка звернення до сайту, який парсимо.
 * Або status (HTTP-код ≥ 400), або err (мережева помилка / таймаут).
 */
const recordSiteError = ({ url, status, err, engine, proxy, finalUrl }) => {
  const domain = domainOf(url) || 'невідомий';
  const code = status ? String(status) : networkCode(err);
  const label = status ? statusText(status) : NETWORK_LABELS[code] || `Мережева помилка (${code})`;
  record({
    kind: 'site',
    key: `${domain}|${code}`,
    message: `${label} — ${domain}`,
    level: status && status < 500 ? 'warn' : 'error',
    domain,
    status: status || null,
    meta: {
      url,
      ...(finalUrl && finalUrl !== url ? { finalUrl } : {}),
      status: status || undefined,
      code: status ? undefined : code,
      error: err ? firstLine(err.message) : undefined,
      engine,
      proxy: proxy ? `${proxy.host}:${proxy.port}` : undefined,
    },
  });
};

/**
 * Обгортка для engine.fetchPage: фіксує 4xx/5xx і мережеві помилки, нічого не змінюючи в поведінці.
 */
const wrapFetch = (fetchPage, engine) => async (url, options = {}) => {
  let result;
  try {
    result = await fetchPage(url, options);
  } catch (err) {
    const status = err?.response?.status; // axios кидає на 5xx (validateStatus: s < 500)
    recordSiteError({ url, status, err: status ? null : err, engine, proxy: options.proxy });
    throw err;
  }
  if (result?.status >= 400) {
    recordSiteError({ url, status: result.status, engine, proxy: options.proxy, finalUrl: result.finalUrl });
  }
  return result;
};

/** Наш API повернув клієнту 429 (rate limit). */
const recordApiRateLimit = (req) => {
  record({
    kind: 'api',
    key: req.ip,
    message: `Ліміт запитів до нашого API перевищено (HTTP 429) — ${req.ip}`,
    level: 'warn',
    domain: req.ip,
    status: 429,
    meta: {
      ip: req.ip,
      method: req.method,
      path: req.originalUrl?.split('?')[0],
      userAgent: req.get?.('user-agent'),
    },
  });
};

module.exports = { record, recordServerError, recordSiteError, recordApiRateLimit, wrapFetch, domainOf };
