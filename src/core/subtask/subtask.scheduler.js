/**
 * SubTask Scheduler
 *
 * Manages cron jobs for sub-tasks independently of the main task scheduler.
 * Two scheduling modes run in parallel:
 *   1. Per-sub-task cron jobs (precise schedule, registered at creation/update)
 *   2. Poll-based tick every minute (catchup for missed runs, e.g. after restart)
 */
const cron = require("node-cron");
const subtaskRepo = require("../../db/repositories/subtask.repository");
const taskRepo = require("../../db/repositories/task.repository");
const subtaskService = require("./subtask.service");
const logger = require("../../utils/logger");

const TICK_BATCH  = 50;  // скільки підзадач обробляти за один тік
const TICK_CONCUR = 5;   // скільки паралельних fetch у межах одного батча

class SubTaskScheduler {
  constructor() {
    this._jobs       = new Map(); // subTaskId → cron.ScheduledTask
    this._poller     = null;
    this._tickActive = false;    // захист від перекриття тіків
  }

  /** Start the scheduler and catch up any overdue sub-tasks */
  start() {
    this._poller = cron.schedule("* * * * *", () => this._tick(), {
      scheduled: true,
    });
    logger.info("SubTask scheduler started");
    setImmediate(() => this._tick()); // catch up on restart without blocking
  }

  stop() {
    this._poller?.stop();
    this._poller = null;
    for (const job of this._jobs.values()) job.stop();
    this._jobs.clear();
  }

  /**
   * Register (or re-register) a cron job for a sub-task.
   * Safe to call multiple times — removes any existing job first.
   */
  scheduleSubTask(subTask) {
    if (!subTask.schedule?.enabled) return;
    const cronExpr = subTask.schedule?.cron;
    if (!cronExpr || !cron.validate(cronExpr)) return;

    this.unschedule(subTask._id);

    const id = String(subTask._id);
    const job = cron.schedule(
      cronExpr,
      async () => {
        try {
          const fresh = await subtaskRepo.findById(id);
          if (!fresh || fresh.status === "running") return;

          // Check if parent task is running
          const parentTask = await taskRepo.findById(fresh.parentTaskId);
          if (!parentTask || parentTask.status !== "running") {
            logger.debug("SubTask skipped: parent task not running", {
              subtaskId: id,
              parentTaskId: fresh.parentTaskId,
              parentStatus: parentTask?.status,
            });
            return;
          }

          await subtaskService.run(fresh);
        } catch (err) {
          logger.error("Scheduled subtask failed", { id, error: err.message });
        }
      },
      { scheduled: true, timezone: "UTC" },
    );

    this._jobs.set(id, job);
  }

  unschedule(id) {
    const key = String(id);
    if (this._jobs.has(key)) {
      this._jobs.get(key).stop();
      this._jobs.delete(key);
    }
  }

  /** Manually trigger a sub-task immediately (bypasses schedule) */
  async runNow(id) {
    const subTask = await subtaskRepo.findById(id);
    if (!subTask) throw new Error("SubTask not found");
    if (subTask.status === "running")
      throw new Error("SubTask already running");
    return subtaskService.run(subTask);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Poll-based catchup: runs any overdue sub-tasks not caught by cron jobs */
  async _tick() {
    if (this._tickActive) {
      logger.debug("SubTask tick skipped — previous tick still running");
      return;
    }
    this._tickActive = true;
    try {
      const due = await subtaskRepo.findDue(TICK_BATCH);
      if (!due.length) return;
      logger.debug(`SubTask tick: ${due.length} due`);

      // Завантажуємо parentTask-статуси одним запитом
      const parentIds = [...new Set(due.map((s) => String(s.parentTaskId)))];
      const parents   = await taskRepo.findByIds(parentIds);
      const parentMap = new Map(parents.map((p) => [String(p._id), p]));

      // Обробляємо батчами по TICK_CONCUR паралельно
      for (let i = 0; i < due.length; i += TICK_CONCUR) {
        const batch = due.slice(i, i + TICK_CONCUR);
        await Promise.all(
          batch.map(async (st) => {
            try {
              const parentTask = parentMap.get(String(st.parentTaskId));
              if (!parentTask || parentTask.status !== "running") return;
              await subtaskService.run(st);
            } catch (err) {
              logger.error("SubTask tick error", { id: st._id, error: err.message });
            }
          }),
        );
        // Пауза між батчами щоб не перевантажувати сайт
        if (i + TICK_CONCUR < due.length) {
          await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
        }
      }
    } catch (err) {
      logger.error("SubTask scheduler tick error", { error: err.message });
    } finally {
      this._tickActive = false;
    }
  }
}

module.exports = new SubTaskScheduler();
