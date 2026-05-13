/**
 * SubTask Service
 *
 * Responsibilities:
 *   createOrUpdate — called by parser.service when a new item URL is discovered;
 *                    creates a SubTask doc (idempotent — upsert by parentTaskId+url).
 *   run            — fetches the item URL, extracts data using stored selectors,
 *                    detects changes via SHA-256 hash, persists result.
 */
const crypto = require("crypto");
const staticEngine = require("../parser/engines/static.engine");
const dynamicEngine = require("../parser/engines/dynamic.engine");
const { extractAll, extractRecord } = require("../parser/selector.service");
const subtaskRepo = require("../../db/repositories/subtask.repository");
const parseEvents = require("../../utils/parse-events");
const taskRepo = require("../../db/repositories/task.repository");
const logger = require("../../utils/logger");

/** Convert interval in minutes to a cron expression */
const intervalToCron = (minutes) => {
  if (minutes < 1) minutes = 1;
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `0 */${hours} * * *`;
  const days = Math.floor(hours / 24);
  return `0 0 */${days} * *`;
};

const hashData = (data) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(data ?? null))
    .digest("hex");

const resolveFields = (fields) => {
  if (!fields) return new Map();
  if (fields instanceof Map) return fields;
  return new Map(Object.entries(fields));
};

class SubTaskService {
  /**
   * Register a new sub-task for the given item URL.
   * Called from parser.service after the parent task discovers item links.
   * Uses upsert — safe to call multiple times for the same URL.
   *
   * @param {object} parentTask  - Lean Task doc
   * @param {string} itemUrl     - Detail page URL for this item
   * @returns {Promise<object>}  - The SubTask doc (new or existing)
   */
  async createOrUpdate(parentTask, itemUrl) {
    const intervalMinutes = parentTask.subTasks?.intervalMinutes ?? 60;
    const cron = parentTask.subTasks?.cron || intervalToCron(intervalMinutes);
    // Add random delay (0-10 minutes) to spread out initial runs and avoid overloading the target website
    const randomDelayMinutes = Math.floor(Math.random() * 10);
    const nextRun = new Date(
      Date.now() + (intervalMinutes + randomDelayMinutes) * 60 * 1000,
    );

    const defaults = {
      ...this._buildDefaults(parentTask),
      schedule: { enabled: true, intervalMinutes, cron, nextRun },
    };

    const doc = await subtaskRepo.upsertByUrl(
      String(parentTask._id),
      itemUrl,
      defaults,
    );
    logger.debug("SubTask upserted", {
      parentTaskId: parentTask._id,
      url: itemUrl,
      id: doc._id,
    });
    return doc;
  }

  /**
   * Execute a single sub-task run:
   *   1. Fetch the item URL
   *   2. Extract data via stored selectors
   *   3. Hash → compare with lastHash
   *   4. Update SubTask doc + append history entry
   *
   * @param {object} subTask - Lean SubTask doc
   */
  async run(subTask) {
    const startTime = Date.now();

    // Atomic claim — якщо вже running (запущено паралельно), пропускаємо
    const claimed = await subtaskRepo.claimForRun(subTask._id);
    if (!claimed) {
      logger.debug("SubTask already running, skip", { id: subTask._id });
      return { changed: false, data: null, duration: 0 };
    }

    // Check if parent task is stopped
    const parentTask = await taskRepo.findById(subTask.parentTaskId);
    if (parentTask && parentTask.status === "stopped") {
      await subtaskRepo.updateStatus(subTask._id, "idle");
      logger.info("SubTask skipped because parent task is stopped", {
        id: subTask._id,
      });
      return { changed: false, data: null, duration: 0 };
    }

    try {
      const engine =
        subTask.engine === "dynamic" ? dynamicEngine : staticEngine;
      const fetchOptions = {
        timeout: subTask.options?.timeout ?? 30000,
        headers: subTask.options?.headers ?? {},
        antiBot: subTask.options?.antiBot ?? true,
        method: "GET",
        body: null,
        proxy: null,
      };

      const {
        $,
        status,
        duration: fetchDuration,
      } = await engine.fetchPage(subTask.url, fetchOptions);

      // Emit subtask request event
      parseEvents.emit(subTask.parentTaskId, {
        type: "subtask:request",
        url: subTask.url,
        method: "GET",
        status,
        duration: fetchDuration,
      });

      // Extract data from the detail page (sub-tasks are always single-item pages)
      const fields = resolveFields(subTask.selectors?.fields);
      let newData;
      if (fields.size > 0) {
        newData = extractRecord($, $("body"), fields, subTask.url);
      } else {
        newData = {};
      }

      const newHash = hashData(newData);
      const changed = newHash !== subTask.lastHash;
      const duration = Date.now() - startTime;
      const now = new Date();
      const nextRun = new Date(
        now.getTime() + (subTask.schedule?.intervalMinutes ?? 60) * 60 * 1000,
      );

      await subtaskRepo.update(subTask._id, {
        status: "idle",
        lastData: newData,
        lastHash: newHash,
        lastParsedAt: now,
        totalRuns: (subTask.totalRuns ?? 0) + 1,
        changedRuns: (subTask.changedRuns ?? 0) + (changed ? 1 : 0),
        "schedule.lastRun": now,
        "schedule.nextRun": nextRun,
      });

      // History: store full data for every run
      await subtaskRepo.appendHistory(subTask._id, {
        parsedAt: now,
        duration,
        changed,
        data: newData,
        error: null,
      });

      logger.info("SubTask run", {
        id: subTask._id,
        url: subTask.url,
        changed,
        duration,
        nextRun,
      });

      return { changed, data: newData, duration };
    } catch (err) {
      const duration = Date.now() - startTime;
      const nextRun = new Date(
        Date.now() + (subTask.schedule?.intervalMinutes ?? 60) * 60 * 1000,
      );

      // Emit failed subtask request event
      parseEvents.emit(subTask.parentTaskId, {
        type: "subtask:request",
        url: subTask.url,
        method: "GET",
        status: 0, // error status
        duration,
        error: err.message,
      });

      await subtaskRepo.update(subTask._id, {
        status: "error",
        totalRuns: (subTask.totalRuns ?? 0) + 1,
        "schedule.lastRun": new Date(),
        "schedule.nextRun": nextRun,
      });
      await subtaskRepo.appendHistory(subTask._id, {
        parsedAt: new Date(),
        duration,
        changed: false,
        data: null,
        error: err.message,
      });

      logger.error("SubTask run failed", {
        id: subTask._id,
        url: subTask.url,
        error: err.message,
      });
      throw err;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _buildDefaults(parentTask) {
    // Prefer detailFields for sub-task parsing; fall back to main fields
    const rawDetail = parentTask.selectors?.detailFields;
    const rawMain = parentTask.selectors?.fields;

    const hasDetail =
      rawDetail &&
      (rawDetail instanceof Map
        ? rawDetail.size > 0
        : Object.keys(rawDetail).length > 0);

    const raw = hasDetail ? rawDetail : rawMain;
    const fields = raw instanceof Map ? Object.fromEntries(raw) : (raw ?? {});

    return {
      selectors: { fields }, // Sub-tasks extract from the entire page, no item selector needed
      engine: parentTask.engine ?? "static",
      options: parentTask.options ?? {},
      proxy: parentTask.proxy ?? {},
    };
  }
}

const instance = new SubTaskService();
instance.intervalToCron = intervalToCron; // expose for controller
module.exports = instance;
