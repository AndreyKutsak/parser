/**
 * Proxy Manager — handles proxy rotation, health tracking, and validation
 */
const proxyRepo = require("../../db/repositories/proxy.repository");
const { validateProxy, validateBatch, precheck } = require("./proxy.validator");
const logger = require("../../utils/logger");

class ProxyManager {
  constructor() {
    // In-memory cache for fast round-robin rotation
    this._activeProxies = [];
    this._index = 0;
    this._cacheExpiry = 0;
    this.CACHE_TTL = 60 * 1000; // 1 minute
    this._checkStatus = { running: false };
  }

  /**
   * Get the next active proxy using round-robin rotation.
   * Falls back to DB if cache is stale.
   */
  async getNextProxy() {
    await this._refreshCache();

    if (!this._activeProxies.length) {
      logger.warn("No active proxies available");
      return null;
    }

    const proxy = this._activeProxies[this._index % this._activeProxies.length];
    this._index++;

    // Update lastUsed asynchronously (don't block). Must NOT touch status/failCount —
    // this proxy hasn't actually been used yet, so it shouldn't look "verified healthy".
    proxyRepo.touchLastUsed(proxy._id).catch(() => {});

    return proxy;
  }

  async getById(id) {
    return proxyRepo.findById(id);
  }

  /**
   * Parse a proxy string "host:port[:username:password]" and create it in DB
   */
  async addProxy({
    host,
    port,
    protocol = "http",
    username,
    password,
    tags = [],
  }) {
    const proxy = await proxyRepo.create({
      host,
      port,
      protocol,
      username,
      password,
      tags,
    });
    this._invalidateCache();
    return proxy;
  }

  /**
   * Bulk import proxies from a newline-separated text
   * Supported formats:
   *   host:port
   *   protocol://host:port
   *   protocol://user:pass@host:port
   */
  async importFromText(text, defaults = {}) {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const parsed = [];
    const seen = new Set();
    let skipped = 0;

    for (const line of lines) {
      const proxy = this._parseLine(line, defaults);
      if (!proxy || !proxy.host || !proxy.port) {
        skipped++;
        continue;
      }
      const key = this._proxyKey(proxy);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      parsed.push(proxy);
    }

    if (!parsed.length) return { imported: 0, skipped };

    // Точний дедуп проти вже наявних у БД (host+port+protocol+username)
    const { items: existing } = await proxyRepo.findAll({ limit: 100000 });
    const existingKeys = new Set(existing.map((p) => this._proxyKey(p)));
    const toCreate = parsed.filter((p) => !existingKeys.has(this._proxyKey(p)));
    skipped += parsed.length - toCreate.length;

    if (!toCreate.length) return { imported: 0, skipped };

    await proxyRepo.bulkCreate(toCreate);
    this._invalidateCache();
    logger.info(`Imported ${toCreate.length} proxies, skipped ${skipped} duplicates`);
    return { imported: toCreate.length, skipped };
  }

  /** Ключ точного збігу проксі для дедупу: host+port+protocol+username */
  _proxyKey(p) {
    const host = String(p.host || "").trim().toLowerCase();
    const protocol = String(p.protocol || "http").trim().toLowerCase();
    const username = String(p.username || "").trim();
    return `${host}:${p.port}:${protocol}:${username}`;
  }

  _parseLine(line, defaults = {}) {
    try {
      // Try URL format: protocol://user:pass@host:port
      if (line.includes("://")) {
        const url = new URL(line);
        return {
          protocol: url.protocol.replace(":", ""),
          host: url.hostname,
          port: parseInt(url.port) || 8080,
          username: url.username || defaults.username,
          password: url.password || defaults.password,
          ...defaults,
        };
      }

      // Simple: host:port[:user:pass]
      const parts = line.split(":");
      if (parts.length < 2) return null;
      return {
        protocol: defaults.protocol || "http",
        host: parts[0],
        port: parseInt(parts[1]),
        username: parts[2] || defaults.username,
        password: parts[3] || defaults.password,
        ...defaults,
      };
    } catch {
      return null;
    }
  }

  /** Стан поточної/останньої масової перевірки (для UI і щоб не запускати дві одночасно). */
  getCheckStatus() {
    return { ...this._checkStatus };
  }

  async _saveCheckResult(proxy, result) {
    if (result.ok) {
      await proxyRepo.recordCheckSuccess(proxy._id, {
        responseTime: result.responseTime,
        country: result.country,
        exitIp: result.ip,
        transparent: result.transparent,
        protocol: result.protocol,
      });
    } else {
      await proxyRepo.recordCheckFailure(proxy._id, result.error);
    }
  }

