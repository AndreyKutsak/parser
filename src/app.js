/**
 * Web Parser Pro — Main application entry point
 */
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { connect } = require("./db/connection");
const scheduler = require("./core/scheduler/scheduler.service");
const subTaskScheduler = require("./core/subtask/subtask.scheduler");
const queueManager = require("./queue/queue.manager");
const logger = require("./utils/logger");
const eventBridge = require("./utils/event-bridge");
const parseEvents = require("./utils/parse-events");
const createApp = require("./server/createApp");

const app = createApp();
const PORT = 3000;

async function start() {
  try {
    await connect();
    await queueManager.init();
    await eventBridge.initSubscriber(parseEvents);

    scheduler.start();
    await scheduler.loadFromDatabase();
    subTaskScheduler.start();

    app.listen(PORT, () => {
      logger.info(`Web Parser Pro running on http://localhost:${PORT}`);
      logger.info(`API docs: http://localhost:${PORT}/api-docs`);
    });
  } catch (err) {
    logger.error("Startup failed", { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

async function shutdown(signal) {
  logger.info(`${signal} received - shutting down gracefully`);
  scheduler.stop();
  subTaskScheduler.stop();
  await queueManager.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: String(reason) });
});

start();

module.exports = app;
