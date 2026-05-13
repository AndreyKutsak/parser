const subtaskRepo = require("../../db/repositories/subtask.repository");
const subtaskScheduler = require("../../core/subtask/subtask.scheduler");
const subtaskService = require("../../core/subtask/subtask.service");
const exporterService = require("../../core/exporter/exporter.service");
const logger = require("../../utils/logger");

/**
 * @swagger
 * tags:
 *   name: Підзадачі
 *   description: Кінцеві точки для управління підзадачами (моніторинг окремих товарів)
 */

/** GET /api/tasks/:taskId/subtasks */
exports.list = async (req, res, next) => {
  try {
    const items = await subtaskRepo.findByParent(req.params.taskId);
    res.json({ success: true, items });
  } catch (err) {
    next(err);
  }
};

/** GET /api/tasks/:taskId/subtasks/:id */
exports.get = async (req, res, next) => {
  try {
    const item = await subtaskRepo.findById(req.params.id);
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "SubTask not found" });
    res.json({ success: true, item });
  } catch (err) {
    next(err);
  }
};

/** GET /api/tasks/:taskId/subtasks/:id/history */
exports.history = async (req, res, next) => {
  try {
    const item = await subtaskRepo.findById(req.params.id);
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "SubTask not found" });
    // Return history newest-first; data is null for unchanged runs (space-efficient)
    const history = [...(item.history ?? [])].reverse();
    res.json({
      success: true,
      history,
      totalRuns: item.totalRuns,
      changedRuns: item.changedRuns,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/tasks/:taskId/subtasks/:id
 * Body: { intervalMinutes?, cron?, enabled? }
 */
exports.update = async (req, res, next) => {
  try {
    const { intervalMinutes, cron, enabled } = req.body;
    const patch = {};

    if (enabled != null) patch["schedule.enabled"] = !!enabled;
    if (intervalMinutes != null)
      patch["schedule.intervalMinutes"] = Number(intervalMinutes);
    if (cron != null) patch["schedule.cron"] = cron || null;

    // Auto-generate cron from interval when no custom cron is provided
    if (intervalMinutes != null && cron == null) {
      const existing = await subtaskRepo.findById(req.params.id);
      if (!existing?.schedule?.cron) {
        patch["schedule.cron"] = subtaskService.intervalToCron(
          Number(intervalMinutes),
        );
      }
    }

    const item = await subtaskRepo.update(req.params.id, patch);
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "SubTask not found" });

    // Re-register cron job with updated schedule
    subtaskScheduler.scheduleSubTask(item);
    res.json({ success: true, item });
  } catch (err) {
    next(err);
  }
};

/** POST /api/tasks/:taskId/subtasks/:id/run */
exports.runNow = async (req, res, next) => {
  try {
    const result = await subtaskScheduler.runNow(req.params.id);
    res.json({ success: true, result });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/tasks/:taskId/subtasks/:id
 * Disables the sub-task (does not delete the doc — history is preserved).
 */
exports.disable = async (req, res, next) => {
  try {
    subtaskScheduler.unschedule(req.params.id);
    await subtaskRepo.update(req.params.id, { "schedule.enabled": false });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

/** GET /api/tasks/:taskId/subtasks/:id/export/json */
exports.exportJson = async (req, res, next) => {
  try {
    const item = await subtaskRepo.findById(req.params.id);
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "SubTask not found" });

    const history = (item.history ?? []).map((h) => ({
      parsedAt: h.parsedAt,
      duration: h.duration,
      changed: h.changed,
      error: h.error,
      ...h.data,
    }));

    const data = JSON.stringify(history, null, 2);
    res
      .set({
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="subtask-history-${req.params.id}.json"`,
      })
      .send(data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/tasks/:taskId/subtasks/:id/export/csv */
exports.exportCsv = async (req, res, next) => {
  try {
    const item = await subtaskRepo.findById(req.params.id);
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "SubTask not found" });

    const history = (item.history ?? []).map((h) => ({
      parsedAt: h.parsedAt,
      duration: h.duration,
      changed: h.changed,
      error: h.error,
      ...h.data,
    }));

    const data = await exporterService.historyToCsv(history);
    res
      .set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="subtask-history-${req.params.id}.csv"`,
      })
      .send("\uFEFF" + data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/tasks/:taskId/subtasks/:id/export/excel */
exports.exportExcel = async (req, res, next) => {
  try {
    const item = await subtaskRepo.findById(req.params.id);
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "SubTask not found" });

    const history = (item.history ?? []).map((h) => ({
      parsedAt: h.parsedAt,
      duration: h.duration,
      changed: h.changed,
      error: h.error,
      ...h.data,
    }));

    const buffer = await exporterService.historyToExcel(history, {
      subtaskUrl: item.url,
    });

    res
      .set({
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="subtask-history-${req.params.id}.xlsx"`,
      })
      .send(buffer);
  } catch (err) {
    next(err);
  }
};
