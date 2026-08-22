// Claustrophobia Bot Arena — continuous engine-vs-engine tournament.
//
// CCC-style: every pairing plays each opening twice with colors swapped.
// Clocks are 3 minutes + 2 second increment per move; the orchestrator owns
// the clocks and passes each engine a per-move time budget, so engines
// without native time management still pace themselves. Illegal moves,
// crashes and flag falls forfeit. Elo (K=24) updates after every game.
//
// Runs as claustro-arena.service; state lives in the site DB so the web
// server can serve /api/arena/* straight from tables.

import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { spawn } from 'node:child_process';

// Remote-engine transport hygiene (diagnosed with the nmbf author 2026-08-11):
// this host has NO global IPv6 route, so AAAA legs die instantly with
// ENETUNREACH, and Node's Happy-Eyeballs default gives each address only
// ~250ms to complete a TCP handshake — a cold anycast PoP loses that race.
// Prefer v4 and give each connect attempt a real budget.
setDefaultResultOrder('ipv4first');
try { setDefaultAutoSelectFamilyAttemptTimeout(2500); } catch { /* older node */ }
import { openSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..', 'site');
const rules = await import(join(SITE, 'shared', 'rules.js').replace(/\\/g, '/'));
const { initialState, replayMoves, allLegalMoves, isTerminal, winner, parseMove, pathDist } = rules;

const DB_PATH = join(SITE, 'data', 'site.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');

const GAMES_TARGET = 8;          // concurrent boards
const BASE_MS = 180_000;         // 3 minutes
const INC_MS = 2_000;            // +2s per move
const MOVE_CAP = 400;            // ply cap → draw
const K = 24;                    // Elo K-factor

// ---------------------------------------------------------------------------
// DB schema

db.exec(`
CREATE TABLE IF NOT EXISTS arena_bots (
  key TEXT PRIMARY KEY, name TEXT NOT NULL,
  elo REAL NOT NULL DEFAULT 1500, games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS arena_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  p0 TEXT NOT NULL, p1 TEXT NOT NULL,
  opening TEXT NOT NULL, pair_tag TEXT NOT NULL,
  moves TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ongoing',
  winner INTEGER, reason TEXT,
  clock0 REAL, clock1 REAL,
  elo0 REAL, elo1 REAL, elo0_after REAL, elo1_after REAL,
  started_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_arena_games_status ON arena_games(status);
`);
try { db.exec('ALTER TABLE arena_games ADD COLUMN evals TEXT'); } catch {} // one eval per ply, p0 POV, null = engine gave none
try { db.exec('ALTER TABLE arena_games ADD COLUMN moved_at INTEGER'); } catch {} // when the side to move started thinking — clients tick clocks from this
try { db.exec('ALTER TABLE arena_games ADD COLUMN stats TEXT'); } catch {}
try { db.exec('ALTER TABLE arena_bots ADD COLUMN offline INTEGER NOT NULL DEFAULT 0'); } catch {} // repeated-bench engines: greyed + labeled on the site; a camped rating must be visibly unbeatable-by-absence // per-ply {n: nodes/sims, ms} from the engine that moved, null = book/none

const ROSTER = [
  { key: 'claustrophobia', name: 'Claustrophobia v2' },
  { key: 'titanium', name: 'Titanium v19.8.2' }, // 12532da — ships gated champion net f430f608; repo says 19.8.2 (owner said 19.8.3)
  { key: 'gorisanson', name: 'Gorisanson 0.3' },
  { key: 'qbr', name: 'ACE QBR' }, // per the authors: neutral name, not "Ace One"
  { key: 'ishtar', name: 'ACE Ishtar 16' }, // claustro-ishnat*.service — native harness (extracted net + search, ORT CPU)
  { key: 'sigma', name: 'SigmaQuoridor 321' },
  { key: 'ka', name: 'Ka' }, // served from claustro-ka.service on this host
  // claustro_v1 removed 2026-08-09 (user) — service stopped, Elo/history kept; re-add = restore this line + start claustro-v1.service
  { key: 'claustro_cpu', name: 'Claustrophobia v2 CPU' }, // same live champion, CPU-only engined :9202, 2 threads — the fair-fight entry
  { key: 'sigma_gpu', name: 'SigmaQuoridor 321 GPU' }, // same net, CUDA + sim_batch_size 8 (~1.3k sims/s vs ~65 CPU)
  { key: 'ka_gpu', name: 'Ka GPU' }, // same net via onnx2torch on CUDA (claustro-ka-gpu.service :9718, ~2x CPU speed)
  { key: 'kya', name: 'Kya 188-249' }, // xwkya/quoridor-zi container (kya-gpu.service, 172.18.0.10:9040, ORT CUDA)
  // kya_cpu removed 2026-08-20 (user) — kya-cpu.service stopped, Elo/history kept; re-add = restore this line + start kya-cpu.service
  { key: 'nmbf', name: 'nmbf v15' }, // REMOTE author-hosted endpoint (closed source); own time management from clock
  { key: 'ishtar2', name: 'Ishtar' }, // THE REAL ISHTAR — author's optima container (UGI over stdio, GB10 GPU inference; private weights), pooled on engine-host
  { key: 'ace_kya', name: 'ACE Kya' }, // se24 python MCTS (spark1 engine-host pool; shipping-default config, own mtg=24 clocking; NO eval by user request)
  // house baseline bots — deliberately simple classical engines (~arena floor);
  // deterministic, so variety comes entirely from the opening pairs
  { key: 'pathfinder', name: 'Greedy Racer' }, // shortest-path racer + reactive walls
  { key: 'scout', name: 'Minimax Depth 2' }, // fixed depth-2 alpha-beta, path-diff eval
  { key: 'sentinel', name: 'Minimax Depth 4' }, // iterative-deepening alpha-beta to depth 4
];
// per-engine concurrent-game caps = real parallel capacity: two native Ishtar
// harnesses, two Ka servers, one Ka GPU server, a two-worker Sigma pool, four QBR CPU threads
// caps must MATCH the engine-host pool sizes for hosted engines — an uncapped
// scheduler seat 503s as "pool exhausted" (titanium/gorisanson bug 2026-08-12)
const LIMITS = { ishtar: 2, sigma: 2, sigma_gpu: 2, ka: 2, ka_gpu: 1, qbr: 4, titanium: 2, gorisanson: 2, claustro_v1: 2, claustro_cpu: 2, pathfinder: 2, scout: 2, sentinel: 2, kya: 2, nmbf: 1, ishtar2: 1, ace_kya: 1 };
for (const b of ROSTER) {
  db.prepare('INSERT INTO arena_bots (key, name, enabled) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET name = excluded.name, enabled = 1')
    .run(b.key, b.name);
}
// engines dropped from the roster stop being scheduled (history + Elo kept)
db.prepare(`UPDATE arena_bots SET enabled = 0 WHERE key NOT IN (${ROSTER.map(() => '?').join(',')})`)
  .run(...ROSTER.map((b) => b.key));
// orphaned ongoing games from a previous crash → void
db.prepare("UPDATE arena_games SET status = 'void', reason = 'orchestrator restart' WHERE status = 'ongoing'").run();

// ---------------------------------------------------------------------------
// Time management (orchestrator-side, used for every engine)

// Derived clock rule (engine-project arena forensics 2026-08-12, verdict
// §3.2): spend (rem - RESERVE) evenly over the estimated remaining moves,
// never dip under RESERVE_HARD, degrade to the floor below the reserve
// instead of orbiting a fixed point. Applies identically to every engine.
const RESERVE_MS = 40_000;
const RESERVE_HARD_MS = 3_000;
const BUDGET_FLOOR_MS = 150;
const BUDGET_CAP_MS = 15_000;
function budgetMs(remaining, st = null) {
  let movesLeft = 16;
  if (st) {
    try {
      const d = Math.max(pathDist(st, 0), pathDist(st, 1));
      movesLeft = Math.max(8, Math.min(30, d + 6));
    } catch { /* estimator only */ }
  }
  const base = (remaining - RESERVE_MS) / movesLeft + INC_MS;
  return Math.round(Math.max(BUDGET_FLOOR_MS, Math.min(base, BUDGET_CAP_MS, remaining - RESERVE_HARD_MS)));
}

// ---------------------------------------------------------------------------
// Adapter: Claustrophobia (engined over HTTP; budget → sims via measured rate)

// batched MCGS era (2026-08-12, upstream-finished): ~8k sims/s measured on
// the shared server. sims is a ceiling; movetime governs.
let claustroGpuRate = 6000; // sims/s EWMA — learns from realized simsRun
async function claustroMove(moves, budget, clock) {
  // SERVER-SIDE TIME MANAGEMENT (QUORIDOR_TM=1 live 2026-08-16): with a valid
  // clock the engine plans its own per-move time from the raw fields — the
  // old caller-side sims ladder, movetime math and 8s panic path are retired
  // on this path (the engine's own panic + implausible-clock tightening
  // replace them). Legacy math kept only as the no-clock fallback.
  const tmMode = Number.isFinite(clock?.my_ms) && clock.my_ms > 0;
  const panic = !tmMode && (clock?.my_ms ?? Infinity) < 8_000;
  const sims = panic ? 32 : Math.max(200, Math.round((budget / 1000) * claustroGpuRate * 1.5));
  const t0 = Date.now();
  // low lane: bot games must never queue a human's move behind them
  const body = JSON.stringify(tmMode
    ? {
      moves: moves.join(' '), topK: 1, pvLen: 1, priority: 'low',
      remaining_ms: Math.round(clock.my_ms), increment_ms: Math.round(clock.inc_ms || 0), overhead_ms: 120,
    }
    : { moves: moves.join(' '), sims, movetime: panic ? 60 : Math.max(300, budget - 250), topK: 1, pvLen: 1, priority: 'low' });
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(process.env.CLAUSTRO_ARENA_URL || 'http://169.254.152.37:9200/analyze', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        // TM's wall cap tops out at 60s — the timeout only guards a wedged server
        signal: AbortSignal.timeout(tmMode ? 70_000 : Math.max(5000, budget * 3)),
      });
      const j = await r.json();
      if (!j.ok) throw new Error('analyze not ok');
      // engined value: 0..1 win prob unsolved, ±[-1,1] solved — fold to 0..1
      const v = j.value;
      const ev = typeof v === 'number' ? (v < 0 ? (v + 1) / 2 : Math.min(v, 1)) : null;
      const dtg = Math.max(0.05, (Date.now() - t0) / 1000);
      if (!tmMode && !panic && j.simsRun > 0) claustroGpuRate = 0.75 * claustroGpuRate + 0.25 * (j.simsRun / dtg);
      return { n: j.top?.[0]?.notation || j.bestmove, ev, nodes: j.simsRun ?? j.sims ?? sims, ms: Date.now() - t0 };
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((ok) => setTimeout(ok, 2000)); // engined restart window (champion sync ~8-10s)
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter: ACE QBR — NATIVE aarch64 build from the zip's rust source (the
// missing src/cat.rs is stubbed; the cat_root feature stays off, and the
// build reproduces the canonical binary's bench signature
// 17389156364253996563 exactly, so it is search-identical to the engine the
// author shipped). QBP protocol, persistent child per game seat. Owner asks
// for ~200ms grace over the nominal budget, which our flag margin provides.

const QBR_BIN_NATIVE = join(process.env.HOME, 'arena-engines', 'qbr-r4', 'rust', 'target', 'release', 'qbr');
// gen_r4 net (2026-08-18 drop): blob + manifest MUST sit in the same dir; the
// flags below are the authors' deployed champion config. Build verified against
// their exact bench identity (nodes=329265 signature=816116888495200073).
const QBR_NNUE = join(process.env.HOME, 'arena-engines', 'qbr-r4', 'gen_r4.qnn');
function qbrStateOf(st) {
  const cell = ([r, c]) => String.fromCharCode(97 + c) + (r + 1);
  const slot = (s) => String.fromCharCode(97 + (s % 8)) + (Math.floor(s / 8) + 1);
  const list = (m) => { const a = [...m].map(slot); return a.length ? a.join(',') : '-'; }; // README says "h=;" but the binary only accepts "-"
  return `p0=${cell(st.pawns[0])};p1=${cell(st.pawns[1])};w0=${st.wallsLeft[0]};w1=${st.wallsLeft[1]};h=${list(st.hwalls)};v=${list(st.vwalls)};t=${st.side}`;
}
// centipawn (side-to-move frame) -> rough win prob, chess-style logistic
const cpToEv = (cp) => 1 / (1 + Math.pow(10, -cp / 400));
function makeQbr() {
  const child = spawn(QBR_BIN_NATIVE, ['qbp', '--feature', `nnue3=${QBR_NNUE}`, '--feature', 'wallq_tc=off', '--feature', 'rfp_margin=50', '--feature', 'threads=1'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let ebuf = '';
  let lastNodes = null;
  let lastScore = null;
  const infoLine = (line) => {
    if (!line.startsWith('info ')) return;
    const nm = line.match(/\bnodes=(\d+)/);
    if (nm) lastNodes = Number(nm[1]);
    const sm = line.match(/\bscore=(-?\d+)/); // score_frame=stm per protocol dump
    if (sm) lastScore = Number(sm[1]);
  };
  const waiters = [];
  // qbr prints `info ... nodes=N score=S` on STDERR; only `move` answers go to stdout
  child.stderr.on('data', (d) => {
    ebuf += d.toString();
    let idx;
    while ((idx = ebuf.indexOf('\n')) >= 0) {
      infoLine(ebuf.slice(0, idx).trim());
      ebuf = ebuf.slice(idx + 1);
    }
  });
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      infoLine(line);
      if (line.startsWith('move ')) {
        const w = waiters.shift();
        const tok = line.slice(5).trim();
        // stderr info lines race the stdout move line — give them a beat to land
        if (w) setTimeout(() => {
          w.resolve({ tok, nodes: lastNodes, score: lastScore, ms: Date.now() - w.t0 });
          lastNodes = null; lastScore = null;
        }, 80);
        else { lastNodes = null; lastScore = null; }
      }
    }
  });
  child.on('exit', () => { for (const w of waiters.splice(0)) w.reject(new Error('qbr exited')); });
  child.stdin.write('newgame\n');
  return {
    child,
    async move(moves, budget) {
      const state = qbrStateOf(replayMoves(moves));
      const r = await new Promise((resolve, reject) => {
        waiters.push({ resolve, reject, t0: Date.now() });
        child.stdin.write(`genmove ${Math.max(80, Math.round(budget) - 150)} ${state}\n`);
        setTimeout(() => reject(new Error('qbr timeout')), budget * 3 + 10_000);
      });
      // README claims prefix wall tokens (hb3) but the binary emits our suffix
      // style (d5v); convert only a true prefix form — second char must be a
      // file letter, so pawn "h3" and walls "h5v"/"b3h" pass through untouched
      const n = /^[hv][a-h][1-8]$/.test(r.tok) ? r.tok.slice(1) + r.tok[0] : r.tok;
      const ev = typeof r.score === 'number' ? cpToEv(r.score) : null; // score_frame=stm
      return { n, ev, nodes: r.nodes, ms: r.ms };
    },
    kill() { try { child.kill(); } catch {} },
  };
}

