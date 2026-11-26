/**
 * VPN-демон: тримає піднятими VPN-тунелі для записів Proxy з kind='vpn'.
 *   - WireGuard (vpnType відсутній або 'wireguard') — через wireproxy: userspace, без root, SOCKS5 на 127.0.0.1:<port>;
 *   - OpenVPN (vpnType='openvpn', напр. сервери VPN Gate) — openvpn через sudo + власний SOCKS5 (socks-server.js)
 *     на 127.0.0.1:<port>, вихідні з'єднання якого йдуть з IP тунелю (див. openvpn.js).
 *
 * Окремий процес pm2 ("vpn"), щоб тунелі не падали при перезапуску app/worker.
 * Кожні RECONCILE_MS звіряє БД із запущеними процесами:
 *   - новий/увімкнений VPN → пише конфіг і запускає тунель;
 *   - змінений конфіг/порт → перезапуск;
 *   - видалений/вимкнений → зупинка.
 * Після старту робить звичайну перевірку проксі (вихідний IP, країна) → status active/inactive.
 * Процес, що впав, перезапускається з наростаючою паузою (10 с … 5 хв).
 *
 * Env: WIREPROXY_BIN (інакше ~/bin/wireproxy, інакше `wireproxy` з PATH), OPENVPN_BIN, VPN_SUDO=0,
 * VPN_MAX_OPENVPN — скільки OpenVPN-тунелів можна тримати одночасно (за замовчуванням 10; кожен — процес openvpn).
 * Конфіги: env VPN_DIR (за замовчуванням ~/.parser-vpn), права 700/600 — там приватні ключі.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { connect, disconnect } = require("../db/connection");
const proxyRepo = require("../db/repositories/proxy.repository");
const { validateProxy } = require("../core/proxy/proxy.validator");
const { buildWireproxyConfig } = require("../core/proxy/wg-config");
const { buildOpenVpnConfig } = require("../core/proxy/ovpn-config");
const ovpn = require("./openvpn");
const { createSocksServer } = require("./socks-server");
const logger = require("../utils/logger");

const RECONCILE_MS = 5000;
const CHECK_DELAY_MS = 4000; // дати тунелю WireGuard зробити handshake перед перевіркою
const OVPN_CONNECT_TIMEOUT_MS = 60000; // скільки чекати «Initialization Sequence Completed»
const MAX_OPENVPN = Math.max(1, parseInt(process.env.VPN_MAX_OPENVPN, 10) || 10);
const VPN_DIR = process.env.VPN_DIR || path.join(os.homedir(), ".parser-vpn");
const BIN =
  process.env.WIREPROXY_BIN ||
  (fs.existsSync(path.join(os.homedir(), "bin", "wireproxy")) ? path.join(os.homedir(), "bin", "wireproxy") : "wireproxy");

/**
 * id → { type, child, hash, port, startedAt, stderr: string[], restarts, nextStartAt,
 *        // лише OpenVPN:
 *        dev, localAddress, socks, connectTimer }
 */
const tunnels = new Map();
let stopping = false;

const isOvpn = (v) => v.vpnType === "openvpn";
const configOf = (v) => (isOvpn(v) ? v.ovpnConfig : v.wgConfig);
const hashOf = (vpn) =>
  crypto
    .createHash("sha1")
    .update([vpn.vpnType || "wireguard", vpn.port, configOf(vpn), vpn.vpnNeedsAuth ? 1 : 0, vpn.vpnUsername || "", vpn.vpnPassword || ""].join("\0"))
    .digest("hex");

const SECRET_RE = /(PrivateKey|password|auth-user-pass)\S*/gi;

function keepOutput(t, buf) {
  for (const line of String(buf).split(/\r?\n/).filter(Boolean)) {
    t.stderr.push(line.replace(SECRET_RE, "$1=***").slice(0, 300));
    if (t.stderr.length > 40) t.stderr.shift();
  }
}

