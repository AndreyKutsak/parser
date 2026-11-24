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

  // Результат останньої перевірки
  lastError:   { type: String },   // причина останньої невдалої перевірки
  exitIp:      { type: String },   // IP, який бачать сайти через цей проксі
  transparent: { type: Boolean, default: false }, // проксі розкриває IP нашого сервера

  country: { type: String },
  tags:    [{ type: String }],
  note:    { type: String },

  // ── VPN (WireGuard) ───────────────────────────────────────────────────────
  // kind='vpn': тунель піднімає окремий процес vpn.daemon (wireproxy), а парсер ходить через
  // локальний SOCKS5 host=127.0.0.1:port — для решти коду це звичайний socks5-проксі.
  kind:        { type: String, enum: ['proxy', 'vpn'], default: 'proxy' },
  name:        { type: String },                     // назва для людини, напр. «NL Amsterdam»
  wgConfig:    { type: String, select: false },      // вміст .conf (містить приватний ключ — не віддаємо в API)
  vpnEndpoint: { type: String },                     // Endpoint з [Peer] — для показу в списку
  vpnEnabled:  { type: Boolean, default: true },     // false — тунель зупинено
  vpnStatus:   { type: String, enum: ['starting', 'running', 'error', 'stopped'] },
  vpnError:    { type: String },
  vpnStartedAt:{ type: Date },

  // Остання перевірка на конкретному сайті: { url, ok, status, responseTime, title, blocked, error, at }
  lastSiteCheck: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

// Build the proxy URL string
proxySchema.virtual('url').get(function () {
  const auth = this.username ? `${this.username}:${this.password}@` : '';
  return `${this.protocol}://${auth}${this.host}:${this.port}`;
});

proxySchema.index({ status: 1, lastUsed: 1 });

module.exports = mongoose.model('Proxy', proxySchema);