// ---------------------------------------------------------------------------
// Adapter: ACE Ishtar — native harness (claustro-ishnat*.service). The
// extracted search modules + b2 net run in Node with an ORT-CPU eval sidecar;
// verified move-identical to the original WebGPU build at fixed node budgets.
// Notation passes through untranslated: ours == the page's "official" notation.

const ISHTAR_ENDPOINTS = (process.env.ISHTAR_BRIDGE || 'http://169.254.152.37:9720,http://169.254.152.37:9721')
  .split(',').map((url) => ({ url, busy: false }));
async function ishtarMove(moves, budget) {
  const ep = ISHTAR_ENDPOINTS.find((e) => !e.busy) || ISHTAR_ENDPOINTS[0];
  ep.busy = true;
  try {
    const r = await fetch(ep.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moves, timeMs: Math.max(200, budget - 250), budget_ms: Math.max(200, budget - 250) }),
      signal: AbortSignal.timeout(Math.round(budget * 3) + 8000),
    });
    const j = await r.json();
    if (!j.ok) throw new Error('ishtar: ' + (j.err || j.error || 'bridge error'));
    const raw = typeof j.winProb === 'number' ? j.winProb : (typeof j.ev === 'number' ? j.ev : null);
    const ev = raw == null ? null : Math.max(0, Math.min(1, raw));
    return { n: j.move, ev, nodes: j.nodes ?? null, ms: j.ms ?? null };
  } finally {
    ep.busy = false;
  }
}

