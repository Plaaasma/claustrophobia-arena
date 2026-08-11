"""Headless HTTP service around the Ka (sugiyama2718/Quoridor) engine.

Runs on the dl380 (CPU TF). Loads the release checkpoint once per color and
answers stateless move queries:

  POST /move    {"actions": ["e2", "e8h", ...],      # Glendenning strings from
                                                     # the start position
                 "search_nodes": 3000,               # optional, default 3000
                 "tau": 0.0}                         # optional, 0 => argmax
    -> {"action": "<glendenning>", "turn": N, "value": <root v>, "nodes": N}

  GET /health   -> {"ok": true, "model": "...", "loaded": [colors]}

Notation: Ka's native Glendenning strings (their `accept_action_str` /
`actionid2str`). The caller (our bridge) does any conversion.

Usage:  cd ~/ka/src && MPLBACKEND=Agg python3 ../ka_server.py --port 9714 \
            --ckpt ../application_data/parameter/epoch4100.ckpt
"""

import argparse
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("MPLBACKEND", "Agg")
# NOTE: do NOT set CUDA_VISIBLE_DEVICES=-1 here — the tensorflow-cpu wheel has
# no CUDA anyway, and hiding the device blinds onnxruntime's CUDA EP (--ort).
# DirectML is kept off via DML_VISIBLE_DEVICES=-1 in the launcher.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from Agent import actionid2str  # noqa: E402
from CNNAI import CNNAI  # noqa: E402
from State import State, State_init, accept_action_str  # noqa: E402

AIS = {}
LOCK = threading.Lock()
CKPT = ""
ORT_PATH = ""  # optional ONNX plan: net forwards run on onnxruntime (CUDA)
TORCH_PATH = ""  # optional ONNX -> onnx2torch module on CUDA (aarch64 has no ORT-GPU wheel)


class OrtShim:
    """Drop-in for the inference subset of tf.Session: routes the three
    serving patterns — sess.run(p_tf, {x}), sess.run(y, {x}),
    sess.run([p_tf, y], {x}) — to onnxruntime (CUDA EP, CPU fallback);
    everything else falls through to the real TF session."""

    def __init__(self, real_sess, x, p_tf, y, ort_sess):
        import numpy as np

        self._np = np
        self._real = real_sess
        self._x, self._p, self._y = x, p_tf, y
        self._ort = ort_sess
        self._in = ort_sess.get_inputs()[0].name  # exported as [p_tf, y]

    def _forward(self, feats):
        return self._ort.run(None, {self._in: feats.astype(self._np.float32)})

    def run(self, fetches, feed_dict=None, **kw):
        feats = feed_dict.get(self._x) if feed_dict else None
        if feats is not None:
            if fetches is self._p:
                return self._forward(feats)[0]
            if fetches is self._y:
                return self._forward(feats)[1]
            if (
                isinstance(fetches, (list, tuple))
                and len(fetches) == 2
                and fetches[0] is self._p
                and fetches[1] is self._y
            ):
                return list(self._forward(feats))
        return self._real.run(fetches, feed_dict=feed_dict, **kw)

    def __getattr__(self, name):  # graph, close, ... -> real session
        return getattr(self._real, name)


