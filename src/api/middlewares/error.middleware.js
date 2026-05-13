const logger = require('../../utils/logger');

/**
 * Central error handler — must be registered last in Express middleware chain
 */
const errorHandler = (err, req, res, next) => {
  // Mongoose validation errors
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({ success: false, message: 'Validation error', errors: messages });
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({ success: false, message: `Duplicate ${field}` });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }

  // Joi validation
  if (err.isJoi) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const status = err.statusCode || err.status || 500;
  const message = err.message || 'Internal server error';

  logger.error('Unhandled error', { status, message, path: req.path, method: req.method, stack: err.stack });

  res.status(status).json({
    success: false,
    message: process.env.NODE_ENV === 'production' && status === 500 ? 'Internal server error' : message,
  });
};

/**
 * 404 handler — must be before errorHandler
 */
const notFound = (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
};

module.exports = { errorHandler, notFound };
