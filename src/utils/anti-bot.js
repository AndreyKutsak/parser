/**
 * Anti-bot measures — realistic user-agent rotation, headers, and behaviour
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
];

const ACCEPT_LANGUAGES = [
  'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
  'en-US,en;q=0.9',
  'en-GB,en;q=0.8',
  'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
];

/**
 * Get a random user-agent string
 */
const getRandomUserAgent = () =>
  USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

/**
 * Build realistic browser-like headers for HTTP requests
 */
const buildHeaders = (customHeaders = {}) => ({
  'User-Agent': getRandomUserAgent(),
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)],
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0',
  ...customHeaders,
});

/**
 * Apply anti-detection patches to a Puppeteer page
 * Hides webdriver fingerprints, sets realistic properties
 */
const applyStealthPatches = async (page) => {
  await page.evaluateOnNewDocument(() => {
    // Overwrite the `webdriver` property to return false
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Fake plugins list
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin' },
        { name: 'Chrome PDF Viewer' },
        { name: 'Native Client' },
      ],
    });

    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['uk-UA', 'uk', 'en-US', 'en'],
    });

    // Override permissions to avoid detection
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });
};

/**
 * Simulate human-like mouse movement on a Puppeteer page
 */
const simulateHumanBehaviour = async (page) => {
  // Random scroll
  const scrollY = Math.floor(Math.random() * 300) + 100;
  await page.evaluate((y) => window.scrollBy(0, y), scrollY);
  await new Promise(r => setTimeout(r, Math.random() * 500 + 200));
};

module.exports = { getRandomUserAgent, buildHeaders, applyStealthPatches, simulateHumanBehaviour };
