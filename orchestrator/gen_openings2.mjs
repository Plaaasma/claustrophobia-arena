// Phase 2: synthesize balanced openings. Take popular 4-ply prefixes, expand
// plies 5-6 with the engine's own top-K candidate moves (realistic play by
// construction), eval every resulting 6-ply line, print the same TSV format.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.HOME + '/Claustrophobia/site/data/site.db', { readOnly: true });

async function analyze(body) {
  const r = await fetch('http://127.0.0.1:9200/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: 'low', ...body }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'analyze failed');
  return j;
}

// already-evaluated 6-ply lines from phase 1 — skip duplicates
const seen = new Set();
try {
  for (const l of readFileSync('/tmp/opening_evals.tsv', 'utf8').trim().split('\n')) {
    seen.add(l.split('\t').slice(2).join('\t'));
  }
} catch { /* absent */ }

// popular 4-ply prefixes from the corpora
const pre = new Map();
const add = (moves, w) => {
  if (!moves || moves.length < 4) return;
  const p = moves.slice(0, 4).join(' ');
  pre.set(p, (pre.get(p) || 0) + w);
};
for (const f of ['human_openings.jsonl', 'model_openings.jsonl']) {
  try {
    for (const l of readFileSync(process.env.HOME + '/Claustrophobia/site/data/' + f, 'utf8').trim().split('\n')) {
      try { const d = JSON.parse(l); add(d.moves, d.count || 1); } catch { /* partial */ }
    }
  } catch { /* absent */ }
}
for (const r of db.prepare('SELECT moves FROM engine_games').all()) add(r.moves.split(' '), 3);
const prefixes = [...pre.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([p]) => p);
console.error(`${prefixes.length} four-ply prefixes`);

let evals = 0;
const MAX_EVALS = 550;
for (const p4 of prefixes) {
  if (evals >= MAX_EVALS) break;
  let t5;
  try { t5 = (await analyze({ moves: p4, sims: 3000, topK: 8, pvLen: 1 })).top || []; }
  catch (e) { console.error(`skip prefix (${e.message}): ${p4}`); continue; }
  for (const m5 of t5.slice(0, 6)) {
    if (evals >= MAX_EVALS) break;
    const p5 = `${p4} ${m5.notation}`;
    let t6;
    try { t6 = (await analyze({ moves: p5, sims: 3000, topK: 8, pvLen: 1 })).top || []; }
    catch { continue; }
    for (const m6 of t6.slice(0, 4)) {
      if (evals >= MAX_EVALS) break;
      const p6 = `${p5} ${m6.notation}`;
      if (seen.has(p6)) continue;
      seen.add(p6);
      try {
        const j = await analyze({ moves: p6, sims: 6000, topK: 1, pvLen: 1 });
        evals++;
        console.log(`${(((j.value ?? 0) + 1) / 2).toFixed(4)}\t1\t${p6}`);
        if (evals % 50 === 0) console.error(`${evals} evals`);
      } catch { /* illegal or timeout — skip */ }
    }
  }
}
console.error(`done: ${evals} new lines evaluated`);
