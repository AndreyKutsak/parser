/**
 * @swagger
 * tags:
 *   name: Експорт
 *   description: Кінцеві точки експорту даних
 */
const taskRepo = require("../../db/repositories/task.repository");
const exporterService = require("../../core/exporter/exporter.service");
const logger = require("../../utils/logger");

const getTaskOrFail = async (id, res) => {
  const task = await taskRepo.findById(id);
  if (!task) {
    res.status(404).json({ success: false, message: "Task not found" });
    return null;
  }
  return task;
};

const parseFieldLabels = (value) => {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
};

const parseFieldTypes = (value) => {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
};

const parseArray = (value) =>
  Array.isArray(value) ? value : value ? [value] : [];

const parseJsonConfig = (value) => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
};

const parseExportParams = (query) => ({
  fields: parseArray(query.fields),
  fieldLabels: parseFieldLabels(query.fieldLabels),
  fieldTypes: parseFieldTypes(query.fieldTypes),
  uniqueField: query.uniqueField || null,
  aggregateFields: parseArray(query.aggregateFields),
  mode: query.mode || null,
  deltaFields: parseArray(query.deltaFields),
  dateFrom: query.dateFrom || null,
  dateTo: query.dateTo || null,
  jsonConfig: parseJsonConfig(query.jsonConfig),
  filters: {
    status: query.status,
    changed: query.changed,
    search: query.search,
    createdAtFrom: query.filterFrom || null,
    createdAtTo: query.filterTo || null,
  },
});

/**
 * @swagger
 * /api/tasks/{taskId}/export/json:
 *   get:
 *     summary: Експортувати дані у форматі JSON
 *     tags: [Експорт]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *       - in: query
 *         name: runId
 *         schema:
 *           type: string
 *         description: ID запуску для експорту (опціонально, експортує всі якщо не вказано)
 *     responses:
 *       200:
 *         description: JSON файл з даними
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 */
exports.json = async (req, res, next) => {
  try {
    const task = await getTaskOrFail(req.params.taskId, res);
    if (!task) return;
    const p = parseExportParams(req.query);
    const data = await exporterService.toJson(String(task._id), {
      runId: req.query.runId,
      keyField: task.selectors?.keyField || null,
      ...p,
    });

    const filename = req.query.runId
      ? `${sanitize(task.category || task.name)}_run_${req.query.runId.slice(-8)}`
      : `${sanitize(task.category || task.name)}`;

    res
      .set({
        "Content-Type": "application/json",
        "Content-Disposition": createContentDisposition(filename, "json"),
      })
      .send(data);
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{taskId}/export/csv:
 *   get:
 *     summary: Експортувати дані у форматі CSV
 *     tags: [Експорт]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *       - in: query
 *         name: runId
 *         schema:
 *           type: string
 *         description: ID запуску для експорту (опціонально)
 *     responses:
 *       200:
 *         description: CSV файл з даними
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 */
exports.csv = async (req, res, next) => {
  try {
    const task = await getTaskOrFail(req.params.taskId, res);
    if (!task) return;
    const p = parseExportParams(req.query);
    const data = await exporterService.toCsv(String(task._id), {
      runId: req.query.runId,
      keyField: task.selectors?.keyField || null,
      ...p,
    });

    const filename = req.query.runId
      ? `${sanitize(task.category || task.name)}_run_${req.query.runId.slice(-8)}`
      : `${sanitize(task.category || task.name)}`;

    res
      .set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": createContentDisposition(filename, "csv"),
      })
      .send("\uFEFF" + data); // BOM for Excel UTF-8 compatibility
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{taskId}/export/excel:
 *   get:
 *     summary: Експортувати дані у форматі Excel
 *     tags: [Експорт]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *       - in: query
 *         name: runId
 *         schema:
 *           type: string
 *         description: ID запуску для експорту (опціонально)
 *     responses:
 *       200:
 *         description: Excel файл з даними
 *         content:
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema:
 *               type: string
 *               format: binary
 */
exports.excel = async (req, res, next) => {
  try {
    const task = await getTaskOrFail(req.params.taskId, res);
    if (!task) return;
    const p = parseExportParams(req.query);

    const filename = req.query.runId
      ? `${sanitize(task.category || task.name)}_run_${req.query.runId.slice(-8)}`
      : `${sanitize(task.category || task.name)}`;

    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": createContentDisposition(filename, "xlsx"),
    });

    // Pass res directly — ExcelJS streams the workbook without a second in-memory buffer
    await exporterService.toExcel(String(task._id), {
      runId: req.query.runId,
      taskName: task.name,
      keyField: task.selectors?.keyField || null,
      ...p,
      stream: res,
    });
  } catch (err) {
    next(err);
  }
};

const unescape = (s) =>
  String(s ?? "").replace(/\\t/g, "\t").replace(/\\n/g, "\n");

