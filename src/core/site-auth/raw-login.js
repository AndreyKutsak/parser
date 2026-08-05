/**
 * Пряма HTTP-авторизація на сайті конкурента (форма логін/пароль -> POST -> cookies).
 *
 * Виконується ЦІЛКОМ на цьому сервері (тим самим клієнтом/IP, що потім і скрейпить сторінки
 * товарів через static/dynamic engine). Раніше логін робив зовнішній PHP-сервер (baza.m-p.in.ua)
 * окремим curl-запитом зі своєї IP, а фактичний запит сторінки товару виконував цей мікросервіс
 * з ІНШОЇ інфраструктури. Діагностика показала, що для частини сайтів (напр. sm-opt.com,
 * ricambiexpress.com) це на практиці "з'їдало" переважну більшість запитів (сайт мовчки
 * повертав гостьову версію сторінки або редіректив на /login попри валідну cookie), хоча сама
 * cookie при повторному використанні ТИМ САМИМ клієнтом, що логінився, лишалась робочою будь-як
 * довго (перевірено прямим відтворенням). Тепер логін і подальший фетч походять з одного місця.
 */
const axios = require('axios');
const https = require('https');
const { buildHeaders } = require('../../utils/anti-bot');

const FIXED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Сайти конкурентів часто мають кульгаві/самопідписані сертифікати або застарілі ланцюжки —
// попередня curl-реалізація так само вимкнено перевіряла (CURLOPT_SSL_VERIFYPEER=false).
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const MAX_REDIRECTS = 8;

const mergeCookies = (jar, setCookieHeaders) => {
  if (!setCookieHeaders) return;
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const raw of arr) {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
};

const jarToHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

// Автопідстановка прихованих полів форми (CSRF-токен тощо) — генерується сервером на кожне
// завантаження сторінки логіну і одноразовий, в конфігу його не зберегти.
const extractHiddenFields = (html) => {
  const hidden = {};
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/type\s*=\s*["']hidden["']/i.test(tag)) continue;
    const nameMatch = tag.match(/name\s*=\s*["']([^"']*)["']/i);
    if (!nameMatch) continue;
    const valueMatch = tag.match(/value\s*=\s*["']([^"']*)["']/i);
    hidden[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
  }
  return hidden;
};

const commonHeaders = () => buildHeaders({ 'User-Agent': FIXED_UA });

/**
 * Один HTTP-запит БЕЗ автоматичного слідування за редіректом (axios/follow-redirects інакше не
 * переносить Set-Cookie між хопами — на відміну від curl з активним cookie-jar, — а частина
 * сайтів (класичний osCommerce: login.php -> cookie_usage.php -> назад) саме перевіряє, чи
 * дійшла cookie до наступного хопу, і без ручного мерджу тут зациклюється).
 */
const rawRequest = (method, url, { jar, extraHeaders = {}, data, contentType }) =>
  axios.request({
    method,
    url,
    data,
    headers: {
      ...commonHeaders(),
      Cookie: jarToHeader(jar),
      ...(contentType ? { 'Content-Type': contentType } : {}),
      ...extraHeaders,
    },
    maxRedirects: 0,
    validateStatus: () => true,
    timeout: 30000,
    httpsAgent: insecureAgent,
  });

/**
 * GET з ручним слідуванням за редіректами, зливаючи cookies на кожному хопі.
 */
const followGet = async (url, jar, extraHeaders = {}) => {
  let currentUrl = url;
  let resp;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    resp = await rawRequest('get', currentUrl, { jar, extraHeaders });
    mergeCookies(jar, resp.headers['set-cookie']);
    if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
      currentUrl = new URL(resp.headers.location, currentUrl).toString();
      continue;
    }
    break;
  }
  return { resp, finalUrl: currentUrl };
};

/**
 * @param {string} url             - URL форми логіну (куди відправляється POST/GET)
 * @param {string} method          - 'GET' | 'POST'
 * @param {Array<{name:string,value?:string}>} fields - поля форми
 * @param {string} [successPattern] - текст, що має з'явитись на сторінці ЛИШЕ після реального успішного входу
 * @returns {Promise<{success:boolean, cookies?:string, message?:string, httpCode?:number}>}
 */
const rawLogin = async (url, method, fields, successPattern = '') => {
  const jar = new Map();
  const postFields = {};
  for (const f of fields || []) {
    if (!f?.name) continue;
    postFields[f.name] = f.value ?? '';
  }

  const baseUrl = url.split('?')[0];

  // Крок 1: звичайний GET на сторінку логіну — сесійні cookies і, за потреби, CSRF-токен
  const { resp: getResp, finalUrl: loginPageUrl } = await followGet(baseUrl, jar);

  const hidden = extractHiddenFields(String(getResp.data || ''));
  for (const name of Object.keys(postFields)) {
    if (postFields[name] === '' && hidden[name] !== undefined) postFields[name] = hidden[name];
  }

  const urlObj = new URL(url);
  const origin = `${urlObj.protocol}//${urlObj.host}`;

  // Крок 2: сам логін. Автоматичний редірект не гнатись напряму на цьому кроці — на деяких
  // сайтах бот-захист блокує саме редірект після POST, якщо на ньому лишаються POST-специфічні
  // заголовки (Origin); переходимо туди окремо нижче.
  let loginResp;
  if (String(method).toUpperCase() === 'GET') {
    const sep = url.includes('?') ? '&' : '?';
    loginResp = await rawRequest('get', url + sep + new URLSearchParams(postFields).toString(), { jar });
  } else {
    loginResp = await rawRequest('post', url, {
      jar,
      data: new URLSearchParams(postFields).toString(),
      contentType: 'application/x-www-form-urlencoded',
      extraHeaders: { Origin: origin, Referer: loginPageUrl },
    });
  }
  mergeCookies(jar, loginResp.headers['set-cookie']);

  // Логін завершився редіректом (типова поведінка при успіху) — переходимо туди ручним слідуванням
  // (без Origin/Referer — це вже не форма, а звичайна навігація), щоб отримати реальний контент
  // сторінки для перевірки successPattern.
  let finalHtml = loginResp.data;
  if (loginResp.status >= 300 && loginResp.status < 400 && loginResp.headers.location) {
    const redirectUrl = new URL(loginResp.headers.location, url).toString();
    const { resp: followResp } = await followGet(redirectUrl, jar);
    finalHtml = followResp.data;
  }

  if (jar.size === 0) {
    return { success: false, message: `Сайт не повернув жодного cookie (HTTP ${loginResp.status}) - перевірте URL, метод і поля форми` };
  }

  if (successPattern && !String(finalHtml || '').includes(successPattern)) {
    return { success: false, message: `Отримано cookie, але ознака успішного входу "${successPattern}" не знайдена на сторінці після логіну (ймовірно невірний логін/пароль або змінилась форма)` };
  }

  return { success: true, cookies: jarToHeader(jar), httpCode: loginResp.status };
};

module.exports = { rawLogin };
