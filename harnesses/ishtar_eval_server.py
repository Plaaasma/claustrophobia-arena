#!/usr/bin/env python3
"""Native evaluator sidecar for the extracted ACE Ishtar net.

Loads the pristine b2_ishtar.onnx (sha256-verified extraction from the
published artifact) via onnx2torch, on ISHTAR_DEVICE=cuda|cpu.

stdin JSONL:  {"rows": <b64 of B*486 little-endian f16>, "b": B}
stdout JSONL: {"p": <b64 of B*209 f32 raw policy logits>,
               "v": <b64 of B f32 STM values in [-1,1]>}
"""
import base64
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ONNX_PATH = os.path.join(HERE, "b2_ishtar.onnx")
DEVICE = os.environ.get("ISHTAR_DEVICE", "cpu")

if DEVICE == "cuda":
    import onnx
    import torch
    from onnx import TensorProto, numpy_helper
    from onnx2torch import convert

    # Upcast the fp16 artifact to a clean fp32 graph BEFORE conversion (the
    # ARM64 kit's verified recipe, parity 0.0049): onnx2torch otherwise bakes
    # the Cast-to-half nodes in and the eager fp16 graph runs ~10x slower.
    model_proto = onnx.load(ONNX_PATH)
    for init in model_proto.graph.initializer:
        if init.data_type == TensorProto.FLOAT16:
            arr = numpy_helper.to_array(init).astype(np.float32)
            init.CopyFrom(numpy_helper.from_array(arr, init.name))
    for node in model_proto.graph.node:
        if node.op_type == "Cast":
            for a in node.attribute:
                if a.name == "to" and a.i == TensorProto.FLOAT16:
                    a.i = TensorProto.FLOAT
    for vi in list(model_proto.graph.input) + list(model_proto.graph.output) + list(model_proto.graph.value_info):
        tt = vi.type.tensor_type
        if tt.elem_type == TensorProto.FLOAT16:
            tt.elem_type = TensorProto.FLOAT
    OUT_NAMES = [o.name for o in model_proto.graph.output]
    dev = torch.device("cuda")
    mod = convert(model_proto).to(dev).eval()

    def run(raw):  # raw: np f16 [B,9,9,6] NHWC
        with torch.no_grad():
            out = mod(torch.from_numpy(raw.astype(np.float32)).to(dev))
        outs = list(out) if isinstance(out, (list, tuple)) else [out]
        return [o.float().cpu().numpy() for o in outs]
else:
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = int(os.environ.get("ISHTAR_THREADS", "2"))
    so.inter_op_num_threads = 1
    sess = ort.InferenceSession(ONNX_PATH, sess_options=so, providers=["CPUExecutionProvider"])
    IN_NAME = sess.get_inputs()[0].name
    OUT_NAMES = [o.name for o in sess.get_outputs()]

    def run(raw):
        return sess.run(None, {IN_NAME: raw})

P_IDX = next(i for i, n in enumerate(OUT_NAMES) if "policy" in n)
V_IDX = next(i for i, n in enumerate(OUT_NAMES) if n.startswith("value"))

sys.stderr.write(f"ishtar_eval: device={DEVICE} outputs={OUT_NAMES}\n")
sys.stderr.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        b = int(req["b"])
        raw = np.frombuffer(base64.b64decode(req["rows"]), dtype=np.float16).reshape(b, 9, 9, 6)
        outs = run(raw)
        p = np.asarray(outs[P_IDX], dtype=np.float32).reshape(b, 209)
        v = np.asarray(outs[V_IDX], dtype=np.float32).reshape(b)
        resp = {"p": base64.b64encode(p.tobytes()).decode(),
                "v": base64.b64encode(v.tobytes()).decode()}
    except Exception as e:  # noqa: BLE001 — answer, never die
        resp = {"err": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
