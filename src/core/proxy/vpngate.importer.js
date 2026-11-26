/**
 * Імпорт безкоштовних OpenVPN-серверів VPN Gate (*.opengw.net) за країною.
 *
 * Список серверів беремо з каталогу vpnhub.me (сторінки /en/<країна>-open-vpn.html?page=N): у кожному рядку
 * кнопка OpenVPN має data-host, data-hid і порти data-tcp / data-udp. Сам .ovpn віддає VPN Gate:
 * http://www.vpngate.net/common/openvpn_download.aspx?<udp|tcp>=1&host=…&port=…&hid=…
 *
 * Сервери VPN Gate тримають волонтери, вони часто зникають і міняють порти — імпорт можна запускати
 * повторно: існуючі записи (той самий хост:порт) оновлюються, нові додаються.
 */
const axios = require("axios");
const cheerio = require("cheerio");
const { validateOvpnConfig } = require("./ovpn-config");

const LIST_URL = (country, page) => `https://vpnhub.me/en/${country}-open-vpn.html${page > 1 ? `?page=${page}` : ""}`;
const DOWNLOAD_URL = "http://www.vpngate.net/common/openvpn_download.aspx";
const MAX_PAGES = 30;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  "Accept-Language": "en",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Розбір однієї сторінки каталогу. Повертає сервери й номер останньої сторінки з пагінації. */
function parseListPage(html) {
  const $ = cheerio.load(html);
  const servers = [];
  $("table tbody tr").each((_, tr) => {
    const row = $(tr);
    const open = row.find('button[data-protocol="open"][data-supported="1"]');
    const host = open.attr("data-host");
    if (!host) return;
    const ssl = row.find('button[data-protocol="ssl"][data-supported="1"]');
    servers.push({
      country: row.find("td").first().text().trim(),
      host: host.trim().toLowerCase(),
      hid: open.attr("data-hid") || "",
      tcp: open.attr("data-tcp") || null,
      udp: open.attr("data-udp") || null,
      username: ssl.attr("data-username") || "vpn",
      password: ssl.attr("data-password") || "vpn",
      protocols: ["ssl", "l2tp", "sstp", "open"].filter((p) => row.find(`button[data-protocol="${p}"][data-supported="1"]`).length),
    });
  });
  const lastPage = Math.max(1, ...$('a[href*="page="]').map((_, a) => parseInt(String($(a).attr("href")).match(/page=(\d+)/)?.[1], 10) || 1).get());
  return { servers, lastPage };
}

/**
 * Усі сервери країни з каталогу, по одному на хост (UDP, якщо є, інакше TCP).
 * @param {string} country - код країни латиницею в нижньому регістрі (ua, pl, de…)
 */
async function listServers(country = "ua", { maxServers = 300, onProgress = () => {} } = {}) {
  const byHost = new Map();
  let lastPage = 1;
  for (let page = 1; page <= Math.min(lastPage, MAX_PAGES); page++) {
    const r = await axios.get(LIST_URL(country, page), { timeout: 20000, headers: HEADERS, responseType: "text" });
    const parsed = parseListPage(r.data);
    if (page === 1) lastPage = parsed.lastPage;
    for (const s of parsed.servers) {
      if (!s.hid || (!s.udp && !s.tcp) || byHost.has(s.host)) continue;
      byHost.set(s.host, { ...s, proto: s.udp ? "udp" : "tcp", port: s.udp || s.tcp });
    }
    onProgress({ page, pages: lastPage, found: byHost.size });
    if (byHost.size >= maxServers) break;
    await sleep(500);
  }
  return [...byHost.values()].slice(0, maxServers);
}

/** Завантажити .ovpn сервера з VPN Gate. */
async function downloadConfig({ host, port, hid, proto }) {
  const params = new URLSearchParams({ sid: String(Date.now()), [proto]: "1", host, port: String(port), hid: String(hid) });
  const r = await axios.get(`${DOWNLOAD_URL}?${params}`, { timeout: 20000, headers: HEADERS, responseType: "text", maxContentLength: 200 * 1024 });
  const text = String(r.data || "");
  const { errors } = validateOvpnConfig(text);
  if (errors.length) throw new Error(`VPN Gate віддав некоректний .ovpn для ${host}: ${errors[0]}`);
  return text;
}

module.exports = { listServers, downloadConfig, parseListPage };
