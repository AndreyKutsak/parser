/**
 * Parser Worker — runs as a separate process consuming BullMQ jobs
 * Start with: node src/queue/workers/parser.worker.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const { connect, disconnect } = require('../../db/connection');
const parserService = require('../../core/parser/parser.service');
const dynamicEngine = require('../../core/parser/engines/dynamic.engine');
const taskRepo = require('../../db/repositories/task.repository');
const logger = require('../../utils/logger');
const eventBridge = require('../../utils/event-bridge');
const parseEvents = require('../../utils/parse-events');

const STATIC_QUEUE   = 'parser';
const DYNAMIC_QUEUE  = 'parser-dynamic';
// Static (axios) tasks are cheap — allow higher concurrency
const STATIC_CONCURRENCY  = parseInt(process.env.MAX_CONCURRENT_TASKS)         || 5;
// Dynamic (Puppeteer) tasks are heavy — limit to avoid memory pressure
const DYNAMIC_CONCURRENCY = parseInt(process.env.MAX_CONCURRENT_DYNAMIC_TASKS) || 2;
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS) || 30_000;

const connection = {
  host:                 process.env.REDIS_HOST || 'localhost',
  port:                 parseInt(process.env.REDIS_PORT) || 6379,
  password:             process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 0,
  enableOfflineQueue:   false,
  retryStrategy:        (times) => Math.min(times * 1000, 10000),
  connectTimeout:       5000,
};

async function main() {
  await connect();

  // Forward parse events from this worker process to the main server via Redis Pub/Sub
  await eventBridge.initPublisher(parseEvents);

  logger.info('Parser worker started', {
    staticConcurrency: STATIC_CONCURRENCY,
    dynamicConcurrency: DYNAMIC_CONCURRENCY,
  });

  const jobHandler = async (job) => {
    const { taskId } = job.data;
    logger.info('Processing job', { jobId: job.id, taskId });
    const task = await taskRepo.findById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    return parserService.run(task);
  };

  const workerOpts = (concurrency) => ({
    connection,
    concurrency,
    settings: {
      stalledInterval: 30_000,
      maxStalledCount: 1,
    },
  });

  const staticWorker  = new Worker(STATIC_QUEUE,  jobHandler, workerOpts(STATIC_CONCURRENCY));
  const dynamicWorker = new Worker(DYNAMIC_QUEUE, jobHandler, workerOpts(DYNAMIC_CONCURRENCY));

  for (const worker of [staticWorker, dynamicWorker]) {
    worker.on('completed', (job, result) => {
      logger.info('Job completed', { jobId: job.id, records: result?.totalRecords });
    });
    worker.on('failed', (job, err) => {
      logger.error('Job failed', { jobId: job?.id, error: err.message, stack: err.stack });
    });
    worker.on('stalled', (jobId) => {
      logger.warn('Job stalled — will be retried or moved to failed', { jobId });
    });
    worker.on('error', (err) => {
      logger.error('Worker error', { error: err.message });
    });
  }

  let shutdownCalled = false;
  const shutdown = async (signal) => {
    if (shutdownCalled) return;
    shutdownCalled = true;

    logger.info('Worker shutting down...', { signal });

    // Force-exit if graceful shutdown hangs (e.g. stuck job or DB)
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref(); // don't keep the process alive just for this timer

    try {
      await Promise.all([staticWorker.close(), dynamicWorker.close()]);
      await dynamicEngine.closeAll();
      await eventBridge.close();
      await disconnect();
    } catch (err) {
      logger.error('Error during shutdown', { error: err.message });
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Log uncaught errors before crashing so the cause isn't lost in logs
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });

  // Unhandled job-level rejections are handled by BullMQ — only log here
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
  });
}

main().catch((err) => {
  logger.error('Worker startup failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
