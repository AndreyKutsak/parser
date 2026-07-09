/**
 * Site authentication service.
 *
 * Supports two modes:
 *   form   — launches Playwright, fills the login form, extracts cookies
 *   manual — cookies are already stored; nothing to do here
 */
const logger = require('../../utils/logger');
const siteAuthRepo = require('../../db/repositories/site-auth.repository');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  // Playwright is optional
}

/**
 * Performs form-based authentication via Playwright.
 * Navigates to loginUrl, fills credentials + any extra fields, submits,
 * waits for success, extracts cookies, and saves them to the DB.
 *
 * @param {object} auth - SiteAuth document (plain object)
 * @returns {Promise<string>} Cookie string "k=v; k2=v2"
 */
const authenticateForm = async (auth) => {
  if (!chromium) {
    throw new Error('Playwright не встановлено. Виконайте: npm install playwright');
  }

  const {
    loginUrl,
    formConfig = {},
    credentials = {},
  } = auth;

  const {
    usernameSelector,
    passwordSelector,
    submitSelector,
    successSelector,
    extraFields = [],
  } = formConfig;

  const launchOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
    channel: 'chromium-headless-shell',
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();

  try {
    page.setDefaultNavigationTimeout(30000);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    // Fill username
    if (usernameSelector && credentials.username) {
      await page.waitForSelector(usernameSelector, { timeout: 10000 });
      await page.click(usernameSelector, { clickCount: 3 });
      await page.locator(usernameSelector).pressSequentially(credentials.username, { delay: 40 });
    }

    // Fill password
    if (passwordSelector && credentials.password) {
      await page.waitForSelector(passwordSelector, { timeout: 10000 });
      await page.click(passwordSelector, { clickCount: 3 });
      await page.locator(passwordSelector).pressSequentially(credentials.password, { delay: 40 });
    }

    // Fill extra fields
    for (const field of extraFields) {
      if (field.selector && field.value) {
        await page.waitForSelector(field.selector, { timeout: 5000 }).catch(() => {});
        await page.click(field.selector, { clickCount: 3 });
        await page.locator(field.selector).pressSequentially(field.value, { delay: 30 });
      }
    }

    // Submit
    if (submitSelector) {
      await page.waitForSelector(submitSelector, { timeout: 10000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
        page.click(submitSelector),
      ]);
    }

    // Wait for success indicator
    if (successSelector) {
      await page.waitForSelector(successSelector, { timeout: 15000 });
    } else {
      // Fallback: wait a bit for potential redirect
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Extract cookies
    const cookieArr = await page.context().cookies();
    const cookieStr = cookieArr.map((c) => `${c.name}=${c.value}`).join('; ');

    logger.info('Site auth succeeded', { authId: auth._id, cookieCount: cookieArr.length });
    return cookieStr;
  } finally {
    await browser.close().catch(() => {});
  }
};

/**
 * Runs authentication for a SiteAuth config and saves the resulting cookies.
 *
 * @param {string} authId - SiteAuth _id
 * @param {string} ownerId - User _id (for ownership check)
 * @returns {Promise<{ cookies: string, cookiesUpdatedAt: Date }>}
 */
const run = async (authId, ownerId) => {
  const auth = await siteAuthRepo.findById(authId, ownerId);
  if (!auth) throw new Error('Авторизацію не знайдено');

  if (auth.type === 'manual') {
    throw new Error('Ручний тип авторизації — встановіть cookies вручну');
  }

  try {
    const cookies = await authenticateForm(auth);
    await siteAuthRepo.setCookies(authId, cookies);
    return { cookies, cookiesUpdatedAt: new Date() };
  } catch (err) {
    await siteAuthRepo.setError(authId, err.message);
    throw err;
  }
};

/**
 * Returns the active cookie string for a SiteAuth, or null if not authenticated.
 *
 * @param {string|object} authIdOrDoc - SiteAuth _id or doc
 * @returns {Promise<string|null>}
 */
const getCookies = async (authIdOrDoc) => {
  if (!authIdOrDoc) return null;
  if (typeof authIdOrDoc === 'object' && authIdOrDoc.cookies) return authIdOrDoc.cookies;
  const SiteAuth = require('../../db/models/site-auth.model');
  const doc = await SiteAuth.findById(authIdOrDoc).select('cookies').lean();
  return doc?.cookies ?? null;
};

module.exports = { run, getCookies };