  /**
   * Перевірити всі проксі (включно з inactive/banned — вони можуть ожити) і оновити статуси.
   * @param {string} trigger - 'manual' | 'schedule'
   * Повторний виклик під час перевірки не запускає другу — повертає поточний стан.
   */
  async checkAll(trigger = "manual") {
    if (this._checkStatus.running) return { alreadyRunning: true, ...this.getCheckStatus() };

    this._checkStatus = { running: true, trigger, startedAt: new Date(), finishedAt: null, total: 0, done: 0, ok: 0, bad: 0, transparent: 0, error: null };
    const st = this._checkStatus;

    try {
      // Якщо сервіс перевірки недоступний напряму — не перевіряємо, інакше всі проксі
      // отримали б failCount++ через чужий збій і після кількох запусків — ban.
      let serverIp;
      try {
        serverIp = await precheck();
      } catch (err) {
        throw new Error(`Сервіс перевірки недоступний, перевірку скасовано: ${err.message}`);
      }

      const { items: proxies } = await proxyRepo.findAll({ limit: 100000 });
      st.total = proxies.length;
      logger.info(`Checking ${proxies.length} proxies...`, { trigger });

      await validateBatch(
        proxies,
        async (proxy, result) => {
          st.done++;
          if (result.ok) st.ok++;
          else st.bad++;
          if (result.transparent) st.transparent++;
          await this._saveCheckResult(proxy, result);
        },
        { serverIp },
      );

      logger.info("Proxy check complete", { trigger, ok: st.ok, bad: st.bad, transparent: st.transparent, total: st.total, durationMs: Date.now() - st.startedAt });
      return { ok: st.ok, bad: st.bad, transparent: st.transparent, total: st.total };
    } catch (err) {
      st.error = err.message;
      logger.error("Proxy check failed", { trigger, error: err.message });
      throw err;
    } finally {
      st.running = false;
      st.finishedAt = new Date();
      this._invalidateCache();
    }
  }

  /**
   * Test a single proxy by ID and return detailed results
   */
  async checkById(id) {
    const proxy = await proxyRepo.findById(id);
    if (!proxy) throw new Error("Proxy not found");

    const serverIp = await precheck().catch(() => null);
    const result = await validateProxy(proxy, { serverIp });
    await this._saveCheckResult(proxy, result);
    this._invalidateCache();
    const updatedProxy = await proxyRepo.findById(id);
    return { proxy: updatedProxy, ...result };
  }

  async recordFailure(id) {
    await proxyRepo.recordFailure(id);
    this._invalidateCache(); // invalidate cache so bad proxy is not returned
  }

  /**
   * Delete a single proxy by ID
   */
  async removeProxy(id) {
    const result = await proxyRepo.delete(id);
    if (!result) throw new Error("Proxy not found");
    this._invalidateCache();
    logger.info(`Proxy ${id} deleted`);
    return result;
  }

  /**
   * Delete multiple proxies by IDs
   */
  async removeMultiple(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error("IDs must be a non-empty array");
    }

    const deleted = [];
    for (const id of ids) {
      try {
        await proxyRepo.delete(id);
        deleted.push(id);
      } catch (err) {
        logger.warn(`Failed to delete proxy ${id}:`, err.message);
      }
    }

    this._invalidateCache();
    logger.info(`Deleted ${deleted.length} proxies`);
    return { deleted: deleted.length, total: ids.length };
  }

  async resetErrors() {
    const result = await proxyRepo.resetErrors();
    this._invalidateCache();
    logger.info("Proxy errors reset", result);
    return result;
  }

  async deleteDead() {
    if (this._checkStatus.running) throw Object.assign(new Error("Дочекайтесь завершення перевірки"), { statusCode: 409 });
    const result = await proxyRepo.deleteDead();
    this._invalidateCache();
    logger.info("Dead proxies deleted", result);
    return result;
  }

  async getStats() {
    const { items } = await proxyRepo.findAll({ limit: 10000 });
    const byStatus = items.reduce((acc, p) => {
      acc[p.status] = (acc[p.status] || 0) + 1;
      return acc;
    }, {});
    const avgResponse =
      items
        .filter((p) => p.responseTime)
        .reduce((sum, p) => sum + p.responseTime, 0) /
      (items.filter((p) => p.responseTime).length || 1);

    return {
      total: items.length,
      byStatus,
      avgResponseTime: Math.round(avgResponse),
    };
  }

  _invalidateCache() {
    this._cacheExpiry = 0;
  }

  async _refreshCache() {
    if (Date.now() < this._cacheExpiry) return;
    const { items } = await proxyRepo.findAll({ status: "active" });
    // Filter out proxies with too many failures and transparent ones (вони розкривають IP сервера —
    // від блокувань не захищають)
    this._activeProxies = items.filter((proxy) => (proxy.failCount || 0) < 3 && !proxy.transparent);
    this._index = 0;
    this._cacheExpiry = Date.now() + this.CACHE_TTL;
  }
}

module.exports = new ProxyManager();
