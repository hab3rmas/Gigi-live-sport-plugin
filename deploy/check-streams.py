#!/usr/bin/env python3
"""
Check every source of a match end to end, the way a player would: playlist -> variant -> segments.

  python3 deploy/check-streams.py "sky sports golf"              # find by title substring
  python3 deploy/check-streams.py spk_ppv-sky-sports-golf        # or by exact match id
  python3 deploy/check-streams.py "sky sports golf" --base https://sports.drksha.com

Run it from the addon directory on the server (reads data/matches_cache.json).
Prints one block per source with HTTP codes, sizes and speeds, and a verdict.
"""
import json, os, subprocess, sys, time, urllib.parse

args = [a for a in sys.argv[1:] if not a.startswith('--')]
base = 'http://127.0.0.1:7000'
public = 'https://sports.drksha.com'
if '--public' in sys.argv:
    public = sys.argv[sys.argv.index('--public') + 1].rstrip('/')
    args = [a for a in args if a != public]
if '--base' in sys.argv:
    base = sys.argv[sys.argv.index('--base') + 1].rstrip('/')
    args = [a for a in args if a != base]
if not args:
    sys.exit(__doc__)
query = args[0].lower()

cache = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'matches_cache.json')
d = json.load(open(cache))
ms = d.get('matches', d) if isinstance(d, dict) else d
hits = [m for m in ms if query == str(m.get('id', '')).lower() or query in str(m.get('title', '')).lower()]
if not hits:
    sys.exit(f'no match for {query!r} in {cache}')
hits.sort(key=lambda m: (str(m.get('id', '')).lower() != query, str(m.get('date') or '')))
if len(hits) > 1:
    print('several matches, using the first:')
    for m in hits[:6]:
        print('  ', m.get('id'), '|', m.get('title'), '|', m.get('date'))
mid = hits[0]['id']
print('match:', mid, '|', hits[0].get('title'))

def curl(url, limit=None, ua='Mozilla/5.0'):
    cmd = ['curl', '-s', '-L', '-m', '25', '-A', ua, '-w', '\n%{http_code}|%{size_download}|%{time_total}']
    if limit: cmd += ['-r', '0-%d' % limit]
    out = subprocess.run(cmd + [url], capture_output=True).stdout
    body, _, meta = out.rpartition(b'\n')
    try: code, size, t = meta.decode().split('|')
    except Exception: code, size, t = '000', '0', '0'
    return body, int(code), int(size), float(t)

def absolutize(ref_base, ref):
    if ref.startswith('http'): return ref
    if ref.startswith('/'): return base + ref if base.startswith('https://sports') or ref.startswith('/api/') else urllib.parse.urljoin(ref_base, ref)
    return urllib.parse.urljoin(ref_base, ref)

t0 = time.time()
body, code, _, _ = curl(f'{base}/stream/tv/nuvio_sport_{urllib.parse.quote(mid)}.json')
streams = [s for s in json.loads(body or b'{}').get('streams', []) if s.get('url')] if code == 200 else []
print(f'streams list: http {code}, {len(streams)} links in {time.time()-t0:.1f}s\n')
if not streams:
    print('NO STREAMS: every source was filtered out as dead (stream not live yet, tokens refused, or all upstreams unreachable).')
    print('See: docker compose logs nuvio --since 3m | grep -E "Filter|Dropped|EmbedSt|impit"')
    sys.exit(1)

good = 0
laptop = []
for i, s in enumerate(streams, 1):
    name = ((s.get('name') or '') + ' ' + (s.get('title') or '')).replace('\n', ' ')[:90]
    url = s['url']
    print(f'[{i}] {name}\n    {url[:110]}')
    b, c, size, t = curl(url)
    print(f'    playlist: http {c}, {size} B, {t:.2f}s')
    if c != 200 or not b.startswith(b'#EXTM3U'):
        print('    => BAD (not a playlist):', b[:60]); continue
    txt, cur = b.decode('utf8', 'ignore'), url
    for _ in range(2):
        refs = [l for l in txt.splitlines() if l and not l.startswith('#')]
        if not refs: break
        nxt = absolutize(cur, refs[0])
        if '.m3u8' in nxt.split('?')[0] or '/api/manifest' in nxt:
            b, c, size, t = curl(nxt); print(f'    variant: http {c}, {size} B, {t:.2f}s')
            if c != 200: break
            txt, cur = b.decode('utf8', 'ignore'), nxt
        else:
            break
    segs = [l for l in txt.splitlines() if l and not l.startswith('#')][-3:]
    ok = 0
    for j, sg in enumerate(segs, 1):
        seg_url = absolutize(cur, sg)
        _, c, size, t = curl(seg_url)
        kb = size / 1024
        print(f'    segment {j}: http {c}, {kb:.0f} KB, {t:.2f}s, {kb/t if t else 0:.0f} KB/s')
        ok += (c == 200 and size > 10000)
        if j == len(segs) and c == 200 and size > 10000:
            pub = public + seg_url[len(base):] if seg_url.startswith(base) else seg_url
            laptop.append((i, name[:40], size, pub))
    verdict = 'OK' if segs and ok == len(segs) else 'BAD'
    good += verdict == 'OK'
    print('    =>', verdict)
if laptop:
    print('\n=== LAPTOP TEST: run on your laptop (shows real speed from this server to you) ===')
    for i, nm, size, pub in laptop:
        print(f'# [{i}] {nm}  (segment {size/1024:.0f} KB; needs ~{size/1024/1024/4:.1f}+ MB/s for 4s segments)')
        print(f'curl -L -o /dev/null -w "[{i}] %{{speed_download}} B/s, %{{size_download}} B in %{{time_total}}s\\n" "{pub}"')
print(f'\nsummary: {good}/{len(streams)} sources deliver segments from this server')
