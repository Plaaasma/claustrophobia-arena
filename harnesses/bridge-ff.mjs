// ACE Ishtar bridge — Spark edition. Chromium's dawn never exposes
// shader-f16 on linux, but Firefox Nightly's wgpu does (probed: f16 true on
// the GB10 under Xvfb with forced acceleration). So the engine page runs in
// Firefox driven over raw W3C WebDriver via geckodriver — no playwright.
//
// POST /move {moves:[...ours], timeMs} -> {move, winProb, ...}
// Runs as claustro-ishtar.service: `xvfb-run -a node bridge-ff.mjs`.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, 'ace_ishtar.html'));
const PORT = Number(process.env.ISHTAR_PORT || 9705);
const PAGE_PORT = PORT + 1;
const GD_PORT = PORT - 5260; // 9705 -> 4445, 9707 -> 4447 — distinct per instance

createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HTML);
}).listen(PAGE_PORT, '127.0.0.1');

const gd = spawn(join(HERE, 'geckodriver'), ['--port', String(GD_PORT)], { stdio: 'ignore' });
process.on('exit', () => { try { gd.kill(); } catch {} });
await new Promise((ok) => setTimeout(ok, 2000));

const W = `http://127.0.0.1:${GD_PORT}`;
const wd = async (method, path, body) => {
  const r = await fetch(W + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
};

const sess = await wd('POST', '/session', {
  capabilities: { alwaysMatch: { 'moz:firefoxOptions': {
    binary: join(HERE, 'firefox', 'firefox'),
    args: [],
    prefs: {
      'dom.webgpu.enabled': true,
      'gfx.webgpu.force-enabled': true,
      'dom.webgpu.workers.enabled': true,
      'dom.webgpu.indirect-dispatch.enabled': true,
      'gfx.webrender.all': true,
      'webgl.force-enabled': true,
      'layers.acceleration.force-enabled': true,
      'dom.max_script_run_time': 0,
    },
  } } },
});
const sid = sess.value?.sessionId;
if (!sid) { console.log('[ishtar] geckodriver session failed: ' + JSON.stringify(sess).slice(0, 300)); process.exit(1); }
await wd('POST', `/session/${sid}/timeouts`, { script: 600_000, pageLoad: 300_000 });
await wd('POST', `/session/${sid}/url`, { url: `http://127.0.0.1:${PAGE_PORT}/` });
console.log('[ishtar] page loading');

// wait for the engine pool
for (let i = 0; ; i++) {
  const r = await wd('POST', `/session/${sid}/execute/sync`, {
    script: 'return !!(window.ACEEngine && window.ACEEngine.ready && window.ACEEngine.ready());', args: [],
  });
  if (r.value === true) break;
  if (i > 120) { console.log('[ishtar] engine pool never became ready'); process.exit(1); }
  await new Promise((ok) => setTimeout(ok, 2000));
}
console.log('[ishtar] engine pool ready');

// ours == the page's "official" notation; ids are internal — same codec as the
// old Windows bridge, but as WebDriver async-script source
const THINK_SRC = `
  const args = arguments[0]; const done = arguments[arguments.length - 1];
  const off2id = (s) => {
    const C = s.charCodeAt(0) - 97;
    if (s.length <= 2) return (9 - parseInt(s.slice(1), 10)) * 9 + C;
    const h = s[s.length - 1] === 'h';
    return (h ? 100 : 200) + (8 - parseInt(s.slice(1, -1), 10)) * 8 + C;
  };
  const id2off = (id) => {
    if (id < 81) return String.fromCharCode(97 + (id % 9)) + String(9 - ((id / 9) | 0));
    const h = id < 200, slot = id - (h ? 100 : 200);
    return String.fromCharCode(97 + (slot % 8)) + String(8 - ((slot / 8) | 0)) + (h ? 'h' : 'v');
  };
  window.ACEEngine.think(args.moves.map(off2id), { timeMs: args.timeMs, engine: 'ishtar' })
    .then((r) => done({ ok: true, move: id2off(r.move), winProb: r.winProb, nodes: r.nodes, depth: r.depth, ms: r.ms }),
          (e) => done({ ok: false, err: String(e && e.message || e) }));`;

const warm = await wd('POST', `/session/${sid}/execute/async`, { script: THINK_SRC, args: [{ moves: [], timeMs: 3000 }] });
if (!warm.value?.ok) { console.log('[ishtar] warmup FAILED: ' + JSON.stringify(warm.value || warm).slice(0, 300)); process.exit(1); }
console.log(`[ishtar] warmup ok: ${warm.value.move} depth ${warm.value.depth}`);

let chain = Promise.resolve();
createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"engine":"ishtar","host":"spark-firefox"}'); }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const job = chain.then(async () => {
      const { moves = [], timeMs = 2000 } = JSON.parse(body);
      const t0 = Date.now();
      const r = await wd('POST', `/session/${sid}/execute/async`, { script: THINK_SRC, args: [{ moves, timeMs }] });
      const out = r.value && typeof r.value === 'object' ? r.value : { ok: false, err: JSON.stringify(r).slice(0, 200) };
      out.bridgeMs = Date.now() - t0;
      return out;
    }).then(
      (r) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); },
      (e) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, err: String(e && e.message || e) })); },
    );
    chain = job.catch(() => {});
  });
}).listen(PORT, '127.0.0.1');
console.log(`[ishtar] bridge on :${PORT}`);
