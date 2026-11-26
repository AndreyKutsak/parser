/**
 * Proxy Validator — tests whether a proxy is alive, measures response time, and detects country
 */
const axios = require("axios");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const logger = require("../../utils/logger");

const CHECK_URL = process.env.PROXY_CHECK_URL || "https://httpbin.org/ip";
// Безкоштовний ip-api працює ЛИШЕ по HTTP — https://ip-api.com повертає 403 "SSL unavailable",
// через що раніше країна не визначалась у жодного проксі.
const GEO_URL = process.env.GEO_CHECK_URL || "http://ip-api.com/json";
const TIMEOUT = parseInt(process.env.PROXY_CHECK_TIMEOUT) || 15000;
const GEO_TIMEOUT = 10000;
const CONCURRENCY = parseInt(process.env.PROXY_CHECK_CONCURRENCY) || 20;

// Simple country code cache to avoid excessive API calls
const geoCache = new Map();
const GEO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Агенти для axios. Для HTTPS-цілі через HTTP(S)-проксі потрібен HttpsProxyAgent (тунель CONNECT);
 * раніше для https://httpbin.org використовувався HttpProxyAgent, що не відповідає тому,
 * як проксі реально використовується при парсингу HTTPS-сайтів.
 */
const buildAgents = (proxy) => {
  const { protocol, host, port, username, password } = proxy;
  const auth = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password || "")}@`
    : "";
  // OpenVPN-тунель: ім'я сайту резолвить сам SOCKS-сервер через тунель (socks5h). Інакше агент резолвив би
  // локально й міг передати IPv6-адресу, якої в тунелі VPN Gate немає.
  const scheme = proxy.vpnType === "openvpn" ? "socks5h" : protocol;
  const url = `${scheme}://${auth}${host}:${port}`;

  if (protocol.startsWith("socks")) {
    const agent = new SocksProxyAgent(url);
    return { httpAgent: agent, httpsAgent: agent };
  }
  return { httpAgent: new HttpProxyAgent(url), httpsAgent: new HttpsProxyAgent(url) };
};

const extractIp = (data) => {
  const raw = data?.origin ?? data?.ip ?? null;
  return raw ? String(raw).split(",").map((s) => s.trim()) : [];
};

/**
 * Detect country by IP address via geo API
 */
