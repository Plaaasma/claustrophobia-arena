// Arena HTTP API extracted from the Claustrophobia server (server.js).
// REFERENCE EXTRACT — depends on the site's route()/sendJSON/db helpers.

// ---- bot arena (continuous engine tournament, run by claustro-arena.service) --

/** Per-pairing records from finished games: {'a|b': {games, a: {w,l,d}, b: {w,l,d}}}. */
function arenaPairRecords() {
  const rec = {};
  for (const g of db.prepare("SELECT p0, p1, winner FROM arena_games WHERE status = 'done'").all()) {
    const k = [g.p0, g.p1].sort().join('|');
    const m = (rec[k] ??= { games: 0 });
    m[g.p0] ??= { w: 0, l: 0, d: 0 };
    m[g.p1] ??= { w: 0, l: 0, d: 0 };
    m.games++;
    if (g.winner === null || g.winner === undefined) {
      m[g.p0].d++; m[g.p1].d++;
    } else {
      const win = g.winner === 0 ? g.p0 : g.p1;
      const lose = g.winner === 0 ? g.p1 : g.p0;
      m[win].w++; m[lose].l++;
    }
  }
  return rec;
}
const pairPts = (r) => (r ? r.w + r.d * 0.5 : 0);

let arenaOpenCache = { count: -1, data: null };
/** Per-opening aggregates from finished games: overall + per-engine records. */
function arenaOpeningStats() {
  const total = db.prepare(`SELECT COUNT(*) c FROM arena_games WHERE status = 'done'`).get().c;
  if (arenaOpenCache.count === total) return arenaOpenCache.data;
  const byOpen = {};
  for (const g of db.prepare(
    `SELECT opening, p0, p1, winner FROM arena_games WHERE status = 'done' AND opening IS NOT NULL AND opening != ''`).all()) {
    const o = (byOpen[g.opening] ??= { games: 0, p0w: 0, p1w: 0, d: 0, eng: {} });
    o.games++;
    const e0 = (o.eng[g.p0] ??= { games: 0, w: 0, l: 0, d: 0 });
    const e1 = (o.eng[g.p1] ??= { games: 0, w: 0, l: 0, d: 0 });
    e0.games++; e1.games++;
    if (g.winner === null || g.winner === undefined) { o.d++; e0.d++; e1.d++; }
    else if (g.winner === 0) { o.p0w++; e0.w++; e1.l++; }
    else { o.p1w++; e1.w++; e0.l++; }
  }
  const openings = Object.entries(byOpen).map(([opening, o]) => {
    const perf = Object.entries(o.eng)
      .filter(([, r]) => r.games >= 2)
      .map(([key, r]) => ({ key, games: r.games, w: r.w, l: r.l, d: r.d, pct: Math.round(((r.w + r.d / 2) / r.games) * 100) }))
      .sort((a, b) => b.pct - a.pct || b.games - a.games);
    return { opening, games: o.games, p0w: o.p0w, p1w: o.p1w, d: o.d, best: perf.slice(0, 3), worst: perf.slice(-1) };
  }).sort((a, b) => b.games - a.games);
  arenaOpenCache = { count: total, data: openings };
  return openings;
}

let arenaHistCache = { count: -1, data: {} };
function arenaHistory(total = null) {
  if (total === null) total = db.prepare(`SELECT COUNT(*) c FROM arena_games WHERE status = 'done'`).get().c;
  if (arenaHistCache.count !== total) {
    const hist = {};
    let i = 0;
    for (const g of db.prepare(
      `SELECT p0, p1, elo0_after, elo1_after FROM arena_games
       WHERE status = 'done' AND elo0_after IS NOT NULL ORDER BY id`).all()) {
      i++;
      (hist[g.p0] ??= []).push([i, Math.round(g.elo0_after)]);
      (hist[g.p1] ??= []).push([i, Math.round(g.elo1_after)]);
    }
    arenaHistCache = { count: total, data: hist };
  }
  return arenaHistCache.data;
}

route('GET', '/api/arena/state', async (req, res) => {
  let out = { bots: [], live: [], recent: [], total: 0 };
  try {
    out = {
      bots: db.prepare(
        `SELECT key, name, CAST(ROUND(elo) AS INTEGER) elo, games, wins, losses, draws
         FROM arena_bots WHERE enabled = 1 ORDER BY elo DESC`).all(),
      live: db.prepare(
        `SELECT id, p0, p1, opening, moves, evals, stats, clock0, clock1, started_at, moved_at
         FROM arena_games WHERE status = 'ongoing' ORDER BY id LIMIT 12`).all(),
      recent: db.prepare(
        `SELECT id, p0, p1, opening, moves, winner, reason,
                CAST(ROUND(elo0_after) AS INTEGER) elo0_after,
                CAST(ROUND(elo1_after) AS INTEGER) elo1_after, ended_at
         FROM arena_games WHERE status = 'done' ORDER BY id DESC LIMIT 80`).all(),
      total: db.prepare(`SELECT COUNT(*) c FROM arena_games WHERE status = 'done'`).get().c,
    };
    const pairs = arenaPairRecords();
    for (const g of out.live) {
      const m = pairs[[g.p0, g.p1].sort().join('|')];
      g.score0 = pairPts(m?.[g.p0]);
      g.score1 = pairPts(m?.[g.p1]);
      g.pairGames = m?.games || 0;
    }
    out.h2h = pairs; // per-pairing W/L/D — feeds the standings hover cards
    out.history = arenaHistory(out.total); // per-engine Elo after each finished game
  } catch {} // tables appear once the arena service has run
  out.now = Date.now(); // clients tick clocks from moved_at in server time
  sendJSON(res, 200, out);
}, { auth: false });

