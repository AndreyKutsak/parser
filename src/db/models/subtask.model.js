/**
 * SubTask — recurring re-parse of a single item URL discovered by a parent task.
 *
 * lifecycle:
 *   parent task runs → discovers item URLs → creates SubTask docs (upsert by url)
 *   SubTaskScheduler polls 'schedule.nextRun <= now' → calls subtask.service.run()
 *   run() fetches URL, extracts data, hashes result
 *     → if hash changed: stores full data in history entry
 *     → always: updates lastParsedAt, lastData, lastHash, nextRun
 */
const mongoose = require('mongoose');

// One entry in the parse history (embedded, capped at HISTORY_LIMIT via $slice in repo)
const historyEntrySchema = new mongoose.Schema({
  parsedAt:  { type: Date,                          default: Date.now },
  duration:  { type: Number },                      // ms
  changed:   { type: Boolean,                       default: false },
  data:      { type: mongoose.Schema.Types.Mixed,   default: null }, // null when unchanged
  error:     { type: String,                        default: null },
}, { _id: false });

const subTaskSchema = new mongoose.Schema({
  parentTaskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
  url:          { type: String, required: true },

  // Selectors copied from parent at creation time (detailFields → fields fallback)
  selectors: {
    item:   { type: String,                        default: null },
    fields: { type: mongoose.Schema.Types.Mixed,   default: {} },
  },

  engine:  { type: String, enum: ['static', 'dynamic'], default: 'static' },
  options: { type: mongoose.Schema.Types.Mixed,   default: {} },
  proxy:   { type: mongoose.Schema.Types.Mixed,   default: {} },

  schedule: {
    enabled:         { type: Boolean, default: true },
    intervalMinutes: { type: Number,  default: 60 },
    cron:            { type: String,  default: null }, // custom cron overrides intervalMinutes
    nextRun:         { type: Date },
    lastRun:         { type: Date },
  },

  status:       { type: String, enum: ['idle', 'running', 'error'], default: 'idle' },
  lastData:     { type: mongoose.Schema.Types.Mixed, default: null },
  lastHash:     { type: String, default: null },
  lastParsedAt: { type: Date,   default: null },
  totalRuns:    { type: Number, default: 0 },
  changedRuns:  { type: Number, default: 0 },

  history: { type: [historyEntrySchema], default: [] },
}, { timestamps: true });

// Unique per parent+url so upserts are idempotent
subTaskSchema.index({ parentTaskId: 1, url: 1 }, { unique: true });
subTaskSchema.index({ 'schedule.nextRun': 1, 'schedule.enabled': 1 });

module.exports = mongoose.model('SubTask', subTaskSchema);