const detectCountry = async (ip) => {
  if (!ip) return null;

  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.timestamp < GEO_CACHE_TTL) {
    return cached.country;
  }

  try {
    const response = await axios.get(`${GEO_URL}/${encodeURIComponent(ip)}?fields=status,countryCode`, {
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
 * Перевірка перед масовою перевіркою: чи доступний сам CHECK_URL без проксі.
 * Якщо ні — всі проксі виглядали б "мертвими" і масово отримали б ban через збій httpbin.
 * Повертає IP нашого сервера (щоб відрізняти прозорі проксі, які його розкривають).
 */
const precheck = async () => {
  const response = await axios.get(CHECK_URL, { timeout: TIMEOUT, validateStatus: () => true });
  if (response.status !== 200) throw new Error(`${CHECK_URL} повернув HTTP ${response.status}`);
  const [serverIp] = extractIp(response.data);
  if (!serverIp) throw new Error(`${CHECK_URL} не повернув IP`);
  return serverIp;
};

/**
 * Test a single proxy
 * @param {object} proxy  - { host, port, protocol, username, password }
 * @param {object} [ctx]  - { serverIp } — якщо IP сервера видно у відповіді, проксі прозорий
 * @returns {{ ok, responseTime, ip, country, protocol, transparent, error }}
 */
const validateProxy = async (proxy, ctx = {}) => {
  const result = await validateOnce(proxy, ctx);
  // У списках безкоштовних проксі "HTTPS" зазвичай означає "підтримує CONNECT", а не TLS до самого
  // проксі. Якщо TLS-рукостискання з проксі не вдалось — пробуємо як звичайний http-проксі.
  if (!result.ok && proxy.protocol === "https" && /EPROTO|wrong version number|SSL routines/i.test(result.error || "")) {
    const asHttp = await validateOnce({ ...proxy, protocol: "http" }, ctx);
    if (asHttp.ok) return asHttp; // protocol: 'http' — збережеться в БД
  }
  return result;
};

const validateOnce = async (proxy, ctx = {}) => {
  const start = Date.now();
  const fail = (error) => ({
    ok: false,
    responseTime: Date.now() - start,
    ip: null,
    country: null,
    protocol: proxy.protocol,
    transparent: false,
    error,
  });

  const agents = buildAgents(proxy);
  let hardTimer;
  try {
    // Агенти проксі ігнорують axios timeout на етапі з'єднання — без жорсткого таймауту одна
    // "мовчазна" адреса могла підвісити всю масову перевірку назавжди.
    const response = await Promise.race([
      axios.get(CHECK_URL, {
        timeout: TIMEOUT,
        ...agents,
        proxy: false, // не дати axios підхопити HTTP(S)_PROXY з оточення поверх агента
        validateStatus: () => true,
        maxContentLength: 1024 * 1024,
      }),
      new Promise((_, reject) => {
        hardTimer = setTimeout(() => reject(Object.assign(new Error(`Timeout ${TIMEOUT}ms`), { code: "TIMEOUT" })), TIMEOUT + 1000);
      }),
    ]);

    const responseTime = Date.now() - start;
    if (response.status !== 200) return fail(`HTTP ${response.status}`);

    const ips = extractIp(response.data);
    // Деякі "проксі" повертають власну сторінку (captive portal, заглушка) зі статусом 200
    if (!ips.length) return fail("Некоректна відповідь (немає IP) — проксі підміняє відповідь");

    // Прозорий проксі: передає наш реальний IP (X-Forwarded-For) — сайт бачить сервер, а не проксі
    const transparent = !!ctx.serverIp && ips.includes(ctx.serverIp);
    const ip = ips.find((x) => x !== ctx.serverIp) || ips[0];
    const country = await detectCountry(ip).catch(() => null);

    logger.debug("Proxy OK", { proxy: `${proxy.host}:${proxy.port}`, responseTime, ip, country, transparent });
    return { ok: true, responseTime, ip, country, protocol: proxy.protocol, transparent, error: null };
  } catch (err) {
    logger.debug("Proxy FAIL", { proxy: `${proxy.host}:${proxy.port}`, error: err.message });
    const msg = err.message.split("\n")[0];
    return fail(err.code && !msg.startsWith(err.code) ? `${err.code}: ${msg}` : msg);
  } finally {
    clearTimeout(hardTimer);
    // Закрити сокети агента, щоб завислі з'єднання не накопичувались
    agents.httpAgent?.destroy?.();
    if (agents.httpsAgent !== agents.httpAgent) agents.httpsAgent?.destroy?.();
  }
};

const SITE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BLOCK_RE = /captcha|cf-chl|cloudflare|access denied|доступ заборонено|are you a robot|too many requests/i;

/** Один GET на сайт (через проксі або напряму, якщо proxy=null). */
const fetchSiteOnce = async (url, proxy) => {
  const start = Date.now();
  const agents = proxy ? buildAgents(proxy) : {};
  let hardTimer;
  try {
    const response = await Promise.race([
      axios.get(url, {
        timeout: TIMEOUT,
        ...agents,
        proxy: false,
        responseType: "text",
        maxContentLength: 5 * 1024 * 1024,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: { "User-Agent": SITE_UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8", "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.8" },
      }),
      new Promise((_, reject) => {
        hardTimer = setTimeout(() => reject(new Error(`Timeout ${TIMEOUT}ms`)), TIMEOUT + 1000);
      }),
    ]);
    const body = typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "");
    const title = (body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 150);
    const blocked = response.status === 403 || response.status === 429 || BLOCK_RE.test(title) || (body.length < 20000 && BLOCK_RE.test(body));
    return {
      ok: response.status >= 200 && response.status < 400 && !blocked,
      status: response.status,
      responseTime: Date.now() - start,
      bytes: Buffer.byteLength(body),
      title,
      blocked,
      error: null,
    };
  } catch (err) {
    const msg = err.message.split("\n")[0];
    return { ok: false, status: null, responseTime: Date.now() - start, bytes: 0, title: "", blocked: false, error: err.code && !msg.startsWith(err.code) ? `${err.code}: ${msg}` : msg };
  } finally {
    clearTimeout(hardTimer);
    agents.httpAgent?.destroy?.();
    if (agents.httpsAgent !== agents.httpAgent) agents.httpsAgent?.destroy?.();
  }
};

/**
 * Перевірка проксі/VPN на конкретному сайті: запит через проксі і (для порівняння) напряму з сервера.
 * @returns {{ url, via: object, direct: object }}
 */
const checkSite = async (proxy, url) => {
  const [via, direct] = await Promise.all([fetchSiteOnce(url, proxy), fetchSiteOnce(url, null)]);
  return { url, via, direct };
};

/**
 * Validate a list of proxies with a fixed-size worker pool (не чекаємо найповільніший у пачці).
 * @param {Array}    proxies
 * @param {Function} onResult  - async callback(proxy, result)
 * @param {object}   [ctx]     - передається у validateProxy
 * @returns {Array<{ proxy, result }>}
 */
const validateBatch = async (proxies, onResult, ctx = {}) => {
  const results = [];
  let next = 0;

  const worker = async () => {
    while (next < proxies.length) {
      const proxy = proxies[next++];
      const result = await validateProxy(proxy, ctx);
      if (onResult) {
        try {
          await onResult(proxy, result);
        } catch (err) {
          logger.warn("Proxy check: не вдалося зберегти результат", { proxy: `${proxy.host}:${proxy.port}`, error: err.message });
        }
      }
      results.push({ proxy, result });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, proxies.length) }, worker));
  return results;
};

module.exports = { validateProxy, validateBatch, precheck, checkSite };
