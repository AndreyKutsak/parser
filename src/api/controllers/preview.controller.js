const staticEngine = require('../../core/parser/engines/static.engine');
const dynamicEngine = require('../../core/parser/engines/dynamic.engine');
const { extractAll, extractRecord } = require('../../core/parser/selector.service');
const parserService = require('../../core/parser/parser.service');
const proxyManager = require('../../core/proxy/proxy.manager');
const siteAuthService = require('../../core/site-auth/site-auth.service');
const logger = require('../../utils/logger');

const MAX_PREVIEW_RECORDS = 20;

// Якщо після завантаження фінальний URL відрізняється від запитаного і схожий на
// сторінку входу — сайт, найімовірніше, мовчки перенаправив неавторизований запит
// (типово повертає 200, тож самого статус-коду для виявлення недостатньо).
const LOGIN_PATH_HINTS = ['login', 'signin', 'sign-in', 'log-in', 'sso'];
const looksLikeLoginRedirect = (originalUrl, finalUrl) => {
  if (!finalUrl || finalUrl === originalUrl) return false;
  try {
    const orig = new URL(originalUrl);
    const final = new URL(finalUrl);
    if (orig.host === final.host && orig.pathname === final.pathname) return false;
    const finalPath = final.pathname.toLowerCase();
    const origPath = orig.pathname.toLowerCase();
    return LOGIN_PATH_HINTS.some((h) => finalPath.includes(h)) && !LOGIN_PATH_HINTS.some((h) => origPath.includes(h));
  } catch {
    return false;
  }
};

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
  const startedAt = Date.now();

  try {
    const { url, engine, selectors, proxy: proxyCfg, siteAuth: siteAuthId, options } = req.body;
    const fieldNames = Object.keys(selectors.fields);

    logger.info('Preview parse: запит отримано', { url, engine, itemSelector: selectors.item || null, fields: fieldNames, siteAuth: siteAuthId || null });

    let proxy = null;
    if (proxyCfg?.enabled) {
      proxy = proxyCfg.proxyId
        ? await proxyManager.getById(proxyCfg.proxyId)
        : await proxyManager.getNextProxy();
    }

    // Reuse cookies from a saved SiteAuth (same mechanism real task runs use), combined
    // with any manually supplied cookies — lets the preview endpoint test login-protected sites.
    let cookies = options.cookies;
    if (siteAuthId) {
      try {
        const authCookies = await siteAuthService.getCookies(siteAuthId);
        if (authCookies) {
          cookies = cookies ? `${authCookies}; ${cookies}` : authCookies;
          logger.info('Preview parse: використано збережену авторизацію (siteAuth)', { url, siteAuth: siteAuthId });
        } else {
          logger.warn('Preview parse: siteAuth не має збережених cookies — спочатку виконайте авторизацію', { siteAuth: siteAuthId });
        }
      } catch (err) {
        logger.warn('Preview parse: не вдалося завантажити cookies siteAuth', { siteAuth: siteAuthId, error: err.message });
      }
    }

    const fields = new Map(Object.entries(selectors.fields));
    const isDynamic = engine === 'dynamic';
    const fetchEngine = isDynamic ? dynamicEngine : staticEngine;

    const fetchOptions = {
      method: options.method,
      body: options.body?.data ? options.body : null,
      headers: options.headers,
      cookies,
      antiBot: options.antiBot,
      timeout: options.timeout,
      jsonPath: options.jsonPath,
      jsonHtmlField: options.jsonHtmlField,
      proxy,
      ...(isDynamic ? { standalone: true } : {}),
    };

    const { $, status, rawJsonItems, finalUrl } = await fetchEngine.fetchPage(url, fetchOptions);
    logger.info('Preview parse: сторінку завантажено', { url, status, engine, finalUrl });

    // 401/403 signal auth failure directly; a 200 that silently redirected to a login
    // page is the more common real-world case and needs the finalUrl heuristic instead.
    const isAuthFailure = status === 401 || status === 403;
    const isLoginRedirect = !isAuthFailure && looksLikeLoginRedirect(url, finalUrl);

    if (isAuthFailure || isLoginRedirect) {
      const hint = siteAuthId
        ? 'Збережені cookies для цього siteAuth недійсні або протерміновані — повторіть авторизацію.'
        : 'Вкажіть siteAuth (збережену авторизацію) або options.cookies.';
      const message = isAuthFailure
        ? `Сайт повернув HTTP ${status} — потрібна авторизація. ${hint}`
        : `Сайт перенаправив запит на сторінку входу (${finalUrl}) — сесія відсутня або недійсна. ${hint}`;

      logger.warn('Preview parse: потрібна авторизація', { url, status, finalUrl, siteAuth: siteAuthId || null, message });

      return res.status(401).json({
        success: false,
        status,
        authRequired: true,
        finalUrl,
        usedSiteAuth: siteAuthId || null,
        message,
      });
    }

    let matchedItems = null;
    let data;
    if (rawJsonItems && !selectors.item) {
      data = parserService._extractJsonRecords(rawJsonItems, fields).slice(0, MAX_PREVIEW_RECORDS);
    } else if (selectors.item) {
      matchedItems = $(selectors.item).length;
      data = extractAll($, selectors.item, fields, url).slice(0, MAX_PREVIEW_RECORDS);
    } else {
      data = extractRecord($, $('body'), fields, url);
    }

    const emptyFieldNames = Array.isArray(data)
      ? []
      : fieldNames.filter((name) => {
          const v = data[name];
          return v === null || v === '' || (Array.isArray(v) && v.length === 0);
        });
    const isEmpty = Array.isArray(data) ? data.length === 0 : emptyFieldNames.length === fieldNames.length;

    if (isEmpty) {
      let message;
      if (selectors.item && matchedItems === 0) {
        message = `Селектор елемента "${selectors.item}" не знайшов жодного вузла на сторінці`;
      } else if (selectors.item) {
        message = `Селектор елемента "${selectors.item}" знайшов ${matchedItems} вузол(-лів), але жодне поле (${fieldNames.join(', ')}) не отримало значення — перевірте селектори полів`;
      } else {
        message = `Жодного значення не отримано за заданими селекторами полів: ${emptyFieldNames.join(', ')}`;
      }

      logger.warn('Preview parse: селектори нічого не знайшли', {
        url, engine, status, itemSelector: selectors.item || null, matchedItems, emptyFieldNames, message,
      });

      return res.status(422).json({
        success: false,
        status,
        usedProxy: proxy ? { host: proxy.host, port: proxy.port } : null,
        message,
        emptyFields: emptyFieldNames,
        data: Array.isArray(data) ? [] : data,
      });
    }

    logger.info('Preview parse: успішно', {
      url, engine, status, count: Array.isArray(data) ? data.length : 1, durationMs: Date.now() - startedAt,
    });

    res.json({
      success: true,
      status,
      usedProxy: proxy ? { host: proxy.host, port: proxy.port } : null,
      count: Array.isArray(data) ? data.length : 1,
      data,
    });
  } catch (err) {
    logger.warn('Preview parse: помилка', { url: req.body?.url, error: err.message });
    next(err);
  } finally {
    activePreviewCount--;
  }
};
