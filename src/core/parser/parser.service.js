/**
 * Сервіс парсингу — оркеструє завантаження сторінок, витягування даних і пагінацію.
 *
 * Підтримує два режими роботи:
 *   1. Один URL  — через поля task.url + task.options.method/body
 *   2. Кілька URL — через масив task.requests[], де кожен запит має власний
 *      URL, HTTP-метод, тіло та опціонально свої селектори.
 *
 * Загальна логіка виконання:
 *   - Для кожного запиту зі списку запускається цикл пагінації
 *   - Кожна сторінка обробляється з автоматичними повторами при помилці
 *   - При невдачі ротується проксі (якщо увімкнено)
 *   - Між сторінками та між запитами витримується налаштована затримка
 *   - Усі зібрані записи зберігаються в БД одним пакетом
 */
const crypto = require("crypto");
const axios = require("axios");
const { resolveJsonPath, pathToKey, applyJsonFormat } = require('../../utils/json-utils');

const cancelledTasks = new Set(); // taskId → зупинити між сторінками
const PAGE_LOG_MAX = 50;

// Lazy-load to avoid circular dependency
const getSubTaskService = () => require("../subtask/subtask.service");
const parseEvents = require("../../utils/parse-events");

// Emit a typed event to all SSE clients watching this task
const emit = (taskId, event) => parseEvents.emit(String(taskId), event);

/**
 * Відслідковування змін моніторованих полів
 * @param {Object} task - Task doc з конфігом моніторування
 * @param {Object} newResult - Новий результат парсингу
 * @param {Object} oldResult - Попередній результат (якщо існує)
 * @returns {Array} Масив змін полів
 */
const trackFieldChanges = (task, newData, oldData) => {
  if (!oldData || !newData) return [];

  const fieldsMap = task.selectors?.fields || {};
  // Mongoose stores Map fields as Map instances; Object.keys(Map) always returns []
  const fieldNames = fieldsMap instanceof Map
    ? [...fieldsMap.keys()]
    : Object.keys(fieldsMap);
  if (!fieldNames.length) return [];

  const getField = (name) => fieldsMap instanceof Map ? fieldsMap.get(name) : fieldsMap[name];
  const monitoredFields = fieldNames.filter((name) => getField(name)?.monitor === true);
  const trackedFields = monitoredFields.length ? monitoredFields : fieldNames;

  const normalizeVal = (v) => {
    if (v == null) return v;
    if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
    return v;
  };

  const now = new Date();
  const changes = [];

  for (const fieldName of trackedFields) {
    const newValue = normalizeVal(newData[fieldName]);
    const oldValue = normalizeVal(oldData[fieldName]);

    // Пропускаємо поля, яких немає в жодному з результатів
    if (newValue === undefined && oldValue === undefined) continue;

    if (JSON.stringify(newValue) !== JSON.stringify(oldValue)) {
      changes.push({ fieldName, oldValue, newValue, changedAt: now });
    }
  }

  return changes;
};

// Return a lean preview of a data object (first N key-value pairs, values truncated)
const subst = (tpl, item) =>
  tpl.replace(/\{\{([^}]+)\}\}/g, (_, k) => String(item[k.trim()] ?? ''));

// Оцінює одне правило над значенням поля
const _testOperator = (strVal, op, ruleVal) => {
  switch (op) {
    case 'contains':     return strVal.includes(ruleVal);
    case 'not_contains': return !strVal.includes(ruleVal);
    case 'equals':       return strVal === ruleVal;
    case 'not_equals':   return strVal !== ruleVal;
    case 'starts_with':  return strVal.startsWith(ruleVal);
    case 'ends_with':    return strVal.endsWith(ruleVal);
    case 'regex':        try { return new RegExp(ruleVal, 'i').test(strVal); } catch { return false; }
    case 'empty':        return strVal.trim() === '';
    case 'not_empty':    return strVal.trim() !== '';
    case 'gt':           return parseFloat(strVal.replace(/[^\d.-]/g, '')) > parseFloat(ruleVal);
    case 'lt':           return parseFloat(strVal.replace(/[^\d.-]/g, '')) < parseFloat(ruleVal);
    default:             return false;
  }
};

// Застосовує правила до запису. Повертає null якщо запис треба пропустити.
// Копія об'єкту створюється лише коли реально спрацьовує set_field.
const _applyRules = (record, rules) => {
  if (!rules?.length) return record;
  let result = null; // lazy — копіюємо тільки при першій зміні
  for (const rule of rules) {
    if (!rule.field || !rule.operator) continue;
    const src    = result ?? record;
    const strVal = src[rule.field] == null ? '' : String(src[rule.field]);
    if (!_testOperator(strVal, rule.operator, rule.value || '')) continue;
    if (rule.action === 'skip') return null;
    if (rule.action === 'set_field' && rule.targetField) {
      if (!result) result = { ...record };
      result[rule.targetField] = rule.targetValue ?? '';
    }
  }
  return result ?? record;
};


const dataPreview = (obj, n = 4) => {
  if (!obj || typeof obj !== "object") return {};
  return Object.fromEntries(
    Object.entries(obj)
      .slice(0, n)
      .map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 80) : v]),
  );
};

const normalizeHeaders = (rawHeaders) => {
  if (!rawHeaders) return {};
  if (rawHeaders instanceof Map) return Object.fromEntries(rawHeaders);
  if (typeof rawHeaders === "object") return rawHeaders;
  return {};
};

const sendNotification = async (task, runId, items, source = "parser") => {
  if (!task.notification?.enabled || !task.notification?.url || !items?.length)
    return;

  const payload = {
    taskId: String(task._id),
    runId,
    source,
    event: "new_content",
    timestamp: new Date().toISOString(),
    items: items.map((r) => ({
      url: r.url,
      detailUrl: r.detailUrl ?? null,
      page: r.page,
      seq: r.seq,
      data: r.data,
      fieldChanges: r.fieldChanges ?? [],
      status: r.status,
    })),
  };

  const method = String(task.notification.method ?? "POST").toLowerCase();
  const config = {
    method,
    url: task.notification.url,
    headers: {
      "Content-Type": "application/json",
      ...normalizeHeaders(task.notification.headers),
    },
    timeout: 15000,
  };

  if (method === "get") {
    config.params = payload;
  } else {
    config.data = payload;
  }

  try {
    await axios(config);
    logger.info("Notification sent", {
      taskId: task._id,
      url: task.notification.url,
      itemCount: items.length,
      source,
    });
  } catch (err) {
    logger.warn("Notification failed", {
      taskId: task._id,
      url: task.notification.url,
      error: err.message,
    });
  }
};

