// Quoridor rules — shared between the Node server (authoritative move
// validation) and the browser (board UI hints). Mirrors the Rust engine's
// board model exactly; parity is verified against the engine's own legal-move
// lists by test/rules-parity.mjs, not assumed.
//
// Geometry (identical to the engine):
//   * 9x9 cells; row 0 = top, col 0 = left. Notation rank = row+1 (1..9),
//     file = 'a'+col (a..i). Pawn move notation is the DESTINATION ("e2").
//   * P0 starts e1 (0,4), races to row 8 (rank 9). P1 starts e9 (8,4), races
//     to row 0 (rank 1). P0 moves first.
//   * Wall slots are an 8x8 anchor grid (sr 0..7, sc 0..7), slot = sr*8+sc.
//     Notation "<file(sc)><sr+1><h|v>" ("e3h"). A horizontal wall at (sr,sc)
//     blocks vertical movement between rows sr/sr+1 across cols sc,sc+1; a
//     vertical wall blocks horizontal movement between cols sc/sc+1 across
//     rows sr,sr+1. Each player has 10 walls.

export const GOAL_ROW = [8, 0];
export const START = [
  [0, 4],
  [8, 4],
];

export function initialState(walls) {
  return {
    pawns: [
      [0, 4],
      [8, 4],
    ],
    wallsLeft: Array.isArray(walls) && walls.length === 2
      ? [Math.min(10, Math.max(0, walls[0] | 0)), Math.min(10, Math.max(0, walls[1] | 0))]
      : [10, 10],
    // Sets of slot ints (sr*8+sc). Stored as plain arrays in JSON; use the
    // has* helpers below which accept both.
    hwalls: new Set(),
    vwalls: new Set(),
    side: 0,
    ply: 0,
  };
}

export function cloneState(s) {
  return {
    pawns: [ [...s.pawns[0]], [...s.pawns[1]] ],
    wallsLeft: [...s.wallsLeft],
    hwalls: new Set(s.hwalls),
    vwalls: new Set(s.vwalls),
    side: s.side,
    ply: s.ply,
  };
}

const FILES = 'abcdefghi';

export function formatPawn(r, c) {
  return FILES[c] + (r + 1);
}

export function formatWall(sr, sc, horiz) {
  return FILES[sc] + (sr + 1) + (horiz ? 'h' : 'v');
}

/** Parse notation → {kind:'pawn',r,c} | {kind:'wall',sr,sc,h} | null. */
export function parseMove(n) {
  if (typeof n !== 'string') return null;
  const t = n.trim().toLowerCase();
  if (/^[a-i][1-9]$/.test(t)) {
    return { kind: 'pawn', r: t.charCodeAt(1) - 49, c: t.charCodeAt(0) - 97 };
  }
  if (/^[a-h][1-8][hv]$/.test(t)) {
    return {
      kind: 'wall',
      sr: t.charCodeAt(1) - 49,
      sc: t.charCodeAt(0) - 97,
      h: t[2] === 'h',
    };
  }
  return null;
}

function hasWall(set, sr, sc) {
  if (sr < 0 || sr > 7 || sc < 0 || sc > 7) return false;
  return set.has(sr * 8 + sc);
}

/** Is movement between ADJACENT cells (r1,c1)->(r2,c2) blocked by a wall? */
export function wallBetween(s, r1, c1, r2, c2) {
  if (r1 === r2) {
    // horizontal step: crossing the boundary right of min col → vertical walls
    const cc = Math.min(c1, c2);
    return hasWall(s.vwalls, r1 - 1, cc) || hasWall(s.vwalls, r1, cc);
  }
  // vertical step: crossing the boundary below min row → horizontal walls
  const rr = Math.min(r1, r2);
  return hasWall(s.hwalls, rr, c1 - 1) || hasWall(s.hwalls, rr, c1);
}

const DIRS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** Legal pawn destinations for the side to move: [[r,c], ...]. */
export function legalPawnDests(s) {
  const [r, c] = s.pawns[s.side];
  const [orr, oc] = s.pawns[1 - s.side];
  const out = [];
  for (const [dr, dc] of DIRS) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
    if (wallBetween(s, r, c, nr, nc)) continue;
    if (nr === orr && nc === oc) {
      // opponent adjacent: straight jump if open, else the two diagonals
      const jr = nr + dr;
      const jc = nc + dc;
      if (jr >= 0 && jr <= 8 && jc >= 0 && jc <= 8 && !wallBetween(s, nr, nc, jr, jc)) {
        out.push([jr, jc]);
      } else {
        const perps = dr === 0 ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
        for (const [pr, pc] of perps) {
          const tr = nr + pr;
          const tc = nc + pc;
          if (tr < 0 || tr > 8 || tc < 0 || tc > 8) continue;
          if (wallBetween(s, nr, nc, tr, tc)) continue;
          out.push([tr, tc]);
        }
      }
    } else {
      out.push([nr, nc]);
    }
  }
  return out;
}

