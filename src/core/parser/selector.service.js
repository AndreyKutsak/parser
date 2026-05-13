/**
 * Сервіс селекторів — витягує дані з DOM-дерева через cheerio.
 *
 * Підтримує:
 *   - CSS-селектори (стандартний режим)
 *   - XPath-вирази (потребує пакетів xpath + xmldom)
 *   - Читання текстового вмісту або довільного HTML-атрибута
 *   - Ланцюжок трансформацій значень (trim, uppercase, тощо)
 *   - Збір одного або всіх збігів
 */
const { applyTransform, resolveUrl } = require('../../utils/helpers');

/**
 * Витягує значення одного поля з елемента-контейнера.
 *
 * @param {CheerioAPI} $         - Екземпляр cheerio
 * @param {object}     el        - Кореневий елемент для пошуку (контейнер запису)
 * @param {object}     field     - Дескриптор поля
 * @param {string}     field.selector     - CSS-селектор або XPath-вираз
 * @param {string}     [field.selectorType='css'] - Тип селектора: 'css' | 'xpath'
 * @param {string}     [field.attr]       - Атрибут для читання (null = текстовий вміст)
 * @param {*}          [field.transform]  - Трансформація або масив трансформацій
 * @param {boolean}    [field.multiple]   - true = повернути масив усіх збігів
 * @param {string}     [baseUrl='']       - Базовий URL для розгортання відносних посилань
 * @returns {string|string[]|null} Витягнуте значення або null
 */
const extractField = ($, el, field, baseUrl = '') => {
  const { selector, selectorType = 'css', attr = null, transform = null, multiple = false } = field;

  let elements;
  if (selectorType === 'xpath') {
    elements = xpathSelect($, el, selector);
  } else {
    elements = $(selector, el);
  }

  /**
   * Витягує значення з одного DOM-елемента.
   * @param {object} elem - Cheerio-елемент
   * @returns {string|null}
   */
  const extract = (elem) => {
    let value;
    if (attr) {
      value = $(elem).attr(attr) ?? null;
      // Розгортаємо відносні URL для атрибутів src і href
      if (value && (attr === 'src' || attr === 'href')) {
        value = resolveUrl(value, baseUrl);
      }
    } else {
      value = $(elem).text().trim() || null;
    }
    return applyTransform(value, transform);
  };

  if (multiple) {
    const results = [];
    elements.each((_, elem) => results.push(extract(elem)));
    return results;
  }

  return elements.length > 0 ? extract(elements.first()) : null;
};

/**
 * Витягує повний запис із елемента-контейнера за картою полів.
 *
 * @param {CheerioAPI} $         - Екземпляр cheerio
 * @param {object}     container - Cheerio-елемент контейнера (один запис)
 * @param {Map<string, object>} fields - Карта: ім'я поля → дескриптор поля
 * @param {string}     [baseUrl='']    - Базовий URL для відносних посилань
 * @returns {object} Об'єкт запису { fieldName: value, ... }
 */
const extractRecord = ($, container, fields, baseUrl = '') => {
  const record = {};
  for (const [name, field] of fields.entries()) {
    record[name] = extractField($, container, field, baseUrl);
  }
  return record;
};

/**
 * Знаходить усі елементи-контейнери на сторінці та витягує з них записи.
 * Порожні записи (всі поля null або '') пропускаються.
 *
 * @param {CheerioAPI} $            - Екземпляр cheerio
 * @param {string}     itemSelector - CSS-селектор повторюваного елемента
 * @param {Map<string, object>} fields - Карта полів
 * @param {string}     [baseUrl=''] - Базовий URL
 * @returns {Array<object>} Масив витягнутих записів
 */
const extractAll = ($, itemSelector, fields, baseUrl = '') => {
  const records = [];
  $(itemSelector).each((_, el) => {
    const record = extractRecord($, el, fields, baseUrl);
    // Пропускаємо повністю порожні записи
    const hasData = Object.values(record).some(
      v => v !== null && v !== '' && !(Array.isArray(v) && !v.length)
    );
    if (hasData) records.push(record);
  });
  return records;
};

/**
 * Базова підтримка XPath через пакети xpath + xmldom.
 * Повертає об'єкт, сумісний з cheerio-інтерфейсом.
 * При відсутності пакетів повертає порожню колекцію.
 *
 * @param {CheerioAPI} $ - Екземпляр cheerio
 * @param {object}    el - Кореневий елемент
 * @param {string}    xpathExpr - XPath-вираз
 * @returns {object} Псевдо-cheerio об'єкт із методами each/first/length
 */
const xpathSelect = ($, el, xpathExpr) => {
  try {
    const xpath = require('xpath');
    const { DOMParser } = require('xmldom');
    const html = $.html(el);
    const doc  = new DOMParser().parseFromString(html, 'text/html');
    const nodes = xpath.select(xpathExpr, doc);
    return {
      length: nodes.length,
      each:   (fn) => nodes.forEach((n, i) => fn(i, n)),
      first:  () => ({
        length: nodes.length > 0 ? 1 : 0,
        text:   () => nodes[0]?.textContent ?? '',
        attr:   () => null,
      }),
      text: () => nodes[0]?.textContent ?? '',
      attr: () => null,
    };
  } catch {
    return { length: 0, each: () => {}, first: () => ({ length: 0, text: () => '', attr: () => null }) };
  }
};

/**
 * Визначає URL наступної сторінки на основі налаштувань пагінації.
 *
 * Підтримувані типи:
 *   - next-button  — читає href кнопки «Наступна» за CSS-селектором
 *   - url-pattern  — підставляє номер сторінки у шаблон URL ({page})
 *
 * @param {CheerioAPI} $           - Екземпляр cheerio
 * @param {object}     pagination  - Конфігурація пагінації
 * @param {boolean}    pagination.enabled     - Чи увімкнена пагінація
 * @param {string}     pagination.type        - Тип пагінації
 * @param {string}     [pagination.selector]  - Селектор кнопки для next-button
 * @param {string}     [pagination.urlPattern]- Шаблон URL для url-pattern
 * @param {number}     [pagination.startPage] - Початкова сторінка
 * @param {number}     [pagination.currentPage] - Поточна сторінка
 * @param {string}     currentUrl  - Поточний URL (для розгортання відносних посилань)
 * @returns {string|null} URL наступної сторінки або null
 */
const getNextPageUrl = ($, pagination, currentUrl) => {
  if (!pagination?.enabled) return null;

  const { type, selector, urlPattern, startPage, currentPage = startPage } = pagination;

  if (type === 'next-button' && selector) {
    const el = $(selector).first();
    // Try href on the element itself; if it's not an <a>, look inside for <a>
    const href = el.attr('href') || el.find('a').first().attr('href') || null;
    return href ? resolveUrl(href, currentUrl) : null;
  }

  if (type === 'url-pattern') {
    const pattern = urlPattern || selector; // selector — fallback з форми UI
    if (!pattern) return null;
    if (!pattern.includes('{page}')) return null; // pattern без {page} — зупиняємось
    const step = pagination.pageStep ?? 1;
    return pattern.replace('{page}', currentPage + step);
  }

  return null;
};

module.exports = { extractField, extractRecord, extractAll, getNextPageUrl };