exports.txt = async (req, res, next) => {
  try {
    const task = await getTaskOrFail(req.params.taskId, res);
    if (!task) return;
    const p = parseExportParams(req.query);
    const data = await exporterService.toTxt(String(task._id), {
      runId: req.query.runId,
      fieldSep: unescape(req.query.fieldSep ?? "\t"),
      recordSep: unescape(req.query.recordSep ?? "\n"),
      template: req.query.template || null,
      includeHeader: req.query.includeHeader !== "false",
      keyField: task.selectors?.keyField || null,
      ...p,
    });

    const filename = req.query.runId
      ? `${sanitize(task.category || task.name)}_run_${req.query.runId.slice(-8)}`
      : `${sanitize(task.category || task.name)}`;

    res
      .set({
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": createContentDisposition(filename, "txt"),
      })
      .send("\uFEFF" + data);
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/export/domains:
 *   get:
 *     summary: Список доменів з кількістю задач
 *     tags: [Експорт]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Масив доменів
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 domains:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       domain: { type: string, example: "example.com" }
 *                       taskCount: { type: integer, example: 3 }
 */
exports.domains = async (req, res, next) => {
  try {
    const domains = await taskRepo.getAllDomains();
    res.json({ success: true, domains });
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /api/export/domain/fields:
 *   get:
 *     summary: Поля результатів для вказаного домену
 *     tags: [Експорт]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: domain
 *         required: true
 *         schema: { type: string }
 *         description: Домен (наприклад, example.com)
 *     responses:
 *       200:
 *         description: Список полів
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 fields: { type: array, items: { type: string } }
 */
exports.domainFields = async (req, res, next) => {
  try {
    const { domain } = req.query;
    if (!domain) return res.status(400).json({ success: false, message: "domain required" });
    const tasks = await taskRepo.findByDomain(domain);
    if (!tasks.length) return res.json({ success: true, fields: [] });
    const resultRepo = require("../../db/repositories/result.repository");
    const fieldSet = new Set();
    for (const task of tasks.slice(0, 5)) {
      const { items } = await resultRepo.findByTask(String(task._id), { limit: 3 });
      items.forEach((r) => Object.keys(r.data || {}).forEach((k) => fieldSet.add(k)));
    }
    res.json({ success: true, fields: [...fieldSet] });
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /api/export/domain:
 *   get:
 *     summary: Експортувати всі результати по домену
 *     tags: [Експорт]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: domain
 *         required: true
 *         schema: { type: string }
 *         description: Домен (наприклад, example.com)
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [json, csv, excel, txt], default: json }
 *         description: Формат вивантаження
 *       - in: query
 *         name: filterFrom
 *         schema: { type: string, format: date }
 *         description: Дата початку фільтру (YYYY-MM-DD)
 *       - in: query
 *         name: filterTo
 *         schema: { type: string, format: date }
 *         description: Дата кінця фільтру (YYYY-MM-DD)
 *       - in: query
 *         name: fields
 *         schema: { type: array, items: { type: string } }
 *         style: form
 *         explode: true
 *         description: Поля для включення у вивантаження
 *       - in: query
 *         name: uniqueField
 *         schema: { type: string }
 *         description: Поле для дедуплікації
 *       - in: query
 *         name: mode
 *         schema: { type: string, enum: [delta] }
 *         description: delta — розрахунок змін між знімками
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date }
 *         description: Початок delta-діапазону (YYYY-MM-DD)
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date }
 *         description: Кінець delta-діапазону (YYYY-MM-DD)
 *     responses:
 *       200:
 *         description: Файл вивантаження (JSON / CSV / Excel / TXT)
 *         content:
 *           application/json:
 *             schema: { type: array, items: { type: object } }
 *           text/csv:
 *             schema: { type: string }
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema: { type: string, format: binary }
 *           text/plain:
 *             schema: { type: string }
 *       400:
 *         description: Не вказано domain
 */
exports.byDomain = async (req, res, next) => {
  try {
    const domain = req.query.domain;
    if (!domain) return res.status(400).json({ success: false, message: "domain required" });
    const format = req.query.format || "json";
    const p = parseExportParams(req.query);
    const opts = {
      ...p,
      fieldSep: unescape(req.query.fieldSep ?? "\t"),
      recordSep: unescape(req.query.recordSep ?? "\n"),
      template: req.query.template || null,
      includeHeader: req.query.includeHeader !== "false",
    };
    const filename = sanitize(domain);
    if (format === "csv") {
      const data = await exporterService.domainToCsv(domain, opts);
      return res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": createContentDisposition(filename, "csv") }).send("\uFEFF" + data);
    }
    if (format === "excel") {
      const buffer = await exporterService.domainToExcel(domain, opts);
      return res.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": createContentDisposition(filename, "xlsx") }).send(buffer);
    }
    if (format === "txt") {
      const data = await exporterService.domainToTxt(domain, opts);
      return res.set({ "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": createContentDisposition(filename, "txt") }).send("\uFEFF" + data);
    }
    const data = await exporterService.domainToJson(domain, opts);
    res.set({ "Content-Type": "application/json", "Content-Disposition": createContentDisposition(filename, "json") }).send(data);
  } catch (err) {
    next(err);
  }
};

const sanitize = (name) => {
  if (!name || String(name).trim().length === 0) {
    name = "Export";
  }

  const safeName = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "") // Remove dangerous characters, keep spaces
    .trim()
    .slice(0, 80);

  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `Результати — ${safeName} ${dd}.${mm}.${yyyy} ${hh}:${min}`;
};

const CYR_MAP = {
  а: "a",
  б: "b",
  в: "v",
  г: "h",
  ґ: "g",
  д: "d",
  е: "e",
  є: "ie",
  ж: "zh",
  з: "z",
  и: "y",
  і: "i",
  ї: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ь: "",
  ю: "iu",
  я: "ia",
  ё: "yo",
  э: "e",
  ъ: "",
  ы: "y",
};

const transliterate = (str) =>
  str
    .split("")
    .map((ch) => {
      const lo = ch.toLowerCase();
      const t = CYR_MAP[lo];
      if (t === undefined) return ch;
      return ch === ch.toUpperCase() && ch !== lo ? t.toUpperCase() : t;
    })
    .join("");

const createContentDisposition = (filename, format) => {
  const ext = format === "excel" ? "xlsx" : format;
  const asciiFilename = transliterate(filename)
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/:/g, ".")
    .replace(/[<>"/\\|?*]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 120);
  const encodedFilename = encodeURIComponent(filename);
  return `attachment; filename="${asciiFilename}.${ext}"; filename*=UTF-8''${encodedFilename}.${ext}`;
};
