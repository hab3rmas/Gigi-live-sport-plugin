jest.mock('../src/config', () => ({ BASE_URL: 'https://sports.example.com', getRequestBaseUrl: () => 'https://sports.example.com' }));
const { wrapDirectStream } = require('../src/streams');

describe('wrapDirectStream', () => {
  const parse = (u) => { const x = new URL(u); return { path: x.pathname, p: Object.fromEntries(x.searchParams) }; };

  test('CDNLive direct playlist is routed through /api/manifest with its referer', () => {
    const s = { url: 'https://cdnlivetv.tv/secure/api/v1/abc/playlist.m3u8?token=T', _source: 'cdnlive', behaviorHints: { notWebReady: true } };
    wrapDirectStream(s);
    const { path, p } = parse(s.url);
    expect(path).toBe('/api/manifest');
    expect(p.url).toBe('https://cdnlivetv.tv/secure/api/v1/abc/playlist.m3u8?token=T');
    expect(p.referer).toBe('https://cdnlivetv.tv/');
    expect(p.origin).toBe('https://cdnlivetv.tv');
    expect(s.behaviorHints.notWebReady).toBeUndefined();
  });

  test('uses the provider-supplied proxy headers and drops them once wrapped', () => {
    const s = { url: 'https://cdn.example/x.m3u8', behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: 'https://site.example/', Origin: 'https://site.example' } } } };
    wrapDirectStream(s);
    expect(parse(s.url).p.referer).toBe('https://site.example/');
    expect(s.behaviorHints.proxyHeaders).toBeUndefined();
  });

  test('is idempotent and leaves already-wrapped, web-player, mp4 and referer-less links alone', () => {
    const wrapped = { url: 'https://sports.example.com/api/manifest?url=x' };
    wrapDirectStream(wrapped); expect(wrapped.url).toBe('https://sports.example.com/api/manifest?url=x');
    const once = { url: 'https://cdnlivetv.tv/a/playlist.m3u8', _source: 'cdnlive' };
    wrapDirectStream(once); const first = once.url; wrapDirectStream(once); expect(once.url).toBe(first);
    for (const url of ['https://x.example/watch?id=1', 'https://x.example/video.mp4', 'https://unknown.example/live.m3u8']) {
      const s = { url }; wrapDirectStream(s); expect(s.url).toBe(url);
    }
  });
});
