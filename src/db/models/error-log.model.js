const mongoose = require('mongoose');

/**
 * Агреговані помилки сервера: один документ = одна "сигнатура" помилки за одну годину.
 * Так обсяг колекції обмежений (групи × години) навіть під час шквалу однакових помилок,
 * а з погодинних бакетів можна порахувати кількість за будь-який період.
 */
const sampleSchema = new mongoose.Schema({
  at:      { type: Date },
  message: { type: String },
  meta:    { type: mongoose.Schema.Types.Mixed },
  stack:   { type: String },
}, { _id: false });

const errorLogSchema = new mongoose.Schema({
  fingerprint: { type: String, required: true },
  hour:        { type: Date, required: true },    // початок години (UTC)
  process:     { type: String, required: true },  // app | parser.worker | ...
  // server — помилка нашого сервера; site — сайт повернув 4xx/5xx або не відповів; api — наш API віддав 429
  kind:        { type: String, enum: ['server', 'site', 'api'], default: 'server' },
  domain:      { type: String, default: null },   // для site — домен сайту, для api — IP клієнта
  status:      { type: Number, default: null },   // HTTP-код (якщо є)
  level:       { type: String, default: 'error' },
  message:     { type: String },                  // перший рядок повідомлення (з першої появи)
  count:       { type: Number, default: 0 },
  firstAt:     { type: Date },
  lastAt:      { type: Date },
  samples:     { type: [sampleSchema], default: [] }, // останні N появ у цій годині
}, { timestamps: false, versionKey: false });

errorLogSchema.index({ fingerprint: 1, hour: 1, process: 1 }, { unique: true });
errorLogSchema.index({ lastAt: -1 });
errorLogSchema.index({ kind: 1, hour: -1 });
// Автоочищення через 30 днів
errorLogSchema.index({ hour: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model('ErrorLog', errorLogSchema);
