const SubTask = require('../models/subtask.model');

const HISTORY_LIMIT = 100;

class SubTaskRepository {
  findByParent(parentTaskId) {
    return SubTask.find({ parentTaskId }).sort({ createdAt: -1 }).lean();
  }

  findById(id) {
    return SubTask.findById(id, '-history').lean();
  }

  findByUrl(parentTaskId, url) {
    return SubTask.findOne({ parentTaskId, url }).lean();
  }

  /** Load multiple sub-tasks by URL list — used for export join */
  findByUrls(parentTaskId, urls) {
    return SubTask.find({ parentTaskId, url: { $in: urls } }).lean();
  }

  /** Sub-tasks whose nextRun is due and are not currently running.
   *  Excludes heavy `history` array — not needed for scheduling. */
  findDue(limit = 200) {
    return SubTask.find({
      'schedule.enabled': true,
      'schedule.nextRun': { $lte: new Date() },
      status: { $ne: 'running' },
    }, '-history').limit(limit).lean();
  }

  /** Atomically claim a sub-task for execution.
   *  Returns the updated doc only if status was NOT already 'running'.
   *  Prevents double-execution when tick and per-task cron fire simultaneously. */
  claimForRun(id) {
    return SubTask.findOneAndUpdate(
      { _id: id, status: { $ne: 'running' } },
      { $set: { status: 'running' } },
      { new: true, projection: '-history' },
    ).lean();
  }

  create(data) {
    return SubTask.create(data);
  }

  update(id, data) {
    return SubTask.findByIdAndUpdate(id, { $set: data }, { new: true });
  }

  updateStatus(id, status, extra = {}) {
    return SubTask.findByIdAndUpdate(id, { $set: { status, ...extra } }, { new: true });
  }

  /** Append a history entry, keeping only the last HISTORY_LIMIT entries */
  appendHistory(id, entry) {
    return SubTask.findByIdAndUpdate(id, {
      $push: { history: { $each: [entry], $slice: -HISTORY_LIMIT } },
    });
  }

  /**
   * Find-or-create a sub-task for (parentTaskId, url).
   * Defaults are only applied on INSERT — existing docs are never overwritten here.
   */
  upsertByUrl(parentTaskId, url, defaults) {
    return SubTask.findOneAndUpdate(
      { parentTaskId, url },
      { $setOnInsert: { parentTaskId, url, ...defaults } },
      { upsert: true, new: true, lean: true },
    );
  }

  /** All subtasks that are currently running or scheduled for future runs */
  findActive() {
    return SubTask.find({
      $or: [
        { status: 'running' },
        { 'schedule.enabled': true },
      ],
    }).sort({ 'schedule.nextRun': 1 }).lean();
  }

  deleteByParent(parentTaskId) {
    return SubTask.deleteMany({ parentTaskId });
  }
}

module.exports = new SubTaskRepository();
