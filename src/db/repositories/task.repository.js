const Task = require('../models/task.model');

class TaskRepository {
  async findAll({ owner, status, page = 1, limit = 20 } = {}) {
    const filter = {};
    if (owner)  filter.owner  = owner;
    if (status) filter.status = status;

    const [items, total] = await Promise.all([
      Task.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Task.countDocuments(filter),
    ]);

    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  async findById(id) {
    return Task.findById(id).lean();
  }

  async findByIds(ids) {
    return Task.find({ _id: { $in: ids } }, 'status').lean();
  }

  async create(data) {
    return Task.create(data);
  }

  async update(id, data) {
    return Task.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true });
  }

  async delete(id) {
    return Task.findByIdAndDelete(id);
  }

  async updateStatus(id, status, extra = {}) {
    return Task.findByIdAndUpdate(id, { $set: { status, ...extra } }, { new: true });
  }

  async updateStats(id, stats) {
    return Task.findByIdAndUpdate(id, { $set: { stats } }, { new: true });
  }

  /** Find tasks that are scheduled and due to run */
  async findByDomain(domain) {
    const re = new RegExp(domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return Task.find({
      $or: [{ url: re }, { 'requests.url': re }],
    }).lean();
  }

  async getAllDomains() {
    const tasks = await Task.find({}, { url: 1, requests: 1, name: 1 }).lean();
    const domainMap = new Map();
    for (const t of tasks) {
      const urls = [t.url, ...(t.requests || []).map((r) => r.url)].filter(Boolean);
      for (const u of urls) {
        try {
          const host = new URL(u).hostname;
          if (!host) continue;
          if (!domainMap.has(host)) domainMap.set(host, { domain: host, taskCount: 0, taskNames: [] });
          const entry = domainMap.get(host);
          entry.taskCount++;
          entry.taskNames.push(t.name);
        } catch {}
      }
    }
    return [...domainMap.values()].sort((a, b) => b.taskCount - a.taskCount);
  }

  async findDueTasks() {
    return Task.find({
      'schedule.enabled': true,
      'schedule.nextRun': { $lte: new Date() },
      status: { $nin: ['running'] },
    }).lean();
  }

  async findStuckRunning(inactivityThreshold) {
    return Task.find({
      status: 'running',
      $or: [
        { 'stats.lastActivity': { $lt: inactivityThreshold } },
        { 'stats.lastActivity': { $exists: false }, 'schedule.lastRun': { $lt: inactivityThreshold } },
      ],
    }).lean();
  }
}

module.exports = new TaskRepository();
