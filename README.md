# Claustrophobia Bot Arena

The engine-vs-engine tournament that runs around the clock at
[claustrophobia.dev/arena](https://claustrophobia.dev/arena) — 16 Quoridor
engines, CCC-style opening pairs, live boards with dual eval bars, per-engine
profiles, and a fairness-hardened rating system.

This repo is the arena itself: the orchestrator, the wire protocol for
adding engines, our harnesses around third-party engines, the house baseline
bots, and reference extracts of the site's arena API and UI.

## How it works

- **Format**: every pairing plays each opening twice with colors swapped
  (like TCEC/CCC). Clocks are 3+2 Fischer; the orchestrator owns the clocks
  and passes each engine a time budget plus the true clock state. Illegal
  moves and flag falls forfeit; engine/infrastructure failures draw the
  single game rather than punishing the engine.
- **Rating**: Elo (K=24) updates **per opening pair**, not per game — a 1-1
  split scores as a draw. Per-game updates bleed rating from the stronger
  engine on every color-forced opening (measured: ~19% of pairs split
  strictly along color lines before mitigation). W/L/D counts stay per-game.
- **Opening balance filter**: the pool is drawn from an opening book, and
  any opening whose observed pairs split with color >40% (min 6 pairs) is
  banned automatically — those games measure the opening, not the engines.
- **Fair scheduling**: the scheduler always seats the most game-starved
  *pairing* (in-flight games included), so every matchup accumulates games
  and the Elo is a true all-play-all estimate.
- **Telemetry**: engines report win-probability and node counts per move;
  the site stores per-ply evals/stats and renders live eval bars, graphs,
  replays, and per-engine profile pages with searchable game history.

## Repo layout

| Path | What |
|---|---|
| `orchestrator/arena.mjs` | The whole tournament: scheduler, clocks, adapters for every engine, Elo, DB writes. Zero npm dependencies (Node 22 built-ins). |
| `PROTOCOL.md` | The HTTP wire contract for adding your own engine — local, containerized, or hosted anywhere. |
| `engines/house/` | The three house baseline bots (greedy racer, depth-2 and depth-4 minimax) + the shared rules library they run on. |
| `harnesses/` | Our wrappers around third-party engines: python JSONL workers, a Node vm harness for an extracted browser engine, a Firefox/WebDriver WebGPU bridge (retired but instructive). |
| `site-reference/` | Extracts of the site's arena HTTP API and SPA pages, for reference (they depend on site-wide helpers not included here). |
| `tools/elo_recompute.mjs` | Full-history rating recompute under the pair-based rules. |

## Adding an engine

Read `PROTOCOL.md`. Practically: expose one HTTP endpoint that picks a move
from a game history within a time budget, tell us its URL (or ship a
`linux/arm64` Docker image), and the arena does the rest — clocks, scheduling,
ratings, telemetry, and a profile page. Engines run network-isolated when we
host them.

## Notes

- Third-party engine binaries/weights are **not** included — each engine
  belongs to its author. The harnesses show how they're wired.
- The orchestrator writes to the site's SQLite DB directly; adapting it to
  another site means implementing the small `arena_bots`/`arena_games`
  schema at the top of `arena.mjs`.

## License

MIT
