/**
 * Розбір, перевірка й підготовка OpenVPN-конфігу (.ovpn) для VPN-тунелів (напр. сервери VPN Gate, *.opengw.net).
 *
 * openvpn працює від root (через sudo), тому з конфігу користувача беремо ЛИШЕ директиви з білого списку:
 * `up`, `down`, `script-security`, `plugin`, `route`, `redirect-gateway`, `dev`, шляхи до файлів тощо відкидаються —
 * інакше конфіг міг би виконати довільну команду на сервері або змінити його маршрути (SSH, сайт).
 * Свої директиви (пристрій, маршрутизація лише для парсера, скрипт up/down) дописує buildOpenVpnConfig.
 */

// Директиви, які можна безпечно передати openvpn. Значення — скільки аргументів дозволено (не більше).
const ALLOWED = {
  client: 0, 'tls-client': 0, pull: 0, nobind: 0, float: 0, 'persist-key': 0,
  'auth-nocache': 0, 'mute-replay-warnings': 0, 'remote-random': 0,
  remote: 3, proto: 1, port: 1, 'resolv-retry': 1, 'connect-retry': 2, 'connect-retry-max': 1,
  'server-poll-timeout': 1, 'hand-window': 1, 'tls-timeout': 1, 'reneg-sec': 2, 'explicit-exit-notify': 1,
  'remote-cert-tls': 1, 'ns-cert-type': 1, 'verify-x509-name': 2, 'remote-cert-ku': 4, 'remote-cert-eku': 1,
  cipher: 1, 'ncp-ciphers': 1, 'data-ciphers': 1, 'data-ciphers-fallback': 1, auth: 1,
  'tls-version-min': 2, 'tls-version-max': 1, 'tls-cipher': 1, 'tls-ciphersuites': 1, 'key-direction': 1,
  'comp-lzo': 1, compress: 1, 'allow-compression': 1,
  keepalive: 2, ping: 1, 'ping-restart': 1, 'tun-mtu': 1, mssfix: 1, fragment: 1, sndbuf: 1, rcvbuf: 1,
  'replay-window': 2,
};

// Директиви, які відкидаємо мовчки: їх задаємо самі або вони не потрібні тунелю «лише для парсера».
const IGNORED = new Set([
  'dev', 'dev-type', 'persist-tun', 'verb', 'mute', 'auth-user-pass', 'route-nopull', 'redirect-gateway',
  'route', 'route-ipv6', 'route-delay', 'route-method', 'block-outside-dns', 'dhcp-option', 'register-dns',
  'setenv', 'setenv-safe', 'ignore-unknown-option', 'pull-filter', 'topology', 'win-sys', 'ip-win32',
  'push-peer-info', 'http-proxy-retry', 'log', 'log-append', 'status', 'writepid',
]);

// Вбудовані блоки <tag>…</tag>, які пропускаємо (сертифікати й ключі).
const INLINE = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'extra-certs']);
// Директиви, що в .ovpn можуть посилатися на файл — підтримуємо лише вбудовані блоки.
const FILE_REFS = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'extra-certs', 'pkcs12', 'secret']);

const SAFE_ARG = /^[A-Za-z0-9._:@+\-\/=,]+$/; // без лапок, пробілів і спецсимволів оболонки

/** Розбиває рядок на токени, знімаючи лапки ("a b" → a b). */
const tokenize = (line) => (line.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));

/**
 * @param {string} text - вміст .ovpn
 * @returns {{ directives: Array<{name:string,args:string[]}>, blocks: Object<string,string>, dropped: string[], errors: string[] }}
 */
function parseOvpnConfig(text) {
  const directives = [];
  const blocks = {};
  const dropped = [];
  const errors = [];
  let block = null; // { tag, lines }

  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (block) {
      if (line.toLowerCase() === `</${block.tag}>`) {
        if (INLINE.has(block.tag)) blocks[block.tag] = block.lines.join('\n');
        else dropped.push(`<${block.tag}>`);
        block = null;
      } else block.lines.push(line);
      continue;
    }
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const open = line.match(/^<([a-z0-9-]+)>$/i);
    if (open) { block = { tag: open[1].toLowerCase(), lines: [] }; continue; }

    const [rawName, ...args] = tokenize(line);
    const name = rawName.replace(/^--/, '').toLowerCase();

    if (FILE_REFS.has(name)) {
      // «tls-auth [inline] 1» — допустимо; «ca ca.crt», «tls-auth ta.key 1» — файл на диску, не підтримуємо
      if (args.length && args[0] !== '[inline]') {
        errors.push(`«${name} ${args[0]}» посилається на файл — вставте конфіг із вбудованим блоком <${name}>…</${name}>`);
      }
      if (name === 'tls-auth' && /^[01]$/.test(args[1] || '')) directives.push({ name: 'key-direction', args: [args[1]] });
      continue;
    }
    if (name === 'dev' && args[0] && !/^tun/i.test(args[0])) errors.push(`Підтримується лише «dev tun» (у конфігу «dev ${args[0]}»)`);
    if (name === 'dev-type' && args[0] && args[0].toLowerCase() !== 'tun') errors.push(`Підтримується лише «dev-type tun»`);
    if (IGNORED.has(name)) { if (name === 'auth-user-pass') directives.push({ name, args: [] }); continue; }

    const max = ALLOWED[name];
    if (max === undefined) { dropped.push(name); continue; }
    if (args.length > max || !args.every((a) => SAFE_ARG.test(a))) { dropped.push(line.slice(0, 60)); continue; }
    directives.push({ name, args });
  }
  if (block) errors.push(`Блок <${block.tag}> не закрито`);
  return { directives, blocks, dropped, errors };
}

