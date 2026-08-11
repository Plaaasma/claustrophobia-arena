// pathfinder.mjs — tier-1 Quoridor engine: greedy shortest-path racer.
//
// Protocol (JSONL over stdin/stdout), one request per line:
//   {"moves": ["e2","e8",...], "budget_ms": 5000}
// Reply:
//   {"ok": true, "move": "e3", "ev": 0.52, "nodes": 41, "ms": 3}
//   {"ok": false, "error": "...", "nodes": 0, "ms": 1} on bad input. Never exits.
//
// Strategy: play the pawn step that minimises our shortest path to goal.
// When strictly behind in the race and holding walls, instead place the legal
// wall that most lengthens the opponent's shortest path, skipping walls that
// hurt our own path more than theirs. Deterministic notation tiebreaks.

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const RULES_PATH = process.env.QUORIDOR_RULES || 'H:/QuoridorEngineSite/site/shared/rules.js';
const R = await import(pathToFileURL(RULES_PATH).href);

let nodes = 0;

// Lexicographic tuple compare (numbers/strings), smaller wins.
function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

// Own shortest-path length if our pawn stood on (r,c). pathDist ignores pawns,
// so temporarily relocating our pawn is an exact probe.
function probePawnDist(s, side, r, c) {
  const saved = s.pawns[side];
  s.pawns[side] = [r, c];
  const d = R.pathDist(s, side);
  s.pawns[side] = saved;
  return d;
}

// Both players' shortest-path lengths with a candidate wall temporarily added.
function probeWallDists(s, sr, sc, horiz) {
  const set = horiz ? s.hwalls : s.vwalls;
  const slot = sr * 8 + sc;
  set.add(slot);
  const d0 = R.pathDist(s, 0);
  const d1 = R.pathDist(s, 1);
  set.delete(slot);
  return [d0, d1];
}

function chooseMove(s) {
  const me = s.side;
  const opp = 1 - me;
  const fwd = me === 0 ? 1 : -1; // row delta that counts as forward progress
  const myRow = s.pawns[me][0];
  const dMe0 = R.pathDist(s, me);
  const dOpp0 = R.pathDist(s, opp);

  // Best pawn step: minimise our new distance; prefer forward progress, then
  // lowest notation, so the choice is deterministic and never shuffles.
  let pawnBest = null;
  for (const [r, c] of R.legalPawnDests(s)) {
    nodes++;
    const key = [probePawnDist(s, me, r, c), -(r - myRow) * fwd, R.formatPawn(r, c)];
    if (!pawnBest || lexLess(key, pawnBest.key)) pawnBest = { key, move: key[2] };
  }

  // Behind in the race (mover wins ties, so strictly greater = behind) and
  // holding walls: find the wall that most lengthens the opponent's path.
  let wallBest = null;
  if (dMe0 > dOpp0 && s.wallsLeft[me] > 0) {
    for (let sr = 0; sr < 8; sr++) {
      for (let sc = 0; sc < 8; sc++) {
        for (const h of [true, false]) {
          if (!R.wallLegal(s, sr, sc, h)) continue;
          nodes++;
          const [n0, n1] = probeWallDists(s, sr, sc, h);
          const dOpp = (opp === 0 ? n0 : n1) - dOpp0;
          const dMe = (me === 0 ? n0 : n1) - dMe0;
          if (dOpp < 1) continue;   // must actually lengthen their path
          if (dMe > dOpp) continue; // hurts us more than them
          const key = [-dOpp, dMe, R.formatWall(sr, sc, h)];
          if (!wallBest || lexLess(key, wallBest.key)) wallBest = { key, move: key[2] };
        }
      }
    }
  }

  const move = wallBest ? wallBest.move : pawnBest ? pawnBest.move : null;
  if (!move) throw new Error('no legal move available');

  // Crude win-prob for us (the mover) after the move: logistic on race margin.
  const after = R.cloneState(s);
  R.applyMove(after, move);
  let ev = 0.999;
  if (R.winner(after) !== me) {
    const margin = R.pathDist(after, opp) - R.pathDist(after, me) - 0.5; // they move next
    ev = 1 / (1 + Math.exp(-0.45 * margin));
  }
  return { move, ev: Math.round(ev * 1000) / 1000 };
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
    const s = R.replayMoves(req.moves);
    if (R.isTerminal(s)) throw new Error('game is already over');
    const { move, ev } = chooseMove(s);
    out = { ok: true, move, ev, nodes, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e), nodes, ms: Math.round(performance.now() - t0) };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});
