/**
 * outboundProxy.js - route ALL outbound traffic of the addon through one proxy.
 *
 *   OUTBOUND_PROXY_URL=socks5://host:1080     (also socks5h://, http://, https://, user:pass@ supported)
 *   OUTBOUND_NO_PROXY=host1,.suffix           (extra hosts that must go direct)
 *
 * Loopback, private ranges, *.local/.internal and bare docker service names
 * always go direct, so the internal resolver process and Caddy are untouched.
 *
 * Covered: node http/https default agents, explicit agents made with
 * makeNodeAgent(), undici (global dispatcher + makeDispatcher()), Node's builtin
 * fetch, and impit (new Impit() gets the proxy unless one is given).
 *
 * This file is plain CommonJS with no project imports so it can also be
 * preloaded into child processes with `node --require`; childEnv() does that.
 * Domain names are resolved by the PROXY (remote DNS), so the exit IP sees the
 * real hostname and no DNS leaves this host.
 */
'use strict';

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const path = require('path');

function parseProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  const proto = u.protocol.replace(':', '');
  if (!['socks5', 'socks5h', 'socks', 'http', 'https'].includes(proto)) return null;
  const isSocks = proto.startsWith('socks');
  return {
    raw: s,
    protocol: proto,
    isSocks,
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port) || (isSocks ? 1080 : proto === 'https' ? 443 : 8080),
    username: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null
  };
}

const PROXY = parseProxy(process.env.OUTBOUND_PROXY_URL);
const EXTRA_NO_PROXY = String(process.env.OUTBOUND_NO_PROXY || '')
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const CONNECT_TIMEOUT_MS = Number(process.env.OUTBOUND_PROXY_CONNECT_TIMEOUT_MS) || 15000;

function bypass(hostRaw) {
  let h = String(hostRaw || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return true;
  if (/^127\./.test(h) || h === '0.0.0.0') return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (!h.includes('.') && !net.isIP(h)) return true;            // bare docker/service names
  for (const x of EXTRA_NO_PROXY) {
    const suffix = x.replace(/^\*/, '');
    if (h === x || (suffix.startsWith('.') && h.endsWith(suffix)) || h.endsWith('.' + x)) return true;
  }
  return false;
}

// ---- tunnels -----------------------------------------------------------------

function ipv6Bytes(addr) {
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = new Array(8 - h.length - t.length).fill('0');
  const groups = (tail === undefined ? h : [...h, ...fill, ...t]).map((g) => parseInt(g || '0', 16));
  const buf = Buffer.alloc(16);
  groups.forEach((g, i) => buf.writeUInt16BE(g, i * 2));
  return buf;
}

function socks5Handshake(sock, host, port, auth, cb) {
  let stage = 0;
  let buf = Buffer.alloc(0);
  const fail = (msg) => { cleanup(); sock.destroy(); cb(new Error('[outboundProxy] ' + msg)); };
  const sendConnect = () => {
    let addr;
    if (net.isIPv4(host)) addr = Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))]);
    else if (net.isIPv6(host)) addr = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]);
    else {
      const name = Buffer.from(host, 'utf8');
      if (name.length > 255) return fail('hostname too long');
      addr = Buffer.concat([Buffer.from([3, name.length]), name]);
    }
    const p = Buffer.alloc(2); p.writeUInt16BE(port);
    stage = 2;
    sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, p]));
  };
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return fail('not a SOCKS5 server');
        const method = buf[1]; buf = buf.subarray(2);
        if (method === 0) { sendConnect(); continue; }
        if (method === 2 && auth) {
          const u = Buffer.from(auth.username || ''), pw = Buffer.from(auth.password || '');
          stage = 1;
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
          continue;
        }
        return fail('SOCKS5 server requires unsupported authentication');
      }
      if (stage === 1) {
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fail('SOCKS5 authentication failed');
        buf = buf.subarray(2); sendConnect(); continue;
      }
      if (stage === 2) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const need = atyp === 1 ? 10 : atyp === 4 ? 22 : atyp === 3 ? 7 + buf[4] : 0;
        if (!need) return fail('bad SOCKS5 reply');
        if (buf.length < need) return;
        if (buf[1] !== 0) {
          const codes = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported' };
          return fail(`SOCKS5 connect to ${host}:${port} failed: ${codes[buf[1]] || buf[1]}`);
        }
        const extra = buf.subarray(need);
        cleanup();
        if (extra.length) sock.unshift(extra);
        return cb(null, sock);
      }
    }
  };
  const onErr = (e) => fail(`proxy connection error: ${e.message}`);
  const onClose = () => fail('proxy closed the connection during handshake');
  function cleanup() {
    sock.removeListener('data', onData); sock.removeListener('error', onErr); sock.removeListener('close', onClose);
  }
  sock.on('data', onData); sock.on('error', onErr); sock.on('close', onClose);
  sock.write(auth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
}

