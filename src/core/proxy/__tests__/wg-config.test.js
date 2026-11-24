const { validateWgConfig, buildWireproxyConfig } = require('../wg-config');

const KEY = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';
const CONF = `
[Interface]
PrivateKey = ${KEY}
Address = 10.2.0.2/32
PostUp = iptables -A FORWARD   # wg-quick — wireproxy цього не розуміє

[Peer]
PublicKey = ${PUB}
AllowedIPs = 0.0.0.0/0
Endpoint = 185.1.2.3:51820
`;

describe('wg-config', () => {
  test('коректний конфіг: без помилок, endpoint визначено', () => {
    const r = validateWgConfig(CONF);
    expect(r.errors).toEqual([]);
    expect(r.endpoint).toBe('185.1.2.3:51820');
  });

  test('порожній/неповний конфіг — зрозумілі помилки', () => {
    expect(validateWgConfig('').errors).toEqual(expect.arrayContaining(['Немає секції [Interface]', 'Немає секції [Peer]']));
    const r = validateWgConfig(`[Interface]\nPrivateKey = abc\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = ${PUB}\nEndpoint = host-without-port`);
    expect(r.errors).toEqual([
      '[Interface]: PrivateKey має неправильний формат',
      '[Peer]: Endpoint має бути у вигляді host:port',
    ]);
  });

  test('конфіг для wireproxy: прибирає непідтримувані ключі, додає DNS, keepalive і SOCKS5', () => {
    const out = buildWireproxyConfig(CONF, 41001);
    expect(out).not.toMatch(/PostUp/);
    expect(out).toMatch(`PrivateKey = ${KEY}`);
    expect(out).toMatch('DNS = 1.1.1.1');
    expect(out).toMatch('PersistentKeepalive = 25');
    expect(out).toMatch(/\[Socks5\]\nBindAddress = 127\.0\.0\.1:41001/);
  });
});

describe('proxyManager.getNextProxy(pool)', () => {
  jest.resetModules();
  jest.doMock('../../../db/repositories/proxy.repository', () => ({
    findAll: async () => ({
      items: [
        { _id: 'p1', kind: 'proxy', status: 'active' },
        { _id: 'v1', kind: 'vpn', status: 'active' },
        { _id: 'p2', status: 'active' }, // старий запис без kind
      ],
    }),
    touchLastUsed: async () => {},
  }));
  const pm = require('../proxy.manager');

  test('vpn — лише VPN, proxy — лише проксі, all — усі', async () => {
    expect((await pm.getNextProxy('vpn'))._id).toBe('v1');
    expect((await pm.getNextProxy('vpn'))._id).toBe('v1');
    const proxies = new Set([(await pm.getNextProxy('proxy'))._id, (await pm.getNextProxy('proxy'))._id]);
    expect([...proxies].every((id) => id !== 'v1')).toBe(true);
    const all = new Set();
    for (let i = 0; i < 3; i++) all.add((await pm.getNextProxy())._id);
    expect(all.size).toBe(3);
  });
});
