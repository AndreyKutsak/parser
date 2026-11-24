'use strict';

// Підставний рушій: повертає «підказки пошуку» як у zapchasty.com.ua
const mkItem = (id, ref, price, quantity) => ({
  id_product: String(id), reference: ref, price, quantity,
  product_link: `https://zapchasty.com.ua/product/${id}-slug-${id}.html`,
});
const suggestions = {
  'Болт кріплення': [mkItem(928, '01.COD.755', 36, 118), mkItem(3436, '01.DC60-40137AOrig', 24, 32)],
  'OnlyByArticle': [mkItem(6381, '01.DC60-40137AOrig_set', 68, 0)],
};

const parserService = require('../parser.service');

const makeCtx = (calls) => ({
  taskId: 't1', runId: 'r1', idx: 0, followDelay: 0, fetchOptions: { timeout: 1000 },
  emit: () => {},
  engine: {
    fetchPage: async (url, opts) => {
      calls.push({ url, opts });
      const q = decodeURIComponent(new URL(url).searchParams.get('q'));
      return { rawJsonItems: suggestions[q] || [] };
    },
  },
});

const cfg = {
  type: 'лінк на іншу сторінку',
  follow: true,
  urlTemplate:
    'https://shop.test/poshuk?q={{Назва}}&limit=10 || https://shop.test/poshuk?q={{Артикул}}&limit=10',
  jsonFields: [{ path: '[product_link={{Посилання на товар}}].quantity', key: '' }],
};

describe('_followFields: вибір запису за збігом', () => {
  test('кількість береться з запису з потрібним посиланням, а не з першого', async () => {
    const calls = [];
    const rec = {
      'Назва': 'Болт кріплення', 'Артикул': 'X', 'Кількість': null,
      'Посилання на товар': 'https://zapchasty.com.ua/product/3436-slug-3436.html',
    };
    await parserService._followFields(rec, new Map([['Кількість', cfg]]), 'https://shop.test/', makeCtx(calls));
    expect(rec['Кількість']).toBe(32);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.jsonPath).toBe('.');
  });

  test('якщо за назвою не знайдено — пробує другий URL (за артикулом)', async () => {
    const calls = [];
    const rec = {
      'Назва': 'Невідома назва', 'Артикул': 'OnlyByArticle', 'Кількість': null,
      'Посилання на товар': 'https://zapchasty.com.ua/product/6381-slug-6381.html',
    };
    await parserService._followFields(rec, new Map([['Кількість', cfg]]), 'https://shop.test/', makeCtx(calls));
    expect(rec['Кількість']).toBe(0);
    expect(calls).toHaveLength(2);
  });

  test('немає збігу — значення зі списку не змінюється', async () => {
    const calls = [];
    const rec = { 'Назва': 'Невідома', 'Артикул': 'Теж', 'Кількість': null, 'Посилання на товар': 'https://x/product/1-a.html' };
    await parserService._followFields(rec, new Map([['Кількість', cfg]]), 'https://shop.test/', makeCtx(calls));
    expect(rec['Кількість']).toBeNull();
  });

  test('спецсимволи в назві кодуються в URL', async () => {
    const calls = [];
    const rec = { 'Назва': 'A&B #1 M8*1.25', 'Артикул': 'Z', 'Кількість': null, 'Посилання на товар': 'u' };
    await parserService._followFields(rec, new Map([['Кількість', cfg]]), 'https://shop.test/', makeCtx(calls));
    expect(calls[0].url).toContain('q=A%26B%20%231%20M8*1.25');
  });
});
