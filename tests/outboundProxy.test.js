/**
 * OUTBOUND_PROXY_URL: every client (node http(s), undici, builtin fetch) must go through
 * the proxy with REMOTE DNS, while loopback/private hosts stay direct.
 */
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { spawn } = require('child_process');

const PRELOAD = path.join(__dirname, '..', 'src', 'providers', 'outboundProxy.js');

function startFakeSocks({ user, pass } = {}) {
  const seen = [];
  const server = net.createServer((client) => {
    let stage = 0; let buf = Buffer.alloc(0);
    client.on('error', () => {});
    client.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (user) {
          if (!methods.includes(2)) { client.end(Buffer.from([5, 0xff])); return; }
          client.write(Buffer.from([5, 2])); stage = 1;
        } else { client.write(Buffer.from([5, 0])); stage = 2; }
      }
      if (stage === 1) {
        if (buf.length < 2) return;
        const ul = buf[1]; if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return;
        const u = buf.subarray(2, 2 + ul).toString(); const p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        client.write(Buffer.from([1, u === user && p === pass ? 0 : 1]));
        if (u !== user || p !== pass) { client.end(); return; }
        stage = 2;
      }
      if (stage === 2) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host; let end;
        if (atyp === 3) { end = 5 + buf[4]; if (buf.length < end + 2) return; host = buf.subarray(5, end).toString(); }
        else if (atyp === 1) { end = 8; if (buf.length < end + 2) return; host = [...buf.subarray(4, 8)].join('.'); }
        else { client.end(); return; }
        const port = buf.readUInt16BE(end);
        buf = buf.subarray(end + 2);
        seen.push(`${host}:${port}`);
        // Every proxied name "resolves" to the local test origin.
        const upstream = net.connect(port, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (buf.length) upstream.write(buf);
          client.removeListener('data', onData);
          client.pipe(upstream); upstream.pipe(client);
        });
        upstream.on('error', () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
        stage = 3;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

function runChild(script, env) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, ['--require', PRELOAD, '-e', script], { env: { ...process.env, ...env, OUTBOUND_PROXY_QUIET: '1' } });
    let out = ''; let err = '';
    cp.stdout.on('data', (d) => { out += d; }); cp.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => cp.kill('SIGKILL'), 20000);
    cp.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('outboundProxy', () => {
  let origin; let originPort; let proxy;

  beforeAll(async () => {
    origin = http.createServer((req, res) => res.end('hello-from-origin'));
    await new Promise((r) => origin.listen(0, '127.0.0.1', r));
    originPort = origin.address().port;
    proxy = await startFakeSocks();
  });
  afterAll(async () => {
    await new Promise((r) => origin.close(r));
    await new Promise((r) => proxy.server.close(r));
  });
  beforeEach(() => { proxy.seen.length = 0; });

  const clientsScript = (port) => `
    const http = require('http');
    const undici = require('undici');
    const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let b=''; r.on('data', d => b+=d); r.on('end', () => res(b)); }).on('error', rej));
    (async () => {
      const out = {};
      out.http = await get('http://stream-cdn.example.test:${port}/');
      const u = await undici.request('http://undici-cdn.example.test:${port}/');
      out.undici = await u.body.text();
      const f = await fetch('http://fetch-cdn.example.test:${port}/');
      out.fetch = await f.text();
      out.local = await get('http://127.0.0.1:${port}/');
      console.log(JSON.stringify(out));
    })().catch((e) => { console.error('ERR', e && e.stack || e); process.exit(2); });
  `;

  test('http, undici and builtin fetch all tunnel through SOCKS5 with remote DNS; loopback stays direct', async () => {
    const r = await runChild(clientsScript(originPort), { OUTBOUND_PROXY_URL: `socks5://127.0.0.1:${proxy.port}` });
    expect(r.err.replace(/ExperimentalWarning[^\n]*|\(Use `node[^\n]*|\(node:\d+\)[^\n]*/g, '')).not.toMatch(/ERR/);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out.trim().split('\n').pop());
    expect(out).toEqual({ http: 'hello-from-origin', undici: 'hello-from-origin', fetch: 'hello-from-origin', local: 'hello-from-origin' });
    expect(proxy.seen).toEqual(expect.arrayContaining([
      `stream-cdn.example.test:${originPort}`, `undici-cdn.example.test:${originPort}`, `fetch-cdn.example.test:${originPort}`
    ]));
    expect(proxy.seen.some((s) => s.startsWith('127.0.0.1'))).toBe(false);   // loopback never proxied
  }, 30000);

  test('without OUTBOUND_PROXY_URL nothing is proxied', async () => {
    const r = await runChild(`
      const http = require('http');
      http.get('http://127.0.0.1:${originPort}/', (res) => { let b=''; res.on('data', d => b+=d); res.on('end', () => console.log(b)); });`, { OUTBOUND_PROXY_URL: '' });
    expect(r.out.trim()).toBe('hello-from-origin');
    expect(proxy.seen).toEqual([]);
  });

  test('SOCKS5 username/password authentication works and a wrong password fails', async () => {
    const authProxy = await startFakeSocks({ user: 'u', pass: 'p@ss' });
    try {
      const ok = await runChild(clientsScript(originPort), { OUTBOUND_PROXY_URL: `socks5://u:p%40ss@127.0.0.1:${authProxy.port}` });
      expect(ok.code).toBe(0);
      const bad = await runChild(`
        require('http').get('http://x.example.test:${originPort}/', () => console.log('UNEXPECTED_OK')).on('error', (e) => console.log('FAILED ' + e.message));`,
        { OUTBOUND_PROXY_URL: `socks5://u:nope@127.0.0.1:${authProxy.port}` });
      expect(bad.out).toMatch(/FAILED .*authentication failed/);
    } finally { await new Promise((r) => authProxy.server.close(r)); }
  }, 40000);

  test('an unreachable destination surfaces a clear error instead of hanging', async () => {
    const r = await runChild(`
      require('http').get('http://x.example.test:9/', () => console.log('UNEXPECTED_OK')).on('error', (e) => console.log('FAILED ' + e.message));`,
      { OUTBOUND_PROXY_URL: `socks5://127.0.0.1:${proxy.port}` });
    expect(r.out).toMatch(/FAILED .*(refused|failed)/);
  }, 30000);

  const haveOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();
  (haveOpenssl ? test : test.skip)('HTTPS through the tunnel works with the default agent, makeNodeAgent and undici', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=secure.example.test'], { stdio: 'ignore' });
    const tlsServer = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (q, r) => r.end('tls-ok'));
    await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
    const port = tlsServer.address().port;
    try {
      const script = `
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const https = require('https');
        const op = require(${JSON.stringify(PRELOAD)});
        const get = (u, o) => new Promise((res, rej) => https.get(u, o || {}, (r) => { let b=''; r.on('data', d => b+=d); r.on('end', () => res(b)); }).on('error', rej));
        (async () => {
          const out = {};
          out.def = await get('https://tls-a.example.test:${port}/');
          out.exp = await get('https://tls-b.example.test:${port}/', { agent: op.makeNodeAgent('https', { keepAlive: true }) });
          const { request } = require('undici');
          const d = op.makeDispatcher({ connect: { timeout: 20000, rejectUnauthorized: false } });
          out.undici = await (await request('https://tls-c.example.test:${port}/', { dispatcher: d })).body.text();
          console.log(JSON.stringify(out)); process.exit(0);
        })().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(2); });`;
      const r = await runChild(script, { OUTBOUND_PROXY_URL: `socks5://127.0.0.1:${proxy.port}` });
      expect(r.out).toContain('{"def":"tls-ok","exp":"tls-ok","undici":"tls-ok"}');
      expect(proxy.seen).toEqual(expect.arrayContaining([`tls-a.example.test:${port}`, `tls-b.example.test:${port}`, `tls-c.example.test:${port}`]));
    } finally {
      await new Promise((r) => tlsServer.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  test('bypass rules and child env', () => {
    process.env.OUTBOUND_PROXY_URL = 'socks5://10.1.1.1:1080';
    process.env.OUTBOUND_NO_PROXY = '.corp.example,direct.example';
    jest.resetModules();
    const op = require('../src/providers/outboundProxy');
    for (const h of ['localhost', '127.0.0.1', '10.2.3.4', '192.168.1.5', '172.20.0.9', 'caddy', 'redis.internal', 'a.corp.example', 'direct.example', '::1']) expect(op.bypass(h)).toBe(true);
    for (const h of ['cdn.example.com', '8.8.8.8', 'strmd.st', '172.32.0.1']) expect(op.bypass(h)).toBe(false);
    const env = op.childEnv({ NODE_OPTIONS: '--max-old-space-size=300' });
    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=300');
    expect(env.NODE_OPTIONS).toContain('--require=');
    expect(env.NODE_OPTIONS).toContain('outboundProxy.js');
    expect(op.impitProxyUrl()).toBe('socks5h://10.1.1.1:1080');
    delete process.env.OUTBOUND_PROXY_URL; delete process.env.OUTBOUND_NO_PROXY;
    jest.resetModules();
  });

  test('parseProxy rejects garbage and keeps credentials out of the host', () => {
    const { parseProxy } = require('../src/providers/outboundProxy');
    expect(parseProxy('')).toBeNull();
    expect(parseProxy('ftp://x:1')).toBeNull();
    expect(parseProxy('nonsense')).toBeNull();
    const p = parseProxy('socks5://user:pa%3Ass@xray:1081');
    expect(p).toMatchObject({ host: 'xray', port: 1081, username: 'user', password: 'pa:ss', isSocks: true });
  });
});
