// sentinel.mjs — tier-3 Quoridor engine: iterative-deepening alpha-beta.
//
// Protocol (JSONL over stdin/stdout), one request per line:
//   {"moves": ["e2","e8",...], "budget_ms": 5000}
// Reply:
//   {"ok": true, "move": "e3", "ev": 0.64, "nodes": 41000, "ms": 620}
//   {"ok": false, "error": "...", "nodes": 0, "ms": 1} on bad input. Never exits.
//
// Search: iterative deepening depth 2..4, negamax alpha-beta, previous best
// move searched first each iteration. Stops once 60% of budget_ms is consumed
// (time-checked inside the search, so a reply never exceeds the budget).
// Eval (side to move): (oppDist - myDist) + 0.15*(myWalls - oppWalls)
//   + 0.04 * centre-file advantage + 0.02 * own pawn mobility.

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const RULES_PATH = process.env.QUORIDOR_RULES || 'H:/QuoridorEngineSite/site/shared/rules.js';
const R = await import(pathToFileURL(RULES_PATH).href);

const WALL_CAP = 12;      // wall candidates per node (8 at pre-leaf nodes)
const LINE_WALL_CAP = 1;  // walls each side may place within one search line:
                          // prices in the single best standing wall threat while
                          // stopping the wall-spam horizon paranoia that made the
                          // engine hover instead of racing
const WIN = 1000;
const WALL_VALUE = 0.25;  // eval weight per wall in hand
const REP_PENALTY = 0.35; // root-level nudge away from repeating a past position
const PROGRESS = 0.35;    // root-level bonus per step of own-path progress
const TIMEOUT = Symbol('timeout');
let nodes = 0;
let deadline = Infinity;

// Position identity for repetition detection (pawns + walls + side to move).
function hashState(s) {
  return (
    s.pawns[0][0] * 9 + s.pawns[0][1] + ':' + (s.pawns[1][0] * 9 + s.pawns[1][1]) +
    ':' + [...s.hwalls].sort((a, b) => a - b).join(',') +
    ':' + [...s.vwalls].sort((a, b) => a - b).join(',') + ':' + s.side
  );
}

// Replay from startpos, counting how often each position has occurred.
function replayWithHistory(moves) {
  const s = R.initialState();
  const seen = new Map();
  seen.set(hashState(s), 1);
  for (const mv of moves) {
    R.applyMove(s, mv);
    const h = hashState(s);
    seen.set(h, (seen.get(h) || 0) + 1);
  }
  return { s, seen };
}

function checkTime() {
  if (performance.now() > deadline) throw TIMEOUT;
}

function probePawnDist(s, side, r, c) {
  const saved = s.pawns[side];
  s.pawns[side] = [r, c];
  const d = R.pathDist(s, side);
  s.pawns[side] = saved;
  return d;
}

function probeWallDists(s, sr, sc, horiz) {
  const set = horiz ? s.hwalls : s.vwalls;
  const slot = sr * 8 + sc;
  set.add(slot);
  const d0 = R.pathDist(s, 0);
  const d1 = R.pathDist(s, 1);
  set.delete(slot);
  return [d0, d1];
}

// Static eval from the perspective of the side to move.
function evalState(s) {
  const p = s.side;
  const q = 1 - p;
  let e = (R.pathDist(s, q) - R.pathDist(s, p)) + WALL_VALUE * (s.wallsLeft[p] - s.wallsLeft[q]);
  e += 0.04 * (Math.abs(s.pawns[q][1] - 4) - Math.abs(s.pawns[p][1] - 4)); // centre files
  e += 0.02 * R.legalPawnDests(s).length; // mobility of the side to move
  return e;
}

