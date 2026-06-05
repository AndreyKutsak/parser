/**
 * Динамічний рушій — завантажує сторінки через Puppeteer з повним виконанням JavaScript.
 *
 * Підходить для:
 *   - SPA (React, Vue, Angular)
 *   - Сторінок з нескінченним прокручуванням (infinite scroll)
 *   - Ресурсів із захистом від ботів (Cloudflare, Distil)
 *   - Будь-яких сторінок, де контент рендериться на клієнті
 *
 * Підтримує GET і POST-запити (POST реалізується через перехоплення навігаційного запиту).
 *
 * Для встановлення: npm install puppeteer
 */
const cheerio = require('cheerio');
const { applyStealthPatches, simulateHumanBehaviour, getRandomUserAgent } = require('../../../utils/anti-bot');
const logger = require('../../../utils/logger');

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  logger.warn('Puppeteer не встановлено — динамічний рушій вимкнено. Виконайте: npm install puppeteer');
}

/**
 * Запускає браузер Puppeteer з опціональним проксі.
 */
const launchBrowser = async (proxy = null) => {
  if (!puppeteer) throw new Error('Puppeteer не встановлено');

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

  if (proxy) {
    const auth = proxy.username ? `${proxy.username}:${proxy.password}@` : '';
    args.push(`--proxy-server=${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`);
  }

  const launchOpts = {
    headless: process.env.PUPPETEER_HEADLESS !== 'false',
    args,
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return puppeteer.launch(launchOpts);
};

// ── Browser pool ──────────────────────────────────────────────────────────────
// Кожен унікальний проксі отримує один довгоживучий браузер.
// fetchPage відкриває/закриває лише сторінку — не браузер.
// Це зменшує пікове споживання пам'яті з N*400MB до ~1-2 браузери.
const activeBrowsers = new Map();  // proxyKey → Browser
const pendingLaunches = new Map(); // proxyKey → Promise<Browser>

const _proxyKey = (proxy) =>
  proxy ? `${proxy.protocol}://${proxy.host}:${proxy.port}` : '__none__';

const _getBrowser = async (proxy) => {
  const key = _proxyKey(proxy);

  const existing = activeBrowsers.get(key);
  if (existing?.isConnected()) return existing;

  // Serialize concurrent launches for the same proxy key.
  // Without this, two parallel fetchPage calls would both see no active browser
  // and both call launchBrowser — the second result overwrites the first in the Map,
  // leaving an orphaned Chromium process that is never closed (memory/process leak).
  const pending = pendingLaunches.get(key);
  if (pending) return pending;

  const launch = launchBrowser(proxy)
    .then(browser => {
      activeBrowsers.set(key, browser);
      browser.on('disconnected', () => activeBrowsers.delete(key));
      return browser;
    })
    .finally(() => pendingLaunches.delete(key));

  pendingLaunches.set(key, launch);
  return launch;
};

/**
 * Закриває всі активні браузери (викликати при SIGTERM воркера).
 */
const closeAll = async () => {
  const entries = [...activeBrowsers.values()];
  activeBrowsers.clear();
  pendingLaunches.clear();
  await Promise.allSettled(entries.map(b => b.close()));
};

/**
 * Формує тіло POST-запиту та Content-Type для перехоплення запиту Puppeteer.
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
 * Завантажує сторінку через Puppeteer і повертає cheerio-інстанс після виконання JS.
 *
 * POST-запит реалізується через `page.setRequestInterception`: перший навігаційний
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
  } = options;

  // Беремо браузер з пулу (або запускаємо новий для цього проксі),
  // але закриваємо лише сторінку — браузер живе далі.
  const browser = await _getBrowser(proxy);
  const page = await browser.newPage();

  try {
    await page.setDefaultNavigationTimeout(timeout);
    await page.setDefaultTimeout(timeout);
    await page.setUserAgent(getRandomUserAgent());
    await page.setExtraHTTPHeaders(headers);

    if (antiBot) {
      await applyStealthPatches(page);
    }

    if (cookies) {
      const cookieList = cookies.split(';').map(c => {
        const [name, value] = c.trim().split('=');
        return { name: name.trim(), value: (value || '').trim(), url };
      });
      await page.setCookie(...cookieList);
    }

    let response;
    const isPost = method.toUpperCase() === 'POST';
    const needsInterception = blockResources || isPost;

    if (needsInterception) {
      await page.setRequestInterception(true);
      const { postData, contentType } = isPost ? buildPostBody(body) : {};
      let intercepted = false;

      page.on('request', (req) => {
        if (blockResources && BLOCK_RESOURCE_TYPES.has(req.resourceType())) {
          req.abort();
          return;
        }
        if (isPost && !intercepted && req.url() === url) {
          intercepted = true;
          req.continue({
            method: 'POST',
            postData,
            headers: { ...req.headers(), 'Content-Type': contentType },
          });
          return;
        }
        req.continue();
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

    return { $, status: response?.status() };
  } finally {
    await page.close(); // закриваємо лише вкладку, браузер залишається живим
  }
};

/**
 * Автоматично прокручує сторінку до самого низу невеликими кроками.
 * Використовується для завантаження lazy-load контенту та infinite scroll.
 *
 * @param {Page} page - Екземпляр сторінки Puppeteer
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
