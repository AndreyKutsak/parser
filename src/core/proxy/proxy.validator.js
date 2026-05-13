/**
 * Proxy Validator — tests whether a proxy is alive, measures response time, and detects country
 */
const axios = require("axios");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const logger = require("../../utils/logger");

const CHECK_URL = process.env.PROXY_CHECK_URL || "https://httpbin.org/ip";
const GEO_URL = process.env.GEO_CHECK_URL || "https://ip-api.com/json";
const TIMEOUT = 30000;
const GEO_TIMEOUT = 10000;

// Simple country code cache to avoid excessive API calls
const geoCache = new Map();
const GEO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

const buildAgent = (proxy) => {
  const { protocol, host, port, username, password } = proxy;
  const auth = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : "";
  const url = `${protocol}://${auth}${host}:${port}`;

  if (protocol.startsWith("socks")) return new SocksProxyAgent(url);
  if (protocol === "https") return new HttpsProxyAgent(url);
  return new HttpProxyAgent(url);
};

/**
 * Detect country by IP address via geo API
 */
const detectCountry = async (ip) => {
  if (!ip) return null;

  // Check cache first
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.timestamp < GEO_CACHE_TTL) {
    return cached.country;
  }

  try {
    const response = await axios.get(`${GEO_URL}?query=${ip}`, {
      timeout: GEO_TIMEOUT,
      validateStatus: () => true,
    });

    if (response.status === 200 && response.data?.countryCode) {
      const country = response.data.countryCode;
      geoCache.set(ip, { country, timestamp: Date.now() });
      return country;
    }
  } catch (err) {
    logger.debug("GEO lookup failed", { ip, error: err.message });
  }
  return null;
};

/**
 * Test a single proxy
 * @param {object} proxy  - { host, port, protocol, username, password }
 * @returns {{
 *   ok: boolean,
 *   responseTime: number,
 *   ip: string|null,
 *   country: string|null,
 *   protocol: string,
 *   error: string|null
 * }}
 */
const validateProxy = async (proxy) => {
  const agent = buildAgent(proxy);
  const start = Date.now();

  try {
    const response = await axios.get(CHECK_URL, {
      timeout: TIMEOUT,
      httpAgent: agent,
      httpsAgent: agent,
      validateStatus: () => true,
    });

    const responseTime = Date.now() - start;

    if (response.status !== 200) {
      return {
        ok: false,
        responseTime,
        ip: null,
        country: null,
        protocol: proxy.protocol,
        error: `HTTP ${response.status}`,
      };
    }

    const ip = response.data?.origin ?? response.data?.ip ?? null;

    // Detect country asynchronously (don't block on this)
    let country = null;
    if (ip) {
      country = await detectCountry(ip).catch(() => null);
    }

    logger.debug("Proxy OK", {
      proxy: `${proxy.host}:${proxy.port}`,
      protocol: proxy.protocol,
      responseTime,
      ip,
      country,
    });
    return {
      ok: true,
      responseTime,
      ip,
      country: country || null,
      protocol: proxy.protocol,
      error: null,
    };
  } catch (err) {
    logger.debug("Proxy FAIL", {
      proxy: `${proxy.host}:${proxy.port}`,
      protocol: proxy.protocol,
      error: err.message,
    });
    return {
      ok: false,
      responseTime: Date.now() - start,
      ip: null,
      country: null,
      protocol: proxy.protocol,
      error: err.message,
    };
  }
};

/**
 * Validate a list of proxies concurrently (max 10 at a time)
 * @param {Array}   proxies
 * @param {Function} onResult  - callback(proxy, result)
 * @returns {Array<{ proxy, result }>}
 */
const validateBatch = async (proxies, onResult) => {
  const CONCURRENCY = 10;
  const results = [];

  for (let i = 0; i < proxies.length; i += CONCURRENCY) {
    const batch = proxies.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (proxy) => {
        const result = await validateProxy(proxy);
        if (onResult) onResult(proxy, result);
        return { proxy, result };
      }),
    );
    results.push(...batchResults);
  }

  return results;
};

module.exports = { validateProxy, validateBatch };