/** Найінформативніші рядки журналу для показу в UI. */
function lastError(t) {
  const important = t.stderr.filter((l) => /error|fail|cannot|refused|timed? ?out|exiting|denied|not found|no such|sudo|ліміт|не встановлено|немає|weak|зайнятий/i.test(l));
  return (important.length ? important : t.stderr).slice(-3).join(" | ");
}

function writeWgConfig(id, vpn) {
  fs.mkdirSync(VPN_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(VPN_DIR, `${id}.conf`);
  fs.writeFileSync(file, buildWireproxyConfig(vpn.wgConfig, vpn.port), { mode: 0o600 });
  return file;
}

async function checkTunnel(id) {
  const vpn = await proxyRepo.findById(id);
  if (!vpn || !tunnels.get(id)?.child) return;
  const r = await validateProxy(vpn);
  if (r.ok) {
    await proxyRepo.recordCheckSuccess(id, { responseTime: r.responseTime, country: r.country, exitIp: r.ip, transparent: r.transparent });
    await proxyRepo.setVpnState(id, { vpnStatus: "running" });
    tunnels.get(id) && (tunnels.get(id).restarts = 0);
    logger.info("[VPN] тунель працює", { id, exitIp: r.ip, country: r.country });
  } else {
    await proxyRepo.recordCheckFailure(id, r.error);
    await proxyRepo.setVpnState(id, { vpnStatus: "error", vpnError: `Тунель запущено, але трафік не йде: ${r.error}` });
    logger.warn("[VPN] тунель не пропускає трафік", { id, error: r.error });
  }
}

function closeSocks(t) {
  if (t.socks) {
    t.socks.close();
    t.socks = null;
  }
}

/** Спільна обробка завершення процесу тунелю: статус помилки й перезапуск із наростаючою паузою. */
function watchChild(id, t, child) {
  child.stdout.on("data", (b) => keepOutput(t, b));
  child.stderr.on("data", (b) => keepOutput(t, b));

  let dead = false;
  const onDead = (code, signal) => {
    if (dead) return;
    dead = true;
    clearTimeout(t.connectTimer);
    closeSocks(t);
    t.localAddress = null; // адреса звільнена — інакше давала б хибний збіг з іншими тунелями
    if (tunnels.get(id) !== t) return; // уже замінений новим процесом
    t.child = null;
    if (stopping || t.stopped) return;
    t.restarts++;
    const wait = Math.min(10000 * 2 ** (t.restarts - 1), 5 * 60 * 1000);
    t.nextStartAt = Date.now() + wait;
    const last = lastError(t) || `код ${code ?? signal}`;
    logger.warn("[VPN] тунель завершився", { id, type: t.type, code, signal, last, retryInSec: Math.round(wait / 1000) });
    proxyRepo.setVpnState(id, { vpnStatus: "error", vpnError: `${last} (повтор через ${Math.round(wait / 1000)} с)` }).catch(() => {});
    proxyRepo.update(id, { status: "inactive" }).catch(() => {});
  };
  child.on("error", (e) => {
    t.stderr.push(e.code === "ENOENT" ? `${t.type === "openvpn" ? "sudo/openvpn" : "wireproxy"} не встановлено (${e.path || ""})` : e.message);
    if (!child.pid) onDead(null, null); // процес навіть не стартував — 'exit' може не прийти
  });
  child.on("exit", onDead);
}

function startWireGuard(id, vpn, t) {
  const file = writeWgConfig(id, vpn);
  const child = spawn(BIN, ["-c", file], { stdio: ["ignore", "pipe", "pipe"] });
  t.child = child;
  watchChild(id, t, child);
  setTimeout(() => {
    if (tunnels.get(id) === t && t.child) checkTunnel(id).catch((e) => logger.warn("[VPN] перевірка не вдалась", { id, error: e.message }));
  }, CHECK_DELAY_MS);
}

function startOpenVpn(id, vpn, t) {
  const file = ovpn.writeFiles(VPN_DIR, id, vpn, buildOpenVpnConfig);
  ovpn.killStale(file); // процес від попереднього запуску демона тримав би tun-пристрій
  t.dev = ovpn.netParams(vpn.port).dev;
  t.localAddress = null;

  const child = ovpn.spawnOpenVpn(file);
  t.child = child;
  watchChild(id, t, child);

  // Тунель (пере)підключився: оновити IP, підняти SOCKS (один раз) і перевірити трафік
  const onReady = () => {
    if (tunnels.get(id) !== t || !t.child) return;
    clearTimeout(t.connectTimer);
    const ip = ovpn.readTunIp(t.dev);
    if (!ip) {
      t.stderr.push(`Тунель піднявся, але в ${t.dev} немає IPv4-адреси`);
      child.kill("SIGTERM");
      return;
    }
    // Сервери VPN Gate роздають адреси з одного діапазону (10.211.x.x) — два тунелі з однаковою адресою
    // переплутали б маршрутизацію (правило `ip rule from <IP>`). Новіший зупиняємо, повтор отримає іншу адресу.
    const clash = [...tunnels.entries()].find(([otherId, o]) => otherId !== id && o.localAddress === ip);
    if (clash) {
      t.stderr.push(`Адреса тунелю ${ip} збігається з іншим увімкненим VPN — перепідключення пізніше`);
      child.kill("SIGTERM");
      return;
    }
    t.localAddress = ip;
    logger.info("[VPN] OpenVPN підключено", { id, dev: t.dev, tunIp: ip });
    const runCheck = () => checkTunnel(id).catch((e) => logger.warn("[VPN] перевірка не вдалась", { id, error: e.message }));
    if (t.socks) return runCheck();
    const socks = createSocksServer({
      getLocalAddress: () => t.localAddress,
      onError: (msg, meta) => logger.debug("[VPN] socks", { id, msg, ...meta }),
    });
    socks.on("error", (e) => {
      t.stderr.push(e.code === "EADDRINUSE" ? `Порт 127.0.0.1:${vpn.port} зайнятий` : `SOCKS: ${e.message}`);
      child.kill("SIGTERM");
    });
    socks.listen(vpn.port, "127.0.0.1", runCheck);
    t.socks = socks;
  };
  child.stdout.on("data", (b) => {
    if (/Initialization Sequence Completed/.test(String(b))) onReady();
  });

  t.connectTimer = setTimeout(() => {
    if (tunnels.get(id) !== t || !t.child || t.localAddress) return;
    t.stderr.push(`Немає з'єднання з ${vpn.vpnEndpoint || "сервером"} за ${OVPN_CONNECT_TIMEOUT_MS / 1000} с`);
    child.kill("SIGTERM");
  }, OVPN_CONNECT_TIMEOUT_MS);
}

function start(id, vpn, prev) {
  const type = isOvpn(vpn) ? "openvpn" : "wireguard";
  const t = { type, child: null, hash: hashOf(vpn), port: vpn.port, startedAt: new Date(), stderr: [], restarts: prev?.restarts || 0, nextStartAt: 0 };
  tunnels.set(id, t);
  try {
    if (type === "openvpn") startOpenVpn(id, vpn, t);
    else startWireGuard(id, vpn, t);
  } catch (e) {
    // Не вдалося навіть підготувати запуск (запис конфігу тощо) — повтор з паузою, як після падіння
    t.child = null;
    t.restarts++;
    t.nextStartAt = Date.now() + Math.min(10000 * 2 ** (t.restarts - 1), 5 * 60 * 1000);
    proxyRepo.setVpnState(id, { vpnStatus: "error", vpnError: `Не вдалося запустити тунель: ${e.message}` }).catch(() => {});
    return;
  }
  logger.info("[VPN] запуск тунелю", { id, type, name: vpn.name, port: vpn.port, endpoint: vpn.vpnEndpoint });
  proxyRepo.setVpnState(id, { vpnStatus: "starting", vpnStartedAt: t.startedAt }).catch(() => {});
}

function stop(id, reason) {
  const t = tunnels.get(id);
  if (!t) return;
  t.stopped = true;
  tunnels.delete(id);
  clearTimeout(t.connectTimer);
  closeSocks(t);
  if (t.child) t.child.kill("SIGTERM");
  if (t.type === "openvpn") ovpn.removeFiles(VPN_DIR, id);
  else {
    try { fs.unlinkSync(path.join(VPN_DIR, `${id}.conf`)); } catch { /* немає файлу */ }
  }
  logger.info("[VPN] тунель зупинено", { id, reason });
}

async function reconcile() {
  const vpns = await proxyRepo.findVpnsWithConfig();
  const wanted = new Map(vpns.filter((v) => v.vpnEnabled !== false && configOf(v)).map((v) => [String(v._id), v]));

  // Ліміт одночасних OpenVPN (кожен — окремий процес openvpn). Уже запущені мають перевагу, далі — старші.
  const ovpnIds = [...wanted.values()]
    .filter(isOvpn)
    .sort((a, b) => (tunnels.has(String(b._id)) - tunnels.has(String(a._id))) || (new Date(a.createdAt) - new Date(b.createdAt)))
    .map((v) => String(v._id));
  for (const id of ovpnIds.slice(MAX_OPENVPN)) {
    const v = wanted.get(id);
    wanted.delete(id);
    if (!/ліміт/.test(v.vpnError || "")) {
      proxyRepo.setVpnState(id, { vpnStatus: "error", vpnError: `Не запущено: ліміт ${MAX_OPENVPN} одночасних OpenVPN-тунелів (VPN_MAX_OPENVPN). Вимкніть зайві.` }).catch(() => {});
    }
  }

  for (const id of [...tunnels.keys()]) {
    if (!wanted.has(id)) {
      const doc = vpns.find((v) => String(v._id) === id);
      stop(id, doc ? "вимкнено" : "видалено");
    }
  }

  for (const [id, vpn] of wanted) {
    const t = tunnels.get(id);
    if (!t) { start(id, vpn); continue; }
    if (t.hash !== hashOf(vpn)) { stop(id, "конфіг змінено"); start(id, vpn); continue; }
    if (!t.child && Date.now() >= t.nextStartAt) start(id, vpn, t);
  }

  // Вимкнені, у яких ще висить старий статус
  for (const v of vpns) {
    if (v.vpnEnabled === false && v.vpnStatus !== "stopped") proxyRepo.setVpnState(v._id, { vpnStatus: "stopped" }).catch(() => {});
  }
}

async function main() {
  await connect();
  logger.info("[VPN] демон запущено", { wireproxy: BIN, openvpn: ovpn.BIN, sudo: ovpn.USE_SUDO, dir: VPN_DIR, maxOpenVpn: MAX_OPENVPN });
  // openvpn, що пережили попередній процес демона (pm2 kill -9), тримали б tun-пристрої
  const vpns = await proxyRepo.findVpnsWithConfig().catch(() => []);
  if (vpns.some(isOvpn) && ovpn.killStale(VPN_DIR + path.sep)) await new Promise((r) => setTimeout(r, 2000));

  const loop = async () => {
    if (stopping) return;
    try { await reconcile(); } catch (e) { logger.warn("[VPN] reconcile", { error: e.message }); }
    setTimeout(loop, RECONCILE_MS);
  };
  loop();
}

async function shutdown() {
  stopping = true;
  for (const t of tunnels.values()) {
    closeSocks(t);
    t.child?.kill("SIGTERM");
  }
  await disconnect().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (require.main === module) {
  main().catch((e) => {
    logger.error("[VPN] демон не стартував", { error: e.message });
    process.exit(1);
  });
}

module.exports = { reconcile, tunnels };
