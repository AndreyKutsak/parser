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