// ---------------------------------------------------------------------------
// Adapter: Claustrophobia v1 — the last v1-era champion on its own engined
// instance (:9201, claustro-v1.service). Same protocol as the main adapter;
// the older net is slower per sim, so it gets its own budget rate.

const CLAUSTRO_V1_SIMS_PER_SEC = 3000; // measured ~6k/s warm on the TRT plan; halved for load safety
async function claustroV1Move(moves, budget) {
  const sims = Math.max(150, Math.round((budget / 1000) * CLAUSTRO_V1_SIMS_PER_SEC));
  const t0 = Date.now();
  const body = JSON.stringify({ moves: moves.join(' '), sims, topK: 1, pvLen: 1 });
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch('http://127.0.0.1:9201/analyze', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(Math.max(5000, Math.round(budget) * 3)),
      });
      const j = await r.json();
      if (!j.ok) throw new Error('analyze not ok');
      const v = j.value;
      const ev = typeof v === 'number' ? (v < 0 ? (v + 1) / 2 : Math.min(v, 1)) : null;
      return { n: j.top?.[0]?.notation || j.bestmove, ev, nodes: j.simsRun ?? j.sims ?? sims, ms: Date.now() - t0 };
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter: Claustrophobia v2 CPU — the SAME live champion as v2, but on a
// CPU-only engined instance (:9202, GPU hidden, 2 torch threads). The
// level-playing-field entry vs the alpha-beta engines. Rate self-calibrates.

let claustroCpuRate = 250; // sims/sec EMA — measured ~265 at 2 threads (batched MCTS)
async function claustroCpuMove(moves, budget, clock) {
  // Server-side TM on this seat too (F1's 176/177 forfeits were HERE — the
  // engine's clock-derived deadline + panic replace the caller-side guards).
  const tmMode = Number.isFinite(clock?.my_ms) && clock.my_ms > 0;
  const panic = !tmMode && (clock?.my_ms ?? Infinity) < 8_000;
  const sims = panic ? 24 : Math.max(48, Math.min(8000, Math.round((budget / 1000) * claustroCpuRate * 1.5)));
  const body = JSON.stringify(tmMode
    ? {
      moves: moves.join(' '), topK: 1, pvLen: 1,
      remaining_ms: Math.round(clock.my_ms), increment_ms: Math.round(clock.inc_ms || 0), overhead_ms: 120,
    }
    : { moves: moves.join(' '), sims, movetime: panic ? 60 : Math.max(300, Math.round(budget) - 250), topK: 1, pvLen: 1 });
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(process.env.CLAUSTRO_CPU_ARENA_URL || 'http://169.254.152.37:9202/analyze', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(tmMode ? 70_000 : Math.round(budget) * 6 + 30_000),
      });
      const j = await r.json();
      if (!j.ok) throw new Error('analyze not ok');
      const dt = Math.max(0.05, (Date.now() - t0) / 1000);
      // learn from what actually ran — the movetime cap means simsRun <= sims
      if (!tmMode) claustroCpuRate = 0.7 * claustroCpuRate + 0.3 * ((j.simsRun ?? sims) / dt);
      const v = j.value;
      const ev = typeof v === 'number' ? (v < 0 ? (v + 1) / 2 : Math.min(v, 1)) : null;
      return { n: j.top?.[0]?.notation || j.bestmove, ev, nodes: j.simsRun ?? j.sims ?? sims, ms: Date.now() - t0 };
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter: Titanium — SESSION protocol (persistent warm TitaniumSearch).
// `titanium uci` runs the repo's LEGACY GameSearchSession search (~100k n/s,
// docs call it "testing infra"); `titanium session --engine titanium-v17`
// runs TitaniumSearch::production, the real engine (~1.7M n/s). The v17 label
// is wire-compat only — it selects the binary's one production search.
// Wire: `position m1 m2 ...` → `ready N`; `go SEC` → `info json {...}` +
// `bestmove MOVE`, all on stdout. Same move notation as ours.

const TITANIUM_BIN = join(process.env.HOME, 'arena-engines', 'titanium-engine', 'target', 'release', 'titanium');
function makeTitanium() {
  const child = spawn(TITANIUM_BIN, ['session', '--engine', 'titanium-v17'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let lastNodes = null;
  let lastScore = null;
  const waiters = [];
  child.stderr.on('data', () => {}); // keep the pipe drained
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('info json')) {
        const nm = line.match(/"totalNodes":(\d+)|"nodes":(\d+)/);
        if (nm) lastNodes = Number(nm[1] ?? nm[2]);
        const sm = line.match(/"rootScore":(-?\d+)/); // cp, side-to-move frame
        if (sm) lastScore = Number(sm[1]);
      }
      if (line.startsWith('error ')) {
        const w = waiters.shift();
        if (w) w.reject(new Error('titanium: ' + line.slice(6)));
      }
      if (line.startsWith('bestmove ')) {
        const w = waiters.shift();
        const ev = typeof lastScore === 'number' ? cpToEv(lastScore) : null;
        if (w) w.resolve({ n: line.slice(9).trim(), ev, nodes: lastNodes, ms: Date.now() - w.t0 });
        lastNodes = null; lastScore = null;
      }
    }
  });
  child.on('exit', () => { for (const w of waiters.splice(0)) w.reject(new Error('titanium exited')); });
  return {
    child,
    async move(moves, budget) {
      return await new Promise((resolve, reject) => {
        waiters.push({ resolve, reject, t0: Date.now() });
        const sec = Math.max(0.2, (budget - 250) / 1000);
        child.stdin.write(`position ${moves.join(' ')}\ngo ${sec.toFixed(2)}\n`);
        setTimeout(() => reject(new Error('titanium timeout')), budget + 8000);
      });
    },
    kill() { try { child.kill(); } catch {} },
  };
}

// ---------------------------------------------------------------------------
// Adapter: Gorisanson (browser JS evaluated in a VM context; time-sliced MCTS)
// Their board: row 0 at top, first mover starts (8,4) → our row r maps to 8-r.

const GOR_DIR = join(process.env.HOME, 'arena-engines', 'quoridor-ai', 'src', 'js');
const gorSource = readFileSync(join(GOR_DIR, 'game.js'), 'utf8') + '\n' + readFileSync(join(GOR_DIR, 'ai.js'), 'utf8');
function makeGorContext() {
  const sandbox = { console: { log() {}, error() {} }, Math, Date, postMessage() {} };
  createContext(sandbox);
  // class/let/const are lexical in the context — explicitly hoist what we use
  runInContext(gorSource + '\n;globalThis.Game = Game; globalThis.AI = AI; globalThis.MonteCarloTreeSearch = MonteCarloTreeSearch;', sandbox);
  return sandbox;
}
const gorCtx = makeGorContext();
const UCT = 0.2;

function ourMoveToGor(n) {
  const m = parseMove(n);
  if (m.kind === 'pawn') return [[8 - m.r, m.c], null, null];
  if (m.h) return [null, [7 - m.sr, m.sc], null];
  return [null, null, [7 - m.sr, m.sc]];
}
function gorMoveToOurs(mv) {
  if (mv[0]) return rules.formatPawn(8 - mv[0][0], mv[0][1]);
  if (mv[1]) return rules.formatWall(7 - mv[1][0], mv[1][1], true);
  return rules.formatWall(7 - mv[2][0], mv[2][1], false);
}

