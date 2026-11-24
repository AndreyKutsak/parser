/**
 * VPN-демон: тримає піднятими WireGuard-тунелі (через wireproxy) для записів Proxy з kind='vpn'.
 *
 * Окремий процес pm2 ("vpn"), щоб тунелі не падали при перезапуску app/worker.
 * Кожні RECONCILE_MS звіряє БД із запущеними процесами:
 *   - новий/увімкнений VPN → пише конфіг і запускає `wireproxy -c <файл>` (SOCKS5 на 127.0.0.1:<port>);
 *   - змінений конфіг/порт → перезапуск;
 *   - видалений/вимкнений → зупинка.
 * Після старту робить звичайну перевірку проксі (вихідний IP, країна) → status active/inactive.
 * Процес, що впав, перезапускається з наростаючою паузою (10 с … 5 хв).
 *
 * Шлях до wireproxy: env WIREPROXY_BIN, інакше ~/bin/wireproxy, інакше `wireproxy` з PATH.
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
const logger = require("../utils/logger");

const RECONCILE_MS = 5000;
const CHECK_DELAY_MS = 4000; // дати тунелю зробити handshake перед перевіркою
const VPN_DIR = process.env.VPN_DIR || path.join(os.homedir(), ".parser-vpn");
const BIN =
  process.env.WIREPROXY_BIN ||
  (fs.existsSync(path.join(os.homedir(), "bin", "wireproxy")) ? path.join(os.homedir(), "bin", "wireproxy") : "wireproxy");

/** id → { child, hash, port, startedAt, stderr: string[], restarts, nextStartAt } */
const tunnels = new Map();
let stopping = false;

const hashOf = (vpn) => crypto.createHash("sha1").update(`${vpn.port}\0${vpn.wgConfig}`).digest("hex");

function writeConfig(id, vpn) {
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

function start(id, vpn, prev) {
  let file;
  try {
    file = writeConfig(id, vpn);
  } catch (e) {
    proxyRepo.setVpnState(id, { vpnStatus: "error", vpnError: `Не вдалося записати конфіг: ${e.message}` }).catch(() => {});
    return;
  }
  const t = { child: null, hash: hashOf(vpn), port: vpn.port, startedAt: new Date(), stderr: [], restarts: prev?.restarts || 0, nextStartAt: 0 };
  tunnels.set(id, t);

  const child = spawn(BIN, ["-c", file], { stdio: ["ignore", "pipe", "pipe"] });
  t.child = child;
  const keep = (buf) => {
    for (const line of String(buf).split(/\r?\n/).filter(Boolean)) {
      t.stderr.push(line.replace(/PrivateKey\S*/gi, "PrivateKey=***"));
      if (t.stderr.length > 20) t.stderr.shift();
    }
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);

  let dead = false;
  const onDead = (code, signal) => {
    if (dead) return;
    dead = true;
    if (tunnels.get(id) !== t) return; // уже замінений новим процесом
    t.child = null;
    if (stopping || t.stopped) return;
    t.restarts++;
    const wait = Math.min(10000 * 2 ** (t.restarts - 1), 5 * 60 * 1000);
    t.nextStartAt = Date.now() + wait;
    const last = t.stderr.slice(-3).join(" | ") || `код ${code ?? signal}`;
    logger.warn("[VPN] wireproxy завершився", { id, code, signal, last, retryInSec: Math.round(wait / 1000) });
    proxyRepo.setVpnState(id, { vpnStatus: "error", vpnError: `${last} (повтор через ${Math.round(wait / 1000)} с)` }).catch(() => {});
    proxyRepo.update(id, { status: "inactive" }).catch(() => {});
  };
  child.on("error", (e) => {
    t.stderr.push(e.code === "ENOENT" ? `wireproxy не встановлено (${BIN})` : e.message);
    if (!child.pid) onDead(null, null); // процес навіть не стартував — 'exit' може не прийти
  });
  child.on("exit", onDead);

  logger.info("[VPN] запуск тунелю", { id, name: vpn.name, port: vpn.port, endpoint: vpn.vpnEndpoint });
  proxyRepo.setVpnState(id, { vpnStatus: "starting", vpnStartedAt: t.startedAt }).catch(() => {});
  setTimeout(() => {
    if (tunnels.get(id) === t && t.child) checkTunnel(id).catch((e) => logger.warn("[VPN] перевірка не вдалась", { id, error: e.message }));
  }, CHECK_DELAY_MS);
}

function stop(id, reason) {
  const t = tunnels.get(id);
  if (!t) return;
  t.stopped = true;
  tunnels.delete(id);
  if (t.child) t.child.kill("SIGTERM");
  try { fs.unlinkSync(path.join(VPN_DIR, `${id}.conf`)); } catch { /* немає файлу */ }
  logger.info("[VPN] тунель зупинено", { id, reason });
}

async function reconcile() {
  const vpns = await proxyRepo.findVpnsWithConfig();
  const wanted = new Map(vpns.filter((v) => v.vpnEnabled !== false && v.wgConfig).map((v) => [String(v._id), v]));

  for (const id of [...tunnels.keys()]) {
    if (!wanted.has(id)) {
      const doc = vpns.find((v) => String(v._id) === id);
      stop(id, doc ? "вимкнено" : "видалено");
      if (doc) proxyRepo.setVpnState(id, { vpnStatus: "stopped" }).catch(() => {});
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
  logger.info("[VPN] демон запущено", { bin: BIN, dir: VPN_DIR });
  const loop = async () => {
    if (stopping) return;
    try { await reconcile(); } catch (e) { logger.warn("[VPN] reconcile", { error: e.message }); }
    setTimeout(loop, RECONCILE_MS);
  };
  loop();
}

async function shutdown() {
  stopping = true;
  for (const t of tunnels.values()) t.child?.kill("SIGTERM");
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
