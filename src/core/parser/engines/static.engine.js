/**
 * Статичний рушій — завантажує сторінки через axios і парсить HTML через cheerio.
 *
 * Підходить для:
 *   - Класичних серверних сторінок (SSR)
 *   - REST/HTML API
 *   - Будь-яких ресурсів, що не потребують виконання JavaScript
 *
 * Підтримує GET і POST-запити з форматами тіла: json, form, raw.
 */
const http = require('http');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { buildHeaders } = require('../../../utils/anti-bot');
const { resolveJsonPath, flattenJsonItem } = require('../../../utils/json-utils');
const logger = require('../../../utils/logger');

// Persistent keep-alive pools for direct (non-proxy) requests — avoids TCP+TLS handshake on every page
const keepAliveHttpAgent  = new http.Agent ({ keepAlive: true, maxSockets: 10, maxFreeSockets: 5, timeout: 60000 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 5, timeout: 60000 });

// Proxy agent cache — avoid re-creating socket-level objects on every request.
// Capped at 500 entries; oldest entry evicted when full (LRU-lite).
const proxyAgentCache = new Map();
const PROXY_CACHE_MAX = 500;

/**
 * Створює проксі-агент на основі конфігурації.
 *
 * @param {object|null} proxy            - Об'єкт конфігурації проксі
 * @param {string}      proxy.protocol   - Протокол: http | https | socks4 | socks5
 * @param {string}      proxy.host       - Хост проксі-сервера
 * @param {number}      proxy.port       - Порт проксі-сервера
 * @param {string}      [proxy.username] - Логін (необов'язково)
 * @param {string}      [proxy.password] - Пароль (необов'язково)
 * @returns {object|null} Агент для axios або null
 */
const buildProxyAgent = (proxy) => {
  if (!proxy) return null;
  const { protocol, host, port, username, password } = proxy;
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
  const proxyUrl = `${protocol}://${auth}${host}:${port}`;

  const cached = proxyAgentCache.get(proxyUrl);
  if (cached) return cached;

  if (proxyAgentCache.size >= PROXY_CACHE_MAX) {
    proxyAgentCache.delete(proxyAgentCache.keys().next().value);
  }

  let agent;
  if (protocol.startsWith('socks')) agent = new SocksProxyAgent(proxyUrl);
  else if (protocol === 'https') agent = new HttpsProxyAgent(proxyUrl);
  else agent = new HttpProxyAgent(proxyUrl);

  proxyAgentCache.set(proxyUrl, agent);
  return agent;
};

/**
 * Формує тіло запиту та відповідний заголовок Content-Type.
 *
 * Формати:
 *   - json → серіалізує об'єкт через JSON.stringify, Content-Type: application/json
 *   - form → кодує через URLSearchParams,      Content-Type: application/x-www-form-urlencoded
 *   - raw  → передає рядок як є,              Content-Type: text/plain
 *
 * @param {object|null} body         - Об'єкт тіла з полями format і data
 * @param {string}      body.format  - Формат: 'json' | 'form' | 'raw'
 * @param {*}           body.data    - Дані для відправки
 * @returns {{ payload: *, contentType: string|null }}
 */
const buildBody = (body) => {
  if (!body?.data) return { payload: undefined, contentType: null };

  switch (body.format) {
    case 'form': {
      const params = new URLSearchParams(
        typeof body.data === 'object'
          ? body.data
          : Object.fromEntries(new URLSearchParams(body.data))
      );
      return { payload: params.toString(), contentType: 'application/x-www-form-urlencoded' };
    }
    case 'raw':
      return { payload: String(body.data), contentType: 'text/plain' };
    case 'json':
    default:
      return {
        payload: typeof body.data === 'string' ? body.data : JSON.stringify(body.data),
        contentType: 'application/json',
      };
  }
};

/**
 * Завантажує сторінку за заданим URL і повертає cheerio-інстанс для парсингу.
 *
 * @param {string} url                - Цільовий URL
 * @param {object} [options={}]       - Параметри запиту
 * @param {object} [options.headers]  - Додаткові HTTP-заголовки
 * @param {number} [options.timeout]  - Таймаут у мс (default: 30000)
 * @param {object} [options.proxy]    - Конфігурація проксі
 * @param {string} [options.cookies]  - Cookie-рядок у форматі "key=value; key2=value2"
 * @param {boolean}[options.antiBot]  - Додавати реалістичні заголовки та User-Agent
 * @param {string} [options.method]   - HTTP-метод: 'GET' | 'POST' (default: 'GET')
 * @param {object} [options.body]     - Тіло POST-запиту { format, data }
 * @returns {Promise<{ $: CheerioAPI, html: string, status: number, duration: number }>}
 */
