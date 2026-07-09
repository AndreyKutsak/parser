const mongoose = require('mongoose');

const extraFieldSchema = new mongoose.Schema(
  {
    selector: { type: String, required: true },
    value:    { type: String, required: true },
  },
  { _id: false },
);

const siteAuthSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    loginUrl: { type: String, required: true },

    // 'form'   — Playwright fills the form automatically
    // 'manual' — user pastes cookies directly
    type: { type: String, enum: ['form', 'manual'], default: 'form' },

    formConfig: {
      usernameSelector: { type: String, default: null },
      passwordSelector: { type: String, default: null },
      submitSelector:   { type: String, default: null },
      successSelector:  { type: String, default: null },
      extraFields:      { type: [extraFieldSchema], default: [] },
    },

    credentials: {
      username: { type: String, default: null },
      password: { type: String, default: null },
    },

    // Saved session cookies (raw "key=val; key2=val2" string)
    cookies:          { type: String, default: null },
    cookiesUpdatedAt: { type: Date,   default: null },

    status:    { type: String, enum: ['pending', 'active', 'error'], default: 'pending' },
    lastError: { type: String, default: null },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('SiteAuth', siteAuthSchema);