// Sleep що перевіряє скасування кожні 200ms
const cancellableSleep = async (taskId, min, max) => {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cancelledTasks.has(String(taskId))) return;
    await new Promise((r) =>
      setTimeout(r, Math.min(200, deadline - Date.now())),
    );
  }
};
const staticEngine = require("./engines/static.engine");
const dynamicEngine = require("./engines/dynamic.engine");
const { extractAll, extractRecord, getNextPageUrl } = require("./selector.service");
const proxyManager = require("../proxy/proxy.manager");
const resultRepo = require("../../db/repositories/result.repository");
const taskRepo = require("../../db/repositories/task.repository");
const Run = require("../../db/models/run.model");
const { sleep, formatDuration, chunk, resolveUrl } = require("../../utils/helpers");
const logger = require("../../utils/logger");

class ParserService {
  /**
   * Запускає повний цикл парсингу для заданої задачі.
   *
   * @param {object} task                    - Документ задачі з Mongoose (plain object)
   * @param {string} task._id                - Ідентифікатор задачі
   * @param {string} task.name               - Назва задачі
   * @param {string} [task.url]              - Єдиний URL (якщо requests[] порожній)
   * @param {string} task.engine             - Рушій: 'static' | 'dynamic'
   * @param {Array}  [task.requests]         - Список запитів із власними URL/методами
   * @param {object} [task.selectors]        - Загальні селектори (резервні)
   * @param {object} [task.pagination]       - Налаштування пагінації
   * @param {object} [task.options]          - Загальні HTTP-параметри
   * @param {object} [task.proxy]            - Налаштування проксі
   * @param {object} [task.stats]            - Поточна статистика (для накопичення)
   * @returns {Promise<{ runId: string, totalRecords: number, duration: number, pages: number }>}
   */
  async run(task) {
    const runId = crypto.randomUUID();
    const startTime = Date.now();
    let totalRecords = 0;
    let pagesVisited = 0;
    let lastActivityAt = Date.now();
    const pageLog = []; // лог кожної сторінки

    logger.info("Запуск парсингу", {
      taskId: task._id,
      taskName: task.name,
      runId,
    });

    await Run.create({
      taskId: task._id,
      runId,
      status: "running",
      startedAt: new Date(),
    });
    await taskRepo.updateStatus(task._id, "running", {
      "schedule.lastRun": new Date(),
      "stats.lastActivity": new Date(),
    });
    emit(task._id, {
      type: "run:start",
      runId,
      taskName: task.name,
      maxPages: task.pagination?.maxPages ?? 10,
      paginationEnabled: task.pagination?.enabled ?? false,
    });

    // Inject site-auth cookies if configured
    if (task.siteAuth) {
      try {
        const siteAuthService = require('../site-auth/site-auth.service');
        const authCookies = await siteAuthService.getCookies(task.siteAuth);
        if (authCookies) {
          const existing = task.options?.cookies;
          task = {
            ...task,
            options: {
              ...task.options,
              cookies: existing ? `${authCookies}; ${existing}` : authCookies,
            },
          };
          logger.debug('Injected site-auth cookies', { taskId: task._id, authId: task.siteAuth });
        }
      } catch (err) {
        logger.warn('Failed to load site-auth cookies', { taskId: task._id, error: err.message });
      }
    }

    try {
      // Визначаємо проксі для першого запиту
      let proxy = null;
      if (task.proxy?.enabled) {
        proxy = task.proxy.rotate
          ? await proxyManager.getNextProxy()
          : await proxyManager.getById(task.proxy.proxyId);
      }

      const engine = task.engine === "dynamic" ? dynamicEngine : staticEngine;
      const pagination = task.pagination ?? {};
      const maxPages = pagination.maxPages ?? 10;
      const delay = task.options?.delay ?? 1000;
      const retries = task.options?.retries ?? 3;

      // Нормалізуємо список запитів (один або кілька URL)
      const requestList = this._buildRequestList(task);

      // Розділяємо звичайні запити та шаблонні (містять {{field}} у URL або тілі)
      // Без прапора g — інакше .test() зрушує lastIndex і ламає повторні виклики
      const isTemplate = (r) =>
        /\{\{[^}]+\}\}/.test(r.url) ||
        !!(r.body?.data && /\{\{[^}]+\}\}/.test(String(r.body.data)));
      const baseRequests = requestList.filter((r) => !isTemplate(r));
      const templateRequests = requestList.filter(isTemplate);

      // Налаштування рекурсивного обходу
      const crawlEnabled = task.options?.crawl?.enabled || false;
      const crawlSel = task.options?.crawl?.selector || "a[href]";
      const crawlUrlTemplate = task.options?.crawl?.urlTemplate || null;
      const crawlJsonPath = task.options?.crawl?.jsonPath || null;
      logger.info("[CRAWL CONFIG]", {
        crawlEnabled,
        crawlUrlTemplate,
        crawlJsonPath,
        crawlSel,
        sameOrigin: task.options?.crawl?.sameOrigin,
      });
      const crawlMaxDepth = task.options?.crawl?.maxDepth ?? 3;
      const crawlSameOrigin = task.options?.crawl?.sameOrigin !== false;
      const crawlMaxRequests = task.options?.crawl?.maxRequests ?? 0; // 0 = без ліміту
      // Hard cap on the crawlVisited Set to prevent unbounded memory growth on large sites.
      const crawlMaxVisited = parseInt(process.env.CRAWL_MAX_VISITED) || 50_000;
      let crawlDone = 0; // окремий лічильник crawl-запитів

      // Pre-compute task-level selectors — shared across all requests and pages
      const taskFieldsMap = this._resolveFields(task.selectors?.fields);
      const taskDetailFieldsMap = this._resolveFields(task.selectors?.detailFields);