// Ordered candidates: pawn steps (best first), then up to `cap` walls touching
// the opponent's shortest path, ranked by how much they lengthen it.
// allowWalls=false restricts to pawn moves (per-line wall cap reached).
function orderedMoves(s, cap, allowWalls = true) {
  const me = s.side;
  const opp = 1 - me;
  const dMe0 = R.pathDist(s, me);
  const dOpp0 = R.pathDist(s, opp);

  const pawns = R.legalPawnDests(s)
    .map(([r, c]) => {
      nodes++;
      return { n: R.formatPawn(r, c), k: probePawnDist(s, me, r, c) };
    })
    .sort((a, b) => a.k - b.k || (a.n < b.n ? -1 : 1))
    .map((x) => x.n);

  const walls = [];
  if (allowWalls && s.wallsLeft[me] > 0) {
    const path = R.shortestPath(s, opp) || [];
    const seen = new Set();
    for (const [r, c] of path) {
      for (const sr of [r - 1, r]) {
        for (const sc of [c - 1, c]) {
          for (const h of [true, false]) {
            if (sr < 0 || sr > 7 || sc < 0 || sc > 7) continue;
            const id = (h ? 64 : 0) + sr * 8 + sc;
            if (seen.has(id)) continue;
            seen.add(id);
            if (!R.wallLegal(s, sr, sc, h)) continue;
            nodes++;
            const [n0, n1] = probeWallDists(s, sr, sc, h);
            const dOpp = (opp === 0 ? n0 : n1) - dOpp0;
            const dMe = (me === 0 ? n0 : n1) - dMe0;
            if (dOpp < 1) continue;
            walls.push({ n: R.formatWall(sr, sc, h), k: dOpp - 0.5 * dMe });
          }
        }
      }
    }
    walls.sort((a, b) => b.k - a.k || (a.n < b.n ? -1 : 1));
  }
  return pawns.concat(walls.slice(0, cap).map((x) => x.n));
}

// w0/w1: walls already placed by each side within this search line.
function negamax(s, depth, alpha, beta, w0, w1) {
  nodes++;
  checkTime();
  const w = R.winner(s);
  if (w !== null) return w === s.side ? WIN - s.ply : s.ply - WIN;
  if (depth === 0) return evalState(s);
  const canWall = (s.side === 0 ? w0 : w1) < LINE_WALL_CAP;
  const moves = orderedMoves(s, depth === 1 ? 8 : WALL_CAP, canWall);
  if (moves.length === 0) return evalState(s);
  let best = -Infinity;
  for (const mv of moves) {
    const isWall = mv.length === 3;
    const child = R.cloneState(s);
    R.applyMove(child, mv);
    const v = -negamax(child, depth - 1, -beta, -alpha,
      w0 + (isWall && s.side === 0 ? 1 : 0), w1 + (isWall && s.side === 1 ? 1 : 0));
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

function chooseMove(s, budget, seen) {
  deadline = performance.now() + budget * 0.6;
  const me = s.side;
  const dMe0 = R.pathDist(s, me);
  let rootMoves = orderedMoves(s, WALL_CAP);
  if (rootMoves.length === 0) rootMoves = R.allLegalMoves(s); // paranoid fallback
  if (rootMoves.length === 0) throw new Error('no legal move available');

  let bestMove = rootMoves[0]; // safe answer even if depth 2 never completes
  let bestScore = 0;
  for (let depth = 2; depth <= 4; depth++) {
    let dBest = null;
    let dScore = -Infinity;
    let alpha = -Infinity;
    try {
      for (const mv of rootMoves) {
        checkTime();
        const isWall = mv.length === 3;
        const child = R.cloneState(s);
        R.applyMove(child, mv);
        let v = -negamax(child, depth - 1, -Infinity, -alpha,
          isWall && me === 0 ? 1 : 0, isWall && me === 1 ? 1 : 0);
        v -= REP_PENALTY * (seen.get(hashState(child)) || 0);   // anti-shuffle
        v += PROGRESS * (dMe0 - R.pathDist(child, me));         // prefer forward progress
        if (v > dScore) {
          dScore = v;
          dBest = mv;
        }
        if (v > alpha) alpha = v;
      }
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break; // keep the last fully-searched depth's answer
    }
    bestMove = dBest;
    bestScore = dScore;
    if (bestScore >= WIN - 500) break; // forced win found, no need to go deeper
    rootMoves = [bestMove, ...rootMoves.filter((m) => m !== bestMove)];
    if (performance.now() > deadline) break;
  }

  let ev;
  if (bestScore >= WIN - 500) ev = 0.999;
  else if (bestScore <= 500 - WIN) ev = 0.001;
  else ev = 1 / (1 + Math.exp(-0.4 * bestScore));
  return { move: bestMove, ev: Math.round(ev * 1000) / 1000 };
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const t0 = performance.now();
  nodes = 0;
  let out;
  try {
    const req = JSON.parse(line);
    if (!req || !Array.isArray(req.moves)) throw new Error('request must carry a moves[] array');
    const budget = Number.isFinite(req.budget_ms) && req.budget_ms > 0 ? req.budget_ms : 1000;
    const { s, seen } = replayWithHistory(req.moves);
    if (R.isTerminal(s)) throw new Error('game is already over');
    const { move, ev } = chooseMove(s, budget, seen);
    out = { ok: true, move, ev, nodes, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e), nodes, ms: Math.round(performance.now() - t0) };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});
