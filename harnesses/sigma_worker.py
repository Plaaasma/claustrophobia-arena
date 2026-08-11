#!/usr/bin/env python3
"""SigmaQuoridor arena worker — persistent stdin/stdout JSONL bridge.

in:  {"moves": ["e2","e8","d4h",...], "budget_ms": 8000}
out: {"ok": true, "move": "e3", "ev": 0.61, "sims": 740}

Coordinates map 1:1 to site notation: their (x, y) origin bottom-left equals
our (file-1, rank-1); wall anchors identical. Pawn actions are directions, so
inbound moves are converted via dest-cur (straight jumps collapse to the unit
step) and outbound actions are resolved by applying them and diffing position.
Time management: sims budget from an EMA of measured sims/sec.
"""
import faulthandler
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.expanduser("~/arena-engines/SigmaQuoridor"))
import torch  # noqa: E402
from dual_network import make_nn_evaluator  # noqa: E402
from game import PawnAction, State, WallAction  # noqa: E402
from mcts import MCTSAgent  # noqa: E402

CKPT = os.path.expanduser("~/arena-engines/SigmaQuoridor/runs/models_9x9_scratch/best.pt")
DEVICE = os.environ.get("SIGMA_DEVICE", "cpu")  # "cpu" (default) or "cuda" for the GPU arena entry
if DEVICE == "cpu":
    torch.set_num_threads(2)  # two workers share the box with six other engines
agent = MCTSAgent(evaluator=make_nn_evaluator(CKPT, device=torch.device(DEVICE)),
                  num_simulations=100,
                  sim_batch_size=8 if DEVICE == "cuda" else 1)
rate = 80.0 if DEVICE == "cpu" else 300.0  # sims/sec EMA — recalibrates from real moves

# Hard-deadline watchdog. Their MCTS can hang on rare positions (observed: a
# worker spinning at 95% CPU for 74 minutes). The search loop is Python-driven
# so this daemon thread still gets scheduled; os._exit() sidesteps whatever is
# stuck and the arena respawns a fresh worker.
_deadline = [None]
_current_req = [None]  # moves list of the request being searched — hang forensics


def _watchdog():
    while True:
        time.sleep(5)
        d = _deadline[0]
        if d is not None and time.time() > d:
            # forensics: the exact position + the hung main thread's stack
            sys.stderr.write(f"sigma watchdog HANG device={DEVICE} moves={_current_req[0]}\n")
            faulthandler.dump_traceback(file=sys.stderr)
            sys.stderr.flush()
            os._exit(3)


threading.Thread(target=_watchdog, daemon=True).start()


def pos_of(state, player):
    return state.player1pos if player == 1 else state.player2pos


def our_move_to_action(state, n):
    if len(n) == 2:  # pawn destination
        cx, cy = pos_of(state, 1 if state.depth % 2 == 0 else 2)
        dx, dy = (ord(n[0]) - 97) - cx, (int(n[1]) - 1) - cy
        if (abs(dx) == 2 and dy == 0) or (abs(dy) == 2 and dx == 0):
            dx, dy = dx // 2, dy // 2  # straight jump = its unit direction
        return PawnAction(direction=(dx, dy))
    return WallAction(x=ord(n[0]) - 97, y=int(n[1:-1]) - 1, orientation=n[-1])


def action_to_our(state, action):
    if isinstance(action, WallAction):
        return f"{chr(97 + action.x)}{action.y + 1}{action.orientation}"
    mover = 1 if state.depth % 2 == 0 else 2
    nxt = state.next(action)
    x, y = pos_of(nxt, mover)
    return f"{chr(97 + x)}{y + 1}"


def replay(moves):
    st = State(boardsize=9, walls_p1=10, walls_p2=10)
    for n in moves:
        st = st.next(our_move_to_action(st, n))
    return st


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        st = replay(req["moves"])
        sims_cap = 4000 if DEVICE == "cuda" else 1200
        sims = max(24, min(sims_cap, int(rate * req.get("budget_ms", 5000) / 1000.0)))
        _current_req[0] = " ".join(req["moves"])
        # watchdog stays as the wedge backstop only — real time management is
        # the chunked loop below (their search() reuses the stored subtree on
        # an identical position, so chunking is exactly one big search)
        _deadline[0] = time.time() + max(120.0, req.get("budget_ms", 5000) / 1000.0 * 4 + 60.0)
        t0 = time.time()
        budget_s = req.get("budget_ms", 5000) / 1000.0
        done = 0
        root = None
        while done < sims:
            chunk = min(200, sims - done)
            root = agent.search(st, num_sims=chunk)
            done += chunk
            # honor the clock even when the box is starved (observed: torch
            # convs at <10 sims/s under load — a fixed-sims search then runs
            # for minutes and the watchdog shoots an honest move)
            if time.time() - t0 >= budget_s:
                break
        _deadline[0] = None
        dt = max(0.05, time.time() - t0)
        rate = 0.7 * rate + 0.3 * (done / dt)
        best = max(root.children, key=lambda c: c.visit_count)
        ev = (root.q_value + 1.0) / 2.0  # negamax root value, mover POV -> win prob
        out = {"ok": True, "move": action_to_our(st, best.action),
               "ev": round(min(1.0, max(0.0, ev)), 4), "sims": done,
               "ms": int(dt * 1000)}
    except Exception as e:  # report, never die — orchestrator decides forfeits
        _deadline[0] = None
        out = {"ok": False, "err": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
