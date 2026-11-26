/**
 * Запуск OpenVPN-тунелів для vpn.daemon.
 *
 * openvpn потребує root (tun-пристрій, адреса, правила маршрутизації), тому запускається через `sudo -n`
 * (у користувача сервера sudo без пароля) або напряму, якщо демон уже root. Env:
 *   OPENVPN_BIN — шлях до openvpn (за замовчуванням `openvpn`);
 *   VPN_SUDO=0  — не використовувати sudo.
 *
 * Маршрутизація «лише для парсера»: openvpn запускається з route-nopull, тож таблиця main (SSH, сайт,
 * MongoDB) не змінюється. Скрипт up додає окрему таблицю з маршрутом за замовчуванням у tun і правило
 * `ip rule from <IP тунелю> lookup <таблиця>` — у тунель іде тільки те, що SOCKS-сервер відкриває з IP тунелю.
 */
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const BIN = process.env.OPENVPN_BIN || "openvpn";
const USE_SUDO = process.env.VPN_SUDO !== "0" && typeof process.getuid === "function" && process.getuid() !== 0;

const ROUTE_SCRIPT = `#!/bin/sh
# Викликає openvpn (від root) при піднятті/знятті тунелю парсера. Згенеровано vpn.daemon.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
T="$PARSER_TABLE"; P="$PARSER_PRIO"
[ -n "$T" ] && [ -n "$P" ] || exit 1
while ip rule del lookup "$T" 2>/dev/null; do :; done
ip route flush table "$T" 2>/dev/null
if [ "$script_type" = "up" ]; then
  ip route replace default dev "$dev" table "$T" || exit 1
  ip rule add from "$ifconfig_local" lookup "$T" priority "$P" || exit 1
  sysctl -qw "net.ipv4.conf.$dev.rp_filter=2" 2>/dev/null
fi
exit 0
`;

/** Ім'я пристрою, таблиця й пріоритет правила — від локального порту SOCKS (41001–41999), унікальні. */
const netParams = (port) => ({ dev: `pvpn${port}`, table: port, priority: 10000 + (port % 1000) });

const configPath = (dir, id) => path.join(dir, `${id}.ovpn`);
const authPath = (dir, id) => path.join(dir, `${id}.auth`);

function ensureRouteScript(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "ovpn-route.sh");
  let cur = null;
  try { cur = fs.readFileSync(file, "utf8"); } catch { /* ще немає */ }
  if (cur !== ROUTE_SCRIPT) fs.writeFileSync(file, ROUTE_SCRIPT, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

/**
 * Пише конфіг (і файл логіна, якщо треба). Повертає шлях до конфігу.
 * @param {Function} build - buildOpenVpnConfig з core/proxy/ovpn-config
 */
function writeFiles(dir, id, vpn, build) {
  const script = ensureRouteScript(dir);
  let authFile;
  if (vpn.vpnNeedsAuth) {
    authFile = authPath(dir, id);
    fs.writeFileSync(authFile, `${vpn.vpnUsername || "vpn"}\n${vpn.vpnPassword || "vpn"}\n`, { mode: 0o600 });
  }
  const file = configPath(dir, id);
  fs.writeFileSync(file, build(vpn.ovpnConfig, { ...netParams(vpn.port), script, authFile }), { mode: 0o600 });
  return file;
}

function removeFiles(dir, id) {
  for (const f of [configPath(dir, id), authPath(dir, id)]) {
    try { fs.unlinkSync(f); } catch { /* немає файлу */ }
  }
}

function spawnOpenVpn(file) {
  const args = ["--config", file];
  return USE_SUDO
    ? spawn("sudo", ["-n", BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    : spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Зупинити openvpn, що лишився від попереднього запуску демона (pm2 kill, падіння) —
 * інакше tun-пристрій зайнятий і новий процес не стартує.
 * @param {string} pathPattern - конкретний файл конфігу або тека VPN_DIR (тоді всі тунелі парсера)
 */
function killStale(pathPattern) {
  // «[-]-config» — щоб шаблон не збігся з командним рядком самого pkill/sudo, де він записаний
  const pattern = `[-]-config ${escapeRe(pathPattern)}`;
  const args = ["-TERM", "-f", "--", pattern];
  const cmd = USE_SUDO ? ["sudo", ["-n", "pkill", ...args]] : ["pkill", args];
  const r = spawnSync(cmd[0], cmd[1], { timeout: 5000 });
  return r.status === 0; // 0 — когось зупинили, 1 — нікого не було
}

/** IPv4 tun-пристрою (null, якщо ще немає). `ip addr` працює без root. */
function readTunIp(dev) {
  try {
    const out = execFileSync("ip", ["-4", "-o", "addr", "show", "dev", dev], { timeout: 3000, encoding: "utf8" });
    return out.match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1] || null;
  } catch {
    return null;
  }
}

module.exports = { BIN, USE_SUDO, netParams, writeFiles, removeFiles, spawnOpenVpn, killStale, readTunIp, configPath };
