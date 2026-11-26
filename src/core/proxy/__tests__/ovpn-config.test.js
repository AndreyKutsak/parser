const { validateOvpnConfig, buildOpenVpnConfig, parseOvpnConfig } = require('../ovpn-config');
const { parseListPage } = require('../vpngate.importer');

// Скорочений .ovpn у форматі VPN Gate (сертифікати — заглушки, перевіряється лише структура)
const VPNGATE = `
###############################################################################
# OpenVPN 2.0 Sample Configuration File
###############################################################################
dev tun
proto udp
remote vpn968970619.opengw.net 9813
;http-proxy-retry
cipher AES-128-CBC
data-ciphers AES-128-CBC
auth SHA1
resolv-retry infinite
nobind
persist-key
persist-tun
client
verb 3
<ca>
-----BEGIN CERTIFICATE-----
MIIFAKECA
-----END CERTIFICATE-----
</ca>
<cert>
-----BEGIN CERTIFICATE-----
MIIFAKECERT
-----END CERTIFICATE-----
</cert>
<key>
-----BEGIN RSA PRIVATE KEY-----
MIIFAKEKEY
-----END RSA PRIVATE KEY-----
</key>
`;

const OPTS = { dev: 'pvpn41001', table: 41001, priority: 10001, script: '/home/parser/.parser-vpn/ovpn-route.sh' };

describe('ovpn-config', () => {
  test('конфіг VPN Gate: без помилок, endpoint і протокол визначено, логін не потрібен', () => {
    const r = validateOvpnConfig(VPNGATE);
    expect(r.errors).toEqual([]);
    expect(r.endpoint).toBe('vpn968970619.opengw.net:9813');
    expect(r.proto).toBe('udp');
    expect(r.needsAuth).toBe(false);
  });

  test('протокол і порт з рядка remote мають перевагу', () => {
    const r = validateOvpnConfig(VPNGATE.replace('remote vpn968970619.opengw.net 9813', 'remote 1.2.3.4 443 tcp'));
    expect(r.endpoint).toBe('1.2.3.4:443');
    expect(r.proto).toBe('tcp');
  });

  test('неповний конфіг — зрозумілі помилки', () => {
    expect(validateOvpnConfig('client\nproto udp').errors).toEqual(
      expect.arrayContaining(['Немає рядка «remote <хост> <порт>»', 'Немає сертифіката сервера <ca>…</ca>']),
    );
    expect(validateOvpnConfig('[Interface]\nPrivateKey = x').errors).toContain('Це не клієнтський конфіг (немає «client»)');
  });

  test('посилання на файли й dev tap не підтримуються', () => {
    const r = validateOvpnConfig(VPNGATE.replace('<ca>', 'ca /etc/ssl/ca.crt\n<ca>').replace('dev tun', 'dev tap'));
    expect(r.errors.join(' ')).toMatch(/ca \/etc\/ssl\/ca\.crt.*файл/);
    expect(r.errors.join(' ')).toMatch(/dev tun/);
  });

  test('небезпечні директиви відкидаються, свої — додаються', () => {
    const evil = VPNGATE.replace('client', [
      'client',
      'up /bin/rm',
      'script-security 3',
      'plugin /tmp/x.so',
      'redirect-gateway def1',
      'route 0.0.0.0 0.0.0.0',
      'management 0.0.0.0 7505',
      'auth-user-pass /etc/shadow',
      'remote evil.example.com 1194 "; rm -rf /"',
    ].join('\n'));
    const out = buildOpenVpnConfig(evil, OPTS);
    expect(out).not.toMatch(/\/bin\/rm|script-security 3|plugin|redirect-gateway def1|^route 0|management|\/etc\/shadow|rm -rf/m);
    expect(out).toMatch(/^dev pvpn41001$/m);
    expect(out).toMatch(/^route-nopull$/m);
    expect(out).toMatch(/^script-security 2$/m);
    expect(out).toMatch(/^setenv PARSER_TABLE 41001$/m);
    expect(out).toMatch(/^up \/home\/parser\/\.parser-vpn\/ovpn-route\.sh$/m);
    expect(out).not.toMatch(/^persist-tun$/m);
    // лише один dev — наш
    expect(out.match(/^dev /gm)).toHaveLength(1);
  });

  test('сумісність зі старими серверами й блоки сертифікатів', () => {
    const out = buildOpenVpnConfig(VPNGATE, OPTS);
    expect(out).toMatch(/^data-ciphers AES-128-CBC$/m); // з конфігу, не перезаписуємо
    expect(out).toMatch(/^data-ciphers-fallback AES-128-CBC$/m);
    expect(out).toMatch(/^tls-cipher DEFAULT:@SECLEVEL=0$/m);
    expect(out).toMatch(/<ca>\n-----BEGIN CERTIFICATE-----\nMIIFAKECA\n-----END CERTIFICATE-----\n<\/ca>/);
    expect(out).toMatch(/<key>[\s\S]*MIIFAKEKEY[\s\S]*<\/key>/);
    expect(out).not.toMatch(/auth-user-pass/);
  });

  test('auth-user-pass: потрібен логін, у готовому конфігу — наш файл', () => {
    const conf = VPNGATE.replace('client', 'client\nauth-user-pass');
    expect(validateOvpnConfig(conf).needsAuth).toBe(true);
    const out = buildOpenVpnConfig(conf, { ...OPTS, authFile: '/home/parser/.parser-vpn/x.auth' });
    expect(out).toMatch(/^auth-user-pass \/home\/parser\/\.parser-vpn\/x\.auth$/m);
  });

  test('tls-auth з вбудованим ключем і напрямком', () => {
    const conf = VPNGATE.replace('client', 'client\ntls-auth [inline] 1') + '<tls-auth>\nKEY\n</tls-auth>\n';
    const { errors } = parseOvpnConfig(conf);
    expect(errors).toEqual([]);
    const out = buildOpenVpnConfig(conf, OPTS);
    expect(out).toMatch(/^key-direction 1$/m);
    expect(out).toMatch(/<tls-auth>\nKEY\n<\/tls-auth>/);
  });
});

