/**
 * Redis Pub/Sub bridge for parse events.
 *
 * Worker process  → initPublisher(parseEvents)
 *   → monkey-patches parseEvents.emit to also publish each event to Redis
 *
 * Server process  → initSubscriber(parseEvents)
 *   → subscribes to Redis and re-emits received events on local parseEvents bus
 *   → SSE handler in tasks.controller already listens to parseEvents — no changes needed there
 *
 * When running synchronously (no worker): bridge is not used.
 * No double-fire: publisher is only patched in the worker, not in the server.
 */
let IORedis;
try { IORedis = require('ioredis'); } catch { /* ioredis not installed */ }

const CHANNEL_PREFIX = 'parser:events:';

const redisOpts = () => ({
  host:                process.env.REDIS_HOST     || 'localhost',
  port:                parseInt(process.env.REDIS_PORT) || 6379,
  password:            process.env.REDIS_PASSWORD || undefined,
  lazyConnect:         true,
  maxRetriesPerRequest: 0,
  enableOfflineQueue:  false,
  retryStrategy:       (times) => Math.min(times * 1000, 10000),
  connectTimeout:      3000,
});

/**
 * Call once in the WORKER process.
 * Patches parseEvents.emit to forward every event to Redis.
 */
async function initPublisher(parseEvents) {
  if (!IORedis) return;
  const pub = new IORedis(redisOpts());
  try {
    await pub.connect();
    const _emit = parseEvents.emit.bind(parseEvents);
    parseEvents.emit = (taskId, event) => {
      _emit(taskId, event);
      pub.publish(CHANNEL_PREFIX + String(taskId), JSON.stringify(event)).catch(() => {});
    };
    pub.on('error', () => {}); // silence reconnect errors
  } catch {
    // Redis unavailable — events stay in-process only (no SSE from worker)
  }
}

/**
 * Call once in the MAIN SERVER process.
 * Subscribes to all parser event channels and re-emits on local parseEvents bus.
 */
async function initSubscriber(parseEvents) {
  if (!IORedis) return;
  const sub = new IORedis(redisOpts());
  try {
    await sub.connect();
    await sub.psubscribe(CHANNEL_PREFIX + '*');
    sub.on('pmessage', (_pattern, channel, message) => {
      const taskId = channel.slice(CHANNEL_PREFIX.length);
      try {
        parseEvents.emit(taskId, JSON.parse(message));
      } catch { /* malformed message */ }
    });
    sub.on('error', () => {});
  } catch {
    // Redis unavailable — SSE works only for synchronous (in-process) runs
  }
}

module.exports = { initPublisher, initSubscriber };
