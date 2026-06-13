/**
 * Scheduler Service — manages cron-based task execution using node-cron
 */
const cron = require('node-cron');
const taskRepo = require('../../db/repositories/task.repository');
const parserService = require('../parser/parser.service');
const queueManager = require('../../queue/queue.manager');
const logger = require('../../utils/logger');

class SchedulerService {
  constructor() {
    // Map of taskId -> cron job instance
    this._jobs = new Map();
    // Polling job to pick up tasks with nextRun <= now
    this._poller = null;
    this._watchdog = null;
  }

  /**
   * Start the scheduler — polls every minute for due tasks
   */
  start() {
    // Poll every minute for tasks that are due
    this._poller = cron.schedule('* * * * *', () => this._tick(), { scheduled: true });

    // Watchdog every 30 minutes: reset tasks stuck in 'running' with no page activity
    this._watchdog = cron.schedule('*/30 * * * *', () => this._watchdogTick(), { scheduled: true });

    logger.info('Scheduler started');

    // Run immediately on boot
    this._tick();
  }

  stop() {
    if (this._poller) {
      this._poller.stop();
      this._poller = null;
    }
    if (this._watchdog) {
      this._watchdog.stop();
      this._watchdog = null;
    }
    for (const [, job] of this._jobs) job.stop();
    this._jobs.clear();
    logger.info('Scheduler stopped');
  }

  /**
   * Register a task's cron schedule
   */
  scheduleTask(task) {
    if (!task.schedule?.enabled || !task.schedule?.cron) return;
    if (!cron.validate(task.schedule.cron)) {
      logger.warn('Invalid cron expression', { taskId: task._id, cron: task.schedule.cron });
      return;
    }

    // Remove existing job if any
    this.unscheduleTask(task._id);

    const job = cron.schedule(task.schedule.cron, async () => {
      logger.info('Scheduled task triggered', { taskId: task._id, name: task.name });
      try {
        await this._executeTask(task._id);
      } catch (err) {
        logger.error('Scheduled task failed', { taskId: task._id, error: err.message });
      }
    }, { scheduled: true, timezone: 'UTC' });

    this._jobs.set(String(task._id), job);
    logger.info('Task scheduled', { taskId: task._id, cron: task.schedule.cron });
  }

  unscheduleTask(taskId) {
    const key = String(taskId);
    if (this._jobs.has(key)) {
      this._jobs.get(key).stop();
      this._jobs.delete(key);
    }
  }

  /** Trigger a task immediately (manual run) — runs directly, bypasses queue for instant response */
  async runNow(taskId) {
    return this._executeTask(taskId, { useQueue: false });
  }

  /** Pause a task — stops the cron job but keeps config */
  async pauseTask(taskId) {
    this.unscheduleTask(taskId);
    await taskRepo.updateStatus(taskId, 'paused');
  }

  /** Resume a paused task */
  async resumeTask(taskId) {
    const task = await taskRepo.findById(taskId);
    if (!task) throw new Error('Task not found');
    await taskRepo.updateStatus(taskId, 'idle');
    this.scheduleTask(task);
  }

  /** Get list of currently scheduled task IDs */
  getScheduledIds() {
    return Array.from(this._jobs.keys());
  }

  /** Check if nextRun cron expression returns a valid date. For display purposes. */
  getNextRunDate(cronExpr) {
    try {
      // node-cron doesn't expose next date natively; compute manually
      // Simple approximation: just validate
      return cron.validate(cronExpr) ? 'valid cron' : null;
    } catch {
      return null;
    }
  }

  // ---- Private ----

  /** Watchdog: reset tasks that have been stuck in 'running' with no page activity for 30+ min */
  async _watchdogTick() {
    try {
      const threshold = new Date(Date.now() - 30 * 60 * 1000);
      const stuck = await taskRepo.findStuckRunning(threshold);
      if (!stuck.length) return;

      for (const task of stuck) {
        logger.warn('Watchdog: resetting stuck task to idle', {
          taskId: task._id,
          name: task.name,
          lastActivity: task.stats?.lastActivity,
          lastRun: task.schedule?.lastRun,
        });
        await taskRepo.updateStatus(task._id, 'idle');
      }
    } catch (err) {
      logger.error('Watchdog tick error', { error: err.message });
    }
  }

  /** Poll-based tick: find all tasks with nextRun <= now and execute them */
  async _tick() {
    try {
      const dueTasks = await taskRepo.findDueTasks();
      if (!dueTasks.length) return;

      logger.debug(`Scheduler tick: ${dueTasks.length} due tasks`);

      await Promise.allSettled(
        dueTasks.map(task => this._executeTask(task._id).catch(e =>
          logger.error('Task execution error', { taskId: task._id, error: e.message })
        ))
      );
    } catch (err) {
      logger.error('Scheduler tick error', { error: err.message });
    }
  }

  async _executeTask(taskId, { useQueue = true } = {}) {
    const task = await taskRepo.findById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    if (task.status === 'running') {
      logger.warn('Task already running, skipping', { taskId });
      return;
    }

    if (task.status === 'paused') {
      logger.info('Task is paused, skipping', { taskId });
      return;
    }

    // Update nextRun before starting so concurrent schedulers don't pick it up
    if (task.schedule?.cron) {
      const nextRun = this._getNextCronDate(task.schedule.cron);
      await taskRepo.update(taskId, { 'schedule.nextRun': nextRun });
    }

    // Scheduled tasks go through BullMQ: retries, persistence, worker isolation.
    // runNow() bypasses queue (useQueue=false) for synchronous API response.
    if (useQueue && queueManager.enabled) {
      return queueManager.addJob(String(taskId), { engine: task.engine ?? 'static' });
    }
    return parserService.run(task);
  }

  _getNextCronDate(cronExpr) {
    try {
      const parser = require('cron-parser');
      return parser.parseExpression(cronExpr, { utc: true }).next().toDate();
    } catch {
      return new Date(Date.now() + 3600 * 1000);
    }
  }

  /** Load all enabled scheduled tasks from DB and register them */
  async loadFromDatabase() {
    const { items } = await taskRepo.findAll({ status: 'idle' });
    let registered = 0;

    for (const task of items) {
      if (task.schedule?.enabled && task.schedule?.cron) {
        this.scheduleTask(task);
        registered++;
      }
    }

    logger.info(`Loaded ${registered} scheduled tasks from database`);
  }
}

module.exports = new SchedulerService();
