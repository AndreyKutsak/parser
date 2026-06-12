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

const STATIC_QUEUE  = 'parser';
const DYNAMIC_QUEUE = 'parser-dynamic';

const JOB_DEFAULTS = {
  attempts:         3,
  backoff:          { type: 'exponential', delay: 5000 },
  removeOnComplete: 100,
  removeOnFail:     50,
};

class QueueManager {
  constructor() {
    this.staticQueue  = null;
    this.dynamicQueue = null;
    this.queueEvents  = null;
    this._enabled = false;
  }

  get enabled() { return this._enabled; }

  /**
   * Initialize both queues — connects to Redis.
   * If connection fails, queue runs in disabled mode and tasks run synchronously.
   */
  async init() {
    if (!BullMQ) return;

    const connection = {
      host:     process.env.REDIS_HOST     || 'localhost',
      port:     parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect:           true,
      enableOfflineQueue:    false,
      maxRetriesPerRequest:  0,
      retryStrategy:         () => null,
      reconnectOnError:      () => false,
      connectTimeout:        3000,
    };

    let staticQueue  = null;
    let dynamicQueue = null;
    let queueEvents  = null;

    try {
      staticQueue  = new BullMQ.Queue(STATIC_QUEUE,  { connection, defaultJobOptions: JOB_DEFAULTS });
      dynamicQueue = new BullMQ.Queue(DYNAMIC_QUEUE, { connection, defaultJobOptions: JOB_DEFAULTS });
      staticQueue.on('error',  () => {});
      dynamicQueue.on('error', () => {});

      queueEvents = new BullMQ.QueueEvents(STATIC_QUEUE, { connection });
      queueEvents.on('error', () => {});

      // Test connection
      await staticQueue.getJobCounts();

      this.staticQueue  = staticQueue;
      this.dynamicQueue = dynamicQueue;
      this.queueEvents  = queueEvents;
      this._enabled = true;

      logger.info('Queue connected to Redis', {
        host: connection.host,
        port: connection.port,
      });

    } catch (err) {
      logger.warn('Redis unavailable — falling back to synchronous mode', {
        error: err.message,
      });

      await staticQueue?.close().catch(() => {});
      await dynamicQueue?.close().catch(() => {});
      await queueEvents?.close().catch(() => {});

      this.staticQueue  = null;
      this.dynamicQueue = null;
      this.queueEvents  = null;
      this._enabled = false;
    }
  }

  /**
   * Add a parse job to the appropriate queue based on engine type.
   * engine='dynamic' → parser:dynamic (lower concurrency worker)
   * engine='static'  → parser        (higher concurrency worker)
   */
  async addJob(taskId, { priority = 0, delay = 0, engine = 'static' } = {}) {
    if (!this._enabled) {
      logger.info('Queue disabled: running task synchronously', { taskId });
      const taskRepo      = require('../db/repositories/task.repository');
      const parserService = require('../core/parser/parser.service');
      const task = await taskRepo.findById(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      return parserService.run(task);
    }

    const queue = engine === 'dynamic' ? this.dynamicQueue : this.staticQueue;
    const job = await queue.add('parse', { taskId }, { priority, delay });

    logger.info('Job queued', { jobId: job.id, taskId, engine });
    return { jobId: job.id, queued: true };
  }

  async getJob(jobId) {
    if (!this.staticQueue) return null;
    return BullMQ.Job.fromId(this.staticQueue, jobId);
  }

  async getStats() {
    if (!this.staticQueue) return { enabled: false };
    try {
      const [s, d] = await Promise.all([
        this.staticQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
        this.dynamicQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      ]);
      return { enabled: true, static: s, dynamic: d };
    } catch {
      return { enabled: false };
    }
  }

  async clearCompleted() {
    await this.staticQueue?.clean(0, 100, 'completed').catch(() => {});
    await this.dynamicQueue?.clean(0, 100, 'completed').catch(() => {});
  }

  async close() {
    await this.staticQueue?.close().catch(() => {});
    await this.dynamicQueue?.close().catch(() => {});
    await this.queueEvents?.close().catch(() => {});
    this.staticQueue  = null;
    this.dynamicQueue = null;
    this.queueEvents  = null;
    this._enabled = false;
  }
}

module.exports = new QueueManager();
