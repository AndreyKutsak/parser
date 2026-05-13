const Proxy = require("../models/proxy.model");

class ProxyRepository {
  async findAll({ status, protocol, page = 1, limit = 50 } = {}) {
    const filter = {};
    if (status) filter.status = status;
    if (protocol) filter.protocol = protocol;

    const [items, total] = await Promise.all([
      Proxy.find(filter)
        .sort({ lastUsed: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Proxy.countDocuments(filter),
    ]);

    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  async findById(id) {
    return Proxy.findById(id).lean();
  }

  /** Get next available proxy for rotation (round-robin by lastUsed) */
  async getNextActive() {
    return Proxy.findOneAndUpdate(
      { status: "active" },
      { $set: { lastUsed: new Date() } },
      { sort: { lastUsed: 1 }, new: true },
    ).lean();
  }

  async create(data) {
    return Proxy.create(data);
  }

  async bulkCreate(proxyList) {
    return Proxy.insertMany(proxyList, { ordered: false });
  }

  async update(id, data) {
    return Proxy.findByIdAndUpdate(id, { $set: data }, { new: true });
  }

  async delete(id) {
    return Proxy.findByIdAndDelete(id);
  }

  async deleteMultiple(ids) {
    return Proxy.deleteMany({ _id: { $in: ids } });
  }

  async markBanned(id) {
    return Proxy.findByIdAndUpdate(id, {
      $set: { status: "banned" },
      $inc: { failCount: 1 },
    });
  }

  async recordSuccess(id, responseTime, extraData = {}) {
    return Proxy.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "active",
          lastUsed: new Date(),
          responseTime,
          lastChecked: new Date(),
          failCount: 0,
          ...extraData,
        },
        $inc: { useCount: 1 },
      },
      { new: true },
    );
  }

  async recordFailure(id, errorMsg = null) {
    const proxy = await Proxy.findByIdAndUpdate(
      id,
      {
        $inc: { failCount: 1 },
        $set: { lastChecked: new Date() },
      },
      { new: true },
    );

    // Ban proxy if fail count too high (5+ failures)
    if (proxy && proxy.failCount >= 5) {
      await Proxy.findByIdAndUpdate(id, {
        $set: { status: "banned" },
      });
    }
    return proxy;
  }

  async getActiveCount() {
    return Proxy.countDocuments({ status: "active" });
  }
}

module.exports = new ProxyRepository();