/**
 * Перевіряє конфіг. Повертає помилки (порожньо — гаразд) і відомості для UI.
 * @returns {{ errors: string[], endpoint: string|null, proto: string|null, needsAuth: boolean, dropped: string[] }}
 */
function validateOvpnConfig(text) {
  const { directives, blocks, dropped, errors } = parseOvpnConfig(text);
  const remotes = directives.filter((d) => d.name === 'remote');
  const get = (n) => directives.find((d) => d.name === n)?.args;

  if (!remotes.length) errors.push('Немає рядка «remote <хост> <порт>»');
  if (!blocks.ca) errors.push('Немає сертифіката сервера <ca>…</ca>');
  if (blocks.cert && !blocks.key) errors.push('Є <cert>, але немає <key>');
  if (!/^\s*(client|tls-client|pull)\b/im.test(String(text || ''))) errors.push('Це не клієнтський конфіг (немає «client»)');

  const r = remotes[0]?.args || [];
  const proto = (r[2] || get('proto')?.[0] || 'udp').toLowerCase();
  const port = r[1] || get('port')?.[0] || '1194';
  return {
    errors,
    endpoint: r[0] ? `${r[0]}:${port}` : null,
    proto: proto.startsWith('tcp') ? 'tcp' : 'udp',
    needsAuth: directives.some((d) => d.name === 'auth-user-pass'),
    dropped,
  };
}

/**
 * Готовий конфіг для openvpn: очищені директиви користувача + наші.
 * @param {string} text - .ovpn користувача
 * @param {object} o
 * @param {string} o.dev        - ім'я tun-пристрою (напр. pvpn41001)
 * @param {number} o.table      - номер таблиці маршрутизації для цього тунелю
 * @param {number} o.priority   - пріоритет правила `ip rule`
 * @param {string} o.script     - шлях до скрипта up/down
 * @param {string} [o.authFile] - файл «логін\nпароль», якщо сервер вимагає auth-user-pass
 */
function buildOpenVpnConfig(text, { dev, table, priority, script, authFile }) {
  const { directives, blocks } = parseOvpnConfig(text);
  const has = (n) => directives.some((d) => d.name === n);
  const lines = ['# Згенеровано vpn.daemon — не редагувати вручну'];

  for (const d of directives) {
    if (d.name === 'auth-user-pass') continue;
    lines.push([d.name, ...d.args].join(' '));
  }

  // Сумісність зі старими серверами (VPN Gate: AES-128-CBC, клієнтський сертифікат із підписом SHA1 —
  // OpenSSL 3 без SECLEVEL=0 відхиляє його з «ca md too weak»).
  const cipher = directives.find((d) => d.name === 'cipher')?.args[0];
  if (!has('data-ciphers')) lines.push(`data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305${cipher ? `:${cipher}` : ':AES-256-CBC:AES-128-CBC'}`);
  if (cipher && !has('data-ciphers-fallback')) lines.push(`data-ciphers-fallback ${cipher}`);
  if (!has('tls-cipher')) lines.push('tls-cipher DEFAULT:@SECLEVEL=0');

  lines.push(
    '',
    '# Тунель лише для парсера: маршрути сервера не змінюються, трафік іде в тунель тільки з його адреси',
    `dev ${dev}`,
    'dev-type tun',
    'route-nopull',
    'pull-filter ignore "redirect-gateway"',
    'pull-filter ignore "dhcp-option"',
    'pull-filter ignore "block-outside-dns"',
    'pull-filter ignore "ifconfig-ipv6"',
    'pull-filter ignore "route-ipv6"',
    'script-security 2',
    `setenv PARSER_TABLE ${table}`,
    `setenv PARSER_PRIO ${priority}`,
    `up ${script}`,
    `down ${script}`,
    'verb 3',
  );
  if (authFile) lines.push(`auth-user-pass ${authFile}`, 'auth-nocache');

  for (const tag of INLINE) {
    if (blocks[tag]) lines.push(`<${tag}>`, blocks[tag], `</${tag}>`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { parseOvpnConfig, validateOvpnConfig, buildOpenVpnConfig };