/** BFS: can `side`'s pawn still reach its goal row (pawns ignored)? */
export function pathExists(s, side) {
  const goal = GOAL_ROW[side];
  const [sr, sc] = s.pawns[side];
  if (sr === goal) return true;
  const seen = new Uint8Array(81);
  const queue = [sr * 9 + sc];
  seen[sr * 9 + sc] = 1;
  while (queue.length) {
    const cell = queue.pop();
    const r = (cell / 9) | 0;
    const c = cell % 9;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
      if (seen[nr * 9 + nc]) continue;
      if (wallBetween(s, r, c, nr, nc)) continue;
      if (nr === goal) return true;
      seen[nr * 9 + nc] = 1;
      queue.push(nr * 9 + nc);
    }
  }
  return false;
}

/** BFS shortest-path length (moves) from `side`'s pawn to its goal row,
 *  ignoring pawns (the standard racing metric). Infinity if walled off. */
export function pathDist(s, side) {
  const goal = GOAL_ROW[side];
  const [sr, sc] = s.pawns[side];
  if (sr === goal) return 0;
  const dist = new Int16Array(81).fill(-1);
  dist[sr * 9 + sc] = 0;
  const queue = [sr * 9 + sc];
  for (let qi = 0; qi < queue.length; qi++) {
    const cell = queue[qi];
    const r = (cell / 9) | 0;
    const c = cell % 9;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
      if (dist[nr * 9 + nc] !== -1) continue;
      if (wallBetween(s, r, c, nr, nc)) continue;
      dist[nr * 9 + nc] = dist[cell] + 1;
      if (nr === goal) return dist[nr * 9 + nc];
      queue.push(nr * 9 + nc);
    }
  }
  return Infinity;
}

/** BFS shortest path for `side` as [r,c] cells from the pawn to its goal row
 *  (both inclusive), ignoring pawns — same graph as pathDist. Null if sealed
 *  off. Used by the race-path overlay; not part of the rules themselves. */
export function shortestPath(s, side) {
  const goal = GOAL_ROW[side];
  const [sr, sc] = s.pawns[side];
  if (sr === goal) return [[sr, sc]];
  const prev = new Int16Array(81).fill(-2);
  prev[sr * 9 + sc] = -1;
  const queue = [sr * 9 + sc];
  const walk = (endCell) => {
    const cells = [];
    for (let c = endCell; c !== -1; c = prev[c]) cells.push([(c / 9) | 0, c % 9]);
    return cells.reverse();
  };
  for (let qi = 0; qi < queue.length; qi++) {
    const cell = queue[qi];
    const r = (cell / 9) | 0;
    const c = cell % 9;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
      if (prev[nr * 9 + nc] !== -2) continue;
      if (wallBetween(s, r, c, nr, nc)) continue;
      prev[nr * 9 + nc] = cell;
      if (nr === goal) return walk(nr * 9 + nc);
      queue.push(nr * 9 + nc);
    }
  }
  return null;
}

/** Wall placement legality WITHOUT the path check (overlap/crossing only). */
export function wallFits(s, sr, sc, horiz) {
  if (sr < 0 || sr > 7 || sc < 0 || sc > 7) return false;
  if (horiz) {
    if (hasWall(s.hwalls, sr, sc - 1) || hasWall(s.hwalls, sr, sc) || hasWall(s.hwalls, sr, sc + 1)) return false;
    if (hasWall(s.vwalls, sr, sc)) return false;
  } else {
    if (hasWall(s.vwalls, sr - 1, sc) || hasWall(s.vwalls, sr, sc) || hasWall(s.vwalls, sr + 1, sc)) return false;
    if (hasWall(s.hwalls, sr, sc)) return false;
  }
  return true;
}

/** Full wall legality: fits, mover has walls, and both pawns keep a path. */
export function wallLegal(s, sr, sc, horiz) {
  if (s.wallsLeft[s.side] <= 0) return false;
  if (!wallFits(s, sr, sc, horiz)) return false;
  const set = horiz ? s.hwalls : s.vwalls;
  const slot = sr * 8 + sc;
  set.add(slot);
  const ok = pathExists(s, 0) && pathExists(s, 1);
  set.delete(slot);
  return ok;
}

export function winner(s) {
  if (s.pawns[0][0] === 8) return 0;
  if (s.pawns[1][0] === 0) return 1;
  return null;
}

export function isTerminal(s) {
  return winner(s) !== null;
}

/** Every legal move for the side to move, as notation strings. */
export function allLegalMoves(s) {
  if (isTerminal(s)) return [];
  const out = legalPawnDests(s).map(([r, c]) => formatPawn(r, c));
  if (s.wallsLeft[s.side] > 0) {
    for (let sr = 0; sr < 8; sr++) {
      for (let sc = 0; sc < 8; sc++) {
        if (wallLegal(s, sr, sc, true)) out.push(formatWall(sr, sc, true));
        if (wallLegal(s, sr, sc, false)) out.push(formatWall(sr, sc, false));
      }
    }
  }
  return out;
}