function httpConnect(sock, host, port, auth, cb) {
  let buf = Buffer.alloc(0);
  const fail = (msg) => { cleanup(); sock.destroy(); cb(new Error('[outboundProxy] ' + msg)); };
  const target = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  const headers = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
  if (auth && auth.username) headers.push('Proxy-Authorization: Basic ' + Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64'));
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) { if (buf.length > 16384) fail('oversized proxy response'); return; }
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'));
    if (!status || status[1] !== '200') return fail(`HTTP proxy CONNECT ${target} -> ${status ? status[1] : 'bad response'}`);
    const extra = buf.subarray(end + 4);
    cleanup();
    if (extra.length) sock.unshift(extra);
    cb(null, sock);
  };
  const onErr = (e) => fail(`proxy connection error: ${e.message}`);
  const onClose = () => fail('proxy closed the connection during CONNECT');
  function cleanup() { sock.removeListener('data', onData); sock.removeListener('error', onErr); sock.removeListener('close', onClose); }
  sock.on('data', onData); sock.on('error', onErr); sock.on('close', onClose);
  sock.write(headers.join('\r\n') + '\r\n\r\n');
}

/** Open a TCP tunnel to host:port through the configured proxy. cb(err, socket). */
function tunnel(host, port, cb) {
  let finished = false;
  const done = (err, s) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (err && sock) sock.destroy();
    cb(err, s);
  };
  const connectOpts = { host: PROXY.host, port: PROXY.port };
  const sock = PROXY.protocol === 'https'
    ? tls.connect({ ...connectOpts, servername: net.isIP(PROXY.host) ? undefined : PROXY.host })
    : net.connect(connectOpts);
  const timer = setTimeout(() => done(new Error('[outboundProxy] timeout connecting through proxy')), CONNECT_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  sock.setNoDelay(true);
  sock.once('error', (e) => done(new Error(`[outboundProxy] cannot reach proxy ${PROXY.host}:${PROXY.port}: ${e.message}`)));
  sock.once(PROXY.protocol === 'https' ? 'secureConnect' : 'connect', () => {
    sock.removeAllListeners('error');
    const auth = PROXY.username ? { username: PROXY.username, password: PROXY.password } : null;
    (PROXY.isSocks ? socks5Handshake : httpConnect)(sock, host, port, auth, done);
  });
}

// ---- node http / https agents --------------------------------------------------

function makeNodeAgent(kind, opts = {}) {
  const Base = kind === 'https' ? https.Agent : http.Agent;
  if (!PROXY) return new Base(opts);
  class ProxiedAgent extends Base {
    createConnection(options, cb) {
      const host = options.host || options.hostname;
      const port = Number(options.port) || (kind === 'https' ? 443 : 80);
      if (bypass(host)) return super.createConnection(options, cb);
      tunnel(host, port, (err, sock) => {
        if (err) return cb(err);
        if (kind !== 'https') return cb(null, sock);
        const secure = tls.connect({
          ...options,
          socket: sock,
          servername: options.servername || (net.isIP(host) ? undefined : host)
        });
        cb(null, secure);
      });
      return undefined;
    }
  }
  return new ProxiedAgent(opts);
}

// ---- undici ----------------------------------------------------------------------

