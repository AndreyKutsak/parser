const { rawLogin } = require('../../core/site-auth/raw-login');
const logger = require('../../utils/logger');

/**
 * POST /api/tasks/raw-login — пряма HTTP-авторизація на сайті конкурента, виконана цим
 * сервером (тим самим клієнтом/IP, що потім скрейпить сторінки товарів). Захищено тим самим
 * статичним токеном, що і /api/tasks/preview — призначено для зовнішніх cron-скриптів.
 */
exports.rawLogin = async (req, res) => {
  const { url, method, requestFields, successPattern } = req.body || {};

  if (!url || !Array.isArray(requestFields) || requestFields.length === 0) {
    return res.status(400).json({ success: false, message: 'Поля url і requestFields (непорожній масив) обовʼязкові' });
  }

  try {
    const result = await rawLogin(url, method, requestFields, successPattern || '');
    res.json(result);
  } catch (err) {
    logger.warn('Raw login: помилка', { url, error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};
