const Proxy = require("../models/proxy.model");

class ProxyRepository {
  async findAll({ status, protocol, kind, page = 1, limit = 50 } = {}) {
    const filter = {};
    if (status) filter.status = status;
    if (protocol) filter.protocol = protocol;
    if (kind === "vpn") filter.kind = "vpn";
    else if (kind === "proxy") filter.kind = { $ne: "vpn" }; // старі записи без kind — це проксі

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

  /**
   * Результат планової/ручної перевірки (не реального використання):
   * не чіпає useCount/lastUsed, щоб не спотворювати ротацію і статистику.
   */
  async recordCheckSuccess(id, { responseTime, country, exitIp, transparent, protocol }) {
    return Proxy.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "active",
          responseTime,
          lastChecked: new Date(),
          failCount: 0,
          exitIp,
          transparent: !!transparent,
          ...(country ? { country } : {}),
          ...(protocol ? { protocol } : {}), // https→http, якщо автовизначення показало, що це http-проксі
        },
        $unset: { lastError: "" },
      },
      { new: true },
    );
  }

  /**
   * Невдала перевірка: проксі виключається з ротації (inactive), після 5 поспіль невдач — banned.
   * Наступна успішна перевірка повертає його в active.
   */
  async recordCheckFailure(id, errorMsg) {
    const proxy = await Proxy.findByIdAndUpdate(
      id,
      {
        $inc: { failCount: 1 },
        $set: { lastChecked: new Date(), lastError: String(errorMsg || "").slice(0, 300) },
      },
      { new: true },
    );
    if (proxy) {
      const status = proxy.failCount >= 5 ? "banned" : "inactive";
      if (proxy.status !== status) await Proxy.findByIdAndUpdate(id, { $set: { status } });
    }
    return proxy;
  }

  /**
   * Скинути накопичені помилки: failCount=0, прибрати lastError, banned → inactive
   * (у ротацію не потрапляють до наступної успішної перевірки, але знову мають 5 спроб до бану).
   */
  async resetErrors() {
    const [counters, unbanned] = await Promise.all([
      Proxy.updateMany({}, { $set: { failCount: 0 }, $unset: { lastError: "" } }),
      Proxy.updateMany({ status: "banned" }, { $set: { status: "inactive" } }),
    ]);
    return { reset: counters.modifiedCount, unbanned: unbanned.modifiedCount };
  }

  /** Видалити всі неробочі проксі (inactive + banned). VPN не чіпаємо — їх видаляють лише вручну. */
  async deleteDead() {
    const { deletedCount } = await Proxy.deleteMany({ status: { $in: ["inactive", "banned"] }, kind: { $ne: "vpn" } });
    return { deleted: deletedCount };
  }

  // ── VPN (WireGuard / OpenVPN) ───────────────────────────────────────────

  /** Усі VPN разом із конфігом і паролем (для vpn.daemon). */
  async findVpnsWithConfig() {
    return Proxy.find({ kind: "vpn" }).select("+wgConfig +ovpnConfig +vpnPassword").lean();
  }

  /** OpenVPN-записи за адресами «хост:порт» (для повторного імпорту без дублів). */
  async findOpenVpnByEndpoints(endpoints) {
    return Proxy.find({ kind: "vpn", vpnType: "openvpn", vpnEndpoint: { $in: endpoints } }).lean();
  }

  /** Вільний локальний порт для SOCKS5 нового VPN (діапазон 41001–41999). */
  async nextFreeVpnPort() {
    const used = new Set((await Proxy.find({ kind: "vpn" }, { port: 1 }).lean()).map((p) => p.port));
    for (let port = 41001; port <= 41999; port++) if (!used.has(port)) return port;
    throw new Error("Немає вільних портів для VPN");
  }

  async setVpnState(id, { vpnStatus, vpnError = null, vpnStartedAt }) {
    const $set = { vpnStatus };
    if (vpnStartedAt) $set.vpnStartedAt = vpnStartedAt;
    const update = vpnError ? { $set: { ...$set, vpnError: String(vpnError).slice(0, 300) } } : { $set, $unset: { vpnError: "" } };
    return Proxy.updateOne({ _id: id }, update);
  }

  async getActiveCount() {
    return Proxy.countDocuments({ status: "active" });
  }

  /** Оновити lastUsed для round-robin ротації, не чіпаючи статус/лічильник помилок */
  async touchLastUsed(id) {
    return Proxy.findByIdAndUpdate(id, { $set: { lastUsed: new Date() } });
  }
}

module.exports = new ProxyRepository();