/** Is `notation` legal in state `s`? */
export function isLegal(s, notation) {
  const m = parseMove(notation);
  if (!m || isTerminal(s)) return false;
  if (m.kind === 'pawn') {
    return legalPawnDests(s).some(([r, c]) => r === m.r && c === m.c);
  }
  return wallLegal(s, m.sr, m.sc, m.h);
}

/** Apply a move IN PLACE (caller clones if needed). Throws on illegal. */
export function applyMove(s, notation) {
  const m = parseMove(notation);
  if (!m) throw new Error(`unparseable move: "${notation}"`);
  if (isTerminal(s)) throw new Error('game already over');
  if (m.kind === 'pawn') {
    if (!legalPawnDests(s).some(([r, c]) => r === m.r && c === m.c)) {
      throw new Error(`illegal pawn move: "${notation}"`);
    }
    s.pawns[s.side] = [m.r, m.c];
  } else {
    if (!wallLegal(s, m.sr, m.sc, m.h)) throw new Error(`illegal wall: "${notation}"`);
    (m.h ? s.hwalls : s.vwalls).add(m.sr * 8 + m.sc);
    s.wallsLeft[s.side] -= 1;
  }
  s.side = 1 - s.side;
  s.ply += 1;
  return s;
}

/**
 * Replay a move list from the start. Returns the final state.
 * Throws Error with `.index` set on the first illegal move.
 */
export function replayMoves(moves, walls) {
  const s = initialState(walls);
  for (let i = 0; i < moves.length; i++) {
    try {
      applyMove(s, moves[i]);
    } catch (e) {
      e.index = i;
      throw e;
    }
  }
  return s;
}

/** Build a state from raw parts (an arbitrary position — e.g. an imported
 *  "board FEN"). Does NOT check legality; use `boardIsPlayable` for that.
 *  `pawns` are [[r,c],[r,c]]; `hwalls`/`vwalls` are arrays of slot ints
 *  (sr*8+sc). Values are clamped/coerced defensively. */
export function stateFromParts({ pawns, hwalls = [], vwalls = [], wallsLeft = [10, 10], side = 0, ply = 0 }) {
  const cell = (p) => [Math.min(8, Math.max(0, p[0] | 0)), Math.min(8, Math.max(0, p[1] | 0))];
  const slots = (arr) =>
    new Set(
      (Array.isArray(arr) ? arr : [])
        .map((x) => x | 0)
        .filter((x) => x >= 0 && x < 64),
    );
  return {
    pawns: [cell(pawns[0]), cell(pawns[1])],
    wallsLeft: [Math.min(10, Math.max(0, wallsLeft[0] | 0)), Math.min(10, Math.max(0, wallsLeft[1] | 0))],
    hwalls: slots(hwalls),
    vwalls: slots(vwalls),
    side: side ? 1 : 0,
    ply: Math.max(0, ply | 0),
  };
}

/** Sanity-check an arbitrary position: pawns distinct + on-board, neither pawn
 *  already home in an impossible way, walls don't overlap, and BOTH pawns can
 *  still reach their goal. Returns null if OK, else an error string. */
export function boardIsPlayable(s) {
  const [a, b] = s.pawns;
  if (a[0] === b[0] && a[1] === b[1]) return 'both pawns on the same square';
  // Overlapping/crossing walls make an incoherent board.
  for (const slot of s.hwalls) {
    const sr = Math.floor(slot / 8), sc = slot % 8;
    if (s.vwalls.has(slot)) return 'a horizontal and vertical wall share a slot';
    if (s.hwalls.has(sr * 8 + (sc + 1)) && sc + 1 < 8) { /* adjacency allowed, overlap not */ }
  }
  if (!pathExists(s, 0)) return 'Red pawn is walled off from its goal';
  if (!pathExists(s, 1)) return 'Blue pawn is walled off from its goal';
  return null;
}

/** Replay moves starting from an arbitrary root state (not the standard start).
 *  Returns the final state; throws with `.index` on the first illegal move. */
export function applyMovesFrom(root, moves) {
  const s = cloneState(root);
  for (let i = 0; i < moves.length; i++) {
    try {
      applyMove(s, moves[i]);
    } catch (e) {
      e.index = i;
      throw e;
    }
  }
  return s;
}

/** Serializable snapshot (Sets → sorted arrays) for JSON responses. */
export function stateToJSON(s) {
  return {
    pawns: [ [...s.pawns[0]], [...s.pawns[1]] ],
    wallsLeft: [...s.wallsLeft],
    hwalls: [...s.hwalls].sort((a, b) => a - b).map((x) => [Math.floor(x / 8), x % 8]),
    vwalls: [...s.vwalls].sort((a, b) => a - b).map((x) => [Math.floor(x / 8), x % 8]),
    side: s.side,
    ply: s.ply,
    terminal: isTerminal(s),
    winner: winner(s),
  };
}
