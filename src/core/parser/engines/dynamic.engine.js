/**
 * Динамічний рушій — завантажує сторінки через Playwright (Chromium Headless Shell)
 * з повним виконанням JavaScript.
 *
 * Підходить для:
 *   - SPA (React, Vue, Angular)
 *   - Сторінок з нескінченним прокручуванням (infinite scroll)
 *   - Ресурсів із захистом від ботів (Cloudflare, Distil)
 *   - Будь-яких сторінок, де контент рендериться на клієнті
 *
 * Підтримує GET і POST-запити (POST реалізується через перехоплення навігаційного запиту).
 *
 * Chromium Headless Shell — урізана headless-only збірка Chromium (без частини UI-компонентів
 * звичайного браузера), помітно менший відбиток пам'яті за повний Chromium — важливо на
 * пам'яттю-обмежених хостах.
 *
 * Для встановлення: npm install playwright && npx playwright install --with-deps chromium-headless-shell
 */
const cheerio = require('cheerio');
const { applyStealthPatches, simulateHumanBehaviour, getRandomUserAgent } = require('../../../utils/anti-bot');
const logger = require('../../../utils/logger');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  logger.warn('Playwright не встановлено — динамічний рушій вимкнено. Виконайте: npm install playwright');
}

/**
 * Запускає браузер Playwright (chromium-headless-shell) з опціональним проксі.
 */
const launchBrowser = async (proxy = null) => {
  if (!chromium) throw new Error('Playwright не встановлено');

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--disable-notifications',
    '--no-first-run',
    '--no-zygote',
    '--mute-audio',
  ];

  const launchOpts = {
    headless: process.env.PUPPETEER_HEADLESS !== 'false',
    args,
    channel: 'chromium-headless-shell',
    ignoreDefaultArgs: ['--enable-automation'],
  };

  if (proxy) {
    launchOpts.proxy = {
      server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
      username: proxy.username || undefined,
      password: proxy.password || undefined,
    };
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return chromium.launch(launchOpts);
};

// ── Browser pool ──────────────────────────────────────────────────────────────
// Кожен унікальний проксі отримує один довгоживучий браузер.
// fetchPage відкриває/закриває лише сторінку — не браузер.
// Це зменшує пікове споживання пам'яті з N*400MB до ~1-2 браузери.
const activeBrowsers = new Map();  // proxyKey → Browser
const pendingLaunches = new Map(); // proxyKey → Promise<Browser>
const browserLastUsed = new Map(); // proxyKey → timestamp (ms)

// Browsers idle longer than this are proactively closed to free RAM.
const BROWSER_IDLE_MS = parseInt(process.env.BROWSER_IDLE_MS) || 5 * 60 * 1000; // 5 min

const _proxyKey = (proxy) =>
  proxy ? `${proxy.protocol}://${proxy.host}:${proxy.port}` : '__none__';

const _getBrowser = async (proxy) => {
  const key = _proxyKey(proxy);

  const existing = activeBrowsers.get(key);
  if (existing?.isConnected()) {
    browserLastUsed.set(key, Date.now());
    return existing;
  }

  // Serialize concurrent launches for the same proxy key.
  // Without this, two parallel fetchPage calls would both see no active browser
  // and both call launchBrowser — the second result overwrites the first in the Map,
  // leaving an orphaned Chromium process that is never closed (memory/process leak).
  const pending = pendingLaunches.get(key);
  if (pending) return pending;

  const launch = launchBrowser(proxy)
    .then(browser => {
      activeBrowsers.set(key, browser);
      browserLastUsed.set(key, Date.now());
      browser.on('disconnected', () => {
        activeBrowsers.delete(key);
        browserLastUsed.delete(key);
      });
      return browser;
    })
    .finally(() => pendingLaunches.delete(key));

  pendingLaunches.set(key, launch);
  return launch;
};

// Periodically close browsers that have been idle for BROWSER_IDLE_MS.
const _idleCleanupInterval = setInterval(async () => {
  const now = Date.now();
  for (const [key, browser] of activeBrowsers) {
    const lastUsed = browserLastUsed.get(key) ?? 0;
    if (now - lastUsed > BROWSER_IDLE_MS) {
      activeBrowsers.delete(key);
      browserLastUsed.delete(key);
      browser.close().catch(() => {});
      logger.debug('Closed idle browser', { proxyKey: key, idleMs: now - lastUsed });
    }
  }
}, 60_000);
_idleCleanupInterval.unref(); // don't prevent process from exiting

/**
 * Закриває всі активні браузери (викликати при SIGTERM воркера).
 */
const closeAll = async () => {
  clearInterval(_idleCleanupInterval);
  const entries = [...activeBrowsers.values()];
  activeBrowsers.clear();
  pendingLaunches.clear();
  browserLastUsed.clear();
  await Promise.allSettled(entries.map(b => b.close()));
};

/**
 * Формує тіло POST-запиту та Content-Type для перехоплення запиту Playwright.
 *
 * @param {object|null} body        - Конфігурація тіла
 * @param {string}      body.format - Формат: 'json' | 'form' | 'raw'
 * @param {*}           body.data   - Дані
 * @returns {{ postData: string, contentType: string }}
 */
const buildPostBody = (body) => {
  if (!body?.data) return { postData: '', contentType: 'application/json' };

  switch (body.format) {
    case 'form': {
      const params = new URLSearchParams(
        typeof body.data === 'object'
          ? body.data
          : Object.fromEntries(new URLSearchParams(body.data))
      );
      return { postData: params.toString(), contentType: 'application/x-www-form-urlencoded' };
    }
    case 'raw':
      return { postData: String(body.data), contentType: 'text/plain' };
    case 'json':
    default:
      return {
        postData: typeof body.data === 'string' ? body.data : JSON.stringify(body.data),
        contentType: 'application/json',
      };
  }
};

