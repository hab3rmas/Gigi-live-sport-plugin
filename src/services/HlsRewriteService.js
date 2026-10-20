'use strict';

/**
 * HlsRewriteService.js
 *
 * Single source of truth for HLS segment/variant URI rewriting.
 *
 * Both /api/manifest (playlist proxy) and the speed probe in streams.js must
 * build the exact URL a player would use for a given playlist entry. Before
 * this module existed the CF worker pool and the rewrite rules were duplicated
 * inline in routes/manifest.js and streams.js, which drifted apart once.
 *
 * Rewrite rules (mirrors what routes/manifest.js did inline):
 *  - .m3u8  → /api/manifest?url=...&referer=...&origin=...(+rckSuffix)
 *  - .image → random Cloudflare Worker (strips the 42-byte fake WebP/RIFF
 *             header Streamed.pk / TikTok CDN prepends), fallback /api/hlschunk
 *  - disguised pure MPEG-TS (.png/.webp/.js, no .ts) → append '#.ts' hint
 *  - anything else → absolute URL as-is
 */

const CF_IMAGE_WORKER_POOL = [
  'https://nuvio-proxy.odedararaj456.workers.dev',
  'https://nuvio-proxy2.rajodedara360.workers.dev',
  'https://nuvio-proxy3.raj-odedara.workers.dev',
  'https://spring-brook-5c1e.rajodedara456.workers.dev',
  'https://falling-unit-ffa6.rajcfproxy1.workers.dev',
  'https://falling-violet-3301.hansabenhodedara.workers.dev',
  'https://nameless-dawn-2ab8.abhi-munot01.workers.dev',
];

function getCfImageWorker() {
  if (!CF_IMAGE_WORKER_POOL.length) return null;
  return CF_IMAGE_WORKER_POOL[Math.floor(Math.random() * CF_IMAGE_WORKER_POOL.length)];
}

/**
 * Resolve a playlist URI against the manifest URL, inheriting the manifest's
 * query params (upstream CDNs key tokens in the query string).
 */
function resolveSegmentUrl(segmentUri, manifestUrl) {
  try {
    const chunkUrl = new URL(segmentUri, manifestUrl);
    const manifestObj = new URL(manifestUrl);

    manifestObj.searchParams.forEach((val, key) => {
      if (!chunkUrl.searchParams.has(key)) {
        chunkUrl.searchParams.set(key, val);
      }
    });

    return chunkUrl.toString();
  } catch (_) {
    return segmentUri;
  }
}

/**
 * Relay mode: every media byte goes through this server's /api/hlschunk.
 *
 * Default ON in this fork. Without it the player fetches segments straight
 * from the source CDN, which fails when (a) the viewer's ISP blocks the CDN
 * domain, (b) the CDN insists on a browser User-Agent / Referer the client app
 * does not send, or (c) the segment is plain http:// that the app refuses.
 * Relaying fixes all three at the cost of VPS bandwidth (~3-8 Mbit/s per
 * viewer). Set PROXY_ALL_SEGMENTS=false to restore direct-from-CDN delivery.
 */
function isProxyAllSegments(opts = {}) {
  if (typeof opts.proxyAll === 'boolean') return opts.proxyAll;
  return String(process.env.PROXY_ALL_SEGMENTS ?? 'true').toLowerCase() !== 'false';
}

function isDisguisedSegment(absoluteUrl) {
  if (absoluteUrl.includes('.image')) return true;
  const pngLike = absoluteUrl.includes('.png') || absoluteUrl.includes('.webp') || absoluteUrl.includes('.js');
  return pngLike && !absoluteUrl.includes('.ts');
}

function buildChunkPath(absoluteUrl, referer, origin, raw, absoluteAddonBaseUrl) {
  let chunkPath = `/api/hlschunk?url=${encodeURIComponent(absoluteUrl)}`;
  if (referer) chunkPath += `&referer=${encodeURIComponent(referer)}`;
  if (origin) chunkPath += `&origin=${encodeURIComponent(origin)}`;
  if (raw) chunkPath += '&raw=1';
  return absoluteAddonBaseUrl ? new URL(chunkPath, absoluteAddonBaseUrl).toString() : chunkPath;
}

