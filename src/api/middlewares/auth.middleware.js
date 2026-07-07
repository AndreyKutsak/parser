const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../../db/models/user.model');
const logger = require('../../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

/**
 * Protect routes with a static API token (env PREVIEW_API_TOKEN) instead of
 * a per-user JWT — for tooling/scripts that shouldn't need a logged-in user.
 */
const requireApiToken = (req, res, next) => {
  const expected = process.env.PREVIEW_API_TOKEN;
  if (!expected) {
    return res.status(503).json({ success: false, message: 'PREVIEW_API_TOKEN is not configured' });
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-token'] || '');

  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid) {
    return res.status(401).json({ success: false, message: 'Invalid or missing API token' });
  }
  next();
};

/**
 * Protect routes — requires a valid Bearer JWT token
 */
const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(payload.id).select('-password');
    if (!user) return res.status(401).json({ success: false, message: 'User not found' });

    req.user = user;
    next();
  } catch (err) {
    logger.debug('JWT verification failed', { error: err.message });
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

/**
 * Require admin role
 */
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
};

/**
 * Optional auth — populates req.user if token present, but doesn't block
 */
const optionalAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(payload.id).select('-password');
  } catch { /* ignore */ }
  next();
};

module.exports = { requireAuth, requireAdmin, optionalAuth, requireApiToken };
