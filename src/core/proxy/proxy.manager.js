/**
 * Proxy Manager — handles proxy rotation, health tracking, and validation
 */
const proxyRepo = require("../../db/repositories/proxy.repository");
const { validateProxy, validateBatch } = require("./proxy.validator");
const logger = require("../../utils/logger");

class ProxyManager {
  constructor() {
    // In-memory cache for fast round-robin rotation
    this._activeProxies = [];
    this._index = 0;
    this._cacheExpiry = 0;
    this.CACHE_TTL = 60 * 1000; // 1 minute
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

    // Update lastUsed asynchronously (don't block)
    proxyRepo.recordSuccess(proxy._id, 0).catch(() => {});

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

    for (const line of lines) {
      const proxy = this._parseLine(line, defaults);
      if (proxy) parsed.push(proxy);
    }

    if (!parsed.length) return { imported: 0 };

    await proxyRepo.bulkCreate(parsed);
    this._invalidateCache();
    logger.info(`Imported ${parsed.length} proxies`);
    return { imported: parsed.length };
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

  /**
   * Test all active proxies and update their status in DB
   */
  async checkAll() {
    const { items: proxies } = await proxyRepo.findAll({ limit: 10000 }); // перевіряємо всі, включно з banned
    logger.info(`Checking ${proxies.length} proxies...`);

    const results = await validateBatch(proxies, async (proxy, result) => {
      if (result.ok) {
        await proxyRepo.recordSuccess(proxy._id, result.responseTime, {
          country: result.country,
          protocol: result.protocol,
        });
      } else {
        await proxyRepo.recordFailure(proxy._id, result.error);
      }
    });

    const ok = results.filter((r) => r.result.ok).length;
    const bad = results.length - ok;
    this._invalidateCache();

    logger.info("Proxy check complete", { ok, bad, total: results.length });
    return { ok, bad, total: results.length };
  }

  /**
   * Test a single proxy by ID and return detailed results
   */
  async checkById(id) {
    const proxy = await proxyRepo.findById(id);
    if (!proxy) throw new Error("Proxy not found");

    const result = await validateProxy(proxy);
    if (result.ok) {
      await proxyRepo.recordSuccess(id, result.responseTime, {
        country: result.country,
        protocol: result.protocol,
      });
    } else {
      await proxyRepo.recordFailure(id, result.error);
    }
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
    // Filter out proxies with too many failures
    this._activeProxies = items.filter((proxy) => (proxy.failCount || 0) < 3);
    this._index = 0;
    this._cacheExpiry = Date.now() + this.CACHE_TTL;
  }
}

module.exports = new ProxyManager();