      // ── Цикл по звичайних запитах ────────────────────────────────────────
      const REQUEST_CONCURRENCY = parseInt(process.env.REQUEST_CONCURRENCY) || 3;
      const runBaseRequest = async (req) => {
        let reqProxy = proxy;
        const fetchOptions = this._buildFetchOptions(task, req, reqProxy);

        // Вибираємо селектори: власні для запиту або загальні задачі
        const itemSelector = req.selectors?.item || task.selectors?.item;
        const fields = req.selectors?.fields
          ? this._resolveFields(req.selectors.fields)
          : taskFieldsMap;

        // Стан рекурсивного обходу для цього запиту
        const crawlVisited = new Set([req.url]);
        const crawlQueue = []; // { url, depth }
        let crawlBaseOrigin = null;
        if (crawlEnabled) {
          try {
            crawlBaseOrigin = new URL(req.url).origin;
          } catch {}
        }

        let currentPage = pagination.startPage ?? 1;
        // For url-pattern, always derive the starting URL from the pattern using startPage
        // so the page counter and URL stay in sync. Using req.url directly can cause
        // duplicate pages if the task URL contains a different page number than startPage.
        let currentUrl = req.url;
        if (pagination.enabled && pagination.type === "url-pattern") {
          const pat = pagination.urlPattern || pagination.selector;
          if (pat?.includes("{page}"))
            currentUrl = pat.replace("{page}", currentPage);
        }

        // ── Цикл пагінації для поточного запиту ──────────────────────────
        while (currentUrl && pagesVisited < maxPages) {
          // Перевіряємо скасування на початку кожної ітерації
          if (cancelledTasks.has(String(task._id))) {
            cancelledTasks.delete(String(task._id));
            logger.info("Парсинг зупинено вручну", { taskId: task._id });
            currentUrl = null;
            break;
          }

          let pageRecords = [];
          let detailUrls = []; // parallel to pageRecords — detail URL per item (null if none)
          let lastError = null;
          const pageStart = Date.now();

          emit(task._id, {
            type: "page:start",
            runId,
            url: currentUrl,
            method: req.method,
            page: currentPage,
          });

          // ── Цикл повторних спроб ────────────────────────────────────────
          for (let attempt = 1; attempt <= retries; attempt++) {
            try {
              let fetchResult;
              try {
                fetchResult = await engine.fetchPage(currentUrl, fetchOptions);
              } catch (fetchErr) {
                // Позначаємо, що це саме помилка запиту (мережа/проксі),
                // щоб нижче не карати проксі за помилки в селекторах/парсингу.
                fetchErr.isFetchError = true;
                throw fetchErr;
              }
              let { $, status, rawJsonItems } = fetchResult;
              emit(task._id, {
                type: "page:fetch",
                runId,
                url: currentUrl,
                page: currentPage,
                status,
              });

              if (status === 404) {
                logger.warn("Сторінку не знайдено, пагінація зупинена", {
                  url: currentUrl,
                  status,
                });
                if (pageLog.length < PAGE_LOG_MAX) pageLog.push({
                  url: currentUrl,
                  page: currentPage,
                  method: req.method,
                  records: 0,
                  durationMs: Date.now() - pageStart,
                  status: "skipped",
                  error: "HTTP 404",
                });
                currentUrl = null;
                break;
              }

              // Прямий JSON-режим: немає itemSelector, але є rawJsonItems з engine
              if (rawJsonItems && !itemSelector) {
                pageRecords = this._extractJsonRecords(rawJsonItems, fields);
              } else {
                pageRecords = extractAll($, itemSelector, fields, currentUrl);
              }
              detailUrls = new Array(pageRecords.length).fill(null); // reset each attempt

              // ── Crawl: збираємо посилання для рекурсивного обходу ──────
              if (
                crawlEnabled &&
                !crawlUrlTemplate &&
                (crawlMaxDepth === 0 || 0 < crawlMaxDepth)
              ) {
                $(crawlSel).each((_, el) => {
                  if (crawlVisited.size >= crawlMaxVisited) return false; // jQuery .each exit
                  const href = $(el).attr("href");
                  if (!href) return;
                  try {
                    const abs = resolveUrl(href, currentUrl);
                    if (!abs || crawlVisited.has(abs)) return;
                    if (
                      crawlSameOrigin &&
                      crawlBaseOrigin &&
                      new URL(abs).origin !== crawlBaseOrigin
                    )
                      return;
                    crawlVisited.add(abs);
                    crawlQueue.push({ url: abs, depth: 1 });
                  } catch {}
                });
                if (crawlVisited.size >= crawlMaxVisited) {
                  logger.warn('crawlVisited limit reached, stopping link collection', { taskId: task._id, limit: crawlMaxVisited });
                }
              }

              // ── Деталі: заходимо в кожне посилання ─────────────────────
              const linkSelector = task.selectors?.linkSelector;
              if (linkSelector) {
                const detailFields = taskDetailFieldsMap;
                const items$ = $(itemSelector).toArray();

                // Збираємо всі посилання спочатку
                const detailItems = [];
                for (let li = 0; li < items$.length; li++) {
                  const href =
                    $(linkSelector, items$[li]).first().attr("href") ||
                    ($(items$[li]).is(linkSelector)
                      ? $(items$[li]).attr("href")
                      : null);
                  if (!href) continue;
                  detailItems.push({
                    li,
                    detailUrl: resolveUrl(href, currentUrl),
                  });
                }

                // Паралельне завантаження деталей пакетами
                const detailConcurrency = task.options?.detailConcurrency ?? 3;
                const batches = chunk(detailItems, detailConcurrency);

                for (let bi = 0; bi < batches.length; bi++) {
                  const batch = batches[bi];
                  if (cancelledTasks.has(String(task._id))) break;

                  await Promise.all(
                    batch.map(async ({ li, detailUrl }) => {
                      detailUrls[li] = detailUrl;

                      // Register sub-task (idempotent upsert)
                      if (task.subTasks?.enabled) {
                        getSubTaskService()
                          .createOrUpdate(task, detailUrl)
                          .catch((e) =>
                            logger.warn("SubTask upsert failed", {
                              url: detailUrl,
                              error: e.message,
                            }),
                          );
                      }

                      if (detailFields.size === 0) return;

                      const detailStart = Date.now();
                      emit(task._id, {
                        type: "detail:start",
                        runId,
                        url: detailUrl,
                        itemIndex: li,
                      });
                      try {
                        const { $: d$, status: dStatus } =
                          await engine.fetchPage(detailUrl, fetchOptions);
                        const dr = extractRecord(
                          d$,
                          d$("body"),
                          detailFields,
                          detailUrl,
                        );
                        if (pageRecords[li]) Object.assign(pageRecords[li], dr);
                        emit(task._id, {
                          type: "detail:done",
                          runId,
                          url: detailUrl,
                          itemIndex: li,
                          status: dStatus ?? 200,
                          duration: Date.now() - detailStart,
                          preview: dataPreview(dr),
                        });
                      } catch (e) {
                        emit(task._id, {
                          type: "detail:error",
                          runId,
                          url: detailUrl,
                          itemIndex: li,
                          error: e.message,
                        });
                        logger.warn("Помилка деталей", {
                          url: detailUrl,
                          error: e.message,
                        });
                      }
                    }),
                  );

                  // Затримка між пакетами (не між кожним елементом)
                  if (bi < batches.length - 1) {
                    await cancellableSleep(task._id, delay, delay * 2);
                  }
                }
              }

              // ── Follow-fields: рекурсивно проходимо посилання та merge-уємо дані ──
              // Runs AFTER detail pages so detail field values are available in subst()
              const hasFollowFields = [...fields.values()].some(
                (cfg) =>
                  cfg.type === 'лінк на іншу сторінку' &&
                  cfg.follow !== false &&
                  (cfg.urlTemplate || (cfg.subSelectors && Object.keys(cfg.subSelectors).length > 0)),
              );
              logger.debug('[FOLLOW] hasFollowFields=%s records=%d fieldTypes=%j', hasFollowFields, pageRecords.length,
                [...fields.entries()].map(([k, v]) => ({ k, type: v.type, follow: v.follow, hasSub: !!v.subSelectors && Object.keys(v.subSelectors || {}).length > 0 })));
              if (hasFollowFields && pageRecords.length) {
                const followConcurrency = task.options?.detailConcurrency ?? 3;
                const followBatches = chunk(
                  pageRecords.map((rec, idx) => ({ rec, idx })),
                  followConcurrency,
                );
                for (let fbi = 0; fbi < followBatches.length; fbi++) {
                  if (cancelledTasks.has(String(task._id))) break;
                  await Promise.all(
                    followBatches[fbi].map(({ rec, idx }) =>
                      this._followFields(rec, fields, currentUrl, {
                        engine,
                        staticEngine,
                        fetchOptions,
                        taskId: task._id,
                        followDelay: task.options?.followDelay ?? 0,
                        runId,
                        idx,
                        emit,
                      }),
                    ),
                  );
                  if (fbi < followBatches.length - 1) {
                    await cancellableSleep(task._id, delay, delay * 2);
                  }
                }
              }

              // ── Crawl: URL-шаблон з полів кожного запису ───────────────
              // Runs AFTER detail pages so {{detailField}} values are available
              if (crawlEnabled && crawlUrlTemplate && pageRecords.length) {
                logger.info("[CRAWL TEMPLATE] generating URLs from records", {
                  count: pageRecords.length,
                  template: crawlUrlTemplate,
                  sampleKeys: Object.keys(pageRecords[0] || {}),
                });
                for (let ci = 0; ci < pageRecords.length; ci++) {
                  const rec = pageRecords[ci];
                  const built = subst(crawlUrlTemplate, rec);
                  const hasPlaceholder = /\{\{/.test(built);
                  if (ci < 3)
                    logger.info("[CRAWL TEMPLATE] subst result", {
                      ci,
                      built,
                      hasPlaceholder,
                    });
                  if (built && !crawlVisited.has(built) && !hasPlaceholder) {
                    crawlVisited.add(built);
                    crawlQueue.push({ url: built, depth: 1, parentData: rec });
                  }
                }
                logger.info("[CRAWL TEMPLATE] queue after generation", {
                  queueLen: crawlQueue.length,
                });
              }

              logger.info("Сторінку оброблено", {
                url: currentUrl,
                method: req.method,
                page: currentPage,
                records: pageRecords.length,
              });

              if (pageLog.length < PAGE_LOG_MAX) pageLog.push({
                url: currentUrl,
                page: currentPage,
                method: req.method,
                records: pageRecords.length,
                durationMs: Date.now() - pageStart,
                status: "ok",
              });
              emit(task._id, {
                type: "page:done",
                runId,
                url: currentUrl,
                page: currentPage,
                records: pageRecords.length,
                duration: Date.now() - pageStart,
              });

              // Визначаємо URL наступної сторінки (після цього $ більше не потрібен)
              if (pagination.enabled) {
                const nextUrl = getNextPageUrl(
                  $,
                  { ...pagination, currentPage },
                  currentUrl,
                );
                if (!nextUrl) {
                  logger.debug("Пагінація: наступна сторінка не знайдена", {
                    type: pagination.type,
                    selector: pagination.selector,
                    currentPage,
                  });
                  emit(task._id, {
                    type: "page:pagination",
                    runId,
                    reason: "no-next",
                    currentPage,
                  });
                  currentUrl = null;
                } else if (nextUrl === currentUrl) {
                  logger.debug(
                    "Пагінація: наступний URL збігається з поточним",
                    { nextUrl, currentPage },
                  );
                  emit(task._id, {
                    type: "page:pagination",
                    runId,
                    reason: "same-url",
                    nextUrl,
                    currentPage,
                  });
                  currentUrl = null;
                } else {
                  logger.debug("Пагінація: перехід на наступну сторінку", {
                    nextUrl,
                    currentPage,
                  });
                  emit(task._id, {
                    type: "page:pagination",
                    runId,
                    reason: "next",
                    nextUrl,
                    currentPage,
                  });
                  currentUrl = nextUrl;
                }
              } else {
                currentUrl = null;
              }

              // Звільняємо DOM-дерево — більше не потрібне після визначення пагінації
              $ = null; // eslint-disable-line no-unused-vars

              lastError = null;
              break; // успіх — виходимо з циклу повторів
            } catch (err) {
              lastError = err;
              logger.warn(`Спроба ${attempt} не вдалась`, {
                url: currentUrl,
                error: err.message,
              });

              // Помічаємо проксі як несправний лише якщо впав саме запит
              // (мережа/проксі), а не парсинг/селектори на вже отриманій сторінці
              if (reqProxy && task.proxy?.rotate && err.isFetchError) {
                await proxyManager.recordFailure(reqProxy._id);
                reqProxy = await proxyManager.getNextProxy();
                fetchOptions.proxy = reqProxy;
              }

              if (attempt < retries) {
                await sleep(delay * attempt, delay * attempt * 2);
              }
            }
          }

          if (lastError && !pageRecords.length) {
            // Усі спроби вичерпано — фіксуємо помилку і переходимо до наступного запиту
            emit(task._id, {
              type: "page:error",
              runId,
              url: currentUrl,
              page: currentPage,
              error: lastError.message,
            });
            if (pageLog.length < PAGE_LOG_MAX) pageLog.push({
              url: currentUrl,
              page: currentPage,
              method: req.method,
              records: 0,
              durationMs: Date.now() - pageStart,
              status: "error",
              error: lastError.message,
            });
            break;
          }

          // Фільтруємо/трансформуємо записи за правилами задачі
          const taskRules = task.rules ?? [];
          if (taskRules.length) {
            const beforeCount = pageRecords.length;
            const filtered = [];
            const filteredUrls = [];
            for (let ri = 0; ri < pageRecords.length; ri++) {
              const kept = _applyRules(pageRecords[ri], taskRules);
              if (kept !== null) { filtered.push(kept); filteredUrls.push(detailUrls[ri]); }
            }
            if (filtered.length !== beforeCount) {
              logger.debug('[RULES] filtered records', { before: beforeCount, after: filtered.length });
            }
            pageRecords = filtered;
            detailUrls  = filteredUrls;
          }

          // Зберігаємо результати сторінки одразу в БД
          const pageResults = pageRecords.map((data, i) => ({
            taskId: task._id,
            runId,
            url: req.url,
            detailUrl: detailUrls[i] ?? null,
            page: currentPage,
            seq: i,
            status: "ok",
            data,
          }));

          // Відслідковування змін полів між запусками — batch-запити замість N окремих
          const keyField = task.selectors?.keyField || null;
          {
            const taskIdStr = String(task._id);
            const runIdStr = String(runId);

            const detailUrlItems = pageResults.filter((r) => r.detailUrl);
            const keyFieldItems = !detailUrlItems.length && keyField
              ? pageResults.filter((r) => r.data?.[keyField] != null)
              : pageResults.filter((r) => !r.detailUrl && keyField && r.data?.[keyField] != null);
            const seqItems = pageResults.filter(
              (r) => !r.detailUrl && (!keyField || r.data?.[keyField] == null),
            );

            const [oldByDetailUrl, oldByKeyValue, oldBySeq] = await Promise.all([
              detailUrlItems.length
                ? resultRepo.findLatestByUrlBatch(taskIdStr, detailUrlItems.map((r) => r.detailUrl), runIdStr)
                : Promise.resolve(new Map()),
              keyFieldItems.length
                ? resultRepo.findLatestByKeyFieldBatch(taskIdStr, keyField, keyFieldItems.map((r) => r.data[keyField]), runIdStr)
                : Promise.resolve(new Map()),
              seqItems.length
                ? resultRepo.findLatestBySeqBatch(taskIdStr, runIdStr, currentPage, seqItems.map((r) => r.seq))
                : Promise.resolve(new Map()),
            ]);

            for (const result of pageResults) {
              let oldResult = null;
              if (result.detailUrl) {
                oldResult = oldByDetailUrl.get(result.detailUrl) ?? null;
              } else if (keyField && result.data?.[keyField] != null) {
                oldResult = oldByKeyValue.get(String(result.data[keyField])) ?? null;
              } else {
                oldResult = oldBySeq.get(result.seq) ?? null;
              }

              if (oldResult) {
                const changes = trackFieldChanges(task, result.data, oldResult.data);
                if (changes.length > 0) {
                  result.fieldChanges = changes;
                  result._hasChanges = true;
                } else {
                  result._skip = true; // нічого не змінилось — не зберігаємо
                }
              }
            }
          }

          // Зберігаємо лише нові (перший запуск) або змінені записи
          const resultsToSave = pageResults.filter((r) => !r._skip);
          resultsToSave.forEach((r) => {
            delete r._hasChanges;
            delete r._skip;
          });

          if (resultsToSave.length) {
            await resultRepo.insertMany(resultsToSave);
            await sendNotification(task, runId, resultsToSave, "page");
          }

          totalRecords += resultsToSave.length;
          pagesVisited++;
          currentPage += (pagination.type === "url-pattern" ? (pagination.pageStep ?? 1) : 1);
          // Оновлюємо Run кожні 10 сторінок, щоб не навантажувати MongoDB
          if (pagesVisited % 10 === 0) {
            Run.findOneAndUpdate({ runId }, { totalRecords, totalPages: pagesVisited }).catch(() => {});
          }
          // lastActivity — окремий таймер (раз на хвилину), а не за кількістю сторінок:
          // під навантаженням задача може обробляти <10 сторінок за 30 хв watchdog-порогу
          // і хибно позначатись як "зависла", хоча реально й далі парситься.
          if (Date.now() - lastActivityAt >= 60_000) {
            lastActivityAt = Date.now();
            taskRepo.update(task._id, { 'stats.lastActivity': new Date() }).catch(() => {});
          }

          // Ввічлива затримка між сторінками (переривається при скасуванні)
          if (currentUrl && pagesVisited < maxPages) {
            await cancellableSleep(task._id, delay, delay * 2);
          }
        }

        // ── Crawl: рекурсивний обхід знайдених посилань ─────────────────
        if (crawlEnabled && crawlQueue.length > 0) {
          const crawlLimit = crawlMaxRequests > 0 ? crawlMaxRequests : Infinity;
          while (crawlQueue.length > 0 && crawlDone < crawlLimit) {
            if (cancelledTasks.has(String(task._id))) break;
            const { url: crawlUrl, depth, parentData } = crawlQueue.shift();
            try {
              // Параметри запиту: якщо є crawl.jsonPath — перекриває глобальний
              const crawlFetchOpts = this._buildFetchOptions(
                crawlJsonPath
                  ? {
                      ...task,
                      options: { ...task.options, jsonPath: crawlJsonPath },
                    }
                  : task,
                { ...req, url: crawlUrl, body: null, method: "GET" },
                reqProxy,
              );
              const { $ } = await engine.fetchPage(crawlUrl, crawlFetchOpts);
              // JSON crawl: auto-extract all fields from virtual HTML spans
              const records = crawlJsonPath
                ? $("#json-root .json-item")
                    .toArray()
                    .map((el) => {
                      const rec = {};
                      $(el)
                        .find("span[class]")
                        .each((_, span) => {
                          const cls = $(span).attr("class");
                          if (cls) rec[cls] = $(span).text();
                        });
                      return rec;
                    })
                : extractAll($, itemSelector, fields, crawlUrl);
              logger.info("[CRAWL URL]", {
                crawlUrl,
                extracted: records.length,
                jsonMode: !!crawlJsonPath,
                sample: records[0] || null,
              });

              const canGoDeeper = crawlMaxDepth === 0 || depth < crawlMaxDepth;

              if (canGoDeeper) {
                if (crawlUrlTemplate) {
                  // Режим шаблону: для кожного запису генеруємо URL наступного рівня
                  // Поля беруться з поточного запису АБО з parentData (підзадача)
                  for (const rec of records) {
                    const merged = { ...(parentData ?? {}), ...rec };
                    const built = subst(crawlUrlTemplate, merged);
                    if (
                      built &&
                      !crawlVisited.has(built) &&
                      !/\{\{/.test(built)
                    ) {
                      crawlVisited.add(built);
                      crawlQueue.push({
                        url: built,
                        depth: depth + 1,
                        parentData: merged,
                      });
                    }
                  }
                } else {
                  // Режим селектора: збираємо href зі сторінки
                  $(crawlSel).each((_, el) => {
                    if (crawlVisited.size >= crawlMaxVisited) return false;
                    const href = $(el).attr("href");
                    if (!href) return;
                    try {
                      const abs = resolveUrl(href, crawlUrl);
                      if (!abs || crawlVisited.has(abs)) return;
                      if (
                        crawlSameOrigin &&
                        crawlBaseOrigin &&
                        new URL(abs).origin !== crawlBaseOrigin
                      )
                        return;
                      crawlVisited.add(abs);
                      crawlQueue.push({
                        url: abs,
                        depth: depth + 1,
                        parentData: null,
                      });
                    } catch {}
                  });
                }
              }

              const toSave = records.map((data, i) => ({
                taskId: task._id,
                runId,
                url: crawlUrl,
                page: 1,
                seq: i,
                status: "ok",
                data,
              }));
              if (toSave.length) {
                await resultRepo.insertMany(toSave);
                await sendNotification(task, runId, toSave, "crawl");
                totalRecords += toSave.length;
              }
              crawlDone++;
              if (crawlDone % 10 === 0) {
                Run.findOneAndUpdate({ runId }, { totalRecords }).catch(() => {});
              }
              if (Date.now() - lastActivityAt >= 60_000) {
                lastActivityAt = Date.now();
                taskRepo.update(task._id, { 'stats.lastActivity': new Date() }).catch(() => {});
              }
              emit(task._id, {
                type: "page:fetch",
                runId,
                url: crawlUrl,
                page: crawlDone,
                status: 200,
              });
            } catch (err) {
              crawlDone++;
              emit(task._id, {
                type: "page:error",
                runId,
                url: crawlUrl,
                page: crawlDone,
                error: err.message,
              });
            }
            if (crawlQueue.length > 0 && crawlDone < crawlLimit) {
              await cancellableSleep(task._id, delay, delay * 2);
            }
          }
        }

      };

      const reqQueue = [...baseRequests];
      await Promise.all(
        Array.from({ length: Math.min(REQUEST_CONCURRENCY, Math.max(1, reqQueue.length)) }, async () => {
          while (reqQueue.length > 0) {
            const req = reqQueue.shift();
            if (req) await runBaseRequest(req);
          }
        })
      );

      // ── Шаблонні запити: підставляємо поля зі зібраних результатів ────────
      if (templateRequests.length) {
        // Завантажуємо збережені результати з БД — не тримаємо їх у пам'яті весь run
        const savedResults = await resultRepo.findAllByRun(String(task._id), runId);

        if (savedResults.length) {
        const substitute = (str, item) =>
          String(str).replace(/\{\{([^}]+)\}\}/g, (_, k) =>
            String(item[k.trim()] ?? ""),
          );

        for (const tmplReq of templateRequests) {
          for (const result of savedResults) {
            if (cancelledTasks.has(String(task._id))) break;
            const itemData = result.data ?? {};
            const expandedUrl = substitute(tmplReq.url, itemData);
            const expandedBody = tmplReq.body?.data
              ? {
                  format: tmplReq.body.format,
                  data: substitute(
                    typeof tmplReq.body.data === "string"
                      ? tmplReq.body.data
                      : JSON.stringify(tmplReq.body.data),
                    itemData,
                  ),
                }
              : null;
            const expandedReq = {
              ...tmplReq,
              url: expandedUrl,
              body: expandedBody,
            };
            const fetchOpts = this._buildFetchOptions(task, expandedReq, proxy);
            const itemSelector =
              tmplReq.selectors?.item || task.selectors?.item;
            const fields = this._resolveFields(
              tmplReq.selectors?.fields ?? task.selectors?.fields,
            );

            try {
              const { $ } = await engine.fetchPage(expandedUrl, fetchOpts);
              const records = extractAll($, itemSelector, fields, expandedUrl);
              const toSave = records.map((data, i) => ({
                taskId: task._id,
                runId,
                url: expandedUrl,
                page: 1,
                seq: i,
                status: "ok",
                data,
              }));
              if (toSave.length) {
                await resultRepo.insertMany(toSave);
                await sendNotification(task, runId, toSave, "template");
                totalRecords += toSave.length;
                pagesVisited++;
              }
              emit(task._id, {
                type: "subtask:request",
                method: tmplReq.method ?? "GET",
                url: expandedUrl,
                duration: 0,
                status: "ok",
              });
            } catch (err) {
              emit(task._id, {
                type: "subtask:request",
                method: tmplReq.method ?? "GET",
                url: expandedUrl,
                duration: 0,
                error: err.message,
              });
            }

            await cancellableSleep(task._id, delay, delay * 2);
          }
        }
        } // end if (savedResults.length)
      } // end if (templateRequests.length)

      const duration = Date.now() - startTime;
      const now = new Date();
      const stats = {
        totalRuns: (task.stats?.totalRuns ?? 0) + 1,
        successRuns: (task.stats?.successRuns ?? 0) + 1,
        failedRuns: task.stats?.failedRuns ?? 0,
        totalRecords: (task.stats?.totalRecords ?? 0) + totalRecords,
        lastDuration: duration,
        lastRun: now,
        lastError: null,
      };

      await Promise.all([
        taskRepo.updateStatus(task._id, "idle", { stats }),
        Run.findOneAndUpdate(
          { runId },
          {
            status: "completed",
            pages: pageLog,
            totalRecords,
            totalPages: pagesVisited,
            duration,
            finishedAt: now,
          },
        ),
      ]);

      logger.info("Парсинг завершено", {
        taskId: task._id,
        runId,
        totalRecords,
        duration: formatDuration(duration),
      });
      emit(task._id, {
        type: "run:complete",
        runId,
        totalRecords,
        pages: pagesVisited,
        duration,
      });

      return { runId, totalRecords, duration, pages: pagesVisited };
    } catch (err) {
      // If a cancel was requested but the task threw before the cancellation check
      // ran inside the pagination loop, the taskId would stay in the Set forever
      // and cause the next run of this task to be immediately cancelled.
      cancelledTasks.delete(String(task._id));

      const duration = Date.now() - startTime;
      logger.error("Парсинг завершився з помилкою", {
        taskId: task._id,
        runId,
        error: err.message,
      });
      emit(task._id, { type: "run:error", runId, error: err.message });

      await Promise.all([
        taskRepo.updateStatus(task._id, "error", {
          "stats.totalRuns": (task.stats?.totalRuns ?? 0) + 1,
          "stats.failedRuns": (task.stats?.failedRuns ?? 0) + 1,
          "stats.lastError": err.message,
          "stats.lastDuration": duration,
          "stats.lastRun": new Date(),
        }),
        Run.findOneAndUpdate(
          { runId },
          {
            status: "error",
            pages: pageLog,
            duration,
            finishedAt: new Date(),
            error: err.message,
          },
        ),
      ]);

      throw err;
    }
  }

  /**
   * Будує нормалізований список запитів із конфігурації задачі.
   *
   * Якщо task.requests[] непорожній — використовує його.
   * Інакше обгортає єдиний task.url у список із одного елемента
   * (зворотна сумісність зі старим форматом).
   *
   * @param {object} task - Документ задачі
   * @returns {Array<{ url, method, body, headers, cookies, selectors }>}
   */
  _buildRequestList(task) {
    if (task.requests?.length) {
      return task.requests.map((r) => ({
        url: r.url,
        method: r.method ?? "GET",
        body: r.body?.data
          ? { format: r.body.format ?? "json", data: r.body.data }
          : null,
        headers:
          r.headers instanceof Map
            ? Object.fromEntries(r.headers)
            : (r.headers ?? {}),
        cookies: r.cookies ?? null,
        selectors: r.selectors ?? null,
      }));
    }

    // Режим одного URL — зворотна сумісність
    return [
      {
        url: task.url,
        method: task.options?.method ?? "GET",
        body: task.options?.body?.data
          ? {
              format: task.options.body.format ?? "json",
              data: task.options.body.data,
            }
          : null,
        headers: {},
        cookies: null,
        selectors: null,
      },
    ];
  }

  /**
   * Формує об'єкт fetchOptions для рушія, об'єднуючи загальні параметри задачі
   * з перевизначеннями конкретного запиту.
   *
   * Пріоритет: параметри запиту > параметри задачі > значення за замовчуванням.
   *
   * @param {object} task  - Документ задачі
   * @param {object} req   - Нормалізований запит із _buildRequestList
   * @param {object} proxy - Поточний об'єкт проксі або null
   * @returns {object} Об'єкт параметрів для engine.fetchPage()
   */
  _buildFetchOptions(task, req, proxy) {
    const taskHeaders = task.options?.headers
      ? task.options.headers instanceof Map
        ? Object.fromEntries(task.options.headers)
        : typeof task.options.headers === "object"
          ? task.options.headers
          : {}
      : {};

    const mergedHeaders = {
      ...taskHeaders,
      ...req.headers,
      ...(task.options?.ajaxHeader
        ? { "X-Requested-With": "XMLHttpRequest" }
        : {}),
    };
    return {
      timeout: proxy
        ? (task.options?.timeout ?? 60000)
        : (task.options?.timeout ?? 30000),
      headers: mergedHeaders,
      cookies: req.cookies ?? task.options?.cookies ?? null,
      antiBot: task.options?.antiBot ?? true,
      method: req.method,
      body: req.body,
      proxy,
      jsonHtmlField: task.options?.jsonHtmlField ?? null,
      jsonPath: task.options?.jsonPath ?? null,
    };
  }

  /**
   * Рекурсивно проходить поля типу "лінк на іншу сторінку" з follow:true,
   * отримує сторінку/API і merge-ує результат у rec.
   *
   * Два режими на кожному рівні:
   *   - є subSelectors → extractRecord / JSON-path у конкретні поля
   *   - немає subSelectors + є urlTemplate → зберігаємо весь JSON як `${fieldName}_data`
   *
   * @param {object}             rec       - Запис, що мутується
   * @param {Map<string,object>} fieldsMap - Поля для аналізу
   * @param {string}             baseUrl   - Базовий URL для resolveUrl
   * @param {object}             ctx       - { engine, fetchOptions, taskId, runId, idx, emit }
   * @param {number}             [depth=0] - Глибина рекурсії (макс. 5)
   */
  async _followFields(rec, fieldsMap, baseUrl, ctx, depth = 0) {
    if (depth > 4) return;

    const followEntries = [...fieldsMap.entries()].filter(
      ([, cfg]) =>
        cfg.type === 'лінк на іншу сторінку' &&
        cfg.follow !== false &&
        (cfg.urlTemplate || (cfg.subSelectors && Object.keys(cfg.subSelectors).length > 0)),
    );

    for (const [fieldName, cfg] of followEntries) {
      const subFieldsMap = this._resolveFields(cfg.subSelectors);
      const hasSubFields = subFieldsMap.size > 0;

      // Двофазна логіка:
      // Фаза 1 (якщо є subSelectors): йдемо за href → витягуємо sub-поля (напр. goods_id)
      // Фаза 2 (якщо є urlTemplate):  підставляємо тепер заповнені значення → API запит
      // Якщо лише urlTemplate без subSelectors: відразу підставляємо поточні значення rec

      if (hasSubFields) {
        // Фаза 1: follow href → extract sub-fields
        const hrefUrl = rec[fieldName];
        if (!hrefUrl || typeof hrefUrl !== 'string') continue;
        const pageUrl = resolveUrl(hrefUrl, baseUrl);
        try {
          ctx.emit(ctx.taskId, { type: 'follow:start', runId: ctx.runId, url: pageUrl, field: fieldName, index: ctx.idx });
          // Чекаємо поки перший sub-елемент з'явиться у DOM (важливо для веб-компонентів)
          const firstSubSelector = [...subFieldsMap.values()][0]?.selector || null;
          const phase1Opts = firstSubSelector
            ? { ...ctx.fetchOptions, waitFor: firstSubSelector }
            : ctx.fetchOptions;
          const { $: f$ } = await ctx.engine.fetchPage(pageUrl, phase1Opts);
          const subData = extractRecord(f$, f$('body'), subFieldsMap, pageUrl);
          logger.debug('[FOLLOW FIELD] phase1 subData', { fieldName, subData });
          Object.assign(rec, subData);
          ctx.emit(ctx.taskId, { type: 'follow:done', runId: ctx.runId, url: pageUrl, field: fieldName, index: ctx.idx, preview: dataPreview(subData) });
        } catch (e) {
          rec[`${fieldName}_error`] = e.message;
          ctx.emit(ctx.taskId, { type: 'follow:error', runId: ctx.runId, url: pageUrl, field: fieldName, index: ctx.idx, error: e.message });
          logger.warn('[FOLLOW FIELD] фаза 1 помилка', { taskId: ctx.taskId, fieldName, url: pageUrl, error: e.message });
          continue;
        }

        // Затримка між фазами (налаштовується через options.followDelay)
        if (cfg.urlTemplate && ctx.followDelay > 0) {
          await cancellableSleep(ctx.taskId, ctx.followDelay, ctx.followDelay * 1.5);
        }

        // Фаза 2: якщо є urlTemplate — тепер підставляємо (goods_id вже в rec)
        if (cfg.urlTemplate) {
          // Перевіряємо що всі {{vars}} заповнені непорожніми значеннями
          const templateVars = [...cfg.urlTemplate.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1].trim());
          const emptyVars = templateVars.filter(v => rec[v] == null || rec[v] === '');
          if (emptyVars.length > 0) {
            logger.warn('[FOLLOW FIELD] urlTemplate vars пусті, пропускаємо API запит', { fieldName, emptyVars });
            continue;
          }
          const apiRaw = subst(cfg.urlTemplate, rec);
          if (!apiRaw || /\{\{/.test(apiRaw)) {
            logger.warn('[FOLLOW FIELD] urlTemplate не вдалося заповнити', { fieldName, template: cfg.urlTemplate });
            continue;
          }
          const apiUrl = resolveUrl(apiRaw, baseUrl);
          try {
            ctx.emit(ctx.taskId, { type: 'follow:start', runId: ctx.runId, url: apiUrl, field: `${fieldName}→api`, index: ctx.idx });
            const apiEngine = ctx.staticEngine ?? ctx.engine;
            const { $: a$ } = await apiEngine.fetchPage(apiUrl, ctx.fetchOptions);
            let apiData;
            let jsonObj = null;
            try { jsonObj = JSON.parse(a$('body').text()); } catch { /* not JSON */ }
            if (jsonObj) {
              const jFields = Array.isArray(cfg.jsonFields) && cfg.jsonFields.length ? cfg.jsonFields : null;
              if (jFields) {
                // Нова конфігурація jsonFields: [{path, key, format, separator}]
                apiData = {};
                for (const jf of jFields) {
                  const colKey = jf.key || pathToKey(jf.path);
                  const rawVal = resolveJsonPath(jsonObj, jf.path);
                  apiData[`${fieldName}_${colKey}`] = applyJsonFormat(rawVal, jf.format, jf.separator, jf.template);
                  // Зберігаємо сирий масив об'єктів для переформатування при експорті
                  if (Array.isArray(rawVal) && rawVal.some(v => v !== null && typeof v === 'object')) {
                    apiData[`${fieldName}_${colKey}__raw`] = JSON.stringify(rawVal);
                  }
                }
              } else if (cfg.subJsonPath) {
                // Зворотна сумісність: рядок "data.models[].name|..."
                apiData = {};
                for (const p of cfg.subJsonPath.split('|').map(s => s.trim()).filter(Boolean)) {
                  apiData[`${fieldName}_${pathToKey(p)}`] = resolveJsonPath(jsonObj, p);
                }
              } else {
                apiData = { [`${fieldName}_data`]: jsonObj };
              }
            } else {
              apiData = { [`${fieldName}_data`]: a$('body').text() };
            }
            Object.assign(rec, apiData);
            ctx.emit(ctx.taskId, { type: 'follow:done', runId: ctx.runId, url: apiUrl, field: `${fieldName}→api`, index: ctx.idx, preview: dataPreview(apiData) });
          } catch (e) {
            rec[`${fieldName}_api_error`] = e.message;
            ctx.emit(ctx.taskId, { type: 'follow:error', runId: ctx.runId, url: apiUrl, field: `${fieldName}→api`, index: ctx.idx, error: e.message });
            logger.warn('[FOLLOW FIELD] фаза 2 (API) помилка', { taskId: ctx.taskId, fieldName, url: apiUrl, error: e.message });
          }
        }

        // Рекурсія в sub-поля (якщо вони теж мають follow)
        await this._followFields(rec, subFieldsMap, rec[fieldName] ? resolveUrl(rec[fieldName], baseUrl) : baseUrl, ctx, depth + 1);

      } else {
        // Лише urlTemplate без subSelectors — підставляємо поточні значення rec
        const rawUrl = subst(cfg.urlTemplate, rec);
        if (!rawUrl || typeof rawUrl !== 'string' || /\{\{/.test(rawUrl)) continue;
        const targetUrl = resolveUrl(rawUrl, baseUrl);
        try {
          ctx.emit(ctx.taskId, { type: 'follow:start', runId: ctx.runId, url: targetUrl, field: fieldName, index: ctx.idx });
          const { $: f$ } = await ctx.engine.fetchPage(targetUrl, ctx.fetchOptions);
          let jsonObj = null;
          try { jsonObj = JSON.parse(f$('body').text()); } catch { /* not JSON */ }
          let apiData;
          if (jsonObj && cfg.subJsonPath) {
            const nested = resolveJsonPath(jsonObj, cfg.subJsonPath);
            apiData = { [`${fieldName}_data`]: Array.isArray(nested) ? nested[0] : nested };
          } else {
            apiData = { [`${fieldName}_data`]: jsonObj ?? f$('body').text() };
          }
          Object.assign(rec, apiData);
          ctx.emit(ctx.taskId, { type: 'follow:done', runId: ctx.runId, url: targetUrl, field: fieldName, index: ctx.idx, preview: dataPreview(apiData) });
        } catch (e) {
          rec[`${fieldName}_error`] = e.message;
          ctx.emit(ctx.taskId, { type: 'follow:error', runId: ctx.runId, url: targetUrl, field: fieldName, index: ctx.idx, error: e.message });
          logger.warn('[FOLLOW FIELD] помилка', { taskId: ctx.taskId, fieldName, url: targetUrl, error: e.message });
        }
      }
    }
  }

  /**
   * Прямий JSON-режим: витягує записи з масиву JSON-об'єктів без HTML bridge.
   * Поле field.selector трактується як JSON-шлях (підтримує [] нотацію).
   * Якщо selector порожній — використовується ім'я поля як ключ у JSON-об'єкті.
   */
  _extractJsonRecords(items, fields) {
    const records = [];
    for (const item of items) {
      const record = {};
      for (const [name, field] of fields.entries()) {
        const path = field.selector || name; // selector = JSON шлях або ім'я поля
        const raw = resolveJsonPath(item, path);
        if (raw == null) {
          record[name] = '';
          continue;
        }
        if (Array.isArray(raw)) {
          const sep = field.attr || ', '; // attr перевикористовується як роздільник у JSON-режимі
          record[name] = raw
            .map(v => (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v ?? ''))
            .join(sep);
        } else {
          record[name] = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
        }
        if (field.transform) {
          const { applyTransform } = require('../../utils/helpers');
          record[name] = applyTransform(record[name], field.transform) ?? '';
        }
      }
      const hasData = Object.values(record).some(v => v !== '');
      if (hasData) records.push(record);
    }
    return records;
  }

  /**
   * Конвертує карту полів із Mongoose (Map або plain object) у стандартний Map.
   *
   * @param {Map|object|null|undefined} fields - Вхідна карта полів
   * @returns {Map<string, object>}
   */
  _resolveFields(fields) {
    if (!fields) return new Map();
    if (fields instanceof Map) return fields;
    return new Map(Object.entries(fields));
  }
}

const instance = new ParserService();
instance.cancel = (taskId) => cancelledTasks.add(String(taskId));
module.exports = instance;