def make_ort_session():
    # ORT-CUDA needs cudart/cublas/cudnn DLLs; the pip torch bundle has them.
    # Belt and suspenders: PATH (dependency resolution of the provider DLL
    # honors it), add_dll_directory, and ORT's own preloader where available —
    # add_dll_directory ALONE was measured insufficient on this box.
    torch_lib = r"C:\Users\Liam\AppData\Local\Programs\Python\Python312\Lib\site-packages\torch\lib"
    if os.path.isdir(torch_lib):
        os.environ["PATH"] = torch_lib + os.pathsep + os.environ.get("PATH", "")
        os.add_dll_directory(torch_lib)
    import onnxruntime as ort

    if hasattr(ort, "preload_dlls"):
        try:
            ort.preload_dlls()
        except Exception as e:  # noqa: BLE001
            print(f"ka_server: preload_dlls: {e}", flush=True)

    sess = ort.InferenceSession(
        ORT_PATH,
        providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    print(f"ka_server: ORT providers = {sess.get_providers()}", flush=True)
    return sess


class TorchShim:
    """Same serving surface as OrtShim, but forwards run through an
    onnx2torch-converted module on CUDA (no aarch64 onnxruntime-gpu exists).
    The ONNX exports outputs in [p_tf, y] order, matching OrtShim."""

    def __init__(self, real_sess, x, p_tf, y, module, device):
        import numpy as np

        self._np = np
        self._real = real_sess
        self._x, self._p, self._y = x, p_tf, y
        self._mod = module
        self._dev = device

    def _forward(self, feats):
        import torch

        with torch.no_grad():
            t = torch.from_numpy(self._np.asarray(feats, dtype=self._np.float32)).to(self._dev)
            out = self._mod(t)
        if isinstance(out, (list, tuple)):
            return [o.detach().cpu().numpy() for o in out]
        return [out.detach().cpu().numpy()]

    def run(self, fetches, feed_dict=None, **kw):
        feats = feed_dict.get(self._x) if feed_dict else None
        if feats is not None:
            if fetches is self._p:
                return self._forward(feats)[0]
            if fetches is self._y:
                return self._forward(feats)[1]
            if (
                isinstance(fetches, (list, tuple))
                and len(fetches) == 2
                and fetches[0] is self._p
                and fetches[1] is self._y
            ):
                return list(self._forward(feats))
        return self._real.run(fetches, feed_dict=feed_dict, **kw)

    def __getattr__(self, name):
        return getattr(self._real, name)


_TORCH_MOD = None


def make_torch_module():
    global _TORCH_MOD
    if _TORCH_MOD is None:
        import torch
        from onnx2torch import convert

        dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        mod = convert(TORCH_PATH).to(dev).eval()
        _TORCH_MOD = (mod, dev)
        print(f"ka_server: torch shim on {dev}", flush=True)
    return _TORCH_MOD


def get_ai(color: int, search_nodes: int, tau: float) -> "CNNAI":
    ai = AIS.get(color)
    if ai is None:
        ai = CNNAI(
            color,
            search_nodes=search_nodes,
            C_puct=2.5,
            tau=tau,
            use_mix_precision=False,
        )
        ai.load(CKPT)
        if ORT_PATH:
            ai.sess = OrtShim(ai.sess, ai.x, ai.p_tf, ai.y, make_ort_session())
        elif TORCH_PATH:
            mod, dev = make_torch_module()
            ai.sess = TorchShim(ai.sess, ai.x, ai.p_tf, ai.y, mod, dev)
        AIS[color] = ai
    ai.search_nodes = search_nodes
    ai.tau = tau
    return ai


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, "model": CKPT, "loaded": sorted(AIS)})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.startswith("/legal"):
            # Conformance aid: full legal-action-string set for a position,
            # brute-forced by replaying the action list per candidate (cheap C).
            try:
                n = int(self.headers.get("Content-Length", "0"))
                req = json.loads(self.rfile.read(n) or b"{}")
                actions = req.get("actions", [])

                def replay():
                    s = State()
                    State_init(s)
                    for a in actions:
                        assert accept_action_str(s, a), f"illegal prefix {a!r}"
                    return s

                base = replay()
                if base.terminate:
                    self._json(200, {"legal": []})
                    return
                cands = [
                    f"{c}{r}" for c in "abcdefghi" for r in range(1, 10)
                ] + [
                    f"{c}{r}{o}" for c in "abcdefgh" for r in range(1, 9) for o in "hv"
                ]
                legal = [a for a in cands if accept_action_str(replay(), a)]
                self._json(200, {"legal": legal, "turn": base.turn})
            except Exception as e:  # noqa: BLE001
                self._json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        if not self.path.startswith("/move"):
            self._json(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
            actions = req.get("actions", [])
            nodes = int(req.get("search_nodes", 3000))
            tau = float(req.get("tau", 0.0))

            state = State()
            State_init(state)
            for a in actions:
                if not accept_action_str(state, a):
                    self._json(400, {"error": f"illegal action {a!r} at turn {state.turn}"})
                    return
            if state.terminate:
                self._json(409, {"error": "game already over"})
                return
            color = state.turn % 2
            with LOCK:  # one search at a time (TF session + tree state)
                ai = get_ai(color, nodes, tau)
                ai.init_prev()  # stateless: no tree carry between requests
                action_id, _pi, v_prev, v_post, searched = ai.act_and_get_pi(
                    state, use_prev_tree=False
                )
            self._json(
                200,
                {
                    "action": actionid2str(state, action_id),
                    "turn": state.turn,
                    "value": float(v_post),
                    "value_prior": float(v_prev),
                    "nodes": int(searched),
                },
            )
        except Exception as e:  # noqa: BLE001 — service must answer, not die
            self._json(500, {"error": f"{type(e).__name__}: {e}"})


def main() -> None:
    global CKPT, ORT_PATH, TORCH_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9714)
    ap.add_argument("--ckpt", default="../application_data/parameter/epoch4100.ckpt")
    ap.add_argument("--ort", default="", help="ONNX export -> onnxruntime-CUDA forwards")
    ap.add_argument("--torch", default="", help="ONNX export -> onnx2torch-CUDA forwards")
    args = ap.parse_args()
    CKPT = args.ckpt
    ORT_PATH = args.ort
    TORCH_PATH = args.torch
    # Preload color 0 so the first request is not a cold TF build.
    get_ai(0, 3000, 0.0)
    print(f"ka_server: model={CKPT} port={args.port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
