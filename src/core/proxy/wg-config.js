/**
 * Розбір і перевірка WireGuard-конфігу (.conf) для VPN-тунелів через wireproxy.
 *
 * wireproxy піднімає WireGuard у userspace (без root і без змін мережі сервера) і відкриває
 * локальний SOCKS5 — парсер ходить через нього як через звичайний проксі.
 */

// Ключі, які розуміє wireproxy. Решту (PostUp, Table, SaveConfig…) відкидаємо — інакше він не стартує.
const ALLOWED = {
  interface: ['PrivateKey', 'Address', 'DNS', 'MTU', 'ListenPort'],
  peer: ['PublicKey', 'PresharedKey', 'Endpoint', 'AllowedIPs', 'PersistentKeepalive'],
};
const KEY_RE = /^[A-Za-z0-9+/]{42,43}=?$/; // base64 ключ WireGuard (32 байти)

const canon = (section, key) =>
  ALLOWED[section].find((k) => k.toLowerCase() === key.toLowerCase()) || null;

/**
 * @param {string} text - вміст .conf
 * @returns {{ iface: object, peers: object[] }}
 */
function parseWgConfig(text) {
  const iface = {};
  const peers = [];
  let cur = null;
  let section = null;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const sec = line.match(/^\[(\w+)\]$/);
    if (sec) {
      section = sec[1].toLowerCase();
      if (section === 'interface') cur = iface;
      else if (section === 'peer') { cur = {}; peers.push(cur); }
      else cur = null; // невідома секція — ігноруємо
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || !cur) continue;
    const key = canon(section, line.slice(0, eq).trim());
    if (!key) continue;
    cur[key] = line.slice(eq + 1).trim();
  }
  return { iface, peers };
}

/**
 * Перевіряє конфіг. Повертає масив помилок (порожній — усе гаразд) і короткі відомості для UI.
 */
function validateWgConfig(text) {
  const { iface, peers } = parseWgConfig(text);
  const errors = [];
  if (!/\[Interface\]/i.test(text || '')) errors.push('Немає секції [Interface]');
  if (!iface.PrivateKey) errors.push('[Interface]: немає PrivateKey');
  else if (!KEY_RE.test(iface.PrivateKey)) errors.push('[Interface]: PrivateKey має неправильний формат');
  if (!iface.Address) errors.push('[Interface]: немає Address');
  if (!peers.length) errors.push('Немає секції [Peer]');
  peers.forEach((p, i) => {
    const n = peers.length > 1 ? ` #${i + 1}` : '';
    if (!p.PublicKey) errors.push(`[Peer${n}]: немає PublicKey`);
    else if (!KEY_RE.test(p.PublicKey)) errors.push(`[Peer${n}]: PublicKey має неправильний формат`);
    if (!p.Endpoint) errors.push(`[Peer${n}]: немає Endpoint`);
    else if (!/^(\[[0-9a-fA-F:]+\]|[^\s:]+):\d{1,5}$/.test(p.Endpoint)) errors.push(`[Peer${n}]: Endpoint має бути у вигляді host:port`);
  });
  return { errors, endpoint: peers[0]?.Endpoint || null, address: iface.Address || null };
}

/**
 * Конфіг для wireproxy: очищений WireGuard + секція [Socks5] на локальному порту.
 * Якщо DNS не задано — ставимо 1.1.1.1 (wireproxy резолвить імена сайтів через тунель).
 */
function buildWireproxyConfig(text, socksPort) {
  const { iface, peers } = parseWgConfig(text);
  const lines = ['[Interface]'];
  for (const k of ALLOWED.interface) if (iface[k]) lines.push(`${k} = ${iface[k]}`);
  if (!iface.DNS) lines.push('DNS = 1.1.1.1');
  for (const p of peers) {
    lines.push('', '[Peer]');
    for (const k of ALLOWED.peer) if (p[k]) lines.push(`${k} = ${p[k]}`);
    if (!p.AllowedIPs) lines.push('AllowedIPs = 0.0.0.0/0, ::/0');
    if (!p.PersistentKeepalive) lines.push('PersistentKeepalive = 25');
  }
  lines.push('', '[Socks5]', `BindAddress = 127.0.0.1:${socksPort}`, '');
  return lines.join('\n');
}

module.exports = { parseWgConfig, validateWgConfig, buildWireproxyConfig };