async function gorisansonMove(moves, budget) {
  const t0 = Date.now();
  const deadline = t0 + budget;
  const g = new gorCtx.Game(true); // pawn 0 = first mover
  for (const n of moves) g.doMove(ourMoveToGor(n), true);
  // their opening heuristic shortcut for first two plies
  const mcts = new gorCtx.MonteCarloTreeSearch(gorCtx.Game.clone(g), UCT);
  let simsDone = 0;
  do {
    mcts.search(400);
    simsDone += 400;
    await new Promise((ok) => setImmediate(ok)); // stay responsive
  } while (Date.now() < deadline - 60);
  const best = mcts.selectBestMove();
  let bestMove = best.move;
  // their low-winrate shortest-path rescue heuristic (verbatim behavior)
  if (((g.turn < 6 && g.pawnOfTurn.position.col === 4) || best.winRate < 0.1) && bestMove[0] !== null) {
    const nexts = gorCtx.AI.chooseShortestPathNextPawnPositionsThoroughly(g);
    const ok = nexts.some((p) => bestMove[0][0] === p.row && bestMove[0][1] === p.col);
    if (!ok && nexts.length) {
      const p = nexts[Math.floor(Math.random() * nexts.length)];
      bestMove = [[p.row, p.col], null, null];
    }
  }
  const ev = typeof best.winRate === 'number' ? Math.max(0, Math.min(1, best.winRate)) : null;
  return { n: gorMoveToOurs(bestMove), ev, nodes: simsDone, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Adapter: SigmaQuoridor (persistent python worker, torch CPU; one shared
// process — the scheduler caps sigma at one concurrent game)

const sigmaPools = { cpu: [], gpu: [] }; // separate persistent worker pools per device
let sigmaErrFd = null;
function sigmaSpawn(kind) {
  // stderr → shared log: the worker's watchdog dumps the hanging position +
  // stack trace there when it has to shoot a wedged search
  if (sigmaErrFd === null) {
    try { sigmaErrFd = openSync(join(process.env.HOME, 'arena-engines', 'sigma_worker.err'), 'a'); }
    catch { sigmaErrFd = 'ignore'; }
  }
  const c = spawn('python3', [join(process.env.HOME, 'arena-engines', 'sigma_worker.py')],
    {
      stdio: ['pipe', 'pipe', sigmaErrFd ?? 'ignore'],
      env: kind === 'gpu' ? { ...process.env, SIGMA_DEVICE: 'cuda' } : process.env,
    });
  c.buf = '';
  c.waiters = [];
  c.stdout.on('data', (d) => {
    c.buf += d.toString();
    let i;
    while ((i = c.buf.indexOf('\n')) >= 0) {
      const line = c.buf.slice(0, i);
      c.buf = c.buf.slice(i + 1);
      const w = c.waiters.shift();
      if (w) { try { w.resolve(JSON.parse(line)); } catch (e) { w.reject(e); } }
    }
  });
  c.on('exit', () => { for (const w of c.waiters.splice(0)) w.reject(new Error('sigma worker exited')); });
  const slot = { child: c, busy: false };
  sigmaPools[kind].push(slot);
  return slot;
}
function sigmaWorker(kind) {
  const pool = sigmaPools[kind];
  for (let i = pool.length - 1; i >= 0; i--) if (pool[i].child.exitCode !== null) pool.splice(i, 1);
  return pool.find((s) => !s.busy) || sigmaSpawn(kind);
}
async function sigmaMoveKind(kind, moves, budget) {
  const s = sigmaWorker(kind);
  s.busy = true;
  try {
    const j = await new Promise((resolve, reject) => {
      let settled = false;
      s.child.waiters.push({
        resolve: (v) => { settled = true; resolve(v); },
        reject: (e) => { settled = true; reject(e); },
      });
      s.child.stdin.write(JSON.stringify({ moves, budget_ms: Math.max(300, Math.round(budget) - 200) }) + '\n');
      setTimeout(() => {
        if (settled) return;
        reject(new Error('sigma timeout'));
        // Evict BEFORE killing: a worker stuck inside native code can shrug
        // off SIGTERM and sit in the pool eating every later request (the
        // 2026-08-09 incident: one wedged worker drew every sigma game for
        // half an hour). SIGKILL is not ignorable.
        const pool = sigmaPools[kind];
        const idx = pool.indexOf(s);
        if (idx >= 0) pool.splice(idx, 1);
        try { s.child.kill('SIGKILL'); } catch {}
      }, Math.max(150_000, budget * 4 + 90_000)); // worker watchdog (4x+60s, floor 120s) must fire first
    });
    if (!j.ok) throw new Error('sigma: ' + j.err);
    return { n: j.move, ev: typeof j.ev === 'number' ? j.ev : null, nodes: j.sims ?? null, ms: j.ms ?? null };
  } finally {
    s.busy = false;
  }
}
const sigmaMove = (moves, budget) => sigmaMoveKind('cpu', moves, budget);
const sigmaGpuMove = (moves, budget) => sigmaMoveKind('gpu', moves, budget);

// ---------------------------------------------------------------------------
// Adapter: Ka (sugiyama2718/Quoridor, epoch4100 checkpoint — dedicated
// ka_server instance on the Windows box, :9716; the barricade bridge keeps
// its own on :9715). Ka notation = pure vertical mirror of ours (proven by
// conform.py): pawn rank r -> 10-r, wall rank r -> 9-r, files unchanged.

const KA_ENDPOINTS = (process.env.KA_ARENA || 'http://169.254.152.37:9716/move,http://169.254.152.37:9717/move')
  .split(',').map((url) => ({ url, busy: false }));
const kaFlip = (mv) => (mv.length === 2
  ? mv[0] + String(10 - Number(mv[1]))
  : mv[0] + String(9 - Number(mv.slice(1, -1))) + mv[mv.length - 1]);
let kaRate = 120; // nodes/sec EMA — CPU TF on a shared box; starts pessimistic
async function kaMove(moves, budget) {
  const nodes = Math.max(100, Math.min(6_000, Math.round(kaRate * Math.max(0.3, (budget - 300) / 1000))));
  const ep = KA_ENDPOINTS.find((e) => !e.busy) || KA_ENDPOINTS[0];
  ep.busy = true;
  const t0 = Date.now();
  let j;
  try {
    const r = await fetch(ep.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actions: moves.map(kaFlip), search_nodes: nodes, tau: 0 }),
      signal: AbortSignal.timeout(Math.round(budget * 8) + 60_000),
    });
    j = await r.json();
  } catch (e) {
    kaRate = Math.max(20, kaRate / 2); // overshot the box's real speed — adapt from failures too
    throw e;
  } finally {
    ep.busy = false;
  }
  if (!j.action) throw new Error('ka: ' + JSON.stringify(j).slice(0, 120));
  const dt = Math.max(0.05, (Date.now() - t0) / 1000);
  kaRate = 0.7 * kaRate + 0.3 * (nodes / dt);
  const ev = typeof j.value === 'number' ? Math.max(0, Math.min(1, (j.value + 1) / 2)) : null;
  return { n: kaFlip(j.action), ev, nodes: j.nodes ?? nodes, ms: Math.round(dt * 1000) };
}

// Ka GPU: same server code with the net swapped onto CUDA via onnx2torch
// (claustro-ka-gpu.service :9718). Own rate EMA — measured ~590 n/s warm.
const KA_GPU_URL = process.env.KA_GPU_ARENA || 'http://169.254.152.37:9718/move';
let kaGpuBusy = false;
let kaGpuRate = 400; // nodes/sec EMA — starts below measured warm speed
async function kaGpuMove(moves, budget) {
  const nodes = Math.max(100, Math.min(12_000, Math.round(kaGpuRate * Math.max(0.3, (budget - 300) / 1000))));
  kaGpuBusy = true;
  const t0 = Date.now();
  let j;
  try {
    const r = await fetch(KA_GPU_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actions: moves.map(kaFlip), search_nodes: nodes, tau: 0 }),
      signal: AbortSignal.timeout(Math.round(budget * 8) + 60_000),
    });
    j = await r.json();
  } catch (e) {
    kaGpuRate = Math.max(50, kaGpuRate / 2);
    throw e;
  } finally {
    kaGpuBusy = false;
  }
  if (!j.action) throw new Error('ka_gpu: ' + JSON.stringify(j).slice(0, 120));
  const dt = Math.max(0.05, (Date.now() - t0) / 1000);
  kaGpuRate = 0.7 * kaGpuRate + 0.3 * (nodes / dt);
  const ev = typeof j.value === 'number' ? Math.max(0, Math.min(1, (j.value + 1) / 2)) : null;
  return { n: kaFlip(j.action), ev, nodes: j.nodes ?? nodes, ms: Math.round(dt * 1000) };
}

