/**
 * Utility helpers — common transformation and validation functions
 */

/**
 * Sleep for a random delay between min and max ms (anti-bot)
 */
const sleep = (min = 500, max = 2000) => {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
};

const regexCache = new Map();
const getCachedRegex = (pattern) => {
  let re = regexCache.get(pattern);
  if (!re) { re = new RegExp(pattern); regexCache.set(pattern, re); }
  return re;
};

/**
 * Apply transformation rules to a scraped string value
 * Supported transforms: trim, lowercase, uppercase, number, int, boolean, regex:<pattern>:<group>
 */
const applyTransform = (value, transforms) => {
  if (!value || !transforms) return value;

  const rules = Array.isArray(transforms) ? transforms : [transforms];

  return rules.reduce((val, rule) => {
    if (typeof val !== 'string') val = String(val ?? '');

    if (rule === 'trim') return val.trim();
    if (rule === 'lowercase') return val.toLowerCase();
    if (rule === 'uppercase') return val.toUpperCase();
    if (rule === 'number' || rule === 'float') {
      const num = parseFloat(val.replace(/[^\d.,]/g, '').replace(',', '.'));
      return isNaN(num) ? null : num;
    }
    if (rule === 'int' || rule === 'integer') {
      const num = parseInt(val.replace(/[^\d]/g, ''), 10);
      return isNaN(num) ? null : num;
    }
    if (rule === 'boolean') {
      return ['true', '1', 'yes', 'так', '+'].includes(val.toLowerCase());
    }
    if (rule === 'remove-html') {
      return val.replace(/<[^>]+>/g, '').trim();
    }
    if (rule.startsWith('regex:')) {
      const parts = rule.split(':');
      const pattern = parts[1];
      const group = parseInt(parts[2] ?? '0', 10);
      try {
        const match = val.match(getCachedRegex(pattern));
        return match ? (match[group] ?? match[0]) : null;
      } catch {
        return val;
      }
    }
    if (rule.startsWith('replace:')) {
      // replace:<from>:<to>
      const parts = rule.split(':');
      return val.replaceAll(parts[1] ?? '', parts[2] ?? '');
    }
    return val;
  }, value);
};

/**
 * Build an absolute URL from a relative one using a base
 */
const resolveUrl = (href, baseUrl) => {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
};

/**
 * Chunk an array into pages of given size
 */
const chunk = (arr, size) => {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
};

/**
 * Deep merge objects (right wins)
 */
const deepMerge = (target, source) => {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] ?? {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
};

/**
 * Safe JSON parse — returns null on failure
 */
const safeJson = (str) => {
  try { return JSON.parse(str); } catch { return null; }
};

/**
 * Format duration in ms to human-readable string
 */
const formatDuration = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
};

module.exports = { sleep, applyTransform, resolveUrl, chunk, deepMerge, safeJson, formatDuration };