function buildManifestPath(absoluteUrl, referer, origin, rckSuffix, absoluteAddonBaseUrl) {
  let manifestPath = `/api/manifest?url=${encodeURIComponent(absoluteUrl)}`;
  if (referer) manifestPath += `&referer=${encodeURIComponent(referer)}`;
  if (origin) manifestPath += `&origin=${encodeURIComponent(origin)}`;
  manifestPath += rckSuffix || '';
  return absoluteAddonBaseUrl ? new URL(manifestPath, absoluteAddonBaseUrl).toString() : manifestPath;
}

/**
 * Rewrite one playlist entry into the URL the player should fetch.
 */
function rewriteHlsUri(segmentUri, manifestUrl, opts = {}) {
  const { referer = '', origin = '', rckSuffix = '', absoluteAddonBaseUrl = '' } = opts;
  const absoluteUrl = resolveSegmentUrl(segmentUri, manifestUrl);

  if (absoluteUrl.includes('.m3u8')) {
    return buildManifestPath(absoluteUrl, referer, origin, rckSuffix, absoluteAddonBaseUrl);
  }

  if (isProxyAllSegments(opts)) {
    // Disguised segments (fake PNG/WebP/RIFF headers) keep the uncloak
    // transform; genuine segments (TS, fMP4, AAC) are relayed byte-for-byte.
    return buildChunkPath(absoluteUrl, referer, origin, !isDisguisedSegment(absoluteUrl), absoluteAddonBaseUrl);
  }

  if (absoluteUrl.includes('.image')) {
    const cfWorker = getCfImageWorker();
    if (cfWorker) {
      let workerChunkUrl = `${cfWorker}/?url=${encodeURIComponent(absoluteUrl)}`;
      if (referer) workerChunkUrl += `&referer=${encodeURIComponent(referer)}`;
      if (origin) workerChunkUrl += `&origin=${encodeURIComponent(origin)}`;
      return workerChunkUrl;
    }
    return buildChunkPath(absoluteUrl, referer, origin, false, absoluteAddonBaseUrl);
  }

  // Plain MPEG-TS segments stream directly from the upstream CDN (0 VPS bandwidth bleeding).

  const isPureDisguisedTs = absoluteUrl.includes('.png') || absoluteUrl.includes('.webp') || absoluteUrl.includes('.js');
  if (isPureDisguisedTs && !absoluteUrl.includes('.ts')) {
    return absoluteUrl + '#.ts';
  }

  return absoluteUrl;
}

/**
 * Rewrite the URI="..." attribute of a playlist tag.
 *  - EXT-X-MEDIA (alternate audio/subtitle playlists): through /api/manifest,
 *    exactly like variant playlists. A relative URI used to be left as-is and
 *    resolved against the addon host, so separate audio tracks 404'd.
 *  - EXT-X-MAP (fMP4 init segment) and EXT-X-KEY / EXT-X-SESSION-KEY (AES
 *    keys): absolute, and relayed raw in proxy-all mode. Relative key URIs
 *    previously resolved against the addon host as well.
 * Returns the line unchanged when the tag carries no URI or a data:/skd: URI.
 */
function rewriteTagLine(line, manifestUrl, opts = {}) {
  const l = String(line).trim();
  const tag = l.slice(0, l.indexOf(':') + 1);
  if (!['#EXT-X-MAP:', '#EXT-X-KEY:', '#EXT-X-SESSION-KEY:', '#EXT-X-MEDIA:', '#EXT-X-I-FRAME-STREAM-INF:'].includes(tag)) return line;
  const m = l.match(/URI="([^"]+)"/);
  if (!m) return line;
  const raw = m[1];
  if (/^(data|skd|urn):/i.test(raw)) return line;
  const { referer = '', origin = '', rckSuffix = '', absoluteAddonBaseUrl = '' } = opts;
  let abs;
  try { abs = new URL(raw, manifestUrl).toString(); } catch (_) { return line; }
  let out = abs;
  if (tag === '#EXT-X-MEDIA:' || tag === '#EXT-X-I-FRAME-STREAM-INF:') {
    out = abs.includes('.m3u8') ? buildManifestPath(abs, referer, origin, rckSuffix, absoluteAddonBaseUrl) : abs;
  } else if (isProxyAllSegments(opts)) {
    out = buildChunkPath(abs, referer, origin, true, absoluteAddonBaseUrl);
  }
  return l.replace(`URI="${raw}"`, `URI="${out}"`);
}

module.exports = {
  CF_IMAGE_WORKER_POOL,
  getCfImageWorker,
  resolveSegmentUrl,
  rewriteHlsUri,
  rewriteTagLine,
  isProxyAllSegments,
};
