/**
 * Winston-транспорт: помилки (level=error) → MongoDB для сторінки "Помилки".
 * Уся логіка запису — в error-store.js (там же гарантія, що запис ніколи не кидає і не логує).
 */
const { Transport } = require('winston'); // = winston-transport, без окремої залежності
const { recordServerError } = require('./error-store');

class ErrorMonitorTransport extends Transport {
  constructor(opts = {}) {
    super({ level: 'error', ...opts });
  }

  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    recordServerError(info);
    callback();
  }
}

module.exports = ErrorMonitorTransport;
