// Claustrophobia arena ENGINE HOST — runs the child-process/in-process
// engines (titanium, qbr, gorisanson, sigma cpu+gpu, house bots) on a
// separate box from the orchestrator. One HTTP endpoint:
//   POST /move {key, moves, budget_ms, clock} -> {ok, move, ev, nodes, ms}
//   GET  /     -> {ok, pools}
// Adapter code below is EXTRACTED VERBATIM from arena.mjs — keep in sync.
import { setDefaultResultOrder } from 'node:dns';
import { execSync, spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
setDefaultResultOrder('ipv4first');

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..', 'site');
const rules = await import(join(SITE, 'shared', 'rules.js').replaceAll(String.fromCharCode(92), '/'));
const { initialState, replayMoves, allLegalMoves, isTerminal, winner, parseMove } = rules;
const INC_MS = 2_000;

// ---------------------------------------------------------------------------
// PER-INSTANCE MEMORY CAP (2026-08-26, user directive: 4 GB per engine
// instance). Pooled children share engine-host's cgroup, so a unit-level
// MemoryMax cannot bound them individually — each child is launched in its own
// transient systemd scope instead, which gives it a private memory.max.
// Exceeding it OOM-kills that one engine: the arena scores it as an engine
// failure and VOIDS the pair, so a runaway costs nobody Elo.
//
// Docker-backed engines are deliberately NOT wrapped: the container's memory
// lives in dockerd's cgroup, not this scope, and `docker run --memory` is
// exactly what broke CUDA init on this GB10 before (kya, 2026-08-11).
const ENGINE_MEM_MAX = process.env.ENGINE_MEM_MAX || '4G';
const SCOPE_OK = (() => {
  if (process.env.ENGINE_MEM_CAP === '0') return false;
  try {
    execSync(`systemd-run --user --scope -q -p MemoryMax=${ENGINE_MEM_MAX} -- /bin/true`,
      { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    console.log('[host] systemd scopes unavailable — engines run uncapped');
    return false;
  }
})();
console.log(`[host] per-instance memory cap: ${SCOPE_OK ? ENGINE_MEM_MAX : 'off'}`);

/** spawn() with a private memory cap, falling back to a bare spawn. */
function spawnCapped(cmd, args, opts) {
  if (!SCOPE_OK) return spawn(cmd, args, opts);
  return spawn('systemd-run',
    ['--user', '--scope', '-q', '--collect', '-p', `MemoryMax=${ENGINE_MEM_MAX}`, '--', cmd, ...args],
    opts);
}


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
  const child = spawnCapped(QBR_BIN_NATIVE, ['qbp', '--feature', `nnue3=${QBR_NNUE}`, '--feature', 'wallq_tc=off', '--feature', 'rfp_margin=50', '--feature', 'threads=1'],
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

const ISHTAR_ENDPOINTS = (process.env.ISHTAR_BRIDGE || 'http://127.0.0.1:9720,http://127.0.0.1:9721')
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

// Adapter: Titanium — SESSION protocol (persistent warm TitaniumSearch).
// `titanium uci` runs the repo's LEGACY GameSearchSession search (~100k n/s,
// docs call it "testing infra"); `titanium session --engine titanium-v17`
// runs TitaniumSearch::production, the real engine (~1.7M n/s). The v17 label
// is wire-compat only — it selects the binary's one production search.
// Wire: `position m1 m2 ...` → `ready N`; `go SEC` → `info json {...}` +
// `bestmove MOVE`, all on stdout. Same move notation as ours.

const TITANIUM_BIN = join(process.env.HOME, 'arena-engines', 'titanium-engine', 'target', 'release', 'titanium');
function makeTitanium() {
  const child = spawnCapped(TITANIUM_BIN, ['session', '--engine', 'titanium-v17'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  const c = spawnCapped('python3', [join(process.env.HOME, 'arena-engines', 'sigma_worker.py')],
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

// Adapters: house baseline bots (Pathfinder / Scout / Sentinel) — persistent
// JSONL children over the site's shared rules.js. Deterministic, fast
// (<200ms/move), one child per game seat.

const SIMPLE_DIR = join(process.env.HOME, 'arena-engines', 'simple');
const SIMPLE_RULES = join(process.env.HOME, 'Claustrophobia', 'site', 'shared', 'rules.js');
function makeSimple(key) {
  const child = spawnCapped(process.execPath, [join(SIMPLE_DIR, `${key}.mjs`)],
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
// Ishtar (James Harmon's optima framework, author-provided container; UGI over
// stdio). Persistent `docker run -i` child — the TF session loads once and the
// process keeps its tree between calls; `newgame` + full replay per request
// keeps it stateless from the arena's point of view. WALL NOTATION: optima's
// wall rank is ours + 1 (their d6h == our d5h — verified by board render, both
// wall axes); files and pawn moves are identical. Translate at this boundary
// ONLY. Container runs --network none: UGI needs no network at all.
const toOptima = (m) => (m.length === 3 ? `${m[0]}${Number(m[1]) + 1}${m[2]}` : m);
const fromOptima = (m) => (m.length === 3 ? `${m[0]}${Number(m[1]) - 1}${m[2]}` : m);

function makeIshtar2() {
  const child = spawn('docker', [
    'run', '-i', '--rm', '--network', 'none', '--gpus', 'all',
    '--ipc=host', '--ulimit', 'memlock=-1:-1',
    // XLA-compiled model (3.7x: 1.1k -> ~4k evals/s at batch 64; TF-TRT was a
    // regression). XLA needs a GB10-capable ptxas at runtime — the container's
    // CUDA predates compute 12.1, so mount the host's CUDA 13 tools over it.
    '-v', '/usr/local/cuda-13.0/bin/ptxas:/usr/local/cuda/bin/ptxas:ro',
    '-v', '/usr/local/cuda-13.0/bin/nvlink:/usr/local/cuda/bin/nvlink:ro',
    'optima-ishtar:arm64-gpu-xla-v1',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let onLine = null;
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line && onLine) onLine(line);
    }
  });
  let dead = false;
  child.on('exit', () => { dead = true; if (onLine) onLine('__exit__'); });
  const send = (s) => child.stdin.write(s + '\n');
  const waitFor = (pred, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { onLine = null; reject(new Error('ishtar2 timeout')); }, ms);
    onLine = (line) => {
      if (line === '__exit__') { clearTimeout(t); onLine = null; return reject(new Error('ishtar2 exited')); }
      const v = pred(line);
      if (v) { clearTimeout(t); onLine = null; resolve(v); }
    };
  });
  // one-time handshake; the TF session + model load ride on the first await
  const ready = (async () => {
    send('ugi');
    await waitFor((l) => (l === 'ugiok' ? l : null), 120_000);
    send('isready');
    await waitFor((l) => (l === 'readyok' ? l : null), 120_000);
    send('setoption name parallelism value 64') // measured: rate is parallelism-insensitive (~1.1k/s openings) — eval pipeline serializes upstream; 64 = proven-Elo config;
  })();
  let q = Promise.resolve(); // UGI is a serial protocol — one move at a time per child
  return {
    child,
    async move(moves, budget, clock) {
      const run = async () => {
        if (dead) throw new Error('ishtar2 exited');
        await ready;
        // engine-side fixed_time from the arena budget (seconds); low clock
        // gets a token think — the arena's flag-kill is the hard stop
        const panic = (clock?.my_ms ?? Infinity) < 8_000;
        const secs = panic ? 0.3 : Math.max(0.3, (budget - 500) / 1000);
        send('newgame');
        send(`setoption name fixed_time value ${secs.toFixed(1)}`);
        for (const m of moves) send(`makemove ${toOptima(m)}`);
        let lastInfo = null;
        const t0 = Date.now();
        send('go');
        const best = await waitFor((l) => {
          if (l.startsWith('info time ')) { lastInfo = l; return null; }
          if (l.startsWith('bestmove ')) return l.slice(9).trim();
          return null;
        }, Math.max(30_000, budget * 3 + 60_000));
        if (!best) throw new Error('ishtar2: empty bestmove');
        const visits = lastInfo?.match(/ visits (\d+)/)?.[1];
        const score = lastInfo?.match(/ score ([0-9.eE+-]+)/)?.[1];
        return {
          n: fromOptima(best),
          ev: score != null ? Math.max(0, Math.min(1, Number(score))) : null,
          nodes: visits != null ? Number(visits) : null,
          ms: Date.now() - t0,
        };
      };
      const p = q.then(run, run);
      q = p.catch(() => {});
      return p;
    },
    kill() {
      try { child.stdin.write('quit\n'); } catch { /* dead pipe */ }
      try { child.kill(); } catch { /* already gone */ }
    },
  };
}

// ---------------------------------------------------------------------------
// ACE Kya (se24) — python MCTS around the se24-selfplay net, JSON lines on
// stdio. Shipping defaults from its README (measured, not guessed): MCGS
// class with graph off, eps 0.06, act=grill, terminal solver + race
// tablebase. It does its own clock budgeting (mtg=24) from the clock we
// pass. NO ev is returned by design — the seat runs without an eval bar.
function makeAceKya() {
  const child = spawnCapped('python3', ['se24_server.py'], {
    cwd: join(process.env.HOME, 'arena-engines', 'se24'),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
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
  child.on('exit', () => { for (const w of waiters.splice(0)) w.reject(new Error('ace_kya exited')); });
  return {
    child,
    async move(moves, budget, clock) {
      const j = await new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        child.stdin.write(JSON.stringify({ moves, budget_ms: budget, clock }) + '\n');
        // first request rides the torch/CUDA model load (~20s cold)
        setTimeout(() => reject(new Error('ace_kya timeout')), budget * 3 + 60_000);
      });
      if (!j.ok) throw new Error(`ace_kya: ${j.error}`);
      return { n: j.move, ev: null, nodes: j.nodes ?? null, ms: j.ms ?? null };
    },
    kill() { try { child.kill(); } catch { /* gone */ } },
  };
}

// ---------------------------------------------------------------------------
// Zquoridor (github.com/gitzambrano/zquoridor) — C++17 alpha-beta + int8 NNUE
// via its QTP text frontend (single-token notation like ours). VERTICAL
// MIRROR: their first mover ("black") starts at e9 heading DOWN — pawn rank
// r <-> 10-r, wall rank r <-> 9-r, files unchanged (verified by board
// render). The mirror is its own inverse.
const toZq = (m) => (m.length === 3 ? `${m[0]}${9 - Number(m[1])}${m[2]}` : `${m[0]}${10 - Number(m[1])}`);
function makeZquoridor() {
  const child = spawnCapped(join(process.env.HOME, 'arena-engines', 'zquoridor', 'bin', 'qtp_engine'),
    [join(process.env.HOME, 'arena-engines', 'zquoridor', 'data', 'nnue', 'nnue_weights_int8.bin'), '40', '200'],
    { cwd: join(process.env.HOME, 'arena-engines', 'zquoridor'), stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let onReply = null;
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || !onReply) continue;
      if (line.startsWith('=') || line.startsWith('?')) onReply(line);
    }
  });
  let dead = false;
  child.on('exit', () => { dead = true; if (onReply) onReply('? engine exited'); });
  const cmd = (c, ms = 10_000) => new Promise((resolve, reject) => {
    if (dead) return reject(new Error('zquoridor exited'));
    const t = setTimeout(() => { onReply = null; reject(new Error('zquoridor timeout')); }, ms);
    onReply = (line) => {
      clearTimeout(t);
      onReply = null;
      if (line.startsWith('?')) reject(new Error(`zquoridor: ${line.slice(1).trim() || 'error'}`));
      else resolve(line.slice(1).trim());
    };
    child.stdin.write(c + '\n');
  });
  let q = Promise.resolve(); // QTP is serial — one command stream per child
  return {
    child,
    async move(moves, budget) {
      const run = async () => {
        const t0 = Date.now();
        await cmd('clear_board');
        for (let i = 0; i < moves.length; i++) {
          const color = i % 2 === 0 ? 'b' : 'w';
          const m = moves[i];
          await cmd(`${m.length === 3 ? 'playwall' : 'playmove'} ${color} ${toZq(m)}`);
        }
        await cmd(`level 40 ${Math.max(100, Math.round(budget) - 150)}`);
        const tok = await cmd(`genmove ${moves.length % 2 === 0 ? 'b' : 'w'}`, budget * 3 + 20_000);
        if (!tok) throw new Error('zquoridor: empty genmove');
        return { n: toZq(tok), ev: null, nodes: null, ms: Date.now() - t0 };
      };
      const p = q.then(run, run);
      q = p.catch(() => {});
      return p;
    },
    kill() { try { child.stdin.write('quit' + '\n'); } catch { /* dead */ } try { child.kill(); } catch { /* gone */ } },
  };
}

// ---------------------------------------------------------------------------
// Instance pools + HTTP front

// caps = arena LIMITS + 1 headroom: a slow move can outlive the
// orchestrator's patience, and its slot stays busy while the retry arrives —
// without headroom two concurrent games + one straggler = "pool exhausted"
const POOLED = {
  titanium: { cap: 3, make: makeTitanium },
  qbr: { cap: 5, make: makeQbr },
  gorisanson: { cap: 3, make: () => ({ move: gorisansonMove, kill() {} }) },
  sigma: { cap: 3, make: () => ({ move: sigmaMove, kill() {} }) },
  sigma_gpu: { cap: 3, make: () => ({ move: sigmaGpuMove, kill() {} }) },
  ishtar2: { cap: 2, make: makeIshtar2 },
  zquoridor: { cap: 3, make: makeZquoridor },
  pathfinder: { cap: 3, make: () => makeSimple('pathfinder') },
  scout: { cap: 3, make: () => makeSimple('scout') },
  sentinel: { cap: 3, make: () => makeSimple('sentinel') },
};
const pools = {}; // key -> [{eng, busy, bad}]
function acquire(key) {
  const cfg = POOLED[key];
  if (!cfg) return null;
  const pool = (pools[key] ??= []);
  for (let i = pool.length - 1; i >= 0; i--) if (pool[i].bad) pool.splice(i, 1);
  const free = pool.find((s) => !s.busy);
  if (free) { free.busy = true; return free; }
  if (pool.length >= cfg.cap) return 'full';
  const slot = { eng: cfg.make(), busy: true, bad: false };
  pool.push(slot);
  return slot;
}

const server = createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET') {
    return send(200, { ok: true, pools: Object.fromEntries(Object.entries(pools).map(([k, p]) => [k, p.length])) });
  }
  if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    let slot = null;
    try {
      const { key, moves, budget_ms, clock } = JSON.parse(body);
      slot = acquire(key);
      if (slot === null) return send(400, { ok: false, error: `unknown pooled engine ${key}` });
      if (slot === 'full') { slot = null; return send(503, { ok: false, error: `${key} pool exhausted` }); }
      const mv = await slot.eng.move(moves, budget_ms, clock);
      send(200, { ok: true, move: mv.n, ev: mv.ev, nodes: mv.nodes, ms: mv.ms });
    } catch (e) {
      if (slot && typeof slot === 'object') {
        slot.bad = true; // a failed child may be wedged — replace it next call
        try { slot.eng.kill(); } catch {}
      }
      send(200, { ok: false, error: String(e?.message || e) });
    } finally {
      if (slot && typeof slot === 'object') slot.busy = false;
    }
  });
});
const BIND = process.env.HOST_BIND || '169.254.152.37';
const PORT = Number(process.env.HOST_PORT || 9800);
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


selfTest();
qbrProbe().catch((e) => console.log(`[host] qbr probe FAILED: ${e.message}`));
server.listen(PORT, BIND, () => console.log(`[host] engine host on ${BIND}:${PORT}`));
