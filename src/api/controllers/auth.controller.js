/**
 * @swagger
 * tags:
 *   name: Авторизація
 *   description: Кінцеві точки авторизації
 */
const jwt = require("jsonwebtoken");
const User = require("../../db/models/user.model");
const logger = require("../../utils/logger");

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || "7d";

const signToken = (user) =>
  jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES,
  });

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Зареєструвати нового користувача
 *     tags: [Авторизація]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password]
 *             properties:
 *               username: { type: string, description: "Ім'я користувача" }
 *               email: { type: string, format: email, description: "Електронна пошта" }
 *               password: { type: string, minLength: 6, description: "Пароль (мінімум 6 символів)" }
 */
exports.register = async (req, res, next) => {
  try {
    const { username, email, password } = req.body;

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      return res
        .status(409)
        .json({ success: false, message: "Username or email already taken" });
    }

    const user = await User.create({ username, email, password });
    const token = signToken(user);

    logger.info("User registered", { userId: user._id, username });
    res.status(201).json({ success: true, token, user });
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Увійти та отримати JWT токен
 *     tags: [Авторизація]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email, description: "Електронна пошта" }
 *               password: { type: string, description: "Пароль" }
 *     responses:
 *       200:
 *         description: Успішний вхід
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 token: { type: string, description: "JWT токен" }
 *                 user: { $ref: '#/components/schemas/User' }
 */
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select("+password");
    if (!user || !(await user.comparePassword(password))) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    const token = signToken(user);
    logger.info("User logged in", { userId: user._id });
    res.json({ success: true, token, user });
  } catch (err) {
    next(err);
  }
};

exports.me = async (req, res) => {
  res.json({ success: true, user: req.user });
};
