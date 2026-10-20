/**
 * LeagueCardService.js
 *
 * Broadcast-style match posters for the major football competitions
 * (Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League,
 * Europa League). Every competition has its own colour identity, the two crests
 * are the hero, and kick-off / live status are readable at thumbnail size.
 *
 * Returns an SVG string, or null when the fixture is not one of the supported
 * competitions / has no two teams - the caller then uses the generic card.
 * Disable with MATCH_CARD_STYLE=classic.
 */
'use strict';

const FONT = "'Inter','Segoe UI',Roboto,'Helvetica Neue','DejaVu Sans',Arial,sans-serif";

// bg: [top, bottom]  accent: highlight  ink: text on accent chips
const THEMES = {
  epl:   { name: 'PREMIER LEAGUE',   bg: ['#4a1d73', '#1b0833'], accent: '#00ff85', ink: '#1b0833', glow: '#b36bff' },
  laliga:{ name: 'LA LIGA',          bg: ['#2a0a0f', '#0d0305'], accent: '#ff4b44', ink: '#ffffff', glow: '#ff8a3d' },
  seriea:{ name: 'SERIE A',          bg: ['#06336b', '#02101f'], accent: '#27c4ff', ink: '#02101f', glow: '#2f8cff' },
  bundes:{ name: 'BUNDESLIGA',       bg: ['#3a0710', '#120205'], accent: '#ffffff', ink: '#d20515', glow: '#ff3b4d' },
  ligue1:{ name: 'LIGUE 1',          bg: ['#0b1a45', '#050b22'], accent: '#d6ff3f', ink: '#050b22', glow: '#3f6bff' },
  ucl:   { name: 'CHAMPIONS LEAGUE', bg: ['#0a2a7a', '#030a26'], accent: '#9fd0ff', ink: '#030a26', glow: '#4d8bff' },
  uel:   { name: 'EUROPA LEAGUE',    bg: ['#4a2300', '#150a00'], accent: '#ffa21f', ink: '#150a00', glow: '#ff8a00' },
  uecl:  { name: 'CONFERENCE LEAGUE',bg: ['#04451f', '#021409'], accent: '#3dff8f', ink: '#021409', glow: '#17c964' }
};

function detectCompetition(leagueRaw) {
  const l = String(leagueRaw || '').toLowerCase();
  if (!l) return null;
  if (/conference/.test(l)) return 'uecl';
  if (/europa/.test(l)) return 'uel';
  if (/champions\s*league|\buefa cl\b|\bucl\b/.test(l)) return 'ucl';
  if (/premier league|\bepl\b/.test(l) && !/(russian|scottish|ukrain|saudi|egypt|indian|kenya|ghana|nigeria|cyprus|irish|welsh|northern)/.test(l)) return 'epl';
  if (/la\s?liga(?!\s*2)|primera divisi[oó]n/.test(l)) return 'laliga';
  if (/serie a\b/.test(l) && !/brazil/.test(l)) return 'seriea';
  if (/bundesliga/.test(l) && !/(2\.|austria|2 )/.test(l)) return 'bundes';
  if (/ligue 1/.test(l)) return 'ligue1';
  return null;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Shrink the font until the name fits roughly into maxPx (avg glyph ~0.58em, caps ~0.68em).
function fitName(name, maxPx, maxFont, minFont) {
  const text = String(name || '').trim();
  let size = maxFont;
  const w = (s) => text.length * s * 0.76;
  while (size > minFont && w(size) > maxPx) size -= 1;
  let out = text;
  if (w(size) > maxPx) {
    const maxChars = Math.max(4, Math.floor(maxPx / (size * 0.76)) - 1);
    out = text.slice(0, maxChars).trim() + '…';
  }
  return { text: out.toUpperCase(), size };
}

function monogram(name) {
  const parts = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const m = (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2));
  return m.toUpperCase();
}

function crest(dataUri, name, cx, cy, size, th, id) {
  const r = size / 2;
  const plate =
    `<circle cx="${cx}" cy="${cy}" r="${r * 1.12}" fill="url(#plate)" opacity="0.95"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r * 1.12}" fill="none" stroke="${th.accent}" stroke-opacity="0.35" stroke-width="2"/>`;
  if (dataUri) {
    const pad = size * 0.14;
    return plate +
      `<image x="${cx - r + pad}" y="${cy - r + pad}" width="${size - pad * 2}" height="${size - pad * 2}" ` +
      `preserveAspectRatio="xMidYMid meet" href="${esc(dataUri)}" xlink:href="${esc(dataUri)}"/>`;
  }
  return plate +
    `<text x="${cx}" y="${cy + size * 0.14}" text-anchor="middle" font-family="${FONT}" font-weight="800" ` +
    `font-size="${size * 0.38}" fill="#ffffff" fill-opacity="0.92">${esc(monogram(name))}</text>`;
}