// Searchable, sortable finished-games query — feeds the arena page's game
// search and the engine profile filters. All filters optional.
route('GET', '/api/arena/games', async (req, res, { url }) => {
  const q = url.searchParams;
  const esc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
  const clauses = ["status = 'done'"];
  const args = [];
  const key = (v) => v && /^[a-z0-9_]{1,40}$/.test(v) ? v : null;
  const p = key(q.get('p'));
  const vs = key(q.get('vs'));
  if (p) { clauses.push('(p0 = ? OR p1 = ?)'); args.push(p, p); }
  if (vs) { clauses.push('(p0 = ? OR p1 = ?)'); args.push(vs, vs); }
  const result = q.get('result');
  if (result === 'draw') clauses.push('winner IS NULL');
  else if (result === 'decisive') clauses.push('winner IS NOT NULL');
  else if (key(result)) { clauses.push('((winner = 0 AND p0 = ?) OR (winner = 1 AND p1 = ?))'); args.push(result, result); }
  const reason = (q.get('reason') || '').slice(0, 40);
  if (reason) { clauses.push("reason LIKE ? ESCAPE '\\'"); args.push(`%${esc(reason)}%`); }
  const opening = (q.get('opening') || '').slice(0, 80);
  if (opening && /^[a-i1-9hv .]+$/.test(opening)) { clauses.push("opening LIKE ? ESCAPE '\\'"); args.push(`${esc(opening.trim())}%`); }
  const sort = { new: 'id DESC', old: 'id ASC', long: 'LENGTH(moves) DESC, id DESC', short: 'LENGTH(moves) ASC, id DESC' }[q.get('sort')] || 'id DESC';
  const limit = Math.max(1, Math.min(100, Number(q.get('limit')) || 25));
  const offset = Math.max(0, Math.min(20000, Number(q.get('offset')) || 0));
  let games = [], total = 0;
  const names = {};
  try {
    const where = clauses.join(' AND ');
    total = db.prepare(`SELECT COUNT(*) c FROM arena_games WHERE ${where}`).get(...args).c;
    games = db.prepare(
      `SELECT id, p0, p1, opening, moves, winner, reason,
              CAST(ROUND(elo0_after) AS INTEGER) elo0_after,
              CAST(ROUND(elo1_after) AS INTEGER) elo1_after, ended_at
       FROM arena_games WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    for (const b of db.prepare('SELECT key, name FROM arena_bots').all()) names[b.key] = b.name;
  } catch {}
  sendJSON(res, 200, { games, total, names, offset, limit });
}, { auth: false });

route('GET', '/api/arena/openings', async (req, res) => {
  let names = {};
  let openings = [];
  try {
    openings = arenaOpeningStats();
    for (const b of db.prepare('SELECT key, name FROM arena_bots').all()) names[b.key] = b.name;
  } catch {}
  sendJSON(res, 200, { openings, names });
}, { auth: false });

// Engine profile: rating series + paginated full game history for one bot.
route('GET', '/api/arena/engine/:key', async (req, res, { params, url }) => {
  const key = String(params.key || '');
  let bot = null;
  try { bot = db.prepare('SELECT key, name, CAST(ROUND(elo) AS INTEGER) elo, games, wins, losses, draws, enabled FROM arena_bots WHERE key = ?').get(key); } catch {}
  if (!bot) return sendJSON(res, 404, { error: 'no such engine' });
  const standings = db.prepare('SELECT key FROM arena_bots WHERE enabled = 1 ORDER BY elo DESC').all();
  const rank = standings.findIndex((b) => b.key === key) + 1;
  const names = {};
  for (const b of db.prepare('SELECT key, name FROM arena_bots').all()) names[b.key] = b.name;
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
  const games = db.prepare(
    `SELECT id, p0, p1, opening, moves, winner, reason,
            CAST(ROUND(elo0_after) AS INTEGER) elo0_after,
            CAST(ROUND(elo1_after) AS INTEGER) elo1_after, ended_at
     FROM arena_games WHERE status = 'done' AND (p0 = ? OR p1 = ?) AND id < ?
     ORDER BY id DESC LIMIT ?`).all(key, key, before, limit + 1);
  const hasMore = games.length > limit;
  if (hasMore) games.pop();
  const h2h = [];
  try {
    for (const [pk, m] of Object.entries(arenaPairRecords())) {
      const [a, b] = pk.split('|');
      if (a !== key && b !== key) continue;
      const opp = a === key ? b : a;
      h2h.push({ opp, ...(m[key] || { w: 0, l: 0, d: 0 }), games: m.games });
    }
  } catch {}
  // this engine's per-opening record
  let openings = [];
  try {
    const mine = {};
    for (const g of db.prepare(
      `SELECT opening, p0, p1, winner FROM arena_games
       WHERE status = 'done' AND opening != '' AND (p0 = ? OR p1 = ?)`).all(key, key)) {
      const side = g.p0 === key ? 0 : 1;
      const m = (mine[g.opening] ??= { games: 0, w: 0, l: 0, d: 0 });
      m.games++;
      if (g.winner === null || g.winner === undefined) m.d++;
      else if (g.winner === side) m.w++;
      else m.l++;
    }
    openings = Object.entries(mine)
      .map(([opening, r]) => ({ opening, ...r, pct: Math.round(((r.w + r.d / 2) / r.games) * 100) }))
      .sort((a, b) => b.pct - a.pct || b.games - a.games);
  } catch {}
  // per-game result timeline on the SAME global game ordinal as `history`,
  // so the chart hover can reconstruct the h2h table at any point in time
  const timeline = [];
  try {
    let i = 0;
    for (const g of db.prepare(
      `SELECT p0, p1, winner FROM arena_games
       WHERE status = 'done' AND elo0_after IS NOT NULL ORDER BY id`).all()) {
      i++;
      if (g.p0 !== key && g.p1 !== key) continue;
      const opp = g.p0 === key ? g.p1 : g.p0;
      const side = g.p0 === key ? 0 : 1;
      const r = g.winner === null || g.winner === undefined ? 'd' : g.winner === side ? 'w' : 'l';
      timeline.push([i, opp, r]);
    }
  } catch {}
  sendJSON(res, 200, { bot, rank, ranked: standings.length, names, history: arenaHistory()[key] || [], games, hasMore, h2h, openings, timeline });
}, { auth: false });

route('GET', '/api/arena/game/:id', async (req, res, { params }) => {
  let g = null, names = {};
  try {
    g = db.prepare(
      `SELECT id, p0, p1, opening, moves, evals, stats, status, winner, reason,
              clock0, clock1, started_at, ended_at, moved_at,
              CAST(ROUND(elo0_after) AS INTEGER) elo0_after,
              CAST(ROUND(elo1_after) AS INTEGER) elo1_after
       FROM arena_games WHERE id = ?`).get(Number(params.id));
    for (const b of db.prepare('SELECT key, name, CAST(ROUND(elo) AS INTEGER) elo FROM arena_bots').all()) {
      names[b.key] = { name: b.name, elo: b.elo };
    }
  } catch {}
  if (!g) return sendJSON(res, 404, { error: 'no such arena game' });
  let pair = { score0: 0, score1: 0, games: 0 };
  try {
    const m = arenaPairRecords()[[g.p0, g.p1].sort().join('|')];
    if (m) pair = { score0: pairPts(m[g.p0]), score1: pairPts(m[g.p1]), games: m.games };
  } catch {}
  sendJSON(res, 200, { game: g, names, pair, now: Date.now() });
}, { auth: false });

// Copy a finished arena game into the caller's library so the normal review
// pipeline can grade it. Idempotent per (user, arena game) via site_game_id.
route('POST', '/api/arena/game/:id/review', async (req, res, { user, params }) => {
  if (!requireVerified(res, user, 'review games')) return;
  const g = db.prepare('SELECT * FROM arena_games WHERE id = ?').get(Number(params.id));
  if (!g || !g.moves) return sendJSON(res, 404, { error: 'no such arena game' });
  if (g.status === 'ongoing') return sendJSON(res, 400, { error: 'game still in progress' });
  const tag = `arena:${g.id}`;
  const existing = db.prepare("SELECT id FROM games WHERE user_id = ? AND source = 'manual' AND site_game_id = ?").get(user.id, tag);
  if (existing) return sendJSON(res, 200, { gameId: existing.id });
  const botName = (k) => db.prepare('SELECT name FROM arena_bots WHERE key = ?').get(k)?.name || k;
  const r = db.prepare(
    `INSERT INTO games (user_id, source, status, moves, my_side, winner, win_reason, opponent, site_game_id, time_control, meta, created_at, played_at)
     VALUES (?, 'manual', 'finished', ?, 0, ?, ?, ?, ?, '3+2', ?, ?, ?)`).run(
    user.id, g.moves, g.winner ?? null, g.reason || null,
    `Arena: ${botName(g.p0)} vs ${botName(g.p1)}`, tag,
    JSON.stringify({ arenaGameId: g.id, arenaP0: g.p0, arenaP1: g.p1 }),
    Date.now(), g.ended_at || g.started_at || Date.now());
  const gameId = Number(r.lastInsertRowid);
  try { adoptCachedReview(gameId); } catch { /* best effort — reviews are shareable pure functions */ }
  sendJSON(res, 200, { gameId });
});

