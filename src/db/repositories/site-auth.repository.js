const SiteAuth = require('../models/site-auth.model');

const list = (owner) =>
  SiteAuth.find({ owner }).sort({ updatedAt: -1 }).lean();

const findById = (id, owner) =>
  SiteAuth.findOne({ _id: id, owner }).lean();

const create = (data) =>
  SiteAuth.create(data);

const update = (id, owner, data) =>
  SiteAuth.findOneAndUpdate({ _id: id, owner }, data, { new: true }).lean();

const remove = (id, owner) =>
  SiteAuth.deleteOne({ _id: id, owner });

const setCookies = (id, cookies) =>
  SiteAuth.findByIdAndUpdate(id, {
    cookies,
    cookiesUpdatedAt: new Date(),
    status: 'active',
    lastError: null,
  }, { new: true }).lean();

const setError = (id, message) =>
  SiteAuth.findByIdAndUpdate(id, {
    status: 'error',
    lastError: message,
  }).lean();

module.exports = { list, findById, create, update, remove, setCookies, setError };
