/**
 * @swagger
 * tags:
 *   name: Результати
 *   description: Доступ до витягнутих даних
 */
const axios = require("axios");
const resultRepo = require("../../db/repositories/result.repository");

/**
 * @swagger
 * /api/tasks/{taskId}/results:
 *   get:
 *     summary: Отримати результати парсингу
 *     tags: [Результати]
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
 *         description: Фільтр за ID запуску
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Номер сторінки
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 1000
 *         description: Кількість елементів на сторінку
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [success, error]
 *         description: Фільтр за статусом
 *     responses:
 *       200:
 *         description: Список результатів
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 results: { type: array, items: { $ref: '#/components/schemas/Result' } }
 *                 total: { type: integer }
 *                 page: { type: integer }
 *                 pages: { type: integer }
 */
exports.list = async (req, res, next) => {
  try {
    const { runId, page = 1, limit = 100, status, changed, search } = req.query;
    const result = await resultRepo.findByTask(req.params.taskId, {
      runId,
      status,
      changed,
      search,
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 1000),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

exports.getRuns = async (req, res, next) => {
  try {
    const runs = await resultRepo.getRuns(req.params.taskId);
    res.json({ success: true, runs });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{taskId}/results/search:
 *   get:
 *     summary: Пошук результатів за назвою поля та значенням
 *     description: |
 *       Публічний endpoint — авторизація **не потрібна**.
 *
 *       Повертає всі збережені результати задачі, де `data.<field> === value`.
 *
 *       **Приклади запитів:**
 *       ```
 *       GET /api/tasks/665abc/results/search?field=price&value=100
 *       GET /api/tasks/665abc/results/search?field=status&value=active&limit=50
 *       GET /api/tasks/665abc/results/search?field=category&value=electronics&limit=500
 *       ```
 *
 *       **Обмеження:** максимум 5 000 записів за один запит.
 *     tags: [Результати]
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB ObjectId задачі
 *         example: "665abc123def456789012345"
 *       - in: query
 *         name: field
 *         required: true
 *         schema:
 *           type: string
 *         description: |
 *           Назва поля всередині об'єкта `data` (підтримуються вкладені поля через крапку,
 *           напр. `details.price`).
 *         example: price
 *       - in: query
 *         name: value
 *         required: true
 *         schema:
 *           type: string
 *         description: Значення для точного збігу. Рядок, число або булеве значення.
 *         example: "100"
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 1000
 *           minimum: 1
 *           maximum: 5000
 *         description: Максимальна кількість записів у відповіді.
 *     responses:
 *       200:
 *         description: Список результатів, що відповідають критерію пошуку
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 total:
 *                   type: integer
 *                   description: Кількість знайдених записів
 *                   example: 3
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       _id:        { type: string, example: "665abc000000000000000001" }
 *                       taskId:     { type: string, example: "665abc123def456789012345" }
 *                       runId:      { type: string, example: "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
 *                       url:        { type: string, example: "https://example.com/products" }
 *                       detailUrl:  { type: string, nullable: true, example: "https://example.com/product/42" }
 *                       page:       { type: integer, example: 1 }
 *                       seq:        { type: integer, example: 0 }
 *                       data:
 *                         type: object
 *                         description: Витягнуті дані (структура залежить від конфігурації задачі)
 *                         example: { "name": "Product A", "price": "100", "stock": "in stock" }
 *                       status:     { type: string, enum: [ok, error], example: "ok" }
 *                       fieldChanges:
 *                         type: array
 *                         description: Зміни значень порівняно з попереднім запуском
 *                         items:
 *                           type: object
 *                           properties:
 *                             fieldName: { type: string }
 *                             oldValue:  { }
 *                             newValue:  { }
 *                             changedAt: { type: string, format: date-time }
 *                       createdAt:  { type: string, format: date-time }
 *             example:
 *               success: true
 *               total: 2
 *               items:
 *                 - _id: "665abc000000000000000001"
 *                   taskId: "665abc123def456789012345"
 *                   runId: "f47ac10b-58cc-4372-a567-0e02b2c3d479"
 *                   url: "https://example.com/products"
 *                   detailUrl: null
 *                   page: 1
 *                   seq: 0
 *                   data: { name: "Product A", price: "100", stock: "in stock" }
 *                   status: "ok"
 *                   fieldChanges: []
 *                   createdAt: "2026-06-10T14:00:00.000Z"
 *       400:
 *         description: Не передано обов'язковий параметр `field` або `value`
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: "field and value are required" }
 *       404:
 *         description: Задача не знайдена або результатів немає (повертає порожній масив, не 404)
 */
exports.search = async (req, res, next) => {
  try {
    const { field, value, limit = 1000 } = req.query;
    if (!field || value === undefined || value === "") {
      return res.status(400).json({ success: false, message: "field and value are required" });
    }
    const items = await resultRepo.findByFieldValue(
      req.params.taskId,
      field,
      value,
      { limit: Math.min(parseInt(limit) || 1000, 5000) },
    );
    res.json({ success: true, total: items.length, items });
  } catch (err) {
    next(err);
  }
};

exports.deleteResults = async (req, res, next) => {
  try {
    const { runId } = req.query;
    if (runId) {
      await resultRepo.deleteByRun(req.params.taskId, runId);
    } else {
      await resultRepo.deleteByTask(req.params.taskId);
    }
    res.json({ success: true, message: "Results deleted" });
  } catch (err) {
    next(err);
  }
};

exports.deleteOne = async (req, res, next) => {
  try {
    const r = await resultRepo.deleteById(
      req.params.taskId,
      req.params.resultId,
    );
    if (!r.deletedCount)
      return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, message: "Result deleted" });
  } catch (err) {
    next(err);
  }
};

exports.count = async (req, res, next) => {
  try {
    const total = await resultRepo.countByTask(req.params.taskId);
    res.json({ success: true, total });
  } catch (err) {
    next(err);
  }
};

exports.forwardToApi = async (req, res, next) => {
  try {
    const { taskId } = req.params;
    const { resultIds, apiUrl, method = "POST", headers = {}, bodyTemplate } = req.body;

    if (!apiUrl) return res.status(400).json({ success: false, message: "apiUrl required" });
    if (!Array.isArray(resultIds) || !resultIds.length)
      return res.status(400).json({ success: false, message: "resultIds required" });

    const records = await resultRepo.findByIds(taskId, resultIds);
    const summary = [];

    for (const record of records) {
      let requestBody;
      if (bodyTemplate) {
        const rendered = bodyTemplate.replace(/\{\{([^}]+)\}\}/g, (_, k) =>
          String(record.data?.[k] ?? ""),
        );
        try { requestBody = JSON.parse(rendered); } catch { requestBody = rendered; }
      } else {
        requestBody = record.data;
      }

      try {
        const response = await axios({ method, url: apiUrl, headers, data: requestBody, timeout: 30000 });
        await resultRepo.setApiResponse(record._id, { response: response.data });
        summary.push({ resultId: String(record._id), status: response.status, ok: true });
      } catch (err) {
        const errMsg = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message;
        await resultRepo.setApiResponse(record._id, { error: errMsg });
        summary.push({ resultId: String(record._id), ok: false, error: errMsg });
      }
    }

    const ok = summary.filter((s) => s.ok).length;
    res.json({ success: true, sent: ok, failed: summary.length - ok, results: summary });
  } catch (err) {
    next(err);
  }
};
