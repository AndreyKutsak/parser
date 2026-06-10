/**
 * @swagger
 * tags:
 *   name: Завдання
 *   description: Управління завданнями парсера
 */
const jwt = require("jsonwebtoken");
const taskRepo = require("../../db/repositories/task.repository");
const Run = require("../../db/models/run.model");
const parserService = require("../../core/parser/parser.service");
const queueManager = require("../../queue/queue.manager");
const scheduler = require("../../core/scheduler/scheduler.service");
const parseEvents = require("../../utils/parse-events");
const logger = require("../../utils/logger");

/**
 * @swagger
 * /api/tasks:
 *   get:
 *     summary: Отримати список завдань
 *     tags: [Завдання]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [idle, running, paused, error]
 *         description: Фільтр за статусом
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
 *           default: 20
 *           maximum: 100
 *         description: Кількість елементів на сторінку
 *     responses:
 *       200:
 *         description: Список завдань
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 tasks: { type: array, items: { $ref: '#/components/schemas/Task' } }
 *                 total: { type: integer, description: 'Загальна кількість' }
 *                 page: { type: integer, description: 'Поточна сторінка' }
 *                 pages: { type: integer, description: 'Загальна кількість сторінок' }
 */
exports.list = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const result = await taskRepo.findAll({
      owner: req.user._id,
      status,
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks:
 *   post:
 *     summary: Створити нове завдання
 *     tags: [Завдання]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Task'
 *     responses:
 *       201:
 *         description: Завдання створено
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 task: { $ref: '#/components/schemas/Task' }
 */
exports.create = async (req, res, next) => {
  try {
    const task = await taskRepo.create({ ...req.body, owner: req.user._id });

    // Register cron schedule if provided
    if (task.schedule?.enabled && task.schedule?.cron) {
      scheduler.scheduleTask(task);
    }

    logger.info("Task created", { taskId: task._id, name: task.name });
    res.status(201).json({ success: true, task });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{id}:
 *   get:
 *     summary: Отримати завдання за ID
 *     tags: [Завдання]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *     responses:
 *       200:
 *         description: Деталі завдання
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 task: { $ref: '#/components/schemas/Task' }
 *       404:
 *         description: Завдання не знайдено
 */
exports.get = async (req, res, next) => {
  try {
    const task = await taskRepo.findById(req.params.id);
    if (!task)
      return res
        .status(404)
        .json({ success: false, message: "Task not found" });
    res.json({ success: true, task });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{id}:
 *   put:
 *     summary: Оновити завдання
 *     tags: [Завдання]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Task'
 *     responses:
 *       200:
 *         description: Завдання оновлено
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 task: { $ref: '#/components/schemas/Task' }
 *       404:
 *         description: Завдання не знайдено
 */
exports.update = async (req, res, next) => {
  try {
    const task = await taskRepo.update(req.params.id, req.body);
    if (!task)
      return res
        .status(404)
        .json({ success: false, message: "Task not found" });

    // Re-register schedule
    scheduler.unscheduleTask(task._id);
    if (task.schedule?.enabled && task.schedule?.cron) {
      scheduler.scheduleTask(task);
    }

    res.json({ success: true, task });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{id}:
 *   delete:
 *     summary: Видалити завдання
 *     tags: [Завдання]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *     responses:
 *       200:
 *         description: Завдання видалено
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Завдання видалено" }
 *       404:
 *         description: Завдання не знайдено
 */
exports.remove = async (req, res, next) => {
  try {
    scheduler.unscheduleTask(req.params.id);
    // Also disable all sub-tasks for this task
    const subtaskRepo = require("../../db/repositories/subtask.repository");
    const subtaskScheduler = require("../../core/subtask/subtask.scheduler");
    const subTasks = await subtaskRepo.findByParent(req.params.id);
    for (const st of subTasks) {
      subtaskScheduler.unschedule(st._id);
      await subtaskRepo.update(st._id, { "schedule.enabled": false });
    }
    const task = await taskRepo.delete(req.params.id);
    if (!task)
      return res
        .status(404)
        .json({ success: false, message: "Task not found" });
    res.json({ success: true, message: "Task deleted" });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{id}/run:
 *   post:
 *     summary: Запустити завдання негайно
 *     tags: [Завдання]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *     responses:
 *       200:
 *         description: Завдання запущено
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Завдання розпочато" }
 *                 jobId: { type: string, description: 'ID завдання в черзі' }
 *       409:
 *         description: Завдання вже виконується
 */
exports.run = async (req, res, next) => {
  try {
    const task = await taskRepo.findById(req.params.id);
    if (!task)
      return res
        .status(404)
        .json({ success: false, message: "Task not found" });

    if (task.status === "running") {
      return res
        .status(409)
        .json({ success: false, message: "Task is already running" });
    }

    // Queue the job (async) or run synchronously if queue disabled
    const result = await queueManager.addJob(String(task._id), { engine: task.engine || 'static' });

    res.json({ success: true, message: "Task started", ...result });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{id}/pause:
 *   post:
 *     summary: Призупинити планувальник завдання
 *     tags: [Завдання]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *     responses:
 *       200:
 *         description: Завдання призупинено
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Завдання призупинено" }
 */
exports.pause = async (req, res, next) => {
  try {
    await scheduler.pauseTask(req.params.id);
    res.json({ success: true, message: "Task paused" });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{id}/resume:
 *   post:
 *     summary: Відновити планувальник завдання
 *     tags: [Завдання]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *     responses:
 *       200:
 *         description: Завдання відновлено
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Завдання відновлено" }
 */
exports.resume = async (req, res, next) => {
  try {
    await scheduler.resumeTask(req.params.id);
    res.json({ success: true, message: "Task resumed" });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{id}/stop:
 *   post:
 *     summary: Зупинити виконуюче завдання
 *     tags: [Завдання]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *     responses:
 *       200:
 *         description: Сигнал зупинки надіслано
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Сигнал зупинки надіслано" }
 *       409:
 *         description: Завдання не виконується
 */
exports.stop = async (req, res, next) => {
  try {
    const task = await taskRepo.findById(req.params.id);
    if (!task)
      return res
        .status(404)
        .json({ success: false, message: "Task not found" });
    if (task.status !== "running")
      return res
        .status(409)
        .json({ success: false, message: "Task is not running" });

    // Also disable all sub-tasks for this task
    const subtaskRepo = require("../../db/repositories/subtask.repository");
    const subtaskScheduler = require("../../core/subtask/subtask.scheduler");
    const subTasks = await subtaskRepo.findByParent(req.params.id);
    for (const st of subTasks) {
      subtaskScheduler.unschedule(st._id);
      await subtaskRepo.update(st._id, { "schedule.enabled": false });
    }

    await taskRepo.update(req.params.id, { status: "stopped" });
    parserService.cancel(req.params.id);
    res.json({ success: true, message: "Stop signal sent" });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{id}/runs:
 *   get:
 *     summary: Отримати останні запуски завдання
 *     tags: [Завдання]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *     responses:
 *       200:
 *         description: Список запусків
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 runs: { type: array, items: { type: object, properties: { _id: { type: string }, startedAt: { type: string, format: date-time }, completedAt: { type: string, format: date-time }, status: { type: string }, pagesProcessed: { type: integer }, itemsFound: { type: integer } } } }
 */
exports.getRuns = async (req, res, next) => {
  try {
    const runs = await Run.find({ taskId: req.params.id })
      .sort({ startedAt: -1 })
      .limit(20)
      .lean();
    res.json({ success: true, runs });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/tasks/{id}/live:
 *   get:
 *     summary: Потік подій парсингу в режимі реального часу (SSE)
 *     tags: [Завдання]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID завдання
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: JWT токен для авторизації
 *     responses:
 *       200:
 *         description: Потік Server-Sent Events з подіями парсингу
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: "data: {\"type\":\"page:start\",\"url\":\"https://example.com\"}\n\n"
 */
exports.live = (req, res) => {
  // Verify JWT from query string
  const token = req.query.token;
  if (!token) return res.status(401).end();
  try {
    jwt.verify(token, process.env.JWT_SECRET || "dev_secret");
  } catch {
    return res.status(401).end();
  }

  const taskId = req.params.id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx/proxy buffering
  res.flushHeaders();

  const write = (event) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const onEvent = (event) => {
    write(event);
    if (event.type === "run:complete" || event.type === "run:error") {
      cleanup();
      res.end();
    }
  };

  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 20000);

  const cleanup = () => {
    clearInterval(keepalive);
    parseEvents.off(taskId, onEvent);
  };

  parseEvents.on(taskId, onEvent);
  req.on("close", cleanup);

  write({ type: "connected", taskId });
};

/**
 * @swagger
 * /api/tasks/queue/stats:
 *   get:
 *     summary: Статистика черги та запланованих завдань
 *     tags: [Завдання]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Статистика черги
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 queue: { type: object, properties: { waiting: { type: integer }, active: { type: integer }, completed: { type: integer }, failed: { type: integer } } }
 *                 scheduledTasks: { type: integer, description: 'Кількість запланованих завдань' }
 */
exports.queueStats = async (req, res, next) => {
  try {
    const stats = await queueManager.getStats();
    const scheduled = scheduler.getScheduledIds();
    res.json({ success: true, queue: stats, scheduledTasks: scheduled.length });
  } catch (err) {
    next(err);
  }
};
