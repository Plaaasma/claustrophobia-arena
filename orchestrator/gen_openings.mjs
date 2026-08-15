// Mine candidate 6-ply openings from every corpus we have, eval each with the
// serving engine (low priority), print TSV: winProbRed \t weight \t opening
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.HOME + '/Claustrophobia/site/data/site.db', { readOnly: true });
const cand = new Map(); // opening -> weight
const add = (moves, w) => {
  if (!moves || moves.length < 6) return;
  const p = moves.slice(0, 6).join(' ');
  cand.set(p, (cand.get(p) || 0) + w);
};
for (const f of ['human_openings.jsonl', 'model_openings.jsonl']) {
  try {
    for (const l of readFileSync(process.env.HOME + '/Claustrophobia/site/data/' + f, 'utf8').trim().split('\n')) {
      try { const d = JSON.parse(l); add(d.moves, d.count || 1); } catch { /* partial line */ }
    }
  } catch { /* file absent */ }
}
for (const r of db.prepare('SELECT moves FROM engine_games').all()) add(r.moves.split(' '), 3);
for (const r of db.prepare("SELECT DISTINCT opening FROM arena_games WHERE opening <> ''").all()) add(r.opening.split(' '), 5);
const list = [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, 220);
console.error(`evaluating ${list.length} candidates`);
let done = 0;
for (const [op, w] of list) {
  try {
    const r = await fetch('http://127.0.0.1:9200/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: op, sims: 6000, topK: 1, pvLen: 1, priority: 'low' }),
      signal: AbortSignal.timeout(120_000),
    });
    const j = await r.json();
    if (!j.ok) { console.error(`skip (${j.error}): ${op}`); continue; }
    // winProb is side-to-move; after 6 plies Red (side 0) is to move
    console.log(`${(((j.value ?? 0) + 1) / 2).toFixed(4)}\t${w}\t${op}`);
  } catch (e) {
    console.error(`skip (${e.message}): ${op}`);
  }
  if (++done % 25 === 0) console.error(`${done}/${list.length}`);
}
