'use strict';

/**
 * childProcessLimiter.js — bounded, coalesced replacement for execFile('node', ...)
 *
 * Several providers (EmbedSt, EmbedIndia, PpvSt, and StreamedPk through them)
 * launch a fresh Node process per stream variant to run a WASM extractor. The
 * original code had no global cap: a handful of viewers opening matches with
 * a dozen variants each spawned dozens of ~50 MB processes at once, which is
 * what drove the box into swap / OOM and Cloudflare 524s.
 *
 * This module keeps the exact execFile(file, args, opts, cb) contract so the
 * call sites change only their require(), and adds:
 *   - a global concurrency cap (CHILD_PROC_MAX, default derived from CPU count);
 *   - a bounded wait queue (excess work fails fast instead of piling up);
 *   - coalescing of identical in-flight invocations (same script + args), so
 *     two viewers resolving the same variant share one process;
 *   - process.execPath instead of whatever `node` is first on PATH;
 *   - SIGKILL on timeout, so a wedged extractor never lingers;
 *   - Node's on-disk compile cache for the children (faster cold start).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const CPU = Math.max(1, (os.cpus() || []).length);
const MAX_CONCURRENT = Math.max(1, Number(process.env.CHILD_PROC_MAX) || Math.min(8, Math.max(2, CPU * 2)));
const MAX_QUEUE = Math.max(0, Number(process.env.CHILD_PROC_QUEUE_MAX) || 64);
const QUEUE_WAIT_MS = Math.max(1000, Number(process.env.CHILD_PROC_QUEUE_WAIT_MS) || 10000);

let compileCacheDir = null;
try {
  compileCacheDir = process.env.NODE_COMPILE_CACHE || path.join(os.tmpdir(), 'nuvio-node-compile-cache');
  fs.mkdirSync(compileCacheDir, { recursive: true });
} catch (_) {
  compileCacheDir = null;
}

let running = 0;
const queue = []; // { start, enqueuedAt, timer }
const inFlight = new Map(); // key -> { callbacks: [] }
const stats = { started: 0, coalesced: 0, rejectedQueueFull: 0, rejectedQueueWait: 0, timedOut: 0 };

function release() {
  running = Math.max(0, running - 1);
  while (queue.length > 0 && running < MAX_CONCURRENT) {
    const job = queue.shift();
    clearTimeout(job.timer);
    running++;
    job.start();
  }
}

function acquire(start, onReject) {
  if (running < MAX_CONCURRENT) {
    running++;
    start();
    return;
  }
  if (queue.length >= MAX_QUEUE) {
    stats.rejectedQueueFull++;
    onReject(new Error(`child process queue full (${MAX_QUEUE})`));
    return;
  }
  const job = { start, timer: null };
  job.timer = setTimeout(() => {
    const idx = queue.indexOf(job);
    if (idx !== -1) queue.splice(idx, 1);
    stats.rejectedQueueWait++;
    onReject(new Error(`child process queue wait exceeded ${QUEUE_WAIT_MS}ms`));
  }, QUEUE_WAIT_MS);
  if (job.timer.unref) job.timer.unref();
  queue.push(job);
}

/**
 * Drop-in for child_process.execFile. `file === 'node'` is mapped to the
 * running Node binary.
 */
function execFile(file, args, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const options = { ...(opts || {}) };
  const callback = typeof cb === 'function' ? cb : () => {};
  const bin = file === 'node' ? process.execPath : file;
  const argv = Array.isArray(args) ? args.map(String) : [];

  const key = JSON.stringify([bin, argv]);
  const existing = inFlight.get(key);
  if (existing) {
    stats.coalesced++;
    existing.callbacks.push(callback);
    return null;
  }
  const entry = { callbacks: [callback] };
  inFlight.set(key, entry);

  const finish = (err, stdout, stderr) => {
    inFlight.delete(key);
    for (const fn of entry.callbacks) {
      try { fn(err, stdout, stderr); } catch (e) { console.error('[childProcessLimiter] callback threw:', e && e.message); }
    }
  };

  acquire(() => {
    stats.started++;
    const env = require('../providers/outboundProxy').childEnv({ ...process.env, ...(options.env || {}) });
    if (compileCacheDir && !env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE = compileCacheDir;
    let released = false;
    const done = (err, stdout, stderr) => {
      if (!released) { released = true; release(); }
      if (err && err.killed) stats.timedOut++;
      finish(err, stdout == null ? '' : stdout, stderr == null ? '' : stderr);
    };
    try {
      cp.execFile(bin, argv, {
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        killSignal: 'SIGKILL',
        windowsHide: true,
        ...options,
        env,
      }, done);
    } catch (err) {
      done(err, '', '');
    }
  }, (err) => finish(err, '', err.message));

  return null;
}

function getStats() {
  return { running, queued: queue.length, max: MAX_CONCURRENT, ...stats };
}

module.exports = { execFile, getStats, MAX_CONCURRENT };
