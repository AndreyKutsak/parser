const mongoose = require("mongoose");
const Result = require("../models/result.model");

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class ResultRepository {
  async findByTask(
    taskId,
    { runId, page = 1, limit = 100, status, changed, search, createdAtFrom, createdAtTo, skipCount = false } = {},
  ) {
    const filter = { taskId };
    if (runId && runId !== "undefined") filter.runId = runId;
    if (status && status !== "undefined") filter.status = status;
    if (changed === "true" || changed === true) {
      filter["fieldChanges.0"] = { $exists: true };
    }
    if (search && search !== "undefined") {
      const regex = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ url: regex }, { detailUrl: regex }, { runId: regex }];
    }
    if (createdAtFrom || createdAtTo) {
      filter.createdAt = {};
      if (createdAtFrom) filter.createdAt.$gte = new Date(createdAtFrom);
      if (createdAtTo) {
        const d = new Date(createdAtTo);
        d.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = d;
      }
    }

    const query = Result.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();

    if (skipCount) {
      const items = await query;
      return { items, total: null, page, pages: null };
    }

    const [items, total] = await Promise.all([query, Result.countDocuments(filter)]);
    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  async findAllByRun(taskId, runId, { status, changed, search, createdAtFrom, createdAtTo } = {}) {
    const result = await this.findByTask(taskId, {
      runId,
      status,
      changed,
      search,
      createdAtFrom,
      createdAtTo,
      page: 1,
      limit: 5000,
      skipCount: true,
    });
    return result.items;
  }

  /** Get distinct run IDs for a task, most recent first */
  async getRuns(taskId) {
    return Result.aggregate([
      {
        $match: {
          taskId: new mongoose.Types.ObjectId(taskId),
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$runId",
          createdAt: { $first: "$createdAt" },
          count: { $sum: 1 },
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: 50 },
    ]);
  }

  async insertMany(results) {
    if (!results.length) return [];
    return Result.insertMany(results, { ordered: false });
  }

  async deleteByTask(taskId) {
    return Result.deleteMany({ taskId });
  }

  async deleteByRun(taskId, runId) {
    return Result.deleteMany({ taskId, runId });
  }

  async deleteById(taskId, resultId) {
    return Result.deleteOne({ _id: resultId, taskId });
  }

  async countByTask(taskId) {
    return Result.countDocuments({ taskId });
  }

  async findLatestByUrl(taskId, detailUrl, excludeRunId = null) {
    const filter = { taskId, detailUrl };
    if (excludeRunId) filter.runId = { $ne: excludeRunId };
    return Result.findOne(filter).sort({ createdAt: -1 }).lean();
  }

  /** Find the most recent result for a given key field value (for category change tracking) */
  async findLatestByKeyField(taskId, keyField, keyValue, excludeRunId = null) {
    const filter = { taskId, [`data.${keyField}`]: keyValue };
    if (excludeRunId) filter.runId = { $ne: excludeRunId };
    return Result.findOne(filter).sort({ createdAt: -1 }).lean();
  }

  /** Find the most recent result at a given page+seq from a DIFFERENT run (positional fallback) */
  async findLatestBySeq(taskId, excludeRunId, page, seq) {
    return Result.findOne({ taskId, runId: { $ne: excludeRunId }, page, seq })
      .sort({ createdAt: -1 })
      .lean();
  }

  /**
   * Batch version of findLatestByUrl — one aggregate query instead of N individual ones.
   * Returns a Map<detailUrl, result>.
   */
  async findLatestByUrlBatch(taskId, detailUrls, excludeRunId) {
    if (!detailUrls.length) return new Map();
    const results = await Result.aggregate([
      { $match: { taskId: new mongoose.Types.ObjectId(taskId), detailUrl: { $in: detailUrls }, runId: { $ne: excludeRunId } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$detailUrl", doc: { $first: "$$ROOT" } } },
    ]);
    return new Map(results.map((r) => [r._id, r.doc]));
  }

  /**
   * Batch version of findLatestByKeyField — one aggregate query instead of N individual ones.
   * Returns a Map<keyValue(string), result>.
   */
  async findLatestByKeyFieldBatch(taskId, keyField, keyValues, excludeRunId) {
    if (!keyValues.length) return new Map();
    const results = await Result.aggregate([
      { $match: { taskId: new mongoose.Types.ObjectId(taskId), [`data.${keyField}`]: { $in: keyValues }, runId: { $ne: excludeRunId } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: `$data.${keyField}`, doc: { $first: "$$ROOT" } } },
    ]);
    return new Map(results.map((r) => [String(r._id), r.doc]));
  }

  /**
   * Batch version of findLatestBySeq — one aggregate query for all seq positions on a page.
   * Returns a Map<seq(number), result>.
   */
  async findByIds(taskId, ids) {
    const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
    return Result.find({ taskId, _id: { $in: objectIds } }).lean();
  }

  async setApiResponse(resultId, { response = null, error = null } = {}) {
    return Result.updateOne(
      { _id: resultId },
      { $set: { apiResponse: response, apiSentAt: new Date(), apiError: error } },
    );
  }

  async findLatestBySeqBatch(taskId, excludeRunId, page, seqs) {
    if (!seqs.length) return new Map();
    const results = await Result.aggregate([
      { $match: { taskId: new mongoose.Types.ObjectId(taskId), runId: { $ne: excludeRunId }, page, seq: { $in: seqs } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$seq", doc: { $first: "$$ROOT" } } },
    ]);
    return new Map(results.map((r) => [r._id, r.doc]));
  }
}

module.exports = new ResultRepository();
