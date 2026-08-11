// scout.mjs — tier-2 Quoridor engine: fixed depth-2 alpha-beta.
//
// Protocol (JSONL over stdin/stdout), one request per line:
//   {"moves": ["e2","e8",...], "budget_ms": 5000}
// Reply:
//   {"ok": true, "move": "e3", "ev": 0.61, "nodes": 900, "ms": 8}
//   {"ok": false, "error": "...", "nodes": 0, "ms": 1} on bad input. Never exits.
//
// Eval (side to move): (oppDist - myDist) + 0.15 * (myWalls - oppWalls).
// Move ordering: pawn advances first (best resulting own distance), then wall
// candidates taken from slots touching the opponent's shortest path, ranked by
// how much they lengthen that path, capped at WALL_CAP per node.

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const RULES_PATH = process.env.QUORIDOR_RULES || 'H:/QuoridorEngineSite/site/shared/rules.js';
const R = await import(pathToFileURL(RULES_PATH).href);

const WALL_CAP = 12;
const WIN = 1000;
const REP_PENALTY = 0.35; // root-level nudge away from repeating a past position
let nodes = 0;

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
  return (R.pathDist(s, q) - R.pathDist(s, p)) + 0.15 * (s.wallsLeft[p] - s.wallsLeft[q]);
}

// Ordered candidate moves: pawn steps (best first), then up to `cap` walls
// adjacent to the opponent's shortest path, ranked by path-lengthening.
function orderedMoves(s, cap) {
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
  if (s.wallsLeft[me] > 0) {
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

function negamax(s, depth, alpha, beta) {
  nodes++;
  const w = R.winner(s);
  if (w !== null) return w === s.side ? WIN - s.ply : s.ply - WIN;
  if (depth === 0) return evalState(s);
  const moves = orderedMoves(s, WALL_CAP);
  if (moves.length === 0) return evalState(s);
  let best = -Infinity;
  for (const mv of moves) {
    const child = R.cloneState(s);
    R.applyMove(child, mv);
    const v = -negamax(child, depth - 1, -beta, -alpha);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

function chooseMove(s, seen) {
  let moves = orderedMoves(s, WALL_CAP);
  if (moves.length === 0) moves = R.allLegalMoves(s); // paranoid fallback
  if (moves.length === 0) throw new Error('no legal move available');

  let bestMove = moves[0];
  let bestScore = -Infinity;
  let alpha = -Infinity;
  for (const mv of moves) {
    const child = R.cloneState(s);
    R.applyMove(child, mv);
    let v = -negamax(child, 1, -Infinity, -alpha);
    v -= REP_PENALTY * (seen.get(hashState(child)) || 0); // anti-shuffle
    if (v > bestScore) {
      bestScore = v;
      bestMove = mv;
    }
    if (v > alpha) alpha = v;
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
    const { s, seen } = replayWithHistory(req.moves);
    if (R.isTerminal(s)) throw new Error('game is already over');
    const { move, ev } = chooseMove(s, seen);
    out = { ok: true, move, ev, nodes, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e), nodes, ms: Math.round(performance.now() - t0) };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});
