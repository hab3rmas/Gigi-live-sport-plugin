/**
 * Proxy-all-segments mode: playlist rewriting + /api/hlschunk relay.
 */
const http = require('http');

jest.mock('../src/services/OutboundUrlGuard', () => ({
  checkOutboundUrl: async (url) => ({ ok: true, url }),
  rejectBlockedUrl: (res) => { res.status(403).end(); return true; },
}));

const { rewriteHlsUri, rewriteTagLine } = require('../src/services/HlsRewriteService');

describe('HlsRewriteService relay mode', () => {
  const M = 'https://cdn.example/live/index.m3u8?token=abc';
  const opts = { referer: 'https://site.example/', origin: 'https://site.example', proxyAll: true };

  test('plain TS segments are relayed raw through /api/hlschunk', () => {
    const out = rewriteHlsUri('seg1.ts', M, opts);
    expect(out.startsWith('/api/hlschunk?url=')).toBe(true);
    expect(out).toContain('raw=1');
    expect(decodeURIComponent(out)).toContain('https://cdn.example/live/seg1.ts?token=abc');
    expect(decodeURIComponent(out)).toContain('referer=https://site.example/');
  });

  test('disguised segments keep the uncloak path (no raw)', () => {
    expect(rewriteHlsUri('chunk1.png', M, opts)).not.toContain('raw=1');
    expect(rewriteHlsUri('chunk1.image', M, opts)).not.toContain('raw=1');
  });

  test('variant playlists still go through /api/manifest', () => {
    expect(rewriteHlsUri('720p.m3u8', M, opts).startsWith('/api/manifest?url=')).toBe(true);
  });

  test('direct mode is unchanged when disabled', () => {
    expect(rewriteHlsUri('seg1.ts', M, { ...opts, proxyAll: false })).toBe('https://cdn.example/live/seg1.ts?token=abc');
  });

  test('EXT-X-KEY / EXT-X-MAP URIs are made absolute and relayed', () => {
    const key = rewriteTagLine('#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1', M, opts);
    expect(key).toMatch(/URI="\/api\/hlschunk\?url=https%3A%2F%2Fcdn\.example%2Flive%2Fkey\.bin.*raw=1"/);
    expect(key).toContain('IV=0x1');
    const map = rewriteTagLine('#EXT-X-MAP:URI="init.mp4"', M, { ...opts, proxyAll: false });
    expect(map).toBe('#EXT-X-MAP:URI="https://cdn.example/live/init.mp4"');
  });

  test('EXT-X-MEDIA alternate playlists go through /api/manifest', () => {
    const line = rewriteTagLine('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/en.m3u8"', M, opts);
    expect(line).toContain('URI="/api/manifest?url=https%3A%2F%2Fcdn.example%2Flive%2Faudio%2Fen.m3u8');
  });

  test('tags without a URI and data: URIs are untouched', () => {
    expect(rewriteTagLine('#EXT-X-TARGETDURATION:6', M, opts)).toBe('#EXT-X-TARGETDURATION:6');
    const dataKey = '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"';
    expect(rewriteTagLine(dataKey, M, opts)).toBe(dataKey);
  });
});

describe('/api/hlschunk relay', () => {
  let upstream, app, server, base, upBase;
  const TS = Buffer.alloc(188 * 4, 0x47);

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      if (req.url === '/redirect.ts') { res.writeHead(302, { Location: '/seg.ts' }); return res.end(); }
      if (req.url === '/seg.ts') {
        if (req.headers.referer !== 'https://site.example/' || !/Mozilla/.test(req.headers['user-agent'] || '')) {
          res.writeHead(403); return res.end('no');
        }
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': TS.length });
        return res.end(TS);
      }
      if (req.url === '/init.mp4') {
        const body = Buffer.from('ftypisom-not-ts-0123456789');
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
        return res.end(body);
      }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    upBase = `http://127.0.0.1:${upstream.address().port}`;

    const express = require('express');
    app = express();
    app.use(require('../src/routes/streamProxy'));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
  });

  const chunk = (path, raw = true) =>
    `${base}/api/hlschunk?url=${encodeURIComponent(upBase + path)}&referer=${encodeURIComponent('https://site.example/')}${raw ? '&raw=1' : ''}`;

  test('relays a segment with the required Referer and a browser User-Agent', async () => {
    const r = await fetch(chunk('/seg.ts'));
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).equals(TS)).toBe(true);
  });

  test('follows CDN redirects instead of stranding the player', async () => {
    const r = await fetch(chunk('/redirect.ts'));
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).length).toBe(TS.length);
  });

  test('raw mode passes non-TS bytes and content-type through untouched', async () => {
    const r = await fetch(chunk('/init.mp4'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(await r.text()).toBe('ftypisom-not-ts-0123456789');
  });

  test('upstream errors are passed through as status codes', async () => {
    const r = await fetch(chunk('/missing.ts'));
    expect(r.status).toBe(404);
  });
});