// ---------------------------------------------------------------------------
// Adapters: house baseline bots (Pathfinder / Scout / Sentinel) — persistent
// JSONL children over the site's shared rules.js. Deterministic, fast
// (<200ms/move), one child per game seat.

const SIMPLE_DIR = join(process.env.HOME, 'arena-engines', 'simple');
const SIMPLE_RULES = join(process.env.HOME, 'Claustrophobia', 'site', 'shared', 'rules.js');
function makeSimple(key) {
  const child = spawn(process.execPath, [join(SIMPLE_DIR, `${key}.mjs`)],
    { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, QUORIDOR_RULES: SIMPLE_RULES } });
  let buf = '';
  const waiters = [];
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const w = waiters.shift();
      if (!w) continue;
      try { w.resolve(JSON.parse(line)); } catch (e) { w.reject(e); }
    }
  });
  child.on('exit', () => { for (const w of waiters.splice(0)) w.reject(new Error(`${key} exited`)); });
  return {
    child,
    async move(moves, budget) {
      const j = await new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        child.stdin.write(JSON.stringify({ moves, budget_ms: Math.max(200, budget - 200) }) + '\n');
        setTimeout(() => reject(new Error(`${key} timeout`)), budget + 8000);
      });
      if (!j.ok) throw new Error(`${key}: ${j.error}`);
      return { n: j.move, ev: typeof j.ev === 'number' ? Math.max(0, Math.min(1, j.ev)) : null, nodes: j.nodes ?? null, ms: j.ms ?? null };
    },
    kill() { try { child.kill(); } catch {} },
  };
}

// ---------------------------------------------------------------------------
// Adapter: Kya (containerized .NET AlphaZero engine; speaks our exact wire
// contract on quoridor-engine/1 — {moves, budget_ms} -> {ok, move, ev, nodes}.
// Static IPs on the internal-only docker network kya-net; server-owned time
// management, ev already own-win-prob 0..1.

function makeKyaAdapter(url) {
  return async function kyaMoveHttp(moves, budget) {
    const t0 = Date.now();
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moves, budget_ms: Math.max(300, Math.round(budget) - 250) }),
      signal: AbortSignal.timeout(Math.round(budget) * 3 + 15_000),
    });
    const j = await r.json();
    if (!j.ok) throw new Error('kya: ' + (j.error || 'engine error'));
    const ev = typeof j.ev === 'number' ? Math.max(0, Math.min(1, j.ev)) : null;
    // nodes:0 = served from their per-position analysis cache — hide rather
    // than display "0 nodes" on the boards
    return { n: j.move, ev, nodes: j.nodes > 0 ? j.nodes : null, ms: Date.now() - t0 };
  };
}
const kyaMoveGpu = makeKyaAdapter(process.env.KYA_GPU_URL || 'http://169.254.152.37:9040/'); // Spark 1 over ConnectX (2026-08-11 load split)
const kyaMoveCpu = makeKyaAdapter(process.env.KYA_CPU_URL || 'http://169.254.152.37:9041/');

// ---------------------------------------------------------------------------
// Adapter: nmbf — REMOTE engine (author-hosted, closed source). Same wire
// contract plus the clock object; the engine does its OWN time management
// from clock.my_ms, so the fetch deadline is the remaining clock, not a
// budget multiple. Concurrency 1 per the author (contention hurts strength).

