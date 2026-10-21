/**
 * routes/speedtest.js - GET /api/speedtest?mb=8
 *
 * Streams N megabytes of incompressible data so the real throughput between this
 * server and ANY client (curl, phone browser) can be measured without a live segment
 * (live HLS segments expire within minutes, which makes copied segment URLs useless).
 * Capped in size and concurrency so it cannot be used as a bandwidth burner.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const MAX_MB = Math.max(1, Number(process.env.SPEEDTEST_MAX_MB) || 32);
const MAX_CONCURRENT = Math.max(1, Number(process.env.SPEEDTEST_MAX_CONCURRENT) || 3);
const CHUNK = crypto.randomBytes(256 * 1024);       // generated once; random => not compressible
let active = 0;

router.get('/api/speedtest', (req, res) => {
  const mb = Math.min(MAX_MB, Math.max(1, parseInt(req.query.mb, 10) || 8));
  if (active >= MAX_CONCURRENT) { res.status(429).set('Retry-After', '5').send('busy'); return; }
  active++;
  let released = false;
  const release = () => { if (!released) { released = true; active--; } };
  res.on('close', release);

  const total = mb * 1024 * 1024;
  let sent = 0;
  res.status(200);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(total),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Content-Encoding': 'identity'
  });

  const pump = () => {
    while (sent < total) {
      if (res.destroyed || res.writableEnded) return;
      const n = Math.min(CHUNK.length, total - sent);
      sent += n;
      if (!res.write(n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n))) { res.once('drain', pump); return; }
    }
    res.end();
  };
  pump();
});

module.exports = router;
module.exports._state = () => ({ active, MAX_MB, MAX_CONCURRENT });
