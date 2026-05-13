/**
 * Queue Manager — BullMQ-based job queue for async parse tasks.
 * Falls back gracefully to synchronous execution if Redis is unavailable.
 */
const logger = require('../utils/logger');

let BullMQ;
try {
  BullMQ = require('bullmq');
} catch {
  logger.warn('BullMQ not installed — queue disabled');
}

const QUEUE_NAME = 'parser';

class QueueManager {
  constructor() {
    this.queue = null;
    this.queueEvents = null;
    this._enabled = false;
  }

  get enabled() { return this._enabled; }

  /**
   * Initialize the queue — connects to Redis.
   * If connection fails, queue runs in disabled mode and tasks run synchronously.
   * Uses retryStrategy: () => null so ioredis never tries to reconnect on failure.
   */
  async init() {
    if (!BullMQ) return;

    // Build ioredis connection options that disable auto-reconnect
    const connection = {
      host:     process.env.REDIS_HOST     || 'localhost',
      port:     parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      // Fail fast — do not buffer commands or retry connections
      lazyConnect:           true,
      enableOfflineQueue:    false,
      maxRetriesPerRequest:  0,
      // Return null from retryStrategy to disable all reconnection attempts
      retryStrategy:         () => null,
      reconnectOnError:      () => false,
      connectTimeout:        3000,
    };

    let queue = null;
    let queueEvents = null;

    try {
      queue = new BullMQ.Queue(QUEUE_NAME, {
        connection,
        defaultJobOptions: {
          attempts:         3,
          backoff:          { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail:     50,
        },
      });

      // Silence the internal error events so they don't crash the process
      queue.on('error', () => {});

      queueEvents = new BullMQ.QueueEvents(QUEUE_NAME, { connection });
      queueEvents.on('error', () => {});

      // Test the actual connection (will throw if Redis is down)
      await queue.getJobCounts();

      this.queue = queue;
      this.queueEvents = queueEvents;
      this._enabled = true;

      logger.info('Queue connected to Redis', {
        host: connection.host,
        port: connection.port,
      });

    } catch (err) {
      // Redis not available — shut down the objects cleanly so ioredis stops
      logger.warn('Redis unavailable — falling back to synchronous mode', {
        error: err.message,
      });

      // Close quietly (suppress any close errors)
      await queue?.close().catch(() => {});
      await queueEvents?.close().catch(() => {});

      this.queue = null;
      this.queueEvents = null;
      this._enabled = false;
    }
  }

  /**
   * Add a parse job to the queue.
   * If Redis is not available, runs the task synchronously and returns the result.
   */
  async addJob(taskId, options = {}) {
    if (!this._enabled || !this.queue) {
      logger.info('Queue disabled: running task synchronously', { taskId });
      const taskRepo     = require('../db/repositories/task.repository');
      const parserService = require('../core/parser/parser.service');
      const task = await taskRepo.findById(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      return parserService.run(task);
    }

    const job = await this.queue.add('parse', { taskId }, {
      priority: options.priority || 0,
      delay:    options.delay    || 0,
    });

    logger.info('Job queued', { jobId: job.id, taskId });
    return { jobId: job.id, queued: true };
  }

  async getJob(jobId) {
    if (!this.queue) return null;
    return BullMQ.Job.fromId(this.queue, jobId);
  }

  async getStats() {
    if (!this.queue) return { enabled: false };
    try {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
      return { enabled: true, ...counts };
    } catch {
      return { enabled: false };
    }
  }

  async clearCompleted() {
    if (!this.queue) return;
    await this.queue.clean(0, 100, 'completed').catch(() => {});
  }

  async close() {
    await this.queue?.close().catch(() => {});
    await this.queueEvents?.close().catch(() => {});
    this.queue = null;
    this.queueEvents = null;
    this._enabled = false;
  }
}

module.exports = new QueueManager();