/**
 * Завантажує сторінку через Playwright і повертає cheerio-інстанс після виконання JS.
 *
 * POST-запит реалізується через `page.route`: перший навігаційний
 * запит до цільового URL перехоплюється і замінюється POST із вказаним тілом.
 *
 * @param {string}  url                     - Цільовий URL
 * @param {object}  [options={}]             - Параметри запиту
 * @param {number}  [options.timeout]        - Таймаут навігації в мс (default: 30000 або PUPPETEER_TIMEOUT)
 * @param {object}  [options.proxy]          - Конфігурація проксі
 * @param {object}  [options.headers]        - Додаткові HTTP-заголовки
 * @param {string}  [options.cookies]        - Cookie-рядок "key=value; key2=value2"
 * @param {boolean} [options.antiBot]        - Застосувати stealth-патчі та імітацію поведінки
 * @param {string}  [options.waitFor]        - CSS-селектор, якого чекати перед витяганням HTML
 * @param {boolean} [options.scrollToBottom] - Прокрутити сторінку вниз для lazy-load контенту
 * @param {string}  [options.method]         - HTTP-метод: 'GET' | 'POST' (default: 'GET')
 * @param {object}  [options.body]           - Тіло POST-запиту { format, data }
 * @returns {Promise<{ $: CheerioAPI, html: string, status: number }>}
 */
// Resource types to block by default — images/fonts/media are never needed for scraping
const BLOCK_RESOURCE_TYPES = new Set(['image', 'imageset', 'font', 'media', 'texttrack', 'manifest']);

const fetchPage = async (url, options = {}) => {
  const {
    timeout        = parseInt(process.env.PUPPETEER_TIMEOUT) || 30000,
    proxy          = null,
    headers        = {},
    cookies        = null,
    antiBot        = true,
    waitFor        = null,
    scrollToBottom = false,
    method         = 'GET',
    body           = null,
    blockResources = true,
    // Одноразові виклики (напр. /api/tasks/preview) не повинні лишати браузер у довгоживучому
    // пулі процесу, що їх викликав — у API-процесі (app.js) пул призначений тільки для воркера,
    // і накопичення чужих браузерів там же відкриває шлях до heap OOM.
    standalone     = false,
  } = options;

  // Беремо браузер з пулу (або запускаємо новий для цього проксі),
  // але закриваємо лише контекст/сторінку — браузер живе далі.
  // UA та заголовки в Playwright задаються на рівні контексту, а не сторінки,
  // тому кожен fetchPage створює власний короткоживучий контекст.
  const browser = standalone ? await launchBrowser(proxy) : await _getBrowser(proxy);
  const context = await browser.newContext({
    userAgent: getRandomUserAgent(),
    extraHTTPHeaders: headers,
  });

  try {
    context.setDefaultNavigationTimeout(timeout);
    context.setDefaultTimeout(timeout);
    const page = await context.newPage();

    if (antiBot) {
      await applyStealthPatches(page);
    }

    if (cookies) {
      const cookieList = cookies.split(';').map(c => {
        const [name, value] = c.trim().split('=');
        return { name: name.trim(), value: (value || '').trim(), url };
      });
      await context.addCookies(cookieList);
    }

    let response;
    const isPost = method.toUpperCase() === 'POST';
    const needsInterception = blockResources || isPost;

    if (needsInterception) {
      const { postData, contentType } = isPost ? buildPostBody(body) : {};
      let intercepted = false;

      await page.route('**/*', (route) => {
        const req = route.request();
        if (blockResources && BLOCK_RESOURCE_TYPES.has(req.resourceType())) {
          return route.abort();
        }
        if (isPost && !intercepted && req.url() === url) {
          intercepted = true;
          return route.continue({
            method: 'POST',
            postData,
            headers: { ...req.headers(), 'Content-Type': contentType },
          });
        }
        return route.continue();
      });
    }

    // domcontentloaded is faster and uses less memory than networkidle2
    const waitUntil = options.waitUntil || 'domcontentloaded';
    response = await page.goto(url, { waitUntil, timeout });

    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 10000 }).catch(() => {});
    }

    if (scrollToBottom) {
      await autoScroll(page);
    }

    if (antiBot) {
      await simulateHumanBehaviour(page);
    }

    const html = await page.content();
    const $ = cheerio.load(html, { decodeEntities: true });

    logger.debug('Динамічний запит', { url, method, status: response?.status() });

    return { $, status: response?.status(), finalUrl: page.url() };
  } finally {
    // Swallow close errors — if the browser crashed the context is already gone,
    // and letting this throw would mask the real error from the caller.
    await context.close().catch(e => logger.warn('context.close failed', { url, error: e.message }));
    // standalone browsers aren't pooled — nothing else will ever close them.
    if (standalone) await browser.close().catch(e => logger.warn('standalone browser.close failed', { url, error: e.message }));
  }
};

/**
 * Автоматично прокручує сторінку до самого низу невеликими кроками.
 * Використовується для завантаження lazy-load контенту та infinite scroll.
 *
 * @param {Page} page - Екземпляр сторінки Playwright
 * @returns {Promise<void>}
 */
const autoScroll = async (page) => {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const dist = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, dist);
        total += dist;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
  // Чекаємо завантаження нового контенту після прокрутки
  await new Promise(r => setTimeout(r, 1000));
};

module.exports = { fetchPage, launchBrowser, closeAll };
