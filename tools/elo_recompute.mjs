#!/usr/bin/env node
// One-shot Elo recompute over the full arena history using PAIR-based updates
// (2-game mini-matches; unpaired stragglers rate as single games). Rewrites
// arena_games.elo0/elo1/elo0_after/elo1_after and arena_bots.elo/W/L/D/games.
// Run with the arena service STOPPED.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const K = 24;
const db = new DatabaseSync(join(process.env.HOME, 'Claustrophobia', 'site', 'data', 'site.db'));
db.exec('PRAGMA busy_timeout = 15000');
db.exec('BEGIN'); // one transaction: consistent snapshot + one fsync + no lock churn

const bots = {};
for (const b of db.prepare('SELECT key FROM arena_bots').all()) {
  bots[b.key] = { elo: 1500, games: 0, w: 0, l: 0, d: 0 };
}
const bot = (k) => (bots[k] ??= { elo: 1500, games: 0, w: 0, l: 0, d: 0 });

const games = db.prepare(
  "SELECT id, p0, p1, opening, winner FROM arena_games WHERE status = 'done' ORDER BY id").all();

const updGame = db.prepare('UPDATE arena_games SET elo0 = ?, elo1 = ?, elo0_after = ?, elo1_after = ? WHERE id = ?');

function ratePair(a, b, list /* [{id, p0, aScore}] */) {
  const ra = bot(a), rb = bot(b);
  const ea = 1 / (1 + 10 ** ((rb.elo - ra.elo) / 400));
  const score = list.reduce((s, g) => s + g.aScore, 0) / list.length;
  const na = ra.elo + K * (score - ea);
  const nb = rb.elo + K * (ea - score);
  // Only the LAST game of the pair carries the post-update rating; earlier
  // games keep the pre-pair value. Pairs interleave across slots, so stamping
  // both games with the final value writes a later rating at an earlier chart
  // x — reads as a spike.
  list.forEach((g, i) => {
    const aIsP0 = g.p0 === a;
    const last = i === list.length - 1;
    const va = last ? na : ra.elo, vb = last ? nb : rb.elo;
    updGame.run(aIsP0 ? ra.elo : rb.elo, aIsP0 ? rb.elo : ra.elo, aIsP0 ? va : vb, aIsP0 ? vb : va, g.id);
  });
  ra.elo = na; rb.elo = nb;
}

// PASS 1: decide each game's partner. A real job's two games sit within a few
// dozen ids of each other (8 interleaved slots); anything unpaired within the
// window rates as a single AT ITS OWN position — never later, or the chart
// gets stamped with future-era ratings (the "spike" bug, twice over).
const PAIR_WINDOW = 60;
const partnerOf = new Map(); // second-game id -> first game row
const single = new Set();
{
  const pend = new Map();
  for (const g of games) {
    for (const [pk, pg] of pend) {
      if (g.id - pg.id > PAIR_WINDOW) { pend.delete(pk); single.add(pg.id); }
    }
    const k = [...[g.p0, g.p1].sort(), g.opening].join('|');
    if (pend.has(k)) { partnerOf.set(g.id, pend.get(k)); pend.delete(k); }
    else pend.set(k, g);
  }
  for (const pg of pend.values()) single.add(pg.id);
}

// PASS 2: chronological replay — counts per game. EVERY game is stamped with
// the ratings as of ITS OWN completion (so the chart is strictly ordered);
// the rating UPDATE lands on singles immediately and on pairs at game 2.
const firstOfPair = new Set([...partnerOf.values()].map((g) => g.id));
let pairs = 0, singles = 0;
for (const g of games) {
  const res = g.winner === null ? 0.5 : g.winner === 0 ? 1 : 0;
  const b0 = bot(g.p0), b1 = bot(g.p1);
  b0.games++; b1.games++;
  if (res === 1) { b0.w++; b1.l++; } else if (res === 0) { b0.l++; b1.w++; } else { b0.d++; b1.d++; }

  if (single.has(g.id)) {
    ratePair(g.p0, g.p1, [{ id: g.id, p0: g.p0, aScore: res }]);
    singles++;
  } else if (firstOfPair.has(g.id)) {
    // no rating change yet — snapshot current ratings at this position
    updGame.run(b0.elo, b1.elo, b0.elo, b1.elo, g.id);
  } else if (partnerOf.has(g.id)) {
    const g1 = partnerOf.get(g.id);
    const a = g1.p0; // score the pair from the first game's first-mover perspective
    const s1 = g1.winner === null ? 0.5 : g1.winner === 0 ? 1 : 0;
    const s2 = g.p0 === a ? res : 1 - res;
    // update lands on THIS game only; g1 was stamped at its own time
    ratePair(a, g1.p1, [{ id: g.id, p0: g.p0, aScore: (s1 + s2) / 2 }]);
    pairs++;
  }
}

const upd = db.prepare('UPDATE arena_bots SET elo = ?, games = ?, wins = ?, losses = ?, draws = ? WHERE key = ?');
for (const [k, r] of Object.entries(bots)) upd.run(r.elo, r.games, r.w, r.l, r.d, k);

db.exec('COMMIT');
console.log(`recomputed: ${games.length} games as ${pairs} pairs + ${singles} singles`);
for (const [k, r] of Object.entries(bots).sort((x, y) => y[1].elo - x[1].elo)) {
  if (r.games) console.log(`  ${k.padEnd(16)} ${String(Math.round(r.elo)).padStart(5)}  (${r.w}-${r.l}-${r.d} in ${r.games})`);
}
