/**
 * Модель задачі — зберігає повну конфігурацію одного завдання парсингу.
 *
 * Задача може працювати у двох режимах:
 *   1. Один URL  — поле `url` + `options.method/body` (зворотна сумісність)
 *   2. Кілька URL — масив `requests[]`, де кожен елемент має власний URL,
 *      метод, тіло та опціонально власні селектори.
 *
 * Загальні `selectors` використовуються як резервні для тих запитів,
 * де власні селектори не вказані.
 */
const mongoose = require("mongoose");

/**
 * Опис одного поля для витягування.
 * Визначає, як знайти та обробити значення всередині елемента-контейнера.
 *
 * @property {string}  selector     - CSS-селектор або XPath-вираз
 * @property {string}  selectorType - Тип селектора: 'css' | 'xpath'
 * @property {string}  attr         - HTML-атрибут для читання (null = текстовий вміст)
 * @property {*}       transform    - Рядок або масив трансформацій (trim, uppercase, тощо)
 * @property {boolean} multiple     - true = зібрати всі збіги, false = лише перший
 * @property {boolean} monitor      - true = відстежувати зміни цього поля, false = ні
 */
const fieldSchema = new mongoose.Schema(
  {
    selector: { type: String, required: true },
    selectorType: { type: String, enum: ["css", "xpath"], default: "css" },
    attr: { type: String, default: null },
    transform: { type: mongoose.Schema.Types.Mixed, default: null },
    multiple: { type: Boolean, default: false },
    monitor: { type: Boolean, default: false },
  },
  { _id: false },
);

/**
 * Один запит у багатозапитній задачі.
 * Дозволяє задати різні URL, методи та тіла в межах однієї задачі.
 *
 * @property {string} url               - Цільовий URL
 * @property {string} method            - HTTP-метод: 'GET' | 'POST'
 * @property {object} body              - Тіло запиту (лише для POST)
 * @property {string} body.format       - Формат тіла: 'json' | 'form' | 'raw'
 * @property {*}      body.data         - Дані тіла (об'єкт для json, рядок для form/raw)
 * @property {Map}    headers           - Заголовки, що перекривають загальні task.options.headers
 * @property {string} cookies           - Cookie-рядок, що перекриває загальний
 * @property {object} selectors         - Власні селектори для цього запиту (необов'язково)
 * @property {string} selectors.item    - CSS-селектор повторюваного елемента
 * @property {Map}    selectors.fields  - Карта полів для витягування
 */
const requestSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    method: { type: String, enum: ["GET", "POST"], default: "GET" },
    body: {
      format: { type: String, enum: ["json", "form", "raw"], default: "json" },
      data: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    headers: { type: Map, of: String, default: () => new Map() },
    cookies: { type: String, default: null },
    selectors: {
      item: { type: String, default: null },
      fields: { type: Map, of: fieldSchema },
    },
  },
  { _id: false },
);

/**
 * Конфігурація пагінації.
 *
 * @property {boolean} enabled     - Чи увімкнена пагінація
 * @property {string}  type        - Тип пагінації: next-button | page-number | load-more | scroll | url-pattern
 * @property {string}  selector    - CSS-селектор кнопки «наступна сторінка» / «завантажити ще»
 * @property {string}  urlPattern  - Шаблон URL з плейсхолдером {page}, напр. "https://site.com/page/{page}"
 * @property {number}  startPage   - Початкова сторінка (default: 1)
 * @property {number}  maxPages    - Максимальна кількість сторінок для обходу (default: 10)
 */
const paginationSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    type: {
      type: String,
      enum: [
        "next-button",
        "page-number",
        "load-more",
        "scroll",
        "url-pattern",
      ],
      default: "next-button",
    },
    selector: { type: String },
    urlPattern: { type: String },
    startPage: { type: Number, default: 1 },
    pageStep: { type: Number, default: 1 },
    maxPages: { type: Number, default: 10 },
  },
  { _id: false },
);