describe('ovpn-route.sh', () => {
  test('головна таблиця: маршрут підмережі тунелю переноситься в таблицю тунелю', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const ovpn = require('../../../vpn/openvpn');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvpn-'));
    const file = ovpn.writeFiles(dir, 'x', { port: 41001, ovpnConfig: VPNGATE }, buildOpenVpnConfig);
    const script = fs.readFileSync(path.join(dir, 'ovpn-route.sh'), 'utf8');
    expect(script).toMatch(/route show table main dev "\$dev"/);
    expect(script).toMatch(/ip route del \$R dev "\$dev" table main/);
    expect(script).not.toMatch(/ip route (add|replace) default dev "\$dev"\s*$/m); // default лише в таблиці тунелю
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^dev pvpn41001$/m);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('vpngate.importer parseListPage', () => {
  test('рядки каталогу vpnhub: хост, hid, порти, логін SSL, остання сторінка', () => {
    const html = `
      <table><tbody>
        <tr><td>Ukraine</td><td>vpn1.opengw.net</td><td>
          <button data-protocol="ssl" data-supported="1" data-host="vpn1.opengw.net" data-username="vpn" data-password="vpn"></button>
          <button data-protocol="l2tp" data-supported="0"></button>
          <button data-protocol="open" data-supported="1" data-host="VPN1.opengw.net" data-tcp="443" data-udp="1194" data-hid="123"></button>
        </td></tr>
        <tr><td>Ukraine</td><td>vpn2.opengw.net</td><td>
          <button data-protocol="open" data-supported="0"></button>
        </td></tr>
      </tbody></table>
      <a href="/en/ua-open-vpn.html?page=2">2</a><a href="/en/ua-open-vpn.html?page=10">10</a>`;
    const { servers, lastPage } = parseListPage(html);
    expect(lastPage).toBe(10);
    expect(servers).toEqual([{
      country: 'Ukraine', host: 'vpn1.opengw.net', hid: '123', tcp: '443', udp: '1194',
      username: 'vpn', password: 'vpn', protocols: ['ssl', 'open'],
    }]);
  });
});
