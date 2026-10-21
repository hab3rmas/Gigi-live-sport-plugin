const http = require('http');
const express = require('express');

describe('/api/speedtest', () => {
  let server, base;
  beforeAll(async () => {
    process.env.SPEEDTEST_MAX_MB = '4';
    process.env.SPEEDTEST_MAX_CONCURRENT = '1';
    jest.resetModules();
    const app = express();
    app.use(require('../src/routes/speedtest'));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });

  test('returns exactly the requested number of bytes, capped by SPEEDTEST_MAX_MB', async () => {
    const r1 = await fetch(`${base}/api/speedtest?mb=2`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('cache-control')).toBe('no-store');
    expect((await r1.arrayBuffer()).byteLength).toBe(2 * 1024 * 1024);
    const r2 = await fetch(`${base}/api/speedtest?mb=999`);
    expect((await r2.arrayBuffer()).byteLength).toBe(4 * 1024 * 1024);
    const r3 = await fetch(`${base}/api/speedtest?mb=abc`);
    expect((await r3.arrayBuffer()).byteLength).toBe(4 * 1024 * 1024 > 8 * 1024 * 1024 ? 0 : 4 * 1024 * 1024);
  });

  test('limits concurrency and frees the slot when a client disconnects', async () => {
    const req = http.get(`${base}/api/speedtest?mb=4`);
    const res = await new Promise((resolve) => req.once('response', resolve));
    res.pause();                                           // keep the transfer open
    const busy = await fetch(`${base}/api/speedtest?mb=1`);
    expect(busy.status).toBe(429);
    await busy.arrayBuffer();
    req.destroy();
    await new Promise((r) => setTimeout(r, 150));
    const ok = await fetch(`${base}/api/speedtest?mb=1`);
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
  });
});
