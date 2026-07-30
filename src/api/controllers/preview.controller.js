const staticEngine = require('../../core/parser/engines/static.engine');
const dynamicEngine = require('../../core/parser/engines/dynamic.engine');
const { extractAll, extractRecord } = require('../../core/parser/selector.service');
const parserService = require('../../core/parser/parser.service');
const proxyManager = require('../../core/proxy/proxy.manager');
const logger = require('../../utils/logger');

const MAX_PREVIEW_RECORDS = 20;

// /api/tasks/preview завжди виконується прямо в цьому процесі (app.js, 256MB heap) — на відміну
// від звичайних завдань, які йдуть через чергу в parser.worker. Без ліміту одночасних викликів
// паралельні (або щільно послідовні від зовнішніх cron-скриптів) preview-запити з engine=dynamic
// можуть накопичити кілька Chromium-інстансів у процесі API-сервера і завалити його по heap OOM.
const MAX_CONCURRENT_PREVIEWS = parseInt(process.env.MAX_CONCURRENT_PREVIEWS) || 2;
let activePreviewCount = 0;

/**
 * Одноразовий тестовий парсинг: URL + селектори -> значення полів.
 * Нічого не зберігає в БД (без Task/Run/Result).
 */
exports.preview = async (req, res, next) => {
  if (activePreviewCount >= MAX_CONCURRENT_PREVIEWS) {
    return res.status(503).json({
      success: false,
      message: 'Забагато одночасних тестових запитів, спробуйте за кілька секунд',
    });
  }
  activePreviewCount++;

  try {
    const { url, engine, selectors, proxy: proxyCfg, options } = req.body;

    let proxy = null;
    if (proxyCfg?.enabled) {
      proxy = proxyCfg.proxyId
        ? await proxyManager.getById(proxyCfg.proxyId)
        : await proxyManager.getNextProxy();
    }

    const fields = new Map(Object.entries(selectors.fields));
    const isDynamic = engine === 'dynamic';
    const fetchEngine = isDynamic ? dynamicEngine : staticEngine;

    const fetchOptions = {
      method: options.method,
      body: options.body?.data ? options.body : null,
      headers: options.headers,
      cookies: options.cookies,
      antiBot: options.antiBot,
      timeout: options.timeout,
      jsonPath: options.jsonPath,
      jsonHtmlField: options.jsonHtmlField,
      proxy,
      ...(isDynamic ? { standalone: true } : {}),
    };

    const { $, status, rawJsonItems } = await fetchEngine.fetchPage(url, fetchOptions);

    let data;
    if (rawJsonItems && !selectors.item) {
      data = parserService._extractJsonRecords(rawJsonItems, fields).slice(0, MAX_PREVIEW_RECORDS);
    } else if (selectors.item) {
      data = extractAll($, selectors.item, fields, url).slice(0, MAX_PREVIEW_RECORDS);
    } else {
      data = extractRecord($, $('body'), fields, url);
    }

    res.json({
      success: true,
      status,
      usedProxy: proxy ? { host: proxy.host, port: proxy.port } : null,
      count: Array.isArray(data) ? data.length : 1,
      data,
    });
  } catch (err) {
    logger.warn('Preview parse failed', { url: req.body?.url, error: err.message });
    next(err);
  } finally {
    activePreviewCount--;
  }
};
