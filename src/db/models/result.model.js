const mongoose = require("mongoose");

/**
 * Трекування змін поля: зберігає історію значень поля
 * @property {string} fieldName - назва поля, яке змінилось
 * @property {*}      oldValue  - попереднє значення
 * @property {*}      newValue  - нове значення
 * @property {Date}   changedAt - коли змінилось
 */
const fieldChangeSchema = new mongoose.Schema(
  {
    fieldName: { type: String, required: true },
    oldValue: { type: mongoose.Schema.Types.Mixed },
    newValue: { type: mongoose.Schema.Types.Mixed },
    changedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const resultSchema = new mongoose.Schema(
  {
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      required: true,
      index: true,
    },
    runId: { type: String, required: true, index: true }, // UUID per parse run
    url: { type: String }, // source URL of this result (listing page)
    detailUrl: { type: String, default: null }, // item detail page URL (used for sub-task join)
    page: { type: Number, default: 1 }, // which page it came from
    seq:  { type: Number, default: 0 }, // position within the page (0-based)
    data: { type: mongoose.Schema.Types.Mixed }, // the actual scraped data object
    status: { type: String, enum: ["ok", "error"], default: "ok" },
    error: { type: String },
    fieldChanges: [fieldChangeSchema], // історія змін моніторованих полів
    apiResponse: { type: mongoose.Schema.Types.Mixed, default: null }, // відповідь зовнішнього API
    apiSentAt:   { type: Date, default: null },
    apiError:    { type: String, default: null },
  },
  { timestamps: true },
);

resultSchema.index({ taskId: 1, createdAt: -1 });
resultSchema.index({ taskId: 1, runId: 1 });
// Change-detection queries
resultSchema.index({ taskId: 1, detailUrl: 1, runId: 1, createdAt: -1 });
resultSchema.index({ taskId: 1, page: 1, seq: 1, runId: 1, createdAt: -1 });

module.exports = mongoose.model("Result", resultSchema);
