/**
 * Reports each PM2-managed process's own memory usage into Redis so the
 * dashboard (served by the `app` process) can show RAM for `app` and
 * `parser.worker` side by side, even though they're separate OS processes.
 *
 * Each process calls startReporting(name) once at boot; the app process
 * additionally calls readAll() to render the dashboard widget.
 */
let IORedis;
try { IORedis = require('ioredis'); } catch { /* ioredis not installed */ }

const KEY_PREFIX = 'sysmem:';
const KNOWN_PROCESSES = ['app', 'parser.worker'];
const REPORT_INTERVAL_MS = 10_000;
const KEY_TTL_SEC = 30; // expires if the process dies without a clean shutdown

const redisOpts = () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 1000, 10000),
  connectTimeout: 3000,
});

let reportTimer = null;

/** Call once at process boot. No-op if Redis is unavailable. */
async function startReporting(name) {
  if (!IORedis) return;
  const client = new IORedis(redisOpts());
  client.on('error', () => {}); // silence reconnect noise

  try {
    await client.connect();
  } catch {
    return; // Redis unavailable — skip reporting rather than retry forever
  }

  const report = () => {
    const mem = process.memoryUsage();
    const payload = JSON.stringify({
      name,
      pid: process.pid,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      uptime: process.uptime(),
      updatedAt: Date.now(),
    });
    client.set(KEY_PREFIX + name, payload, 'EX', KEY_TTL_SEC).catch(() => {});
  };

  report();
  reportTimer = setInterval(report, REPORT_INTERVAL_MS);
  reportTimer.unref();
}

let readerClient = null;
let readerReady = null;

/** Lazily connect a single long-lived reader client, reused across polls. */
function getReaderClient() {
  if (!readerClient) {
    readerClient = new IORedis(redisOpts());
    readerClient.on('error', () => {});
    readerReady = readerClient.connect().catch(() => {});
  }
  return readerReady;
}

/** Call from the app process to read all known processes' last-reported memory. */
async function readAll() {
  if (!IORedis) return [];
  try {
    await getReaderClient();
    if (readerClient.status !== 'ready') return [];
    const values = await readerClient.mget(KNOWN_PROCESSES.map((n) => KEY_PREFIX + n));
    return values
      .map((v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { startReporting, readAll };