const NMBF_URL = process.env.NMBF_URL // remote engine endpoint — set via env, never committed;
// flatten a fetch failure into something diagnosable: undici buries the real
// connect errors (code + syscall) inside .cause / AggregateError. No
// addresses — these strings render publicly in game records.
function describeFetchError(e) {
  const parts = [];
  const walk = (err) => {
    if (!err) return;
    if (Array.isArray(err.errors)) { err.errors.forEach(walk); return; }
    parts.push([err.code, err.syscall].filter(Boolean).join(' ') || err.message);
    if (err.cause) walk(err.cause);
  };
  walk(e.cause ?? e);
  return [...new Set(parts)].slice(0, 4).join('; ') || e.message;
}
async function nmbfMove(moves, budget, clock) {
  const t0 = Date.now();
  const attempts = [];
  // transport-level retries only (connect timeouts to their CDN edge happen);
  // an HTTP response with ok:false is the ENGINE speaking — no retry, that
  // would re-run a possibly non-idempotent search against their wishes
  for (let attempt = 0; ; attempt++) {
    let r;
    const a0 = Date.now();
    try {
      r = await fetch(NMBF_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ moves, budget_ms: Math.max(300, Math.round(budget) - 700), clock }),
        signal: AbortSignal.timeout(Math.min((clock?.my_ms ?? budget * 3) + 5000, 120_000)),
      });
    } catch (e) {
      attempts.push(`try${attempt + 1} ${((Date.now() - a0) / 1000).toFixed(1)}s: ${describeFetchError(e)}`);
      if (attempt >= 2 || (clock?.my_ms ?? Infinity) < 20_000) {
        throw new Error(`nmbf transport — request never reached origin (${attempts.join(' | ')})`);
      }
      await new Promise((ok) => setTimeout(ok, 1500));
      continue;
    }
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch {
      // their CDN can answer with an HTML error page — record what it said
      throw new Error(`nmbf: HTTP ${r.status} non-JSON reply: ${text.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
    if (!j.ok) throw new Error('nmbf: ' + (j.error || 'engine error'));
    const ev = typeof j.ev === 'number' ? Math.max(0, Math.min(1, j.ev)) : null;
    return { n: j.move, ev, nodes: j.nodes > 0 ? j.nodes : null, ms: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------------------
// Engine registry

// Engines hosted on Spark 1 (engine-host.mjs) — Spark 2 keeps only the site
// and the two Claustrophobia v2 instances (user directive 2026-08-11:
// dedicate Spark 1 to everything else; site review was starving).
const ENGINE_HOST = process.env.ENGINE_HOST || 'http://169.254.152.37:9800';
function makeHosted(key) {
  return {
    async move(moves, budget, clock) {
      const t0 = Date.now();
      const r = await fetch(`${ENGINE_HOST}/move`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, moves, budget_ms: budget, clock }),
        signal: AbortSignal.timeout(Math.round(budget) * 4 + 170_000), // must OUTLIVE the host's own engine timeouts (sigma watchdog 150s) so slots free before retries
      });
      const j = await r.json();
      if (!j.ok) throw new Error(`${key}@host: ${j.error || 'engine error'}`);
      return { n: j.move, ev: typeof j.ev === 'number' ? Math.max(0, Math.min(1, j.ev)) : null, nodes: j.nodes ?? null, ms: j.ms ?? null };
    },
    kill() {},
  };
}
const HOSTED = new Set(['titanium', 'qbr', 'gorisanson', 'sigma', 'sigma_gpu', 'pathfinder', 'scout', 'sentinel', 'ishtar2', 'ace_kya']);

function makeEngine(key) {
  if (HOSTED.has(key)) return makeHosted(key);
  if (key === 'claustrophobia') return { move: claustroMove, kill() {} };
  if (key === 'titanium') return makeTitanium();
  if (key === 'gorisanson') return { move: gorisansonMove, kill() {} };
  if (key === 'qbr') return makeQbr();
  if (key === 'ishtar') return { move: ishtarMove, kill() {} };
  if (key === 'sigma') return { move: sigmaMove, kill() {} };
  if (key === 'ka') return { move: kaMove, kill() {} };
  if (key === 'claustro_v1') return { move: claustroV1Move, kill() {} };
  if (key === 'claustro_cpu') return { move: claustroCpuMove, kill() {} };
  if (key === 'sigma_gpu') return { move: sigmaGpuMove, kill() {} };
  if (key === 'ka_gpu') return { move: kaGpuMove, kill() {} };
  if (key === 'pathfinder' || key === 'scout' || key === 'sentinel') return makeSimple(key);
  if (key === 'kya') return { move: kyaMoveGpu, kill() {} };
  if (key === 'kya_cpu') return { move: kyaMoveCpu, kill() {} };
  if (key === 'nmbf') return { move: nmbfMove, kill() {} };
  throw new Error(`unknown bot ${key}`);
}

// ---------------------------------------------------------------------------
// Cross-model self-test: replay legality agreement on a sample line

function selfTest() {
  const line = ['e2', 'e8', 'e3', 'e7', 'e4', 'e6', 'e4h', 'd6h', 'c3v', 'f5v'];
  replayMoves(line); // ours: throws if broken
  const g = new gorCtx.Game(true);
  for (const n of line) {
    const mv = ourMoveToGor(n);
    if (!g.isPossibleNextMove(mv)) throw new Error(`gorisanson mapping self-test failed at ${n}`);
    g.doMove(mv, true);
  }
  console.log('[arena] gorisanson mapping self-test OK');
}

// async qbr probe: fixed-node genmove on a walled position must be legal by our rules
async function qbrProbe() {
  const line = ['e2', 'e8', 'e3', 'e7', 'e4', 'e6', 'e4h', 'd6h', 'c3v', 'f5v'];
  const eng = makeQbr();
  try {
    const st = replayMoves(line);
    const r = await eng.move(line, 4000);
    if (!allLegalMoves(st).includes(r.n)) throw new Error(`illegal probe move ${r.n}`);
    console.log(`[arena] qbr probe OK (${r.n})`);
  } finally {
    eng.kill();
  }
}

// ---------------------------------------------------------------------------
// Openings: 6-ply prefixes from the deployed model book, balanced + popular

/** Openings that history shows are color-forced: >40% of their completed
 *  pairs split strictly along color lines (first mover always won). Those
 *  games measure the opening, not the engines — ban them from the pool. */
function colorForcedOpenings() {
  const banned = new Set();
  try {
    // Two tests, because imbalance hides in strata: an opening can look fine
    // across the whole field (weak bots misplay both sides, results vary) yet
    // be fully decided among top engines — both just convert the favored
    // color, every pair force-draws 1-1, and the top ratings compress. So on
    // top of the all-field 40% split test, any opening where >half the pairs
    // between two >=1900 engines are color-decided is banned ("I can beat
    // stockfish if I start up a queen" — measuring conversion, not strength).
    const TOP_ELO = 1900;
    const elo = new Map(db.prepare('SELECT key, elo FROM arena_bots').all().map((r) => [r.key, r.elo]));
    const pend = new Map();
    const stats = new Map(); // opening -> {pairs, colorSplits, topPairs, topSplits}
    for (const g of db.prepare(
      "SELECT p0, p1, opening, winner FROM arena_games WHERE status = 'done' AND opening != '' ORDER BY id").all()) {
      const k = [...[g.p0, g.p1].sort(), g.opening].join('|');
      if (!pend.has(k)) { pend.set(k, g); continue; }
      const g1 = pend.get(k);
      pend.delete(k);
      const s = stats.get(g.opening) || { pairs: 0, colorSplits: 0, topPairs: 0, topSplits: 0, losers: new Set(), topLosers: new Set() };
      const top = (elo.get(g.p0) ?? 0) >= TOP_ELO && (elo.get(g.p1) ?? 0) >= TOP_ELO;
      s.pairs++;
      if (top) s.topPairs++;
      if (g1.winner !== null && g.winner !== null) {
        const win1 = g1.winner === 0 ? g1.p0 : g1.p1;
        const win2 = g.winner === 0 ? g.p0 : g.p1;
        if (win1 !== win2 && g1.winner === g.winner) { // split, same seat won both
          s.colorSplits++;
          // who lost the disadvantaged colour — a ban needs this to happen to
          // SEVERAL different engines, or one engine throwing a colour could
          // delete any opening it dislikes (exploit report 2026-08-22)
          const lose1 = g1.winner === 0 ? g1.p1 : g1.p0;
          s.losers.add(lose1);
          if (top) { s.topSplits++; s.topLosers.add(lose1); }
        }
      }
      stats.set(g.opening, s);
    }
    for (const [op, s] of stats) {
      if (s.pairs >= 6 && s.colorSplits / s.pairs > 0.4 && s.losers.size >= 3) banned.add(op);
      else if (s.topPairs >= 5 && s.topSplits / s.topPairs > 0.5 && s.topLosers.size >= 2) banned.add(op);
    }
  } catch { /* first boot: no data yet */ }
  return banned;
}

function loadOpenings() {
  const TARGET = 64; // full vetted pool — jobs sample from all of it, so book preparation has ~2x the surface and per-restart rotation no longer pins 32 fixed lines
  const banned = colorForcedOpenings();
  const chosen = [];
  const famCount = {}; // cap near-identical siblings: max 2 per 5-ply family
  const add = (p) => {
    if (chosen.length >= TARGET || chosen.includes(p)) return;
    if (banned.has(p)) return; // measured color-forced — decides games by itself
    const fam = p.split(' ').slice(0, 5).join(' ');
    if ((famCount[fam] || 0) >= 2) return;
    try { replayMoves(p.split(' ')); } catch { return; } // must be legal by our rules
    famCount[fam] = (famCount[fam] || 0) + 1;
    chosen.push(p);
  };
  if (banned.size) console.log(`[arena] opening filter: ${banned.size} color-forced openings excluded`);
  // vetted book first: 6-ply lines the champion evals as colour-balanced
  // (tools/arena_openings.txt, regenerated per champion) — the empirical ban
  // list above still outranks it, since eval and practice occasionally differ
  try {
    for (const l of readFileSync(new URL('./arena_openings.txt', import.meta.url), 'utf8').trim().split('\n')) {
      if (l.startsWith('#')) continue;
      add(l.trim().split(/\s+/).slice(1).join(' '));
    }
    console.log(`[arena] vetted opening book: ${chosen.length} lines adopted`);
  } catch { /* no vetted book — fall through to raw corpora */ }
  const bookPrefixes = (file, minCount) => {
    const counts = new Map();
    for (const l of readFileSync(file, 'utf8').trim().split('\n')) {
      const d = JSON.parse(l);
      if (!d.moves || d.moves.length < 6) continue;
      const p = d.moves.slice(0, 6).join(' ');
      counts.set(p, (counts.get(p) || 0) + (d.count || 1));
    }
    return [...counts.entries()].filter(([, n]) => n >= minCount)
      .sort((a, b) => b[1] - a[1]).map(([p]) => p);
  };
  try { for (const p of bookPrefixes(join(SITE, 'data', 'model_openings.jsonl'), 10)) add(p); } catch {}
  try { for (const p of bookPrefixes(join(SITE, 'data', 'human_openings.jsonl'), 2)) add(p); } catch {}
  if (chosen.length < 6) {
    for (const p of ['e2 e8 e3 e7 e4 e6', 'e2 e8 e3 e7 d3 e6', 'e2 e8 e3 e7 e4 d6h',
      'e2 e8 e3 e7 c3h e6', 'e2 e8 f3 e7 f4 e6', 'e2 e8 e3 d7 e4 d6']) add(p);
  }
  console.log(`[arena] ${chosen.length} opening pairs loaded`);
  return chosen;
}

// ---------------------------------------------------------------------------
// Elo

// W/L/D and game counts stay per-game (factual record); RATING moves per
// opening PAIR. Rationale (2026-08-09, user-confirmed): 19.5% of pairs split
// strictly along color lines — the opening deciding, not the engines — and a
// per-game update bleeds ~0.8K from the stronger engine on every such split.
// A pair scored as one mini-match (2-0 -> 1, 1-1 -> 0.5, 0-2 -> 0, draws as
// halves) halves that damage; the opening balance filter below removes the
// worst offenders entirely.
function applyCounts(g, res /* 1 p0 wins, 0 p1 wins, 0.5 draw */) {
  db.prepare('UPDATE arena_bots SET games = games + 1, wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE key = ?')
    .run(res === 1 ? 1 : 0, res === 0 ? 1 : 0, res === 0.5 ? 1 : 0, g.p0);
  db.prepare('UPDATE arena_bots SET games = games + 1, wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE key = ?')
    .run(res === 0 ? 1 : 0, res === 1 ? 1 : 0, res === 0.5 ? 1 : 0, g.p1);
}

/** Snapshot current ratings onto a game row (no rating change) — keeps the
 *  history chart strictly chronological while the pair is still in flight. */
function stampGameElo(gid, p0key, p1key) {
  const e0 = db.prepare('SELECT elo FROM arena_bots WHERE key = ?').get(p0key).elo;
  const e1 = db.prepare('SELECT elo FROM arena_bots WHERE key = ?').get(p1key).elo;
  db.prepare('UPDATE arena_games SET elo0 = ?, elo1 = ?, elo0_after = ?, elo1_after = ? WHERE id = ?')
    .run(e0, e1, e0, e1, gid);
}

/** One rating update for a finished pair. games: [{gid, p0, aScore}] where
 *  aScore is engine `a`'s score in that game (1/0/0.5). The update is stamped
 *  onto the LAST game only (earlier games were stamped at their own finish).
 *  Falls back cleanly to a single game when the pair could not complete. */
function applyPairElo(a, b, games) {
  if (!games.length) return;
  const ba = db.prepare('SELECT elo FROM arena_bots WHERE key = ?').get(a);
  const bb = db.prepare('SELECT elo FROM arena_bots WHERE key = ?').get(b);
  const ea = 1 / (1 + 10 ** ((bb.elo - ba.elo) / 400));
  const score = games.reduce((s, g) => s + g.aScore, 0) / games.length;
  const na = ba.elo + K * (score - ea);
  const nb = bb.elo + K * (ea - score);
  db.prepare('UPDATE arena_bots SET elo = ? WHERE key = ?').run(na, a);
  db.prepare('UPDATE arena_bots SET elo = ? WHERE key = ?').run(nb, b);
  const g = games[games.length - 1];
  const aIsP0 = g.p0 === a;
  db.prepare('UPDATE arena_games SET elo0 = ?, elo1 = ?, elo0_after = ?, elo1_after = ? WHERE id = ?')
    .run(aIsP0 ? ba.elo : bb.elo, aIsP0 ? bb.elo : ba.elo, aIsP0 ? na : nb, aIsP0 ? nb : na, g.gid);
}

// ---------------------------------------------------------------------------
// One game

async function playGame(p0, p1, opening, pairTag) {
  const row = db.prepare(
    'INSERT INTO arena_games (p0, p1, opening, pair_tag, moves, clock0, clock1, started_at, moved_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(p0, p1, opening, pairTag, opening, BASE_MS, BASE_MS, Date.now(), Date.now());
  const gid = row.lastInsertRowid;
  const moves = opening.split(' ');
  const evals = moves.map(() => null); // book plies carry no engine eval
  const stats = moves.map(() => null); // per-ply {n: nodes, ms} from the mover
  const clocks = [BASE_MS, BASE_MS];
  const engines = [makeEngine(p0), makeEngine(p1)];
  let winnerSide = null, reason = null, culprit = null;

  try {
    for (let ply = moves.length; ply < MOVE_CAP; ply++) {
      const st = replayMoves(moves);
      if (isTerminal(st)) { winnerSide = winner(st); reason = 'goal'; break; }
      const side = st.side;
      const budget = budgetMs(clocks[side], st);
      // engine failures get 3 attempts at the move, and a failed attempt's
      // wall time is REFUNDED (t0 resets per attempt, so only the successful
      // attempt is charged) — a network blip or worker respawn shouldn't
      // decide a game. Flag falls stay immediate: the clock is the clock.
      let mv = null;
      let t0 = Date.now();
      for (let tryN = 1; tryN <= 3; tryN++) {
        t0 = Date.now();
        try {
          mv = await Promise.race([
            // third arg: true clock state — engines with native time management
            // (remote nmbf; others ignore it) pace themselves from this
            engines[side].move(moves, budget, { my_ms: Math.round(clocks[side]), opp_ms: Math.round(clocks[1 - side]), inc_ms: INC_MS }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('flag')), clocks[side] + 500)),
          ]);
          break;
        } catch (e) {
          if (/flag/.test(e.message)) {
            winnerSide = 1 - side; reason = 'time forfeit';
            break;
          }
          if (tryN === 3) {
            // ADJUDICATION (exploit report 2026-08-22): a losing engine that
            // "crashes" used to convert the loss into a voided pair — free
            // loss-laundering. If the POSITION (never self-reported evals) is
            // clearly decided against the erroring side, score it as a loss;
            // only genuinely unclear positions still void. Thresholds are
            // conservative: a 5-step path deficit, or the opponent within two
            // steps of goal and ahead, is not coming back at engine level.
            culprit = side === 0 ? p0 : p1;
            let adjudicated = false;
            try {
              const pdMe = pathDist(st, side);
              const pdOpp = pathDist(st, 1 - side);
              if (pdMe - pdOpp >= 5 || (pdOpp <= 2 && pdMe - pdOpp >= 2)) {
                winnerSide = 1 - side;
                reason = `engine failure (${e.message}) — adjudicated loss (paths ${pdMe} vs ${pdOpp})`;
                adjudicated = true;
              }
            } catch { /* pathDist on a corrupt state — fall through to void */ }
            if (!adjudicated) {
              // correlation trail: the erroring side's own last reported eval.
              // A clean engine errors independently of whether it is winning —
              // a pattern of losing-position errors shows up right here.
              const lastOwn = [...evals].reverse().find((v, i) => v !== null && (evals.length - 1 - i) % 2 === side);
              const evNote = lastOwn == null ? '' : ` [errer last self-ev ${side === 0 ? lastOwn : Math.round((1 - lastOwn) * 1000) / 1000}]`;
              winnerSide = null; reason = `engine failure after 3 tries (${e.message}) — drawn${evNote}`;
            }
            break;
          }
          console.log(`[arena] #${gid} ${side === 0 ? p0 : p1} move failed (try ${tryN}/3, time refunded): ${e.message}`);
          await new Promise((ok) => setTimeout(ok, 2000));
        }
      }
      if (!mv) break; // forfeit or drawn above
      const n = mv.n;
      clocks[side] -= Date.now() - t0;
      if (clocks[side] <= 0) { winnerSide = 1 - side; reason = 'time forfeit'; break; }
      const legal = allLegalMoves(st);
      if (!legal.includes(n)) { winnerSide = 1 - side; reason = `illegal move ${n}`; break; }
      clocks[side] += INC_MS;
      moves.push(n);
      // store from side-0's perspective so the graph reads one way up
      evals.push(mv.ev == null ? null : Math.round((side === 0 ? mv.ev : 1 - mv.ev) * 1000) / 1000);
      // cms = wall time the ARENA charged (includes transport/queue) vs the
      // engine's self-reported ms — published so authors can tell "we were
      // slow" from "it sat in a queue" (exploit report 2026-08-22 item 5)
      stats.push({ n: mv.nodes ?? null, ms: mv.ms ?? null, cms: Date.now() - t0 });
      db.prepare('UPDATE arena_games SET moves = ?, evals = ?, stats = ?, clock0 = ?, clock1 = ?, moved_at = ? WHERE id = ?')
        .run(moves.join(' '), JSON.stringify(evals), JSON.stringify(stats), clocks[0], clocks[1], Date.now(), gid);
    }
    if (winnerSide === null && reason === null) {
      const st = replayMoves(moves);
      if (isTerminal(st)) { winnerSide = winner(st); reason = 'goal'; }
      else reason = 'move cap';
    }
  } finally {
    for (const e of engines) e.kill();
  }

  const res = winnerSide === null ? 0.5 : winnerSide === 0 ? 1 : 0;
  db.prepare("UPDATE arena_games SET status = 'done', winner = ?, reason = ?, moves = ?, evals = ?, stats = ?, clock0 = ?, clock1 = ?, ended_at = ? WHERE id = ?")
    .run(winnerSide, reason, moves.join(' '), JSON.stringify(evals), JSON.stringify(stats), clocks[0], clocks[1], Date.now(), gid);
  console.log(`[arena] #${gid} ${p0} vs ${p1} [${opening}] -> ${winnerSide === null ? 'draw' : winnerSide === 0 ? p0 : p1} (${reason}, ${moves.length} plies)`);
  // engine failure = infrastructure, not chess — the pair runner voids the
  // whole pair so neither engine gains or loses anything from it
  return { gid, p0, p1, res, failed: typeof reason === 'string' && reason.startsWith('engine failure') && !reason.includes('adjudicated'), culprit };
}

