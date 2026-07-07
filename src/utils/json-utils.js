'use strict';

/**
 * Витягує значення з JSON за шляхом з підтримкою синтаксису масивів:
 *   "data.models"        → повертає вузол цілком
 *   "data.models[].name" → масив значень поля name з кожного елементу
 */
const resolveJsonPath = (obj, path) => {
  const arrayIdx = path.indexOf('[]');
  if (arrayIdx === -1) {
    return path.split('.').reduce((o, k) => o?.[k], obj) ?? null;
  }
  const arrPath = path.slice(0, arrayIdx).replace(/\.$/, '');
  const subPath = path.slice(arrayIdx + 3);
  const arr = arrPath.split('.').reduce((o, k) => o?.[k], obj);
  if (!Array.isArray(arr)) return null;
  if (!subPath) return arr;
  return arr
    .map(item => subPath.split('.').reduce((o, k) => o?.[k], item) ?? null)
    .filter(v => v != null);
};

/**
 * Перетворює JSON-шлях у коротку назву колонки:
 *   "data.models[].name" → "models_name"
 *   "data.models"        → "models"
 */
const pathToKey = (path) => {
  const cleaned = path.replace(/\[\]/g, '').split('.').filter(Boolean);
  const parts = cleaned[0] === 'data' && cleaned.length > 1 ? cleaned.slice(1) : cleaned;
  return parts.join('_');
};

const _serializeItem = (v) =>
  (v != null && typeof v === 'object') ? JSON.stringify(v) : String(v ?? '');

/**
 * Перетворює розв'язане значення у рядок/число відповідно до формату.
 *
 * Повертає null якщо val == null (щоб відрізнити «немає даних» від «порожній рядок»).
 * Caller-и при потребі конвертують null → '' самостійно.
 */
const applyJsonFormat = (val, format = 'join', separator = null, template = null) => {
  if (val == null) return null;
  if (!Array.isArray(val)) return String(val);

  switch (format) {
    case 'first':     return val[0] ?? null;
    case 'count':     return val.length;
    case 'json':      return JSON.stringify(val);
    case 'join_semi': return val.map(_serializeItem).join(separator ?? '; ');
    case 'join_nl':   return val.map(_serializeItem).join(separator ?? '\n');
    case 'template': {
      const tpl = template || '{value}';
      const sep = separator ?? ' | ';
      return val
        .map(item => {
          if (item == null || typeof item !== 'object') return String(item ?? '');
          return tpl.replace(/\{([^}]+)\}/g, (_, k) => String(item[k.trim()] ?? ''));
        })
        .join(sep);
    }
    default: {
      return val.map(_serializeItem).join(separator ?? ', ');
    }
  }
};

/**
 * Розгортає JSON-об'єкт у плаский словник з underscore-ключами:
 *   { meta: { price: 5 }, tags: ["a","b"] }
 *   → { meta_price: "5", tags: "a, b", tags_0: "a", tags_1: "b" }
 * Обмеження глибини 4 рівні щоб уникнути надмірного розгортання.
 */
const flattenJsonItem = (obj, prefix = '', result = {}, depth = 0) => {
  if (depth > 4) return result;
  if (obj == null || typeof obj !== 'object') {
    // Примітив на вкладеному рівні — зберігаємо безпосередньо
    if (prefix) result[prefix] = String(obj ?? '');
    return result;
  }
  const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj);
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) {
        // Joined representation of the whole array
        result[key] = v.map(i => (i !== null && typeof i === 'object') ? JSON.stringify(i) : String(i ?? '')).join(', ');
        // Individual elements
        v.forEach((item, i) => flattenJsonItem(item, `${key}_${i}`, result, depth + 1));
      } else {
        flattenJsonItem(v, key, result, depth + 1);
      }
    } else {
      result[key] = String(v ?? '');
    }
  }
  return result;
};

module.exports = { resolveJsonPath, pathToKey, applyJsonFormat, flattenJsonItem };
