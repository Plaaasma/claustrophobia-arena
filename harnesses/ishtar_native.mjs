#!/usr/bin/env node
// Native harness for extracted ACE Ishtar 16 search + net.
// Loads pristine extracted JS modules (engine-core + ka-* + ishtar-*) in a vm
// sandbox, evaluates positions through a python sidecar (onnx2torch over the
// pristine b2_ishtar.onnx), and speaks the same JSONL protocol as the other
// arena engine servers: {"moves": [...], "budget_ms": N} per line.
//
// env: ISHTAR_DEVICE=cpu|cuda (sidecar device), ISHTAR_NATIVE_PORT (HTTP port)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEVICE = process.env.ISHTAR_DEVICE || 'cpu';
const PORT = Number(process.env.ISHTAR_NATIVE_PORT || 9720);
const PY = process.env.ISHTAR_PY || `${process.env.HOME}/arena-engines/ka-venv/bin/python`;

// ---- vm sandbox: engine-core is a plain script (top-level function decls
// attach to the context global); the rest are UMD and attach to root when
// `module` is undefined in scope.
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Promise, performance,
  Uint8Array, Uint16Array, Int16Array, Int32Array, Float32Array, Float64Array,
  ArrayBuffer, DataView, Map, Set, WeakMap, TextEncoder, TextDecoder,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

const MODULES = ['engine-core.js', 'ka-encoder.js', 'ka-solver.js', 'ka-engine.js',
  'ka-ab.js', 'ishtar-encoder.js', 'ishtar-ab.js'];
for (const f of MODULES) {
  const src = fs.readFileSync(path.join(HERE, f), 'utf8');
  vm.runInContext(src, sandbox, { filename: f });
}
for (const g of ['Quoridor', 'KaEncoder', 'KaSolver', 'KaEngineLib', 'KaABLib', 'IshtarEncoder', 'IshtarABLib']) {
  if (!sandbox[g]) { console.error(`missing global after load: ${g}`); process.exit(1); }
}

// ---- python eval sidecar
const py = spawn(PY, [path.join(HERE, 'ishtar_eval_server.py')], {
  env: { ...process.env, ISHTAR_DEVICE: DEVICE },
  stdio: ['pipe', 'pipe', 'inherit'],
});
py.on('exit', (c) => { console.error(`eval sidecar exited (${c})`); process.exit(1); });
let pyBuf = '';
const pyQueue = []; // resolvers, FIFO — sidecar answers strictly in order
py.stdout.on('data', (d) => {
  pyBuf += d;
  let i;
  while ((i = pyBuf.indexOf('\n')) >= 0) {
    const line = pyBuf.slice(0, i); pyBuf = pyBuf.slice(i + 1);
    if (line.trim()) pyQueue.shift()?.(JSON.parse(line));
  }
});
function pyEval(rowsB64, b) {
  return new Promise((resolve, reject) => {
    pyQueue.push((r) => r.err ? reject(new Error(r.err)) : resolve(r));
    py.stdin.write(JSON.stringify({ rows: rowsB64, b }) + '\n');
  });
}

// evaluate(rows: Uint16Array(486)[], B) -> [{p: Float32Array(209), value: number}]
// rows carry raw f16 bit patterns; sidecar reinterprets as float16.
async function evaluate(rows, B) {
  const buf = Buffer.allocUnsafe(B * 486 * 2);
  for (let i = 0; i < B; i++) {
    Buffer.from(rows[i].buffer, rows[i].byteOffset, 486 * 2).copy(buf, i * 486 * 2);
  }
  const r = await pyEval(buf.toString('base64'), B);
  // Buffer.from(base64) is a view into Node's shared pool — must respect byteOffset
  const pb = Buffer.from(r.p, 'base64');
  const vb = Buffer.from(r.v, 'base64');
  const p = new Float32Array(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.length));
  const v = new Float32Array(vb.buffer.slice(vb.byteOffset, vb.byteOffset + vb.length));
  const out = [];
  for (let i = 0; i < B; i++) out.push({ p: p.subarray(i * 209, (i + 1) * 209), value: v[i] });
  return out;
}

// ---- engine, wired exactly as ishtar-worker.js does
const S = sandbox;
const searchConfig = { abK: 16, abKrootMul: 2, abK1: 2, abKint: 1, batchChunk: 32, priorFloor: 0.05, predictStop: -1 };
function makeEngine() {
  return S.IshtarABLib.makeEngine({
    Quoridor: S.Quoridor,
    IshtarEncoder: S.IshtarEncoder,
    KaABLib: S.KaABLib,
    KaEngineLib: S.KaEngineLib,
    Solver: S.KaSolver,
    evaluate,
    officialOf: S.KaEncoder.ourIdToOfficial,
    config: searchConfig,
  });
}

// ONE persistent engine, as in the original worker: TT/eval-cache/killers
// carry across moves within (and between) games — cold caches per move played
// measurably weaker despite higher raw nps.
const ENGINE = makeEngine();
let busy = Promise.resolve();
async function handleMove(req) {
  const t0 = Date.now();
  const engine = ENGINE;
  // setPosition takes ACE numeric move IDs; arena speaks official notation
  engine.setPosition((req.moves || []).map((m) => S.KaEncoder.officialToOurId(m)));
  const budget = Math.max(200, Math.min(60000, Number(req.budget_ms) || 5000));
  const opts = { timeMs: budget };
  if (req.max_evals) opts.maxEvals = Number(req.max_evals);
  if (req.max_nodes) opts.maxNodes = Number(req.max_nodes);
  const r = await engine.search(opts);
  return {
    ok: true, move: r.bestOfficial, ev: r.winProb,
    nodes: r.nodes ?? null, evals: r.evals ?? null, depth: r.depth ?? null,
    ms: Date.now() - t0,
  };
}

const server = http.createServer((rq, rs) => {
  if (rq.method !== 'POST') { rs.writeHead(404); rs.end(); return; }
  let body = '';
  rq.on('data', (d) => { body += d; });
  rq.on('end', () => {
    const job = busy.then(async () => {
      let out;
      try { out = await handleMove(JSON.parse(body)); }
      catch (e) { out = { ok: false, error: String(e?.message || e) }; }
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify(out));
    });
    busy = job.catch(() => {});
  });
});

// warmup: one tiny search so eval kernels + caches warm before first arena move
const warm = ENGINE;
warm.setPosition([]);
warm.search({ timeMs: 1500 }).then((r) => {
  console.error(`ishtar-native warm: device=${DEVICE} best=${r.bestOfficial} evals=${r.evals} nodes=${r.nodes}`);
  server.listen(PORT, '127.0.0.1', () => console.error(`ishtar-native listening :${PORT} (${DEVICE})`));
}).catch((e) => { console.error('warmup failed:', e); process.exit(1); });
