const mongoose = require('mongoose');

const pageLogSchema = new mongoose.Schema({
  url:        { type: String },
  page:       { type: Number },
  method:     { type: String, default: 'GET' },
  records:    { type: Number, default: 0 },
  durationMs: { type: Number },
  status:     { type: String, enum: ['ok', 'error', 'skipped'], default: 'ok' },
  error:      { type: String },
}, { _id: false, timestamps: false });

const runSchema = new mongoose.Schema({
  taskId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
  runId:        { type: String, required: true, unique: true },
  status:       { type: String, enum: ['running', 'completed', 'error'], default: 'running' },
  pages:        { type: [pageLogSchema], default: [] },
  totalRecords: { type: Number, default: 0 },
  totalPages:   { type: Number, default: 0 },
  duration:     { type: Number },   // ms
  startedAt:    { type: Date, default: Date.now },
  finishedAt:   { type: Date },
  error:        { type: String },
}, { timestamps: false });

runSchema.index({ taskId: 1, startedAt: -1 });

module.exports = mongoose.model('Run', runSchema);