const fetchPage = async (url, options = {}) => {
  const {
    headers      = {},
    timeout      = 30000,
    proxy        = null,
    cookies      = null,
    antiBot      = true,
    method       = 'GET',
    body         = null,
    jsonHtmlField = null, // якщо відповідь JSON — витягти HTML з цього поля
    jsonPath      = null, // шлях до масиву у JSON-відповіді: "data.models"
  } = options;

  const { payload, contentType } = buildBody(body);

  const extraHeaders = {
    ...(cookies     ? { Cookie: cookies }               : {}),
    ...(contentType ? { 'Content-Type': contentType }   : {}),
  };

  const mergedHeaders = antiBot
    ? buildHeaders({ ...headers, ...extraHeaders })
    : { ...headers, ...extraHeaders };

  const agent = buildProxyAgent(proxy);
  const axiosConfig = {
    method: method.toLowerCase(),
    timeout,
    headers: mergedHeaders,
    responseType: 'text',
    maxRedirects: 5,
    maxContentLength: 10 * 1024 * 1024, // 10MB — відмовляємось від гігантських сторінок
    maxBodyLength: 10 * 1024 * 1024,
    validateStatus: (s) => s < 500, // не кидати помилку на 4xx
    ...(payload !== undefined ? { data: payload } : {}),
  };

  if (agent) {
    axiosConfig.httpAgent  = agent;
    axiosConfig.httpsAgent = agent;
    // Force socket destruction on timeout (proxy agents ignore axios timeout)
    axiosConfig.transport = undefined;
  } else {
    axiosConfig.httpAgent  = keepAliveHttpAgent;
    axiosConfig.httpsAgent = keepAliveHttpsAgent;
  }

  const start = Date.now();
  let _backupTimer;
  const timeoutPromise = new Promise((_, reject) => {
    _backupTimer = setTimeout(() => reject(new Error(`Request timeout after ${timeout}ms`)), timeout + 2000);
  });
  let response;
  try {
    response = await Promise.race([axios(url, axiosConfig), timeoutPromise]);
  } finally {
    clearTimeout(_backupTimer);
  }
  const duration = Date.now() - start;

  logger.debug('Статичний запит', { url, method, status: response.status, duration });

  let htmlContent = response.data;
  let rawJsonItems = null; // повертається для прямого JSON-режиму

  if (jsonPath) {
    try {
      const json = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

      // Підтримка кореневого масиву: jsonPath = "." або "" або "$"
      let items;
      const trimmedPath = (jsonPath || '').trim();
      if (!trimmedPath || trimmedPath === '.' || trimmedPath === '$') {
        items = Array.isArray(json) ? json : [json];
      } else {
        const resolved = resolveJsonPath(json, trimmedPath);
        items = Array.isArray(resolved) ? resolved : (resolved != null ? [resolved] : []);
      }

      rawJsonItems = items; // для прямого JSON-режиму (без itemSelector)

      // HTML bridge: розгортаємо вкладені об'єкти з underscore-ключами для CSS
      const sc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      const toClass = (name) => String(name).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^(\d)/, '_$1');
      htmlContent = '<div id="json-root">' + items.map((item) => {
        const flat = flattenJsonItem(typeof item === 'object' && item !== null ? item : { value: item });
        const spans = Object.entries(flat).map(([k, v]) =>
          `<span class="${toClass(k)}">${sc(v)}</span>`
        ).join('');
        return `<div class="json-item">${spans}</div>`;
      }).join('') + '</div>';
    } catch { /* не JSON — парсимо як HTML */ }
  } else if (jsonHtmlField) {
    try {
      const json = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      if (json[jsonHtmlField]) htmlContent = json[jsonHtmlField];
    } catch { /* не JSON — парсимо як HTML */ }
  }

  const $ = cheerio.load(htmlContent, { decodeEntities: true });
  return { $, status: response.status, duration, rawJsonItems };
};

module.exports = { fetchPage };
