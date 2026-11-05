/**
 * Автоматична перевірка всіх проксі за розкладом.
 *
 * PROXY_CHECK_CRON — cron-вираз (час сервера). За замовчуванням 4 рази на день: 00:15, 06:15, 12:15, 18:15
 *                    (зсув на :15, щоб не збігатися з плановими задачами на початку години).
 *                    "off" — вимкнути.
 */
const cron = require('node-cron');
const logger = require('../../utils/logger');
const proxyManager = require('./proxy.manager');

const DEFAULT_CRON = '15 */6 * * *';

let job = null;
let cronExpr = null;

const nextRun = () => {
  if (!cronExpr) return null;
  try {
    return require('cron-parser').parseExpression(cronExpr).next().toDate();
  } catch {
    return null;
  }
};

const start = () => {
  const expr = (process.env.PROXY_CHECK_CRON || DEFAULT_CRON).trim();
  if (expr === 'off') {
    logger.info('Proxy auto-check disabled (PROXY_CHECK_CRON=off)');
    return;
  }
  if (!cron.validate(expr)) {
    logger.error('Invalid PROXY_CHECK_CRON — proxy auto-check disabled', { cron: expr });
    return;
  }

  cronExpr = expr;
  job = cron.schedule(expr, () => {
    if (proxyManager.getCheckStatus().running) {
      logger.warn('Proxy auto-check skipped: previous check is still running');
      return;
    }
    proxyManager.checkAll('schedule').catch(() => {}); // помилку логує checkAll
  });
  logger.info('Proxy auto-check scheduled', { cron: expr, nextRun: nextRun() });
};

const stop = () => {
  job?.stop();
  job = null;
};

const info = () => ({ enabled: !!job, cron: cronExpr, nextRun: nextRun() });

module.exports = { start, stop, info };
