/**
 * Мінімальний SOCKS5-сервер (без авторизації, лише CONNECT) для OpenVPN-тунелів.
 *
 * openvpn піднімає tun-пристрій, але маршрути сервера не змінює (route-nopull). У тунель потрапляє
 * лише трафік, що виходить з IP тунелю (правило `ip rule from <tunIp>`), тому кожне вихідне з'єднання
 * тут відкривається з localAddress = IP тунелю. Імена сайтів резолвимо теж через тунель (публічні DNS),
 * щоб гео-DNS сайтів бачив країну VPN, а не сервера.
 *
 * Слухає лише 127.0.0.1 — ззовні недоступний.
 */
const net = require("net");
const dns = require("dns");

const DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const HANDSHAKE_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 20000;

// Коди відповіді SOCKS5
const REP = { OK: 0, FAIL: 1, NET_UNREACH: 3, HOST_UNREACH: 4, REFUSED: 5, TTL: 6, CMD: 7, ATYP: 8 };

const errToRep = (e) =>
  e?.code === "ECONNREFUSED" ? REP.REFUSED
  : e?.code === "ENETUNREACH" ? REP.NET_UNREACH
  : e?.code === "EHOSTUNREACH" || e?.code === "ENOTFOUND" || e?.code === "ENODATA" ? REP.HOST_UNREACH
  : e?.code === "ETIMEDOUT" ? REP.TTL
  : REP.FAIL;

const reply = (sock, rep) => {
  if (sock.writable) sock.write(Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]));
};

/**
 * @param {object} o
 * @param {() => string|null} o.getLocalAddress - поточний IP тунелю (null — тунель ще не готовий)
 * @param {(host: string, localAddress: string) => Promise<string>} [o.resolve] - резолв імені в IPv4
 * @param {(msg: string, meta?: object) => void} [o.onError]
 * @returns {net.Server}
 */
function createSocksServer({ getLocalAddress, resolve = resolveViaTunnel, onError = () => {} }) {
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    let stage = "greeting";
    let upstream = null;
    client.setNoDelay(true);
    client.setTimeout(HANDSHAKE_TIMEOUT_MS, () => client.destroy());
    client.on("error", () => upstream?.destroy());
    client.on("close", () => upstream?.destroy());

    const onData = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === "greeting") {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf[0] !== 5) return client.destroy();
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        if (!methods.includes(0)) { client.end(Buffer.from([5, 0xff])); return; }
        client.write(Buffer.from([5, 0]));
        stage = "request";
      }

      if (stage === "request") {
        if (buf.length < 4) return;
        const [ver, cmd, , atyp] = buf;
        if (ver !== 5) return client.destroy();
        let host, offset;
        if (atyp === 1) {
          if (buf.length < 10) return;
          host = Array.from(buf.subarray(4, 8)).join(".");
          offset = 8;
        } else if (atyp === 3) {
          if (buf.length < 5 || buf.length < 5 + buf[4] + 2) return;
          host = buf.subarray(5, 5 + buf[4]).toString("utf8");
          offset = 5 + buf[4];
        } else if (atyp === 4) {
          // Тунелі VPN Gate без IPv6 — чесно відмовляємо, щоб клієнт не чекав таймауту
          if (buf.length < 22) return;
          reply(client, REP.ATYP);
          return client.end();
        } else {
          reply(client, REP.ATYP);
          return client.end();
        }
        const port = buf.readUInt16BE(offset);
        const rest = buf.subarray(offset + 2);
        stage = "connecting";
        client.removeListener("data", onData);
        client.pause();

        if (cmd !== 1) { reply(client, REP.CMD); return client.end(); }

        const localAddress = getLocalAddress();
        if (!localAddress) { reply(client, REP.NET_UNREACH); return client.end(); }

        let ip;
        try {
          ip = net.isIPv4(host) ? host : await resolve(host, localAddress);
        } catch (e) {
          reply(client, REP.HOST_UNREACH);
          return client.end();
        }
        if (client.destroyed) return;

        upstream = net.connect({ host: ip, port, localAddress, family: 4 });
        upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
        upstream.once("connect", () => {
          upstream.setTimeout(0);
          client.setTimeout(0);
          reply(client, REP.OK);
          if (rest.length) upstream.write(rest);
          upstream.pipe(client);
          client.pipe(upstream);
          client.resume();
          stage = "piping";
        });
        upstream.on("error", (e) => {
          if (stage === "connecting") {
            reply(client, errToRep(e));
            client.end();
          } else client.destroy();
          if (e.code !== "ECONNRESET" && e.code !== "EPIPE") onError(e.message, { host, port });
        });
        upstream.on("close", () => client.destroy());
      }
    };
    client.on("data", onData);
  });
  return server;
}

// Резолвери на кожен IP тунелю (IP може змінитися після перепідключення openvpn)
const resolvers = new Map();

/** Резолв імені в IPv4 через публічні DNS, запит іде з IP тунелю (тобто через VPN). */
async function resolveViaTunnel(host, localAddress) {
  let r = resolvers.get(localAddress);
  if (!r) {
    r = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
    r.setServers(DNS_SERVERS);
    r.setLocalAddress(localAddress);
    if (resolvers.size > 50) resolvers.clear();
    resolvers.set(localAddress, r);
  }
  try {
    const [ip] = await r.resolve4(host);
    if (ip) return ip;
  } catch { /* DNS через тунель недоступний — пробуємо системний */ }
  const { address } = await dns.promises.lookup(host, { family: 4 });
  return address;
}

module.exports = { createSocksServer, resolveViaTunnel };
