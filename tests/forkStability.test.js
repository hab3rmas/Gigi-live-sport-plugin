/**
 * Regression tests for the stability / latency fork changes.
 */

describe('childProcessLimiter', () => {
  const ENV = { ...process.env };
  afterEach(() => { process.env = { ...ENV }; jest.resetModules(); });

  test('caps concurrent child processes and coalesces identical invocations', async () => {
    process.env.CHILD_PROC_MAX = '2';
    const { execFile, getStats } = require('../src/services/childProcessLimiter');
    const script = ['-e', 'setTimeout(()=>process.stdout.write(process.argv[1]||"x"),150)'];
    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, getStats().running); }, 10);
    const run = (arg) => new Promise((resolve) => execFile('node', [...script, arg], {}, (err, out) => resolve({ err, out })));
    const results = await Promise.all([run('a'), run('b'), run('c'), run('a')]);
    clearInterval(watch);
    expect(results.map(r => r.out)).toEqual(['a', 'b', 'c', 'a']);
    expect(peak).toBeLessThanOrEqual(2);
    expect(getStats().coalesced).toBeGreaterThanOrEqual(1);
  });

  test('kills a child that exceeds its timeout', async () => {
    const { execFile } = require('../src/services/childProcessLimiter');
    const err = await new Promise((resolve) => execFile('node', ['-e', 'setTimeout(()=>{}, 10000)'], { timeout: 200 }, (e) => resolve(e)));
    expect(err).toBeTruthy();
    expect(err.killed).toBe(true);
  });
});

describe('manifest proxy helpers', () => {
  const mp = require('../src/manifestProxy');

  test('live playlist TTL stays near the live edge', () => {
    expect(mp.liveManifestTtl('#EXTM3U\n#EXT-X-TARGETDURATION:6\n')).toBeLessThanOrEqual(1000);
    expect(mp.liveManifestTtl('#EXTM3U\n#EXT-X-TARGETDURATION:2\n')).toBe(500);
    expect(mp.liveManifestTtl('#EXTM3U\n')).toBeGreaterThan(0);
  });

  test('last good playlist is retrievable within the stale window', () => {
    mp.manifestLastGoodSet('k1', '#EXTM3U\nseg.ts');
    expect(mp.manifestLastGoodGet('k1')).toBe('#EXTM3U\nseg.ts');
    expect(mp.manifestLastGoodGet('missing')).toBeNull();
  });

  test('negative TTL is short', () => {
    expect(mp.MANIFEST_NEGATIVE_TTL_MS).toBeLessThanOrEqual(5000);
  });
});

describe('MatchAggregator sync guards', () => {
  const MatchAggregator = require('../src/services/MatchAggregator');

  test('concurrent syncMatches calls share one run', async () => {
    const agg = Object.create(MatchAggregator.prototype);
    let runs = 0;
    agg._syncMatchesImpl = async () => { runs++; await new Promise(r => setTimeout(r, 30)); return [{ id: 'm' }]; };
    const [a, b, c] = await Promise.all([agg.syncMatches(), agg.syncMatches(), agg.syncMatches()]);
    expect(runs).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(agg.isSyncInFlight).toBe(false);
  });

  test('a provider that never answers is cut off by the per-provider deadline', async () => {
    const prev = process.env.PROVIDER_SYNC_TIMEOUT_MS;
    process.env.PROVIDER_SYNC_TIMEOUT_MS = '5000';
    jest.useFakeTimers();
    try {
      const agg = Object.create(MatchAggregator.prototype);
      const p = agg._fetchProviderMatches({ name: 'hang', getMatches: () => new Promise(() => {}) });
      const settled = p.then(() => 'ok', (e) => e.code);
      await jest.advanceTimersByTimeAsync(5001);
      await expect(settled).resolves.toBe('PROVIDER_SYNC_TIMEOUT');
    } finally {
      jest.useRealTimers();
      if (prev === undefined) delete process.env.PROVIDER_SYNC_TIMEOUT_MS; else process.env.PROVIDER_SYNC_TIMEOUT_MS = prev;
    }
  });
});

describe('handleStream early return', () => {
  jest.resetModules();
  jest.doMock('../src/container', () => ({ resolve: jest.fn() }));
  const container = require('../src/container');
  const { handleStream } = require('../src/streams');

  function deferred() {
    let resolve;
    const promise = new Promise((ok) => { resolve = ok; });
    return { promise, resolve };
  }

  const env = { ...process.env };
  let pending;
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.STREAM_SOFT_DEADLINE_MS = '6000';
    process.env.STREAM_HARD_DEADLINE_MS = '15000';
    process.env.STREAM_FIRST_RESULT_GRACE_MS = '1000';
    process.env.STREAM_PRIORITY_WAIT_MS = '3000';
    process.env.DONATION_URL = 'disabled';
    pending = {};
    const match = { id: 'early', title: 'A vs B', category: 'football', sources: [
      { source: 'watchfooty', id: 'fast' }, { source: 'timstreams', id: 'slow' }, { source: 'daddylive', id: 'p1' },
    ] };
    const services = {
      cacheService: { findMatch: () => match },
      streamResolveCache: { getOrCreate: jest.fn((key) => {
        const id = key.split(':')[2];
        pending[id] = pending[id] || deferred();
        return pending[id].promise;
      }) },
      streamScorer: { calculateScore: () => 1 },
    };
    container.resolve.mockImplementation((name) => services[name]);
  });
  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...env };
  });

  test('does not hold a ready list for the full hard deadline while priority-1 is pending', async () => {
    let response;
    handleStream('tv', 'nuvio_sport_early').then((v) => { response = v; });
    await jest.advanceTimersByTimeAsync(10);
    pending.fast.resolve([{ url: 'https://cdn.example/a.m3u8', _source: 'watchfooty', title: 'A' }]);
    await jest.advanceTimersByTimeAsync(2000);
    expect(response).toBeUndefined(); // still inside the priority wait
    await jest.advanceTimersByTimeAsync(1100);
    expect(response).toBeDefined(); // returned at ~3 s, not 15 s
    expect(response.streams.length).toBeGreaterThanOrEqual(1);
  });

  test('returns right after the grace window once priority-1 has settled', async () => {
    let response;
    handleStream('tv', 'nuvio_sport_early').then((v) => { response = v; });
    await jest.advanceTimersByTimeAsync(10);
    pending.p1.resolve([]);
    pending.fast.resolve([{ url: 'https://cdn.example/b.m3u8', _source: 'watchfooty', title: 'B' }]);
    await jest.advanceTimersByTimeAsync(1100);
    expect(response).toBeDefined();
  });
});
