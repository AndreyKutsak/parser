/**
 * @swagger
 * tags:
 *   name: Проксі
 *   description: Управління проксі
 */
const proxyRepo = require("../../db/repositories/proxy.repository");
const proxyManager = require("../../core/proxy/proxy.manager");
const logger = require("../../utils/logger");

/**
 * @swagger
 * /api/proxies:
 *   get:
 *     summary: Отримати список проксі
 *     tags: [Проксі]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, inactive, checking]
 *         description: "Фільтр за статусом"
 *       - in: query
 *         name: protocol
 *         schema:
 *           type: string
 *           enum: [http, https, socks4, socks5]
 *         description: "Фільтр за протоколом"
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
 *           default: 50
 *         description: Кількість елементів на сторінку
 *     responses:
 *       200:
 *         description: Список проксі
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 proxies: { type: array, items: { $ref: '#/components/schemas/Proxy' } }
 *                 total: { type: integer }
 *                 page: { type: integer }
 *                 pages: { type: integer }
 */
exports.list = async (req, res, next) => {
  try {
    const { status, protocol, page = 1, limit = 50 } = req.query;
    const result = await proxyRepo.findAll({
      status,
      protocol,
      page: parseInt(page),
      limit: parseInt(limit),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/proxies:
 *   post:
 *     summary: Створити новий проксі
 *     tags: [Проксі]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Proxy'
 *     responses:
 *       201:
 *         description: Проксі створено
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 proxy: { $ref: '#/components/schemas/Proxy' }
 */
exports.create = async (req, res, next) => {
  try {
    const proxy = await proxyManager.addProxy(req.body);
    res.status(201).json({ success: true, proxy });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/proxies/import:
 *   post:
 *     summary: Імпортувати проксі з тексту
 *     tags: [Проксі]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [text]
 *             properties:
 *               text: { type: string, description: "Текст з проксі (один на рядок, формат: host:port або host:port:username:password)" }
 *               protocol: { type: string, enum: [http, https, socks4, socks5], default: http, description: 'Протокол за замовчуванням' }
 *               username: { type: string, description: "Ім'я користувача за замовчуванням" }
 *               password: { type: string, description: "Пароль за замовчуванням" }
 *     responses:
 *       200:
 *         description: Проксі імпортовано
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 imported: { type: integer, description: 'Кількість імпортованих проксі' }
 *                 skipped: { type: integer, description: 'Кількість пропущених (дублікати)' }
 */
exports.importBulk = async (req, res, next) => {
  try {
    const { text, protocol, username, password } = req.body;
    const result = await proxyManager.importFromText(text, {
      protocol,
      username,
      password,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const proxy = await proxyRepo.findById(req.params.id);
    if (!proxy)
      return res
        .status(404)
        .json({ success: false, message: "Proxy not found" });
    res.json({ success: true, proxy });
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const proxy = await proxyRepo.update(req.params.id, req.body);
    if (!proxy)
      return res
        .status(404)
        .json({ success: false, message: "Proxy not found" });
    res.json({ success: true, proxy });
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await proxyManager.removeProxy(req.params.id);
    res.json({ success: true, message: "Proxy deleted" });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/proxies/bulk-delete:
 *   post:
 *     summary: Видалити кілька проксі
 *     tags: [Проксі]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Масив ID проксі для видалення
 *     responses:
 *       200:
 *         description: Проксі видалено
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 deleted: { type: integer }
 *                 total: { type: integer }
 */
exports.removeBulk = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "ids must be a non-empty array" });
    }
    const result = await proxyManager.removeMultiple(ids);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/proxies/{id}/check:
 *   post:
 *     summary: Перевірити окремий проксі (з визначенням країни)
 *     tags: [Проксі]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID проксі
 *     responses:
 *       200:
 *         description: Результат перевірки з деталями
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 ok: { type: boolean, example: true, description: 'Чи працює проксі' }
 *                 responseTime: { type: integer, example: 245, description: 'Час відповіді в мс' }
 *                 ip: { type: string, example: "1.2.3.4", description: 'Зовнішня IP адреса проксі' }
 *                 country: { type: string, example: "US", description: 'Код країни (ISO 3166-1 alpha-2)' }
 *                 protocol: { type: string, example: "SOCKS5", description: 'Тип протоколу' }
 *                 error: { type: string, example: null, description: 'Текст помилки, якщо є' }
 *                 proxy:
 *                   type: object
 *                   description: Оновлена інформація проксі
 *                   properties:
 *                     _id: { type: string }
 *                     host: { type: string }
 *                     port: { type: integer }
 *                     protocol: { type: string }
 *                     status: { type: string }
 *                     country: { type: string }
 *                     responseTime: { type: integer }
 *                     failCount: { type: integer }
 *                     useCount: { type: integer }
 *                     lastChecked: { type: string, format: date-time }
 */
exports.check = async (req, res, next) => {
  try {
    const result = await proxyManager.checkById(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/proxies/check-all:
 *   post:
 *     summary: Перевірити всі активні проксі (у фоні)
 *     tags: [Проксі]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Перевірка розпочата
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Перевірка проксі розпочата у фоні" }
 */
exports.checkAll = async (req, res, next) => {
  try {
    // Run in background; return immediately
    proxyManager
      .checkAll()
      .catch((e) => logger.error("Proxy check error", { error: e.message }));
    res.json({ success: true, message: "Proxy check started in background" });
  } catch (err) {
    next(err);
  }
};

exports.stats = async (req, res, next) => {
  try {
    const stats = await proxyManager.getStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    next(err);
  }
};
