const http = require('http');
const net = require('net');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { createSocksServer } = require('../socks-server');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(() => r()));

describe('socks-server', () => {
  let web, webPort, socks, socksPort, resolved;
  let localAddress = '127.0.0.1';

  beforeAll(async () => {
    web = http.createServer((req, res) => res.end(`ok ${req.url} from ${req.socket.remoteAddress}`));
    webPort = await listen(web);
    resolved = [];
    socks = createSocksServer({
      getLocalAddress: () => localAddress,
      // «DNS через тунель»: будь-яке ім'я → 127.0.0.1
      resolve: async (host, la) => { resolved.push([host, la]); return '127.0.0.1'; },
    });
    socksPort = await listen(socks);
  });

  afterAll(async () => {
    await close(socks);
    await close(web);
  });

  test('CONNECT за іменем (socks5h): ім\'я резолвить сервер, з\'єднання з localAddress', async () => {
    const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${socksPort}`);
    const r = await axios.get(`http://some-site.example:${webPort}/page`, { httpAgent: agent, proxy: false, timeout: 5000 });
    expect(r.data).toBe('ok /page from 127.0.0.1');
    expect(resolved).toContainEqual(['some-site.example', '127.0.0.1']);
  });

  test('CONNECT за IPv4 без резолву', async () => {
    resolved.length = 0;
    const agent = new SocksProxyAgent(`socks5://127.0.0.1:${socksPort}`);
    const r = await axios.get(`http://127.0.0.1:${webPort}/ip`, { httpAgent: agent, proxy: false, timeout: 5000 });
    expect(r.data).toMatch(/^ok \/ip/);
    expect(resolved).toEqual([]);
  });

  test('IPv6-ціль — відповідь «тип адреси не підтримується» (8)', async () => {
    const rep = await new Promise((resolve, reject) => {
      const s = net.connect(socksPort, '127.0.0.1', () => s.write(Buffer.from([5, 1, 0])));
      let stage = 0;
      s.on('data', (d) => {
        if (stage++ === 0) {
          s.write(Buffer.concat([Buffer.from([5, 1, 0, 4]), Buffer.alloc(16), Buffer.from([0, 80])]));
        } else {
          resolve(d[1]);
          s.destroy();
        }
      });
      s.on('error', reject);
    });
    expect(rep).toBe(8);
  });

  test('тунель не готовий (немає IP) — відмова одразу, без таймауту', async () => {
    localAddress = null;
    const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${socksPort}`);
    await expect(axios.get(`http://x.example:${webPort}/`, { httpAgent: agent, proxy: false, timeout: 5000 })).rejects.toThrow();
    localAddress = '127.0.0.1';
  });

  test('allowUids: з\'єднання чужого користувача відхиляється, свого — проходить', async () => {
    let uid = 1001;
    const guarded = createSocksServer({
      getLocalAddress: () => '127.0.0.1',
      resolve: async () => '127.0.0.1',
      allowUids: [1000, 0],
      peerUid: async () => uid,
    });
    const port = await listen(guarded);
    const get = () => axios.get(`http://127.0.0.1:${webPort}/g`, {
      httpAgent: new SocksProxyAgent(`socks5://127.0.0.1:${port}`), proxy: false, timeout: 5000,
    });
    await expect(get()).rejects.toThrow();
    uid = 1000;
    await expect(get()).resolves.toMatchObject({ data: 'ok /g from 127.0.0.1' });
    uid = null; // власника не визначено — теж відмова
    await expect(get()).rejects.toThrow();
    await close(guarded);
  });

  test('localPeerUid: розбір /proc/net/tcp (лише Linux)', async () => {
    const { localPeerUid } = require('../socks-server');
    if (process.platform !== 'linux') {
      await expect(localPeerUid({ remotePort: 1, localPort: 2 })).resolves.toBeNull();
      return;
    }
    const s = net.connect(socksPort, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    const uid = await localPeerUid({ remotePort: s.localPort, localPort: socksPort });
    expect(uid).toBe(process.getuid());
    s.destroy();
  });

  test('закритий порт — помилка з\'єднання передається клієнту', async () => {
    const tmp = net.createServer();
    const deadPort = await listen(tmp);
    await close(tmp);
    const agent = new SocksProxyAgent(`socks5://127.0.0.1:${socksPort}`);
    await expect(axios.get(`http://127.0.0.1:${deadPort}/`, { httpAgent: agent, proxy: false, timeout: 5000 })).rejects.toThrow();
  });
});