/**
 * Головна схема задачі парсингу.
 *
 * @property {string}   name              - Назва задачі
 * @property {string}   url               - Єдиний URL (використовується якщо requests[] порожній)
 * @property {string}   engine            - Рушій: 'static' (axios+cheerio) | 'dynamic' (puppeteer)
 * @property {ObjectId} owner             - Посилання на користувача-власника
 *
 * @property {Array}    requests          - Список запитів із власними URL/методами (режим кількох URL)
 *
 * @property {object}   selectors         - Загальні селектори (резервні для requests без власних)
 * @property {string}   selectors.item    - CSS-селектор повторюваного елемента-контейнера
 * @property {Map}      selectors.fields  - Карта полів: ім'я → fieldSchema
 *
 * @property {object}   pagination        - Налаштування пагінації
 *
 * @property {object}   schedule          - Розклад автозапуску
 * @property {boolean}  schedule.enabled  - Чи увімкнений розклад
 * @property {string}   schedule.cron     - Cron-вираз, напр. "0 *\/6 * * *"
 * @property {boolean}  schedule.runOnce  - Виконати лише один раз і вимкнути
 * @property {Date}     schedule.nextRun  - Час наступного запуску
 * @property {Date}     schedule.lastRun  - Час останнього запуску
 *
 * @property {object}   proxy             - Налаштування проксі
 * @property {boolean}  proxy.enabled     - Чи використовувати проксі
 * @property {boolean}  proxy.rotate      - Чи ротувати проксі між запитами
 * @property {ObjectId} proxy.proxyId     - Фіксований проксі (якщо rotate=false)
 *
 * @property {object}   options           - Загальні HTTP-параметри задачі
 * @property {number}   options.timeout   - Таймаут запиту в мс (default: 30000)
 * @property {number}   options.retries   - Кількість повторних спроб при помилці (default: 3)
 * @property {number}   options.delay     - Затримка між сторінками в мс (default: 1000)
 * @property {Map}      options.headers   - Загальні HTTP-заголовки
 * @property {string}   options.cookies   - Cookie-рядок (raw format)
 * @property {boolean}  options.antiBot   - Додавати випадковий User-Agent і реалістичні заголовки
 * @property {string}   options.method    - HTTP-метод для режиму одного URL: 'GET' | 'POST'
 * @property {object}   options.body      - Тіло для режиму одного URL (POST)
 * @property {string}   options.body.format - Формат тіла: 'json' | 'form' | 'raw'
 * @property {*}        options.body.data   - Дані тіла
 *
 * @property {string}   status            - Поточний стан: idle | running | paused | error | completed | stopped
 *
 * @property {object}   stats             - Накопичена статистика виконань
 * @property {number}   stats.totalRuns   - Загальна кількість запусків
 * @property {number}   stats.successRuns - Успішних запусків
 * @property {number}   stats.failedRuns  - Невдалих запусків
 * @property {number}   stats.totalRecords - Загальна кількість зібраних записів
 * @property {number}   stats.lastDuration - Тривалість останнього запуску в мс
 * @property {string}   stats.lastError   - Повідомлення про останню помилку
 *
 * @property {string[]} tags              - Довільні теги для фільтрації
 */
const taskSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, trim: true }, // Категорія для групування та назв файлів експорту
    url: { type: String },
    engine: { type: String, enum: ["static", "dynamic"], default: "static" },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    requests: { type: [requestSchema], default: [] },

    selectors: {
      item: { type: String },
      fields: { type: Map, of: fieldSchema },
      linkSelector: { type: String, default: null }, // CSS для посилання на деталі
      detailFields: { type: Map, of: fieldSchema }, // поля зі сторінки деталей
      keyField: { type: String, default: null }, // поле-ідентифікатор для трекінгу змін у категорії
    },

    pagination: { type: paginationSchema, default: () => ({}) },

    schedule: {
      enabled: { type: Boolean, default: false },
      cron: { type: String },
      runOnce: { type: Boolean, default: false },
      nextRun: { type: Date },
      lastRun: { type: Date },
    },

    proxy: {
      enabled: { type: Boolean, default: false },
      rotate: { type: Boolean, default: true },
      proxyId: { type: mongoose.Schema.Types.ObjectId, ref: "Proxy" },
    },

    options: {
      timeout: { type: Number, default: 30000 },
      retries: { type: Number, default: 3 },
      delay: { type: Number, default: 1000 },
      headers: { type: Map, of: String, default: () => new Map() },
      cookies: { type: String },
      antiBot: { type: Boolean, default: true },
      ajaxHeader: { type: Boolean, default: false },
      jsonHtmlField: { type: String, default: null },
      jsonPath: { type: String, default: null },
      method: { type: String, enum: ["GET", "POST"], default: "GET" },
      body: {
        format: {
          type: String,
          enum: ["json", "form", "raw"],
          default: "json",
        },
        data: { type: mongoose.Schema.Types.Mixed, default: null },
      },
      crawl: {
        enabled: { type: Boolean, default: false },
        selector: { type: String, default: "a[href]" },
        urlTemplate: { type: String, default: null },
        jsonPath: { type: String, default: null },
        maxDepth: { type: Number, default: 3 },
        maxRequests: { type: Number, default: 0 },
        sameOrigin: { type: Boolean, default: true },
      },
    },

    notification: {
      enabled: { type: Boolean, default: false },
      url: { type: String, default: null },
      method: {
        type: String,
        enum: ["POST", "PUT", "PATCH", "GET"],
        default: "POST",
      },
      headers: { type: Map, of: String, default: () => new Map() },
    },

    status: {
      type: String,
      enum: ["idle", "running", "paused", "error", "completed", "stopped"],
      default: "idle",
    },

    stats: {
      totalRuns: { type: Number, default: 0 },
      successRuns: { type: Number, default: 0 },
      failedRuns: { type: Number, default: 0 },
      totalRecords: { type: Number, default: 0 },
      lastDuration: { type: Number },
      lastRun: { type: Date },
      lastActivity: { type: Date },
      lastError: { type: String },
    },

    tags: [{ type: String }],

    /**
     * Sub-task configuration — controls whether item URLs discovered during
     * this task's run should spawn recurring sub-tasks.
     *
     * @property {boolean} enabled         - Whether to create sub-tasks for discovered item URLs
     * @property {number}  intervalMinutes - Re-parse interval in minutes (default: 60)
     * @property {string}  cron            - Custom cron override (null = auto from intervalMinutes)
     */
    subTasks: {
      enabled: { type: Boolean, default: false },
      intervalMinutes: { type: Number, default: 60 },
      cron: { type: String, default: null },
    },
  },
  { timestamps: true },
);

taskSchema.index({ owner: 1, status: 1 });
taskSchema.index({ "schedule.nextRun": 1, "schedule.enabled": 1 });

module.exports = mongoose.model("Task", taskSchema);