function makeDispatcher(agentOpts = {}) {
  const undici = require('undici');
  const direct = new undici.Agent(agentOpts);
  if (!PROXY) return direct;

  const insecure = agentOpts.connect && agentOpts.connect.rejectUnauthorized === false;
  const requestTls = insecure ? { rejectUnauthorized: false } : undefined;
  let proxied;
  if (PROXY.isSocks) {
    const auth = PROXY.username ? `${encodeURIComponent(PROXY.username)}:${encodeURIComponent(PROXY.password || '')}@` : '';
    // undici prints a one-off "experimental" warning for its SOCKS5 agent; it is noise here.
    const emit = process.emitWarning;
    process.emitWarning = function quiet(w, ...rest) {
      if (/SOCKS5 proxy support is experimental/.test(String(w && w.message || w))) return undefined;
      return emit.call(process, w, ...rest);
    };
    try {
      proxied = new undici.Socks5ProxyAgent(`socks5://${auth}${PROXY.host.includes(':') ? `[${PROXY.host}]` : PROXY.host}:${PROXY.port}`, { requestTls });
    } finally { process.emitWarning = emit; }
  } else {
    proxied = new undici.ProxyAgent({ uri: PROXY.raw, requestTls, keepAliveTimeout: agentOpts.keepAliveTimeout, keepAliveMaxTimeout: agentOpts.keepAliveMaxTimeout });
  }

  class RoutingDispatcher extends undici.Dispatcher {
    dispatch(opts, handler) {
      let host = '';
      try {
        const o = opts.origin;
        host = new URL(typeof o === 'string' ? o : (o && o.href) || `${o.protocol}//${o.host}`).hostname;
      } catch (_) { /* fall through: unknown origin goes through the proxy */ }
      return (host && bypass(host) ? direct : proxied).dispatch(opts, handler);
    }
    close() { return Promise.all([direct.close(), proxied.close()]).then(() => undefined); }
    destroy(err) { return Promise.all([direct.destroy(err), proxied.destroy(err)]).then(() => undefined); }
  }
  return new RoutingDispatcher();
}

// ---- impit -------------------------------------------------------------------------

/** Proxy URL in the form impit/reqwest wants (socks5h = remote DNS), or null. */
function impitProxyUrl() {
  if (!PROXY) return null;
  if (!PROXY.isSocks) return PROXY.raw;
  const auth = PROXY.username ? `${encodeURIComponent(PROXY.username)}:${encodeURIComponent(PROXY.password || '')}@` : '';
  return `socks5h://${auth}${PROXY.host.includes(':') ? `[${PROXY.host}]` : PROXY.host}:${PROXY.port}`;
}

// ---- install / child processes -----------------------------------------------------

let installed = false;
function install() {
  if (installed || !PROXY) return false;
  installed = true;
  try {
    http.globalAgent = makeNodeAgent('http', { keepAlive: true });
    https.globalAgent = makeNodeAgent('https', { keepAlive: true });
  } catch (e) { console.warn('[outboundProxy] could not patch node agents:', e.message); }
  try {
    require('undici').setGlobalDispatcher(makeDispatcher({ connect: { timeout: 20000 }, keepAliveTimeout: 15000, keepAliveMaxTimeout: 30000 }));
  } catch (e) { console.warn('[outboundProxy] could not set undici dispatcher:', e.message); }
  try {
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function patchedLoad(request) {
      const exported = origLoad.apply(this, arguments);
      if (request === 'impit' && exported && typeof exported.Impit === 'function' && !exported.__outboundPatched) {
        const OrigImpit = exported.Impit;
        const url = impitProxyUrl();
        class ProxiedImpit extends OrigImpit {
          constructor(o) { super({ ...(url ? { proxyUrl: url } : {}), ...(o || {}) }); }
        }
        try { exported.Impit = ProxiedImpit; Object.defineProperty(exported, '__outboundPatched', { value: true }); } catch (_) { /* frozen export: leave as is */ }
      }
      return exported;
    };
  } catch (e) { console.warn('[outboundProxy] could not hook impit:', e.message); }
  if (!process.env.OUTBOUND_PROXY_QUIET) {
    console.log(`[outboundProxy] outbound traffic -> ${PROXY.protocol}://${PROXY.host}:${PROXY.port} (local/private hosts direct)`);
  }
  return true;
}

const PRELOAD_FILE = path.join(__dirname, 'outboundProxy.js');

/** Environment for a spawned node process so it uses the same proxy. */
function childEnv(env) {
  const out = { ...(env || process.env) };
  if (!PROXY) return out;
  const flag = `--require=${PRELOAD_FILE.includes(' ') ? JSON.stringify(PRELOAD_FILE) : PRELOAD_FILE}`;
  const cur = out.NODE_OPTIONS || '';
  if (!cur.includes(PRELOAD_FILE)) out.NODE_OPTIONS = (cur + ' ' + flag).trim();
  out.OUTBOUND_PROXY_QUIET = '1';
  return out;
}

function isEnabled() { return !!PROXY; }

install();

module.exports = { isEnabled, bypass, install, makeNodeAgent, makeDispatcher, impitProxyUrl, childEnv, tunnel, parseProxy };
