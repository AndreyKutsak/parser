const siteAuthRepo   = require('../../db/repositories/site-auth.repository');
const siteAuthService = require('../../core/site-auth/site-auth.service');

const list = async (req, res) => {
  const items = await siteAuthRepo.list(req.user._id);
  res.json({ success: true, items });
};

const create = async (req, res) => {
  const doc = await siteAuthRepo.create({ ...req.body, owner: req.user._id });
  res.status(201).json({ success: true, item: doc });
};

const update = async (req, res) => {
  const item = await siteAuthRepo.update(req.params.id, req.user._id, req.body);
  if (!item) return res.status(404).json({ success: false, message: 'Не знайдено' });
  res.json({ success: true, item });
};

const remove = async (req, res) => {
  await siteAuthRepo.remove(req.params.id, req.user._id);
  res.json({ success: true });
};

// POST /:id/authenticate — run Playwright form login
const authenticate = async (req, res) => {
  try {
    const result = await siteAuthService.run(req.params.id, req.user._id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// PUT /:id/cookies — manually set cookie string
const setCookies = async (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ success: false, message: 'Поле cookies обовʼязкове' });
  const item = await siteAuthRepo.setCookies(req.params.id, cookies);
  res.json({ success: true, item });
};

module.exports = { list, create, update, remove, authenticate, setCookies };
