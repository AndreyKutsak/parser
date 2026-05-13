const mongoose = require('mongoose');

const proxySchema = new mongoose.Schema({
  host:     { type: String, required: true },
  port:     { type: Number, required: true },
  protocol: { type: String, enum: ['http', 'https', 'socks4', 'socks5'], default: 'http' },
  username: { type: String },
  password: { type: String },

  // Health status
  status:       { type: String, enum: ['active', 'inactive', 'checking', 'banned'], default: 'active' },
  lastChecked:  { type: Date },
  lastUsed:     { type: Date },
  responseTime: { type: Number },  // ms
  successRate:  { type: Number, default: 100 }, // percentage
  failCount:    { type: Number, default: 0 },
  useCount:     { type: Number, default: 0 },

  country: { type: String },
  tags:    [{ type: String }],
  note:    { type: String },
}, { timestamps: true });

// Build the proxy URL string
proxySchema.virtual('url').get(function () {
  const auth = this.username ? `${this.username}:${this.password}@` : '';
  return `${this.protocol}://${auth}${this.host}:${this.port}`;
});

proxySchema.index({ status: 1, lastUsed: 1 });

module.exports = mongoose.model('Proxy', proxySchema);
