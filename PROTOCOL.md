# Arena engine wire protocol

Any engine can join the arena by exposing one HTTP endpoint (locally, in a
container, or hosted anywhere on the internet).

## Request — `POST` (JSON)

```json
{
  "moves": ["e2", "e8", "e3h"],
  "budget_ms": 5000,
  "clock": {"my_ms": 143200, "opp_ms": 151800, "inc_ms": 2000}
}
```

- `moves` — complete game history from the standard start position, in order.
  You play the side to move: even count = first player (starts e1, races
  toward rank 9), odd = second player (starts e9, toward rank 1).
- `budget_ms` — suggested think budget for this move (the orchestrator's
  heuristic: `min(rem·0.3, rem/22 + 1.5s)`).
- `clock` — authoritative clock state: your remaining time, opponent's
  remaining time, Fischer increment. Engines with native time management may
  ignore `budget_ms` and pace themselves from this; the only rule is that
  total elapsed (including network transit) never exceeds `my_ms`.

## Response — HTTP 200 (JSON)

```json
{"ok": true, "move": "e4", "ev": 0.62, "nodes": 12345}
```

- `move` *(required)* — your chosen move.
- `ev` *(optional)* — estimated win probability **for yourself**, 0..1.
  Drives the live eval bars and graphs.
- `nodes` *(optional)* — nodes/sims/evals searched; shown as live telemetry.
- Errors: `{"ok": false, "error": "description"}` with HTTP 200. An errored
  move draws that game; never crash or hang.

`GET` on the same URL should return HTTP 200 when the engine is ready
(health check).

## Notation

Files `a`–`i` left→right from the first player's seat, ranks `1`–`9`
bottom→top (first player's side = rank 1). Pawn move = destination square
(`e4`); jumps are written as the destination like any pawn move. Wall =
anchor square + orientation (`e3h`, `d7v`) — the anchor is the wall's
lower-left square; `h` walls span two columns lying above that rank, `v`
walls span two ranks right of that file. 10 walls per player.

## Semantics

- **Stateless protocol, stateful server welcome**: every request carries the
  full history, so a restarted engine rebuilds from nothing — but trees and
  caches keyed by position are fair game (several arena engines keep
  persistent transposition tables).
- Up to 2 of your games may run **concurrently**, interleaved on the same
  endpoint (configurable per engine).
- Clocks are 3 minutes + 2 seconds Fischer; illegal moves and flag falls
  forfeit; engine failures draw the single game.
