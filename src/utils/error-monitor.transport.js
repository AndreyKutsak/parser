/**
 * Winston-транспорт, що зберігає помилки (level=error) у MongoDB для сторінки "Помилки".
 *
 * Важливо: цей модуль НІКОЛИ не пише через logger (інакше нескінченна рекурсія) і ніколи не кидає —
 * якщо Mongo недоступна, помилка просто не потрапить у монітор (у файлових логах вона лишиться).
 */
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const { Transport } = require('winston'); // = winston-transport, без окремої залежності

const MAX_SAMPLES = 5;
const MAX_STR = 4000;

const processName = () =>
  process.env.name || path.basename(process.argv[1] || 'node', '.js');

const firstLine = (s) => String(s || '').split('\n')[0].trim();

/** Прибирає змінні частини, щоб однакові за суттю помилки групувались разом. */
const normalize = (s) =>
  firstLine(s)
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{24}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/(["'])(?:(?!\1).){1,200}\1/g, '<str>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .slice(0, 300);

const truncate = (v) => (typeof v === 'string' && v.length > MAX_STR ? v.slice(0, MAX_STR) + '…' : v);

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

class ErrorMonitorTransport extends Transport {
  constructor(opts = {}) {
    super({ level: 'error', ...opts });
    this.proc = processName();
  }

  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    try {
      this._save(info);
    } catch { /* ніколи не ламаємо логування */ }
    callback();
  }

  _save(info) {
    // Mongo ще не підключена / відключилась — пропускаємо, щоб mongoose не буферизував записи.
    if (mongoose.connection.readyState !== 1) return;

    const { level, message, timestamp, stack, ...rest } = info;
    const meta = cleanMeta(rest);
    const errText = meta?.error || meta?.message || meta?.reason || '';
    // Для "Unhandled error" повідомлення саме по собі однакове — додаємо шлях запиту (з <id>) у сигнатуру.
    const key = [normalize(message), normalize(errText), meta?.method || '', normalize(meta?.path || '')].join('|');
    const fingerprint = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);

    const now = new Date();
    const hour = new Date(now);
    hour.setUTCMinutes(0, 0, 0);

    const sample = {
      at: now,
      message: truncate(String(message || '')),
      meta,
      stack: truncate(stack || meta?.stack),
    };
    if (sample.meta?.stack) delete sample.meta.stack;

    const ErrorLog = require('../db/models/error-log.model');
    ErrorLog.updateOne(
      { fingerprint, hour, process: this.proc },
      {
        $inc: { count: 1 },
        $set: { lastAt: now },
        $setOnInsert: { level, message: firstLine(message).slice(0, 500), firstAt: now },
        $push: { samples: { $each: [sample], $slice: -MAX_SAMPLES } },
      },
      { upsert: true },
    ).catch(() => {});
  }
}

module.exports = ErrorMonitorTransport;
