const { generateLeagueCardSvg, detectCompetition, dominantColor } = require('../src/services/LeagueCardService');
const { generateMatchCardSvg } = require('../src/services/MinimalistPosterService');

describe('league cards', () => {
  test('detects the major competitions and ignores lookalikes', () => {
    expect(detectCompetition('UEFA Champions League')).toBe('ucl');
    expect(detectCompetition('English Premier League')).toBe('epl');
    expect(detectCompetition('La Liga')).toBe('laliga');
    expect(detectCompetition('Serie A')).toBe('seriea');
    expect(detectCompetition('Bundesliga')).toBe('bundes');
    expect(detectCompetition('Ligue 1')).toBe('ligue1');
    expect(detectCompetition('UEFA Europa League')).toBe('uel');
    expect(detectCompetition('Russian Premier League')).toBeNull();
    expect(detectCompetition('Serie A Brazil')).toBeNull();
    expect(detectCompetition('Austrian Bundesliga 2')).toBeNull();
    expect(detectCompetition('')).toBeNull();
  });

  test('renders poster and landscape SVGs with team names and escapes input', () => {
    const base = { league: 'La Liga', team1: 'Real <Madrid>', team2: "Barça & Co", time: 'Oct 26 · 07:00' };
    const land = generateLeagueCardSvg({ ...base, shape: 'landscape' });
    const post = generateLeagueCardSvg({ ...base, shape: 'poster' });
    expect(land).toContain('width="800"');
    expect(post).toContain('height="889"');
    expect(land).toContain('REAL &lt;MADRID&gt;');
    expect(land).not.toContain('<MADRID>');
    expect(land).toContain('VS');
  });

  test('live score replaces VS; falls through for non-league or missing teams', () => {
    const live = generateLeagueCardSvg({ league: 'Premier League', team1: 'A', team2: 'B', score: '2:1', status: 'live' });
    expect(live).toContain('2  –  1');
    expect(live).toContain('LIVE NOW');
    expect(generateLeagueCardSvg({ league: 'Some Cup', team1: 'A', team2: 'B' })).toBeNull();
    expect(generateLeagueCardSvg({ league: 'La Liga', team1: 'A' })).toBeNull();
  });

  test('MATCH_CARD_STYLE=classic disables it and the generic generator still works', () => {
    process.env.MATCH_CARD_STYLE = 'classic';
    try {
      expect(generateLeagueCardSvg({ league: 'La Liga', team1: 'A', team2: 'B' })).toBeNull();
      expect(generateMatchCardSvg({ category: 'football', league: 'La Liga', team1: 'A', team2: 'B' })).toContain('<svg');
    } finally { delete process.env.MATCH_CARD_STYLE; }
    expect(generateMatchCardSvg({ category: 'football', league: 'La Liga', team1: 'A', team2: 'B', shape: 'poster' })).toContain('LA LIGA');
  });
});

describe('team colours', () => {
  const uri = (fill) => 'data:image/svg+xml;base64,' + Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#fff"/><circle cx="50" cy="50" r="38" fill="${fill}"/></svg>`).toString('base64');

  test('picks the crest colour and ignores white backgrounds', async () => {
    const c = await dominantColor(uri('#a50044'));
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(120);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(110);
  });

  test('returns null for greyscale crests and non-data input', async () => {
    expect(await dominantColor(uri('#888888'))).toBeNull();
    expect(await dominantColor('https://x/y.png')).toBeNull();
    expect(await dominantColor(null)).toBeNull();
  });

  test('card uses a two-team split only when colours are provided', () => {
    const base = { league: 'La Liga', team1: 'A', team2: 'B', shape: 'landscape' };
    expect(generateLeagueCardSvg(base)).not.toContain('id="sideA"');
    expect(generateLeagueCardSvg({ ...base, color1: '#a50044', color2: '#004170' })).toContain('id="sideA"');
  });
});