// ---------------------------------------------------------------------------
// Scheduler: 8 slots; each job = one opening played twice with colors swapped

// per-engine concurrency accounting — acquire happens synchronously inside
// the picker so two slots can never both admit a capped engine in one tick
const activeN = {};
const atCap = (k) => (activeN[k] || 0) >= (LIMITS[k] ?? Infinity);
const OPENINGS = loadOpenings();

// Fairness: seat the most game-starved eligible PAIRING (not engine). The old
// per-engine score let low-game engines always pair among themselves, so some
// matchups (e.g. Claustrophobia v2 vs v1) were never seated — every pair must
// accumulate games for the Elo to mean anything. Primary key = games this
// exact pair has played (in-flight included), tiebreak = engine totals.
const pairKeyOf = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const activePairs = {};
// Repeated-failure bench. Voided pairs count for nothing in pairPlayed, so a
// dead engine (endpoint down, container crashed) stays "most starved" and gets
// re-seated the instant its pair voids — an infinite churn loop against a dead
// backend. Two consecutive voided pairs blamed on the same engine bench it:
// 10 min, doubling to a 60-min cap while it keeps failing, streak and bench
// both reset on its next clean pair.
const failStreak = {};
const benchCount = {};
const benchedUntil = {};
const benched = (k) => (benchedUntil[k] || 0) > Date.now();
function noteEngineFailure(k) {
  failStreak[k] = (failStreak[k] || 0) + 1;
  if (failStreak[k] < 2) return;
  failStreak[k] = 0;
  benchCount[k] = (benchCount[k] || 0) + 1;
  const dur = Math.min(600_000 * 2 ** (benchCount[k] - 1), 3_600_000);
  benchedUntil[k] = Date.now() + dur;
  console.log(`[arena] ${k} benched for ${Math.round(dur / 60000)} min after repeated engine failures`);
  if ((benchCount[k] || 0) >= 2) {
    // second consecutive bench = genuinely down, not a blip — surface it on
    // the site (grey + "offline"): a camped rating must be visibly frozen
    try { db.prepare('UPDATE arena_bots SET offline = 1 WHERE key = ?').run(k); } catch { /* old schema */ }
  }
}
function noteEngineOk(k) {
  failStreak[k] = 0;
  benchCount[k] = 0;
  try { db.prepare('UPDATE arena_bots SET offline = 0 WHERE key = ? AND offline = 1').run(k); } catch { /* old schema */ }
}
function pickJob() {
  const rows = db.prepare('SELECT key, games FROM arena_bots WHERE enabled = 1').all();
  const played = Object.fromEntries(rows.map((r) => [r.key, r.games + (activeN[r.key] || 0) * 2]));
  const pairPlayed = {};
  for (const r of db.prepare("SELECT p0, p1, COUNT(*) AS c FROM arena_games WHERE status IN ('done', 'ongoing') GROUP BY p0, p1").all()) {
    const pk = pairKeyOf(r.p0, r.p1);
    pairPlayed[pk] = (pairPlayed[pk] || 0) + r.c;
  }
  const keys = rows.map((r) => r.key);
  let best = null, bestScore = Infinity;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i], b = keys[j];
      if (atCap(a) || atCap(b) || benched(a) || benched(b)) continue;
      const pk = pairKeyOf(a, b);
      const pg = (pairPlayed[pk] || 0) + (activePairs[pk] || 0) * 2;
      const s = pg * 1000 + played[a] + played[b] + Math.random();
      if (s < bestScore) { bestScore = s; best = [a, b]; }
    }
  }
  if (!best) return null;
  activeN[best[0]] = (activeN[best[0]] || 0) + 1;
  activeN[best[1]] = (activeN[best[1]] || 0) + 1;
  const pk = pairKeyOf(best[0], best[1]);
  activePairs[pk] = (activePairs[pk] || 0) + 1;
  return [best[0], best[1], OPENINGS[Math.floor(Math.random() * OPENINGS.length)]];
}
async function nextJob() {
  for (;;) {
    const job = pickJob();
    if (job) return job;
    await new Promise((ok) => setTimeout(ok, 3000)); // everything eligible is at cap
  }
}
async function slot(id) {
  for (;;) {
    const [a, b, op] = await nextJob();
    const tag = `${a}|${b}|${op}`;
    const done = []; // finished games of this pair
    let pairBroken = false;
    try {
      const g1 = await playGame(a, b, op, tag);
      stampGameElo(g1.gid, a, b); // snapshot ratings at game 1's own position — update lands after game 2
      done.push(g1);
      const g2 = await playGame(b, a, op, tag);
      done.push(g2);
    } catch (e) {
      console.log(`[arena] slot ${id} job error: ${e.message}`);
      pairBroken = true;
      await new Promise((ok) => setTimeout(ok, 5000));
    } finally {
      try {
        if (pairBroken || done.some((g) => g.failed)) {
          // an engine failure anywhere in the pair voids BOTH games: no Elo,
          // no W/L/D — the opening pair gets naturally re-seated later
          for (const g of done) {
            db.prepare("UPDATE arena_games SET status = 'void', reason = reason || ' — pair voided' WHERE id = ?").run(g.gid);
          }
          if (done.length) console.log(`[arena] pair ${a} vs ${b} voided (engine failure)`);
          const blame = done.find((g) => g.culprit)?.culprit;
          if (blame) noteEngineFailure(blame);
        } else {
          for (const g of done) applyCounts({ p0: g.p0, p1: g.p1 }, g.res);
          applyPairElo(a, b, done.map((g) => ({ gid: g.gid, p0: g.p0, aScore: g.p0 === a ? g.res : 1 - g.res })));
          noteEngineOk(a); noteEngineOk(b);
        }
      } catch (e) { console.log(`[arena] pair settle error: ${e.message}`); }
      activeN[a]--; activeN[b]--;
      const pk = pairKeyOf(a, b);
      activePairs[pk] = Math.max(0, (activePairs[pk] || 0) - 1);
    }
  }
}

selfTest();
qbrProbe().catch((e) => console.log(`[arena] qbr probe FAILED: ${e.message}`));
// pre-warm sigma workers (both pools) — torch import + first inference is ~15s cold
for (const [kind, cap] of [['cpu', LIMITS.sigma || 1], ['gpu', LIMITS.sigma_gpu || 1]]) {
  for (let i = 0; i < cap; i++) {
    sigmaMoveKind(kind, ['e2', 'e8'], 2000).then(
      (r) => console.log(`[arena] sigma ${kind} worker ${i} warm (${r.n})`),
      (e) => console.log(`[arena] sigma ${kind} worker ${i} warmup failed: ${e.message}`),
    );
  }
}
for (let i = 0; i < GAMES_TARGET; i++) slot(i);
console.log(`[arena] running ${GAMES_TARGET} boards, roster: ${ROSTER.map((r) => r.name).join(', ')}`);
