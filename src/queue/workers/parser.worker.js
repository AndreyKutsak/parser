/**
 * Parser Worker — runs as a separate process consuming BullMQ jobs
 * Start with: node src/queue/workers/parser.worker.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
const { Worker } = require('bullmq');
const { connect } = require('../../db/connection');
const parserService = require('../../core/parser/parser.service');
const dynamicEngine = require('../../core/parser/engines/dynamic.engine');
const taskRepo = require('../../db/repositories/task.repository');
const logger = require('../../utils/logger');
const eventBridge = require('../../utils/event-bridge');
const parseEvents = require('../../utils/parse-events');

const QUEUE_NAME = 'parser';
const CONCURRENCY = parseInt(process.env.MAX_CONCURRENT_TASKS) || 3;

const connection = {
  host:                 process.env.REDIS_HOST || 'localhost',
  port:                 parseInt(process.env.REDIS_PORT) || 6379,
  password:             process.env.REDIS_PASSWORD || undefined,
  // Fail fast — don't infinitely retry on connection loss
  maxRetriesPerRequest: 0,
  enableOfflineQueue:   false,
  retryStrategy:        (times) => Math.min(times * 1000, 10000), // max 10s between retries
  connectTimeout:       5000,
};

async function main() {
  await connect();

  // Forward parse events from this worker process to the main server via Redis Pub/Sub
  await eventBridge.initPublisher(parseEvents);

  logger.info('Parser worker started', { concurrency: CONCURRENCY });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { taskId } = job.data;
      logger.info('Processing job', { jobId: job.id, taskId });

      const task = await taskRepo.findById(taskId);
      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      const result = await parserService.run(task);
      logger.info('Job completed', { jobId: job.id, taskId, result });
      return result;
    },
    {
      connection,
      concurrency: CONCURRENCY,
    }
  );

  worker.on('completed', (job, result) => {
    logger.info('Job completed', { jobId: job.id, records: result?.totalRecords });
  });

  worker.on('failed', (job, err) => {
    logger.error('Job failed', { jobId: job?.id, error: err.message });
  });

  worker.on('error', (err) => {
    logger.error('Worker error', { error: err.message });
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Worker shutting down...');
    await worker.close();
    await dynamicEngine.closeAll(); // закриваємо всі Chromium-процеси
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error('Worker startup failed', { error: err.message });
  process.exit(1);
});