function parseScore(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2})\s*[:\-–]\s*(\d{1,2})$/);
  return m ? `${m[1]}  –  ${m[2]}` : '';
}


// ── Dominant crest colour (team colours are facts, not protected artwork) ──
let _sharp = null;
function getSharp() { if (_sharp === null) { try { _sharp = require('sharp'); } catch (_) { _sharp = false; } } return _sharp; }
const _colorMemo = new Map();

function hex(r, g, b) { return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }

async function dominantColor(dataUri) {
  if (!dataUri || typeof dataUri !== 'string' || !dataUri.startsWith('data:')) return null;
  if (_colorMemo.has(dataUri)) return _colorMemo.get(dataUri);
  let out = null;
  try {
    const sharp = getSharp();
    const comma = dataUri.indexOf(',');
    const meta = dataUri.slice(5, comma);
    const body = dataUri.slice(comma + 1);
    const buf = /;base64/.test(meta) ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
    if (sharp) {
      const { data, info } = await sharp(buf, { density: 96 }).resize(40, 40, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const buckets = new Map();
      for (let i = 0; i < data.length; i += info.channels) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 160) continue;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        if (lum > 232 || lum < 28 || sat < 0.28) continue;      // skip white, black, grey
        const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        const e = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0, sat: 0 };
        e.n++; e.r += r; e.g += g; e.b += b; e.sat += sat; buckets.set(k, e);
      }
      let best = null, bestScore = 0;
      for (const e of buckets.values()) {
        const score = e.n * (0.5 + e.sat / e.n);
        if (score > bestScore) { bestScore = score; best = e; }
      }
      if (best) out = hex(best.r / best.n, best.g / best.n, best.b / best.n);
    }
  } catch (_) { out = null; }
  if (_colorMemo.size > 500) _colorMemo.clear();
  _colorMemo.set(dataUri, out);
  return out;
}

async function teamColors(badge1, badge2) {
  const [c1, c2] = await Promise.all([dominantColor(badge1), dominantColor(badge2)]);
  return { color1: c1, color2: c2 };
}

function parseHex(h) { const m = /^#([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function shade(h, f) { const c = parseHex(h); if (!c) return h; return hex(c[0] * f, c[1] * f, c[2] * f); }
function dist(a, b) { const x = parseHex(a), y = parseHex(b); if (!x || !y) return 999; return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); }

function generateLeagueCardSvg(spec = {}) {
  if (String(process.env.MATCH_CARD_STYLE || '').toLowerCase() === 'classic') return null;
  const key = detectCompetition(spec.league);
  if (!key) return null;
  if (!spec.team1 || !spec.team2) return null;

  const th = THEMES[key];
  const isPoster = spec.shape === 'poster';
  const w = isPoster ? 600 : 800;
  const h = isPoster ? 889 : 450;
  const status = String(spec.status || '').toLowerCase();
  const isLive = status === 'live';
  const isReplay = status === 'replay';
  const score = parseScore(spec.score);

  const cx = w / 2;
  const parts = [];

  // ── Background: theme gradient, two soft glows, diagonal light streaks ──
  parts.push(`<rect width="${w}" height="${h}" fill="url(#bg)"/>`);
  // Two-team split: each side is washed with that team's crest colour, divided by
  // a slanted seam in the competition accent. Falls back to the theme alone.
  let c1 = spec.color1 || null;
  let c2 = spec.color2 || null;
  if (c1 && c2 && dist(c1, c2) < 70) c2 = th.glow;      // two near-identical kits: contrast the second
  if (c1 || c2) {
    const a = shade(c1 || th.glow, 0.62), b = shade(c2 || th.glow, 0.62);
    const topPoly = isPoster
      ? `0,0 ${w},0 ${w},${h * 0.43} 0,${h * 0.57}`
      : `0,0 ${w * 0.57},0 ${w * 0.43},${h} 0,${h}`;
    const botPoly = isPoster
      ? `0,${h * 0.57} ${w},${h * 0.43} ${w},${h} 0,${h}`
      : `${w * 0.57},0 ${w},0 ${w},${h} ${w * 0.43},${h}`;
    const dir1 = isPoster ? 'x1="0" y1="0" x2="0" y2="1"' : 'x1="0" y1="0" x2="1" y2="0"';
    const dir2 = isPoster ? 'x1="0" y1="1" x2="0" y2="0"' : 'x1="1" y1="0" x2="0" y2="0"';
    spec._splitDefs = `<linearGradient id="sideA" ${dir1}><stop offset="0" stop-color="${a}" stop-opacity="0.95"/><stop offset="1" stop-color="${a}" stop-opacity="0.45"/></linearGradient>` +
      `<linearGradient id="sideB" ${dir2}><stop offset="0" stop-color="${b}" stop-opacity="0.95"/><stop offset="1" stop-color="${b}" stop-opacity="0.45"/></linearGradient>`;
    parts.push(`<polygon points="${topPoly}" fill="url(#sideA)"/>`);
    parts.push(`<polygon points="${botPoly}" fill="url(#sideB)"/>`);
    const seam = isPoster
      ? `<line x1="0" y1="${h * 0.57}" x2="${w}" y2="${h * 0.43}"`
      : `<line x1="${w * 0.57}" y1="0" x2="${w * 0.43}" y2="${h}"`;
    parts.push(seam + ` stroke="${th.accent}" stroke-width="4" stroke-opacity="0.9"/>`);
  }
  parts.push(`<rect width="${w}" height="${h}" fill="url(#glowA)" opacity="${(c1 || c2) ? 0.35 : 1}"/>`);
  parts.push(`<rect width="${w}" height="${h}" fill="url(#glowB)" opacity="${(c1 || c2) ? 0.5 : 1}"/>`);
  parts.push(`<g opacity="0.07" fill="#ffffff">` +
    `<polygon points="${w * 0.05},0 ${w * 0.20},0 ${w * 0.55},${h} ${w * 0.40},${h}"/>` +
    `<polygon points="${w * 0.45},0 ${w * 0.52},0 ${w * 0.90},${h} ${w * 0.83},${h}"/>` +
    `<polygon points="${w * 0.78},0 ${w * 0.95},0 ${w * 1.2},${h} ${w * 1.03},${h}"/></g>`);
  parts.push(`<rect width="${w}" height="${h}" fill="url(#vignette)"/>`);

  const headerY = isPoster ? 74 : 52;
  // League pill (top)
  const leagueLabel = th.name;
  const pillW = Math.min(w - 80, leagueLabel.length * (isPoster ? 15.5 : 13) + 70);
  const pillH = isPoster ? 44 : 36;
  if (spec.leagueBadge) {
    const bs = isPoster ? 72 : 54;
    parts.push(`<image x="${cx - bs / 2}" y="${headerY - bs / 2 - 8}" width="${bs}" height="${bs}" ` +
      `preserveAspectRatio="xMidYMid meet" href="${esc(spec.leagueBadge)}" xlink:href="${esc(spec.leagueBadge)}"/>`);
  }
  const pillY = headerY + (spec.leagueBadge ? (isPoster ? 38 : 26) : -pillH / 2);
  parts.push(`<rect x="${cx - pillW / 2}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" ` +
    `fill="#000000" fill-opacity="0.38" stroke="${th.accent}" stroke-opacity="0.8" stroke-width="1.5"/>`);
  parts.push(`<text x="${cx}" y="${pillY + pillH / 2 + (isPoster ? 6 : 5)}" text-anchor="middle" font-family="${FONT}" ` +
    `font-weight="800" font-size="${isPoster ? 17 : 14}" letter-spacing="3" fill="${th.accent}">${esc(leagueLabel)}</text>`);

  // ── Crests + names ──
  let hero;
  if (isPoster) {
    const size = 190;
    const y1 = 252, y2 = 582;
    parts.push(crest(spec.badge1, spec.team1, cx, y1, size, th));
    parts.push(crest(spec.badge2, spec.team2, cx, y2, size, th));
    const n1 = fitName(spec.team1, w - 60, 40, 20);
    const n2 = fitName(spec.team2, w - 60, 40, 20);
    parts.push(`<text x="${cx}" y="${y1 + size / 2 + 54}" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="${n1.size}" fill="url(#ink)" letter-spacing="1">${esc(n1.text)}</text>`);
    parts.push(`<text x="${cx}" y="${y2 + size / 2 + 54}" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="${n2.size}" fill="url(#ink)" letter-spacing="1">${esc(n2.text)}</text>`);
    // Centre badge between the crests
    const midY = 454;
    hero = { x: cx, y: midY, big: !!score };
  } else {
    const size = 190;
    const yC = 215;
    const x1 = w * 0.22, x2 = w * 0.78;
    parts.push(crest(spec.badge1, spec.team1, x1, yC, size, th));
    parts.push(crest(spec.badge2, spec.team2, x2, yC, size, th));
    const n1 = fitName(spec.team1, w * 0.43, 30, 15);
    const n2 = fitName(spec.team2, w * 0.43, 30, 15);
    parts.push(`<text x="${x1}" y="${yC + size / 2 + 46}" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="${n1.size}" fill="url(#ink)" letter-spacing="1">${esc(n1.text)}</text>`);
    parts.push(`<text x="${x2}" y="${yC + size / 2 + 46}" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="${n2.size}" fill="url(#ink)" letter-spacing="1">${esc(n2.text)}</text>`);
    hero = { x: cx, y: yC + 14, big: !!score };
  }

  // Centre: score or VS
  if (score) {
    parts.push(`<text x="${hero.x}" y="${hero.y + (isPoster ? 14 : 16)}" text-anchor="middle" font-family="${FONT}" font-weight="900" ` +
      `font-size="${isPoster ? 64 : 60}" fill="#ffffff" stroke="#000000" stroke-opacity="0.35" stroke-width="1">${esc(score)}</text>`);
  } else {
    const r = isPoster ? 25 : 30;
    parts.push(`<circle cx="${hero.x}" cy="${hero.y}" r="${r}" fill="${th.accent}"/>`);
    parts.push(`<text x="${hero.x}" y="${hero.y + r * 0.36}" text-anchor="middle" font-family="${FONT}" font-weight="900" ` +
      `font-size="${r * 0.95}" fill="${th.ink}">VS</text>`);
  }

  // ── Footer chip: LIVE / REPLAY / kick-off time ──
  let chipText = String(spec.time || '').trim();
  if (isLive) chipText = 'LIVE NOW';
  else if (isReplay) chipText = chipText ? `REPLAY · ${chipText}` : 'REPLAY';
  if (chipText.length > 30) chipText = chipText.slice(0, 29) + '…';
  if (chipText) {
    const cw = Math.min(w - 60, chipText.length * (isPoster ? 15 : 13) + 64);
    const ch = isPoster ? 52 : 40;
    const cyChip = h - (isPoster ? 44 : 50) - ch / 2 - (isPoster ? 8 : 0);
    const fill = isLive ? '#e11d2e' : th.accent;
    const textFill = isLive ? '#ffffff' : th.ink;
    parts.push(`<rect x="${cx - cw / 2}" y="${cyChip}" width="${cw}" height="${ch}" rx="${ch / 2}" fill="${fill}"/>`);
    if (isLive) parts.push(`<circle cx="${cx - cw / 2 + 26}" cy="${cyChip + ch / 2}" r="6" fill="#ffffff"/>`);
    parts.push(`<text x="${cx + (isLive ? 8 : 0)}" y="${cyChip + ch / 2 + (isPoster ? 7 : 6)}" text-anchor="middle" font-family="${FONT}" ` +
      `font-weight="800" font-size="${isPoster ? 22 : 18}" letter-spacing="1.5" fill="${textFill}">${esc(chipText.toUpperCase())}</text>`);
  }
  // Bottom accent bar
  parts.push(`<rect x="0" y="${h - 8}" width="${w}" height="8" fill="${th.accent}"/>`);

  const defs =
    '<defs>' +
    `<linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${th.bg[0]}"/><stop offset="1" stop-color="${th.bg[1]}"/></linearGradient>` +
    `<radialGradient id="glowA" cx="12%" cy="8%" r="70%"><stop offset="0" stop-color="${th.glow}" stop-opacity="0.38"/><stop offset="1" stop-color="${th.glow}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="glowB" cx="92%" cy="96%" r="70%"><stop offset="0" stop-color="${th.accent}" stop-opacity="0.22"/><stop offset="1" stop-color="${th.accent}" stop-opacity="0"/></radialGradient>` +
    '<radialGradient id="vignette" cx="50%" cy="48%" r="75%"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></radialGradient>' +
    '<radialGradient id="plate" cx="50%" cy="40%" r="65%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.20"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.05"/></radialGradient>' +
    '<linearGradient id="ink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cfd6e4"/></linearGradient>' +
    '</defs>';

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    defs.replace('</defs>', (spec._splitDefs || '') + '</defs>') + parts.join('') + '</svg>';
}

module.exports = { generateLeagueCardSvg, detectCompetition, THEMES, dominantColor, teamColors };
