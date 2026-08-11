// Arena client pages extracted from the Claustrophobia SPA (app.js).
// REFERENCE EXTRACT — depends on site-wide helpers (shell, api, esc, nav,
// Board, miniBoardSVG, replayMoves, toast, skeleton) not included here.

// ---------------------------------------------------------------------------
// bot arena — engines play each other around the clock
// ---------------------------------------------------------------------------

// clone an arena game into the viewer's library, then open the review page
async function openArenaReview(arenaId, el) {
  if (!ME) { toast('Sign in (with a verified email) to review games.'); return; }
  if (el) el.style.opacity = '0.5';
  try {
    const r = await api(`/api/arena/game/${arenaId}/review`, { body: {} });
    nav(`/review/${r.gameId}`);
  } catch (e) {
    if (!String(e.message).includes('verify')) toast(e.message);
  } finally {
    if (el) el.style.opacity = '';
  }
}

// shared search/sort controls for arena game lists. `fixed` pins the first
// engine (profile pages). Returns HTML; pair with wireArenaSearch below.
function arenaSearchBarHTML(names, { fixed = null } = {}) {
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
  const engines = Object.entries(names).sort((a, b) => a[1].localeCompare(b[1]));
  const engineSel = (id, blank) => `<select data-as="${id}" style="max-width:150px">${opt('', blank, true)}${engines.map(([k, n]) => opt(k, n)).join('')}</select>`;
  return `<div data-arena-search style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;font-size:0.86em">
    ${fixed ? '' : engineSel('p', 'any engine')}
    ${engineSel('vs', fixed ? 'any opponent' : 'vs anyone')}
    <select data-as="result"><option value="" selected>any result</option><option value="decisive">decisive</option><option value="draw">draws</option>${fixed ? `<option value="${esc(fixed)}">wins</option>` : ''}</select>
    <select data-as="reason"><option value="" selected>any ending</option><option value="goal">goal</option><option value="time forfeit">time forfeit</option><option value="illegal">illegal move</option><option value="engine failure">engine failure</option><option value="move cap">move cap</option></select>
    <input data-as="opening" type="text" placeholder="opening starts with… (e2 e8 e3)" style="min-width:170px" maxlength="60">
    <select data-as="sort"><option value="new" selected>newest first</option><option value="old">oldest first</option><option value="long">longest games</option><option value="short">shortest games</option></select>
    <button class="btn" data-as="go">Search</button>
    <button class="btn" data-as="clear" style="opacity:0.8">Clear</button>
    <span class="sub" data-as="count"></span>
  </div>`;
}

/** Wires a search bar to a results renderer. fetchPage(params) is called with
 *  the query string params; renderRows(games, names) paints; onClear restores
 *  the page's default list (null = just empty the filters and re-search). */
function wireArenaSearch(root, { fixed = null, pageSize = 25, renderRows, onClear = null, onSearchState = null }) {
  const bar = root.querySelector('[data-arena-search]');
  const el = (id) => bar.querySelector(`[data-as="${id}"]`);
  const countEl = el('count');
  let offset = 0;
  let lastParams = null;
  const params = () => {
    const ps = new URLSearchParams();
    if (fixed) ps.set('p', fixed);
    else if (el('p').value) ps.set('p', el('p').value);
    if (el('vs').value) ps.set('vs', el('vs').value);
    if (el('result').value) ps.set('result', el('result').value);
    if (el('reason').value) ps.set('reason', el('reason').value);
    if (el('opening').value.trim()) ps.set('opening', el('opening').value.trim());
    ps.set('sort', el('sort').value);
    ps.set('limit', String(pageSize));
    return ps;
  };
  const run = async (append = false) => {
    if (!append) offset = 0;
    const ps = params();
    ps.set('offset', String(offset));
    lastParams = ps.toString();
    const d = await api(`/api/arena/games?${ps}`, { quiet: true });
    countEl.textContent = `${d.total} game${d.total === 1 ? '' : 's'}`;
    renderRows(d, append);
    offset += d.games.length;
    return { hasMore: offset < d.total };
  };
  el('go').addEventListener('click', () => { run(false).then((r) => onSearchState?.(true, r.hasMore)); });
  el('opening').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('go').click(); });
  el('clear').addEventListener('click', () => {
    for (const id of ['vs', 'result', 'reason', 'sort']) el(id).selectedIndex = 0;
    if (!fixed) el('p').selectedIndex = 0;
    el('opening').value = '';
    countEl.textContent = '';
    if (onClear) onClear();
    else el('go').click();
  });
  return { loadMore: () => run(true) };
}

// head-to-head performance-rating difference from a record {w,l,d}:
// 400*log10(s/(1-s)) with Laplace smoothing so perfect scores stay finite
function h2hEloEdge(r) {
  const n = r.w + r.l + r.d;
  if (!n) return null;
  const s = (r.w + r.d / 2 + 0.5) / (n + 1);
  return Math.round(400 * Math.log10(s / (1 - s)));
}
function h2hEloCell(r) {
  const dd = h2hEloEdge(r);
  if (dd === null) return '<td></td>';
  const color = dd > 25 ? '#4caf7d' : dd < -25 ? 'var(--red,#e4553a)' : 'inherit';
  return `<td class="mono" style="color:${color}" title="rating edge implied by this head-to-head record alone">${dd > 0 ? '+' : ''}${dd}</td>`;
}

async function renderArena(stale = () => false) {
  const main = shell('', 'arena', true);
  main.innerHTML = skeleton('page');
  let st;
  try {
    st = await api('/api/arena/state');
  } catch (e) {
    main.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  if (stale()) return;

  let skew = typeof st.now === 'number' ? st.now - Date.now() : 0;
  const names = {};
  const fmtClk = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const WALL_GLYPH = '<svg width="7" height="12" viewBox="0 0 7 12" style="vertical-align:-2px;margin:0 3px 0 8px"><rect x="2" width="3" height="12" rx="1.5" fill="#d9822f"/></svg>';
  // remaining time: the stored clock minus how long the side to move has been
  // thinking (moved_at is stamped server-side after every move)
  const remainMs = (g, side) => {
    const plies = g.moves ? g.moves.split(' ').length : 0;
    let ms = g[`clock${side}`];
    if (plies % 2 === side && g.moved_at) ms -= Math.max(0, Date.now() + skew - g.moved_at);
    return ms;
  };
  const clkHTML = (g, side) =>
    `<span class="mono" data-arclk="${g.id}-${side}">${fmtClk(remainMs(g, side))}</span>`;
  // pairing points as tournament halves: 0 -> 0, 0.5 -> ½, 3.5 -> 3½
  const half = (n) => {
    const i = Math.floor(n);
    const h = n - i >= 0.5 ? '½' : '';
    return i === 0 && h ? h : `${i}${h}`;
  };

  const fmtK = (n) => (n >= 100_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);
  // latest search line for one side: "18.4k nodes · 2.1k/s" from its last ply
  const statLine = (g, side) => {
    let stats = [];
    try { stats = JSON.parse(g.stats || '[]'); } catch {}
    for (let i = stats.length - 1; i >= 0; i--) {
      if (i % 2 !== side || !stats[i] || stats[i].n == null) continue;
      const s = stats[i];
      const nps = s.ms > 0 ? s.n / (s.ms / 1000) : null;
      return `${fmtK(s.n)} nodes${nps ? ` · ${fmtK(nps)}/s` : ''}`;
    }
    return '';
  };
  // that side's own latest eval (evals are stored p0-POV; flip for p1)
  const evalOf = (g, side) => {
    let evals = [];
    try { evals = JSON.parse(g.evals || '[]'); } catch {}
    for (let i = evals.length - 1; i >= 0; i--) {
      if (i % 2 !== side || evals[i] == null) continue;
      return side === 0 ? evals[i] : 1 - evals[i];
    }
    return null;
  };
  // per-engine mini eval bar: fill = that engine's own winning chances, tinted
  // with that engine's name color so the attribution is unambiguous
  const evalBar = (g, side) => {
    const v = evalOf(g, side);
    const color = side === 1 ? 'var(--blue,#3e7bd6)' : 'var(--red,#e4553a)';
    const pct = v == null ? null : Math.round(v * 100);
    return `
      <span style="display:inline-flex;align-items:center;gap:5px;flex:1;min-width:0" title="${esc(names[g[`p${side}`]] || g[`p${side}`])}'s eval of its own chances">
        <span style="flex:1;height:5px;border-radius:3px;background:rgba(128,128,128,0.22);overflow:hidden">
          <span style="display:block;height:100%;width:${pct == null ? 0 : pct}%;background:${color};border-radius:3px"></span>
        </span>
        <span class="mono" style="font-size:0.68em;color:${color};min-width:26px;text-align:right">${pct == null ? '—' : pct + '%'}</span>
      </span>`;
  };

  const liveCard = (g) => {
    const moves = g.moves ? g.moves.split(' ') : [];
    let st2 = null;
    try { st2 = replayMoves(moves); } catch {}
    const pts = (side) => (g.pairGames
      ? `<b class="mono" style="margin-left:7px;padding:0 6px;border-radius:9px;background:rgba(128,128,128,0.18);font-size:0.9em" title="score in this pairing (${g.pairGames} games)">${half(g[`score${side}`] || 0)}</b>` : '');
    const walls = (side) => (st2
      ? `<span title="walls left" style="display:inline-flex;align-items:center;padding:1px 7px 1px 3px;border-radius:9px;background:rgba(128,128,128,0.14)">${WALL_GLYPH}<span class="mono" style="font-size:0.92em">${st2.wallsLeft[side]}</span></span>` : '');
    return `
      <a class="card" href="/arena/game/${g.id}" style="padding:10px;display:flex;flex-direction:column;gap:6px;align-items:center;text-decoration:none;color:inherit">
        <div style="display:flex;justify-content:space-between;align-items:center;width:100%;font-size:0.82em">
          <span style="color:var(--blue,#3e7bd6)">${esc(names[g.p1] || g.p1)}${pts(1)}</span>
          <span style="display:flex;align-items:center;gap:11px">${walls(1)}${clkHTML(g, 1)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;width:100%;min-height:1.2em">${evalBar(g, 1)}<span class="sub mono" style="font-size:0.68em;white-space:nowrap">${statLine(g, 1)}</span></div>
        ${st2 ? miniBoardSVG(st2, 'red') : ''}
        <div style="display:flex;align-items:center;gap:10px;width:100%;min-height:1.2em">${evalBar(g, 0)}<span class="sub mono" style="font-size:0.68em;white-space:nowrap">${statLine(g, 0)}</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;width:100%;font-size:0.82em">
          <span style="color:var(--red,#e4553a)">${esc(names[g.p0] || g.p0)}${pts(0)}</span>
          <span style="display:flex;align-items:center;gap:11px">${walls(0)}${clkHTML(g, 0)}</span>
        </div>
        <div class="sub" style="font-size:0.75em">move ${moves.length} · watch</div>
      </a>`;
  };
  // in-place clock refresh — no DOM rebuild, so boards never flicker
  const tickClocks = () => {
    for (const g of st.live) {
      for (const side of [0, 1]) {
        const el = document.querySelector(`[data-arclk="${g.id}-${side}"]`);
        if (!el) continue;
        const ms = remainMs(g, side);
        el.textContent = fmtClk(ms);
        el.classList.toggle('err', ms < 30_000);
      }
    }
  };

  const recentRow = (g) => {
    const win = g.winner === null || g.winner === undefined
      ? '<i>draw</i>'
      : `<b>${esc(names[g.winner === 0 ? g.p0 : g.p1] || '')}</b>`;
    const plies = g.moves ? g.moves.split(' ').length : 0;
    return `<tr>
      <td><a href="/arena/game/${g.id}" title="Replay with the eval bars and graph">
        <span style="color:var(--red,#e4553a)">${esc(names[g.p0] || g.p0)}</span>
        <span class="sub-inline">vs</span>
        <span style="color:var(--blue,#3e7bd6)">${esc(names[g.p1] || g.p1)}</span></a></td>
      <td>${win}</td><td>${esc(g.reason || '')}</td>
      <td class="mono">${plies}</td>
      <td class="mono">${g.elo0_after ?? ''} / ${g.elo1_after ?? ''}</td>
      <td><a href="/arena/game/${g.id}" title="Replay with the eval bars and graph">replay</a>
        · <a href="#" data-arreview="${g.id}" title="Grade every move with the site engine">review</a></td>
    </tr>`;
  };

  // one line per engine; claustrophobia wears the site ember — the only fixed rule
  // one hue family per engine family: claustrophobia=orange, sigma=green,
  // ka=blue, ishtar=purple, qbr=magenta, kya=red, gorisanson=gold,
  // titanium=steel, house bots=tan
  const ARENA_COLORS = {
    claustrophobia: '#d9822f', ishtar: '#9b6dd6', ka: '#3e7bd6', sigma: '#4caf7d',
    qbr: '#dd3fa0', gorisanson: '#d4aa00', titanium: '#6e7f95',
    claustro_v1: '#f0c274', claustro_cpu: '#a35c1e', sigma_gpu: '#8fe0b0', ka_gpu: '#7fb0f0',
    kya: '#d64545', kya_cpu: '#f0a0a0',
  };
  const engColor = (k) => ARENA_COLORS[k] || '#c7b8a3';
  let lastChartTotal = -1;
  const chartHidden = new Set(); // legend-toggled engines survive redraws
  let chartView = null; // zoomed/panned x-window {x0, x1}; null = everything
  let chartDrag = null; // active pan gesture — survives the per-step redraws
  let chartPreset = null; // "last N games" preset — follows the live right edge
  // optional EMA smoothing (default off); window persisted across visits
  let chartSmooth = false;
  let chartSmoothN = 20;
  try {
    chartSmooth = localStorage.getItem('wt-arena-smooth') === '1';
    const n = Number(localStorage.getItem('wt-arena-smooth-n'));
    if (Number.isFinite(n) && n >= 2 && n <= 200) chartSmoothN = n;
  } catch { /* storage blocked */ }
  const smoothPts = (pts) => {
    if (!chartSmooth || pts.length < 3) return pts;
    const a = 2 / (chartSmoothN + 1); // classic EMA alpha from window size
    const out = new Array(pts.length);
    let s = pts[0][1];
    for (let i = 0; i < pts.length; i++) {
      s = a * pts[i][1] + (1 - a) * s;
      out[i] = [pts[i][0], Math.round(s * 10) / 10];
    }
    return out;
  };
  const drawChart = (force = false) => {
    if (!st.history || (!force && st.total === lastChartTotal)) return;
    lastChartTotal = st.total;
    const box = document.getElementById('ar-elochart');
    if (!box) return;
    // retired engines keep their history in the DB but leave the chart
    const enabledKeys = new Set(st.bots.map((b) => b.key));
    const all = Object.entries(st.history).filter(([k, pts]) => pts.length > 0 && enabledKeys.has(k))
      .map(([k, pts]) => [k, smoothPts(pts)]);
    const series = all.filter(([k]) => !chartHidden.has(k));
    if (!all.length) return;
    let xmax = 1;
    for (const [, pts] of all) for (const [i] of pts) if (i > xmax) xmax = i;
    if (chartPreset) chartView = chartPreset >= xmax ? null : { x0: xmax - chartPreset, x1: xmax };
    if (chartView) {
      chartView.x0 = Math.max(0, Math.min(chartView.x0, xmax - 2));
      chartView.x1 = Math.max(chartView.x0 + 2, Math.min(chartView.x1, xmax));
    }
    const vx0 = chartView ? chartView.x0 : 0;
    const vx1 = chartView ? chartView.x1 : xmax;
    // y-range from what's inside the window (plus each line's entry value)
    let ymin = Infinity, ymax = -Infinity;
    for (const [, pts] of (series.length ? series : all)) {
      let entry = null;
      for (const [i, e] of pts) {
        if (i <= vx0) entry = e;
        if (i >= vx0 && i <= vx1) { if (e < ymin) ymin = e; if (e > ymax) ymax = e; }
      }
      if (entry !== null) { if (entry < ymin) ymin = entry; if (entry > ymax) ymax = entry; }
    }
    if (!isFinite(ymin)) { ymin = 1400; ymax = 1600; }
    ymin = Math.floor((ymin - 25) / 50) * 50;
    ymax = Math.ceil((ymax + 25) / 50) * 50;
    const W = 940, H = 280, L = 46, R = 12, T = 10, B = 22;
    const x = (i) => L + ((i - vx0) / (vx1 - vx0)) * (W - L - R);
    const y = (e) => T + (1 - (e - ymin) / (ymax - ymin)) * (H - T - B);
    let grid = '';
    const step = ymax - ymin > 400 ? 100 : 50;
    for (let e = ymin; e <= ymax; e += step) {
      grid += `<line x1="${L}" y1="${y(e)}" x2="${W - R}" y2="${y(e)}" stroke="rgba(128,128,128,0.18)"/>`
        + `<text x="${L - 6}" y="${y(e) + 3.5}" text-anchor="end" font-size="10" style="fill:currentColor;opacity:0.55">${e}</text>`;
    }
    const lines = series.map(([k, pts]) => {
      // include the last point before the window so lines enter from the edge
      let d = '';
      let started = false;
      for (let p = 0; p < pts.length; p++) {
        const [i] = pts[p];
        const nextIn = p + 1 < pts.length && pts[p + 1][0] >= vx0;
        if (i < vx0 && !nextIn) continue;
        if (i > vx1 && started) { d += ` L${x(pts[p][0]).toFixed(1)} ${y(pts[p][1]).toFixed(1)}`; break; }
        d += `${started ? ' L' : 'M'}${x(pts[p][0]).toFixed(1)} ${y(pts[p][1]).toFixed(1)}`;
        started = true;
      }
      return `<path data-k="${esc(k)}" d="${d}" fill="none" stroke="${engColor(k)}" stroke-width="${k === 'claustrophobia' ? 2.5 : 1.8}" stroke-linejoin="round" clip-path="url(#ar-clip)" style="transition:opacity 0.15s"/>`;
    }).join('');
    box.style.position = 'relative';
    const zoomed = !!chartView;
    const presetBtn = (n, label) => {
      const on = n === null ? (!chartPreset && !chartView) : chartPreset === n;
      return `<button type="button" data-pn="${n ?? ''}" style="all:unset;cursor:pointer;padding:2px 10px;border-radius:9px;font-size:0.78em;border:1px solid var(--line-soft,rgba(128,128,128,0.3));${on ? 'background:rgba(217,130,47,0.18);border-color:var(--ember,#d9822f);' : 'opacity:0.75;'}">${label}</button>`;
    };
    box.innerHTML = `<div data-presets style="display:flex;gap:6px;margin-bottom:7px;flex-wrap:wrap;align-items:center" role="group" aria-label="chart window">
        ${presetBtn(100, 'Last 100')}${presetBtn(500, 'Last 500')}${presetBtn(1000, 'Last 1000')}${presetBtn(5000, 'Last 5000')}${presetBtn(null, 'All time')}
        <span style="flex:1"></span>
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:0.78em;cursor:pointer" title="Exponential moving average over each engine's rating">
          <input type="checkbox" data-smooth ${chartSmooth ? 'checked' : ''} style="accent-color:var(--ember,#d9822f)"> Smoothing
        </label>
        <label style="display:${chartSmooth ? 'inline-flex' : 'none'};align-items:center;gap:6px;font-size:0.78em" data-smoothrow>
          <input type="range" data-smooth-n min="2" max="120" step="1" value="${chartSmoothN}" style="width:110px;accent-color:var(--ember,#d9822f)">
          <span class="mono" data-smooth-lbl>${chartSmoothN} games</span>
        </label>
      </div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:520px;display:block;cursor:${zoomed ? 'grab' : 'crosshair'};touch-action:pan-y">
      <defs><clipPath id="ar-clip"><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></clipPath></defs>
      ${grid}${lines}
      <g data-xh style="display:none"><line y1="${T}" y2="${H - B}" stroke="rgba(128,128,128,0.5)" stroke-dasharray="3 3"/></g>
      <text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="10" style="fill:currentColor;opacity:0.55">${zoomed ? `games ${Math.round(vx0)}–${Math.round(vx1)} · scroll to zoom · drag to pan · double-click to reset` : 'games → · scroll to zoom'}</text></svg>`;
    // the hover tip lives on <body>: position:fixed inside the card is broken
    // by transformed ancestors (fixed then anchors to the ancestor, and the
    // card clips it at the bottom edge)
    document.querySelector('body > [data-chart-tip]')?.remove();
    const tipEl = document.createElement('div');
    tipEl.className = 'ar-pop';
    tipEl.setAttribute('data-chart-tip', '1');
    tipEl.style.cssText = 'min-width:150px;z-index:1000;position:fixed;display:none';
    document.body.appendChild(tipEl);
    for (const btn of box.querySelectorAll('[data-presets] button')) {
      btn.addEventListener('click', () => {
        const v = btn.dataset.pn;
        chartPreset = v ? Number(v) : null;
        if (!v) chartView = null;
        drawChart(true);
      });
    }
    box.querySelector('[data-smooth]').addEventListener('change', (e) => {
      chartSmooth = e.target.checked;
      try { localStorage.setItem('wt-arena-smooth', chartSmooth ? '1' : '0'); } catch {}
      drawChart(true);
    });
    const nSlider = box.querySelector('[data-smooth-n]');
    const nLbl = box.querySelector('[data-smooth-lbl]');
    let nDebounce = 0;
    nSlider.addEventListener('input', () => {
      chartSmoothN = Number(nSlider.value);
      if (nLbl) nLbl.textContent = `${chartSmoothN} games`;
      try { localStorage.setItem('wt-arena-smooth-n', String(chartSmoothN)); } catch {}
      // redraw after the drag settles — full rebuilds during the drag would
      // destroy the slider mid-gesture
      clearTimeout(nDebounce);
      nDebounce = setTimeout(() => drawChart(true), 160);
    });

    const svg = box.querySelector('svg');
    const tip = tipEl;
    const xh = svg.querySelector('[data-xh]');
    const xhLine = xh.querySelector('line');
    // step lookup: an engine's rating at game gi = its last change at or before gi
    const eloAt = (pts, gi) => {
      let lo = 0, hi = pts.length - 1, ans = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid][0] <= gi) { ans = pts[mid][1]; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    };
    const emphasize = (key) => {
      for (const p of svg.querySelectorAll('path[data-k]')) {
        p.style.opacity = key && p.dataset.k !== key ? '0.22' : '1';
        p.setAttribute('stroke-width', key && p.dataset.k === key ? '3' : (p.dataset.k === 'claustrophobia' ? '2.5' : '1.8'));
      }
    };
    // px → game index inside the current window
    const giOf = (clientX) => {
      const r = svg.getBoundingClientRect();
      const fx = ((clientX - r.left) / r.width) * W;
      return vx0 + ((fx - L) / (W - L - R)) * (vx1 - vx0);
    };
    svg.addEventListener('mousemove', (e) => {
      if (chartDrag) return; // panning — window handlers own the mouse
      const gi = Math.max(1, Math.min(Math.round(giOf(e.clientX)), Math.round(vx1)));
      xh.style.display = '';
      xhLine.setAttribute('x1', x(gi)); xhLine.setAttribute('x2', x(gi));
      for (const c of xh.querySelectorAll('circle')) c.remove();
      const rows = [];
      for (const [k, pts] of series) {
        const elo = eloAt(pts, gi);
        if (elo === null) continue;
        rows.push({ k, elo });
        const cy = y(elo);
        if (cy < T || cy > H - B) continue; // off-scale while zoomed
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', x(gi)); c.setAttribute('cy', cy); c.setAttribute('r', '3.5');
        c.setAttribute('fill', engColor(k)); c.setAttribute('stroke', 'rgba(0,0,0,0.4)');
        xh.appendChild(c);
      }
      rows.sort((a, b) => b.elo - a.elo);
      tip.innerHTML = `<div class="sub" style="margin-bottom:4px">game ${gi}</div>` + rows.map((rw) => `
        <div style="display:flex;align-items:center;gap:6px;justify-content:space-between">
          <span style="display:inline-flex;align-items:center;gap:5px"><span style="width:9px;height:9px;border-radius:50%;background:${engColor(rw.k)}"></span>${esc(names[rw.k] || rw.k)}</span>
          <b class="mono">${rw.elo}</b></div>`).join('');
      // fixed positioning + viewport clamping — the tip must never be clipped
      // by the card or the bottom of the screen
      tip.style.display = 'block';
      tip.style.right = '';
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let lx = e.clientX + 16;
      if (lx + tw > window.innerWidth - 8) lx = e.clientX - tw - 16;
      let ty = e.clientY - 10;
      if (ty + th > window.innerHeight - 8) ty = window.innerHeight - th - 8;
      if (ty < 8) ty = 8;
      tip.style.left = `${Math.max(8, lx)}px`;
      tip.style.top = `${ty}px`;
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; xh.style.display = 'none'; });
    // zoom: wheel around the cursor's game position
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      chartPreset = null; // manual zoom takes over from any preset
      const at = giOf(e.clientX);
      const span = vx1 - vx0;
      const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
      let ns = Math.max(8, Math.min(span * factor, xmax));
      if (ns >= xmax) { chartView = null; drawChart(true); return; }
      const frac = Math.max(0, Math.min(1, (at - vx0) / span));
      let nx0 = Math.max(0, Math.min(at - frac * ns, xmax - ns));
      chartView = { x0: nx0, x1: nx0 + ns };
      drawChart(true);
    }, { passive: false });
    // pan: drag while zoomed. The svg is REBUILT on every pan step, so the
    // drag lives on window-level handlers keyed off module state, not on
    // this svg instance.
    svg.addEventListener('mousedown', (e) => {
      if (!chartView || e.button !== 0) return;
      e.preventDefault();
      chartPreset = null; // manual pan takes over from any preset
      tip.style.display = 'none'; xh.style.display = 'none';
      chartDrag = { startX: e.clientX, x0: vx0, x1: vx1, pw: svg.getBoundingClientRect().width * ((W - L - R) / W), max: xmax };
      svg.style.cursor = 'grabbing';
      const onMove = (me) => {
        if (!chartDrag) return;
        const span = chartDrag.x1 - chartDrag.x0;
        const dx = ((chartDrag.startX - me.clientX) / chartDrag.pw) * span;
        const nx0 = Math.max(0, Math.min(chartDrag.x0 + dx, chartDrag.max - span));
        chartView = { x0: nx0, x1: nx0 + span };
        drawChart(true);
      };
      const onUp = () => {
        chartDrag = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const s = box.querySelector('svg');
        if (s) s.style.cursor = chartView ? 'grab' : 'crosshair';
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    svg.addEventListener('dblclick', () => { chartView = null; chartPreset = null; drawChart(true); });

    const leg = document.getElementById('ar-elolegend');
    if (leg) {
      leg.innerHTML = st.bots.map((b) => {
        const off = chartHidden.has(b.key);
        return `<button type="button" data-lk="${esc(b.key)}" style="all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;opacity:${off ? 0.35 : 1}" title="${off ? 'show' : 'hide'} this engine">
          <span style="width:14px;height:3px;border-radius:2px;background:${engColor(b.key)}"></span>${esc(b.name)}
          <b class="mono" style="font-size:0.9em">${b.elo}</b></button>`;
      }).join('');
      for (const btn of leg.querySelectorAll('button[data-lk]')) {
        btn.addEventListener('click', () => {
          const k = btn.dataset.lk;
          if (chartHidden.has(k)) chartHidden.delete(k); else chartHidden.add(k);
          drawChart(true);
        });
        btn.addEventListener('mouseenter', () => emphasize(btn.dataset.lk));
        btn.addEventListener('mouseleave', () => emphasize(null));
      }
    }
  };

  let lastLiveKey = '';
  let arSearchMode = false;
  const draw = () => {
    for (const b of st.bots) names[b.key] = b.name;
    document.getElementById('ar-standings').innerHTML = st.bots.length
      ? `<table class="lb-table"><thead><tr><th>#</th><th>Engine</th><th>Rating</th><th>Games</th><th>W</th><th>L</th><th>D</th></tr></thead>
         <tbody>${st.bots.map((b, i) => `<tr data-bkey="${esc(b.key)}" style="cursor:pointer" title="engine profile"><td class="mono">${i + 1}</td><td><b>${esc(b.name)}</b></td>
           <td><b>${b.elo}</b></td><td class="mono">${b.games}</td>
           <td class="mono">${b.wins}</td><td class="mono">${b.losses}</td><td class="mono">${b.draws}</td></tr>`).join('')}</tbody></table>`
      : '<p class="sub">No engines yet.</p>';
    // rebuild the grid only when the games themselves changed (new move, new
    // game); clocks alone update in place — rebuilding every pass is what
    // caused the board flicker
    const liveKey = st.live.map((g) => `${g.id}:${g.moves ? g.moves.length : 0}:${g.score0}-${g.score1}`).join('|');
    if (liveKey !== lastLiveKey) {
      lastLiveKey = liveKey;
      document.getElementById('ar-live').innerHTML = st.live.length
        ? st.live.map(liveCard).join('')
        : '<p class="sub">Games are starting up…</p>';
    }
    tickClocks();
    if (!arSearchMode) paintRecentDefault();
    drawChart();
  };
  const recentTable = (rows) => `<table class="lb-table"><thead><tr><th>Matchup</th><th>Winner</th><th>How</th><th>Moves</th><th>Ratings after</th><th></th></tr></thead>
         <tbody>${rows.map(recentRow).join('')}</tbody></table>`;
  const paintRecentDefault = () => {
    document.getElementById('ar-recent').innerHTML = st.recent.length
      ? recentTable(st.recent.slice(0, 20))
      : '<p class="sub">No finished games yet.</p>';
  };

  main.innerHTML = `
    <div class="lb-wrap" style="position:relative">
      <div class="section-title"><h1>Bot Arena</h1>
        <span class="sub">engines play each other nonstop · 3 min + 2 s clocks · every opening played from both sides</span></div>
      <div class="card"><h3>Standings</h3>
        <p class="sub">Ratings move after every game (<span class="mono" id="ar-total">${st.total}</span> played so far).</p>
        <div id="ar-standings"></div></div>
      <div class="card" style="margin-top:18px"><h3>Rating history</h3>
        <p class="sub">Elo after every finished game.</p>
        <div id="ar-elochart" style="overflow-x:auto"></div>
        <div id="ar-elolegend" class="sub" style="display:flex;flex-wrap:wrap;gap:14px;margin-top:6px"></div></div>
      <h3 style="margin:18px 0 8px">Live boards</h3>
      <div id="ar-live" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:12px"></div>
      <div class="card" style="margin-top:18px"><h3>Recent games</h3>
        <div id="ar-search"></div>
        <div id="ar-recent"></div>
        <button class="btn" id="ar-more" style="margin-top:10px;display:none">Load more</button></div>
      <div class="card" style="margin-top:18px"><h3>Opening stats</h3>
        <p class="sub" style="margin:0 0 8px">Every opening is played from both sides. Score = wins plus half of draws; specialists need at least 4 games on that opening.</p>
        <details id="ar-open-wrap">
          <summary class="btn" style="display:inline-block;cursor:pointer;list-style:none;user-select:none" id="ar-open-toggle">Show opening stats</summary>
          <div id="ar-openings" style="margin-top:10px"><p class="sub">Loading…</p></div>
        </details></div>
    </div>`;
  draw();

  // openings card — separate cached endpoint, loaded once per visit;
  // collapsed by default (the table is tall), summary shows the count
  const openWrap = document.getElementById('ar-open-wrap');
  const openToggle = document.getElementById('ar-open-toggle');
  let openCount = 0;
  const openLabel = () => {
    openToggle.textContent = `${openWrap.open ? 'Hide' : 'Show'} opening stats${openCount ? ` (${openCount} openings)` : ''}`;
  };
  openWrap.addEventListener('toggle', openLabel);
  (async () => {
    try {
      const od = await api('/api/arena/openings', { quiet: true });
      const box = document.getElementById('ar-openings');
      if (!box || stale()) return;
      const rows = od.openings.filter((o) => o.games >= 4).slice(0, 24);
      openCount = rows.length;
      openLabel();
      box.innerHTML = rows.length
        ? `<div style="overflow-x:auto"><table class="lb-table" style="width:100%"><thead>
            <tr><th>Opening</th><th>Games</th><th>Red wins</th><th>Blue wins</th><th>Draws</th><th>Best at it</th></tr></thead>
           <tbody>${rows.map((o) => `
            <tr><td class="mono" style="font-size:0.85em"><a href="/analysis?m=${encodeURIComponent(o.opening.split(' ').join('.'))}" title="open this opening on the analysis board">${esc(o.opening)}</a></td>
              <td class="mono">${o.games}</td>
              <td class="mono" style="color:var(--red,#e4553a)">${Math.round((o.p0w / o.games) * 100)}%</td>
              <td class="mono" style="color:var(--blue,#3e7bd6)">${Math.round((o.p1w / o.games) * 100)}%</td>
              <td class="mono">${Math.round((o.d / o.games) * 100)}%</td>
              <td>${o.best.filter((b) => b.games >= 4).slice(0, 2).map((b) =>
                `<a href="/arena/engine/${esc(b.key)}">${esc(od.names[b.key] || b.key)}</a> <span class="mono sub-inline">${b.pct}% in ${b.games}</span>`).join(' · ') || '<span class="sub-inline">too few games</span>'}</td>
            </tr>`).join('')}</tbody></table></div>`
        : '<p class="sub">Not enough finished games yet.</p>';
    } catch { /* card is optional */ }
  })();

  // recent-list "review" actions (list is re-rendered per poll — delegate)
  document.getElementById('ar-recent').addEventListener('click', (e) => {
    const a = e.target.closest('[data-arreview]');
    if (!a) return;
    e.preventDefault();
    openArenaReview(a.dataset.arreview, a);
  });

  // game search: while active, the poll stops overwriting the table
  document.getElementById('ar-search').innerHTML = arenaSearchBarHTML(names);
  const moreBtn = document.getElementById('ar-more');
  const searchCtl = wireArenaSearch(main, {
    pageSize: 25,
    renderRows: (d, append) => {
      const box = document.getElementById('ar-recent');
      if (!d.games.length && !append) { box.innerHTML = '<p class="sub">No games match.</p>'; return; }
      if (append) box.querySelector('tbody')?.insertAdjacentHTML('beforeend', d.games.map(recentRow).join(''));
      else box.innerHTML = recentTable(d.games);
    },
    onSearchState: (active, hasMore) => {
      arSearchMode = active;
      moreBtn.style.display = active && hasMore ? '' : 'none';
    },
    onClear: () => {
      arSearchMode = false;
      moreBtn.style.display = 'none';
      paintRecentDefault();
    },
  });
  moreBtn.addEventListener('click', async () => {
    moreBtn.disabled = true;
    try { const r = await searchCtl.loadMore(); moreBtn.style.display = r.hasMore ? '' : 'none'; } catch {}
    moreBtn.disabled = false;
  });

  // hover an engine row -> its personal record vs every other engine
  const pop = document.createElement('div');
  pop.className = 'ar-pop'; // solid themed surface — styles.css
  main.querySelector('.lb-wrap').appendChild(pop);
  const standingsBox = document.getElementById('ar-standings');
  standingsBox.addEventListener('mouseover', (e) => {
    const tr = e.target.closest('tr[data-bkey]');
    if (!tr) return;
    const key = tr.dataset.bkey;
    const rows = [];
    for (const [pk, m] of Object.entries(st.h2h || {})) {
      const [a, b] = pk.split('|');
      if (a !== key && b !== key) continue;
      const opp = a === key ? b : a;
      const r = m[key] || { w: 0, l: 0, d: 0 };
      rows.push({ opp: names[opp] || opp, ...r, pts: r.w + r.d / 2, games: m.games });
    }
    rows.sort((x, y) => y.pts / Math.max(1, y.games) - x.pts / Math.max(1, x.games));
    const eloCell = h2hEloCell;
    // this engine's latest finished games, newest first, from the recent feed
    const recent = (st.recent || []).filter((g) => g.p0 === key || g.p1 === key).slice(0, 8).map((g) => {
      const opp = g.p0 === key ? g.p1 : g.p0;
      const res = g.winner === null || g.winner === undefined ? 'D'
        : (g.winner === 0 ? g.p0 : g.p1) === key ? 'W' : 'L';
      return { opp: names[opp] || opp, res, reason: g.reason || '' };
    });
    const resColor = { W: '#4caf7d', L: 'var(--red,#e4553a)', D: 'rgba(128,128,128,0.9)' };
    pop.innerHTML = `<b>${esc(names[key] || key)}</b>
      <div style="display:flex;gap:18px;align-items:flex-start">
        <div style="min-width:280px"><div class="sub-inline">vs the field</div>${rows.length
          ? `<table class="lb-table" style="width:100%"><thead><tr><th>Opponent</th><th>W-L-D</th><th>Points</th><th title="rating edge implied by each head-to-head record alone">Elo edge</th></tr></thead>
             <tbody>${rows.map((r) => `
              <tr><td>${esc(r.opp)}</td>
              <td class="mono">${r.w}-${r.l}-${r.d}</td>
              <td class="mono"><b>${half(r.pts)}</b><span class="sub-inline">/${r.games}</span></td>
              ${eloCell(r)}</tr>`).join('')}</tbody></table>`
          : '<p class="sub" style="margin:6px 0 0">no finished games yet</p>'}</div>
        <div style="min-width:170px"><div class="sub-inline">recent games</div>${recent.length
          ? `<table class="lb-table" style="width:100%"><tbody>${recent.map((r) => `
              <tr><td class="mono" style="color:${resColor[r.res]};font-weight:700;width:16px">${r.res}</td>
              <td>${esc(r.opp)}</td>
              <td class="sub-inline">${esc(r.reason)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="sub" style="margin:6px 0 0">none in the recent list</p>'}</div>
      </div>`;
    const rect = tr.getBoundingClientRect();
    const wrapRect = pop.parentElement.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(rect.left - wrapRect.left + 60, wrapRect.width - 510))}px`;
    pop.style.top = `${rect.bottom - wrapRect.top + 6}px`;
    pop.style.display = 'block';
  });
  standingsBox.addEventListener('mouseleave', () => { pop.style.display = 'none'; });
  standingsBox.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-bkey]');
    if (tr) nav(`/arena/engine/${tr.dataset.bkey}`);
  });

  let pollSeq = 0;
  const poll = setInterval(async () => {
    if (document.hidden) return;
    const mySeq = ++pollSeq;
    try {
      const next = await api('/api/arena/state');
      if (stale() || mySeq !== pollSeq) return; // an overtaken response must never repaint
      st = next;
      if (typeof st.now === 'number') skew = st.now - Date.now();
      const totalEl = document.getElementById('ar-total');
      if (!totalEl) return; // page swapped out from under us
      totalEl.textContent = st.total;
      draw();
    } catch { /* transient — keep the last good state on screen */ }
  }, 2000);
  const tick = setInterval(() => {
    if (document.hidden || stale()) return;
    tickClocks();
  }, 500);
  cleanup = () => { clearInterval(poll); clearInterval(tick); document.querySelector('body > [data-chart-tip]')?.remove(); };
}

/** One arena board, full size — live eval bar + per-engine eval graph, CCC-style. */
async function renderArenaGame(id, stale = () => false) {
  const main = shell('', 'arena', false);
  main.innerHTML = skeleton('page');
  let g, names, pair = { score0: 0, score1: 0, games: 0 }, skew = 0;
  const load = async () => {
    const r = await api(`/api/arena/game/${id}`);
    g = r.game; names = r.names;
    if (r.pair) pair = r.pair;
    if (typeof r.now === 'number') skew = r.now - Date.now();
  };
  try { await load(); } catch (e) { main.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (stale()) return;

  const nameOf = (k) => names[k]?.name || k;
  const fmtClk = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const half = (n) => {
    const i = Math.floor(n);
    const h = n - i >= 0.5 ? '½' : '';
    return i === 0 && h ? h : `${i}${h}`;
  };
  const movesArr = () => (g.moves ? g.moves.split(' ') : []);
  const evalsArr = () => { try { return JSON.parse(g.evals || '[]'); } catch { return []; } };
  // replay cursor: number of plies shown. null = follow the live head.
  let viewPly = null;
  const cutAt = () => (viewPly == null ? movesArr().length : Math.max(0, Math.min(viewPly, movesArr().length)));
  // an engine's view AT the cursor: last non-null eval at that engine's plies
  // before the cut (all stored p0-POV)
  const lastEvalOf = (parity, cut = cutAt()) => {
    const e = evalsArr();
    for (let i = Math.min(cut, e.length) - 1; i >= 0; i--) if (i % 2 === parity && e[i] != null) return e[i];
    return null;
  };
  const analysisHref = () => `/analysis?m=${encodeURIComponent(movesArr().join('.'))}`;

  main.innerHTML = `
    <div class="lb-wrap">
      <div class="section-title">
        <h1 style="font-size:1.25em">
          <span style="color:var(--red,#e4553a)">${esc(nameOf(g.p0))}</span>
          <span class="mono" id="ag-h2h" style="font-size:0.85em;opacity:0.85"></span>
          <span style="color:var(--blue,#3e7bd6)">${esc(nameOf(g.p1))}</span></h1>
        <span class="sub"><a href="/arena">back to the arena</a></span>
      </div>
      <div id="ag-banner"></div>
      <div style="display:flex;gap:14px;align-items:stretch;flex-wrap:wrap">
        <div style="display:flex;gap:6px;align-self:stretch">
          <div title="${esc(nameOf(g.p0))}'s evaluation" style="width:22px;background:var(--blue,#3e7bd6);border-radius:6px;position:relative;overflow:hidden;min-height:320px">
            <div style="position:absolute;top:4px;width:100%;text-align:center;z-index:2"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--red,#e4553a);border:1.5px solid #fff"></span></div>
            <div id="ag-fill0" style="position:absolute;left:0;bottom:0;width:100%;height:50%;background:var(--red,#e4553a);transition:height 0.6s"></div>
            <div style="position:absolute;left:0;top:50%;width:100%;height:1px;background:rgba(255,255,255,0.45)"></div>
            <div id="ag-txt0" class="mono" style="position:absolute;left:0;bottom:4px;width:100%;text-align:center;font-size:9px;color:#fff;text-shadow:0 1px 2px #000"></div>
          </div>
          <div title="${esc(nameOf(g.p1))}'s evaluation" style="width:22px;background:var(--blue,#3e7bd6);border-radius:6px;position:relative;overflow:hidden;min-height:320px">
            <div style="position:absolute;top:4px;width:100%;text-align:center;z-index:2"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--blue,#3e7bd6);border:1.5px solid #fff"></span></div>
            <div id="ag-fill1" style="position:absolute;left:0;bottom:0;width:100%;height:50%;background:var(--red,#e4553a);transition:height 0.6s"></div>
            <div style="position:absolute;left:0;top:50%;width:100%;height:1px;background:rgba(255,255,255,0.45)"></div>
            <div id="ag-txt1" class="mono" style="position:absolute;left:0;bottom:4px;width:100%;text-align:center;font-size:9px;color:#fff;text-shadow:0 1px 2px #000"></div>
          </div>
        </div>
        <div style="flex:1;min-width:280px;max-width:560px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
            <b style="color:var(--blue,#3e7bd6)">${esc(nameOf(g.p1))}</b>
            <span style="display:flex;align-items:center;gap:10px"><span id="ag-walls1" title="walls left"></span><span class="mono" id="ag-clk1"></span></span>
          </div>
          <div class="sub mono" id="ag-stat1" style="text-align:right;font-size:0.75em;min-height:1.2em;margin-bottom:4px"></div>
          <div id="ag-board"></div>
          <div id="ag-replay" style="display:none;justify-content:center;align-items:center;gap:6px;margin-top:6px">
            <button type="button" data-seek="start" title="start" style="all:unset;cursor:pointer;padding:2px 10px;border:1px solid var(--line-soft,rgba(128,128,128,0.3));border-radius:8px">«</button>
            <button type="button" data-seek="-1" title="previous move" style="all:unset;cursor:pointer;padding:2px 12px;border:1px solid var(--line-soft,rgba(128,128,128,0.3));border-radius:8px">‹</button>
            <span class="mono" id="ag-ply" style="min-width:86px;text-align:center;font-size:0.85em"></span>
            <button type="button" data-seek="1" title="next move" style="all:unset;cursor:pointer;padding:2px 12px;border:1px solid var(--line-soft,rgba(128,128,128,0.3));border-radius:8px">›</button>
            <button type="button" data-seek="end" title="end" style="all:unset;cursor:pointer;padding:2px 10px;border:1px solid var(--line-soft,rgba(128,128,128,0.3));border-radius:8px">»</button>
          </div>
          <div class="sub mono" id="ag-stat0" style="text-align:right;font-size:0.75em;min-height:1.2em;margin-top:4px"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
            <b style="color:var(--red,#e4553a)">${esc(nameOf(g.p0))}</b>
            <span style="display:flex;align-items:center;gap:10px"><span id="ag-walls0" title="walls left"></span><span class="mono" id="ag-clk0"></span></span>
          </div>
        </div>
        <div style="flex:1;min-width:260px;display:flex;flex-direction:column;gap:12px">
          <div class="card"><h3>Evaluation</h3>
            <p class="sub" style="margin:0 0 6px">Each engine's own view after its moves — chance the first player wins.</p>
            <div id="ag-graph" style="overflow-x:auto"></div>
            <div class="sub" style="display:flex;gap:14px;margin-top:4px">
              <span><span style="display:inline-block;width:10px;height:3px;background:var(--red,#e4553a);vertical-align:middle"></span> ${esc(nameOf(g.p0))}</span>
              <span><span style="display:inline-block;width:10px;height:3px;background:var(--blue,#3e7bd6);vertical-align:middle"></span> ${esc(nameOf(g.p1))}</span>
            </div></div>
          <div class="card"><h3>Game</h3>
            <p class="sub" id="ag-meta" style="margin:0 0 8px"></p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn" id="ag-review" style="display:none" title="Grade every move with the site engine">Game review</button>
              <a class="btn" id="ag-analyze" href="${analysisHref()}">Open in analysis</a>
            </div></div>
        </div>
      </div>
    </div>`;

  const board = new Board(document.getElementById('ag-board'), { orient: 'red' });

  const GW = 460, GH = 170, GP = 10;
  const gN = () => Math.max(evalsArr().length, movesArr().length, 24);
  const gx = (i) => GP + (i / Math.max(1, gN() - 1)) * (GW - 2 * GP);
  const graphSVG = () => {
    const evals = evalsArr();
    const y = (p) => GP + (1 - p) * (GH - 2 * GP);
    const line = (parity, color) => {
      let d = '', pen = false;
      for (let i = 0; i < evals.length; i++) {
        if (i % 2 !== parity || evals[i] == null) { continue; }
        d += `${pen ? ' L' : 'M'}${gx(i).toFixed(1)} ${y(evals[i]).toFixed(1)}`;
        pen = true;
      }
      return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>` : '';
    };
    const cut = cutAt();
    const cursor = g.status !== 'ongoing' && cut > 0
      ? `<line x1="${gx(cut - 1).toFixed(1)}" y1="${GP}" x2="${gx(cut - 1).toFixed(1)}" y2="${GH - GP}" stroke="rgba(255,255,255,0.5)" stroke-dasharray="3 3"/>` : '';
    return `<svg viewBox="0 0 ${GW} ${GH}" style="width:100%;display:block${g.status !== 'ongoing' ? ';cursor:pointer' : ''}" ${g.status !== 'ongoing' ? 'title="click to jump to a move"' : ''}>
      <rect width="${GW}" height="${GH}" rx="6" fill="var(--card-2,#22262e)"/>
      <line x1="${GP}" y1="${GH / 2}" x2="${GW - GP}" y2="${GH / 2}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="3 4"/>
      ${line(0, 'var(--red,#e4553a)')}${line(1, 'var(--blue,#3e7bd6)')}${cursor}
    </svg>`;
  };

  const paintClocks = () => {
    const toMove = movesArr().length % 2;
    for (const side of [0, 1]) {
      const el = document.getElementById(`ag-clk${side}`);
      if (!el) return;
      let ms = g[`clock${side}`];
      if (g.status === 'ongoing' && side === toMove && g.moved_at) {
        ms -= Math.max(0, Date.now() + skew - g.moved_at);
      }
      el.textContent = fmtClk(ms);
      el.style.color = ms < 30_000 && g.status === 'ongoing' ? 'var(--red,#e4553a)' : '';
    }
  };
  const paint = () => {
    const cut = cutAt();
    const moves = movesArr().slice(0, cut);
    let st;
    try { st = replayMoves(moves); } catch { return; }
    board.setState(st);
    board.setHints({ legal: [], lastMove: moves[moves.length - 1] || null, bestMove: null, badge: null, interactive: false });
    const wg = '<svg width="7" height="12" viewBox="0 0 7 12" style="vertical-align:-2px;margin-right:3px"><rect x="2" width="3" height="12" rx="1.5" fill="#d9822f"/></svg>';
    const fmtK = (n) => (n >= 100_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);
    let gstats = [];
    try { gstats = JSON.parse(g.stats || '[]'); } catch {}
    for (const side of [0, 1]) {
      const el = document.getElementById(`ag-walls${side}`);
      if (el) el.innerHTML = `${wg}<span class="mono">${st.wallsLeft[side]}</span>`;
      const sEl = document.getElementById(`ag-stat${side}`);
      if (sEl) {
        let txt = '';
        for (let i = Math.min(cut, gstats.length) - 1; i >= 0; i--) {
          if (i % 2 !== side || !gstats[i] || gstats[i].n == null) continue;
          const s = gstats[i];
          const nps = s.ms > 0 ? s.n / (s.ms / 1000) : null;
          txt = `${fmtK(s.n)} nodes${nps ? ` · ${fmtK(nps)} n/s` : ''}${s.ms != null ? ` · ${(s.ms / 1000).toFixed(1)}s` : ''}`;
          break;
        }
        sEl.textContent = txt;
      }
    }
    paintClocks();
    for (const side of [0, 1]) {
      const p = lastEvalOf(side, cut);
      const fill = document.getElementById(`ag-fill${side}`);
      const txt = document.getElementById(`ag-txt${side}`);
      if (!fill || !txt) break;
      fill.style.height = `${((p ?? 0.5) * 100).toFixed(1)}%`;
      fill.parentElement.style.opacity = p == null ? '0.45' : '1'; // engine gives no evals yet
      txt.textContent = p == null ? '—' : `${Math.round(p * 100)}%`;
    }
    document.getElementById('ag-graph').innerHTML = graphSVG();
    const total = movesArr().length;
    document.getElementById('ag-meta').textContent =
      `${total} moves · 3 min + 2 s` + (g.status === 'ongoing' ? ' · live' : '')
      + (pair.games ? ` · head-to-head ${half(pair.score0)}–${half(pair.score1)} over ${pair.games} game${pair.games === 1 ? '' : 's'}` : '');
    // replay chrome (finished games only)
    const bar = document.getElementById('ag-replay');
    if (bar && g.status !== 'ongoing') {
      bar.style.display = 'flex';
      const ply = document.getElementById('ag-ply');
      if (ply) ply.textContent = `move ${cut} / ${total}`;
    }
    const rev = document.getElementById('ag-review');
    if (rev && g.status === 'done') rev.style.display = '';
    const h2h = document.getElementById('ag-h2h');
    if (h2h) h2h.textContent = pair.games ? `${half(pair.score0)}–${half(pair.score1)}` : 'vs';
    document.getElementById('ag-analyze').setAttribute('href', analysisHref());
    const banner = document.getElementById('ag-banner');
    if (g.status === 'done') {
      const w = g.winner === null || g.winner === undefined
        ? 'Drawn' : `<b>${esc(nameOf(g.winner === 0 ? g.p0 : g.p1))}</b> won`;
      banner.innerHTML = `<div class="card" style="padding:8px 14px;margin-bottom:10px">${w} — ${esc(g.reason || '')}${g.elo0_after ? ` · ratings after: ${g.elo0_after} / ${g.elo1_after}` : ''}</div>`;
    } else if (g.status === 'void') {
      banner.innerHTML = `<div class="card" style="padding:8px 14px;margin-bottom:10px">Game voided — ${esc(g.reason || 'restart')}</div>`;
    } else banner.innerHTML = '';
  };
  paint();

  // replay controls: buttons, click-to-seek on the graph, arrow keys
  const seek = (to) => {
    if (g.status === 'ongoing') return;
    const total = movesArr().length;
    const cur = cutAt();
    let next = to === 'start' ? 0 : to === 'end' ? total : cur + Number(to);
    next = Math.max(0, Math.min(next, total));
    viewPly = next >= total ? null : next;
    paint();
  };
  const replayBar = document.getElementById('ag-replay');
  if (replayBar) {
    replayBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-seek]');
      if (b) seek(b.dataset.seek);
    });
  }
  document.getElementById('ag-graph').addEventListener('click', (e) => {
    if (g.status === 'ongoing') return;
    const svgEl = e.currentTarget.querySelector('svg');
    if (!svgEl) return;
    const r = svgEl.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * GW;
    const i = Math.round(((fx - GP) / (GW - 2 * GP)) * (gN() - 1)) + 1;
    viewPly = Math.max(0, Math.min(i, movesArr().length));
    if (viewPly >= movesArr().length) viewPly = null;
    paint();
  });
  const onKey = (e) => {
    if (g.status === 'ongoing') return;
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') { seek(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { seek(1); e.preventDefault(); }
    else if (e.key === 'Home') { seek('start'); e.preventDefault(); }
    else if (e.key === 'End') { seek('end'); e.preventDefault(); }
  };
  window.addEventListener('keydown', onKey);

  const reviewBtn = document.getElementById('ag-review');
  if (reviewBtn) {
    reviewBtn.addEventListener('click', async () => {
      if (!ME) { toast('Sign in (with a verified email) to review games.'); return; }
      reviewBtn.disabled = true;
      try {
        const r = await api(`/api/arena/game/${id}/review`, { body: {} });
        nav(`/review/${r.gameId}`);
      } catch (e) {
        if (!String(e.message).includes('verify')) toast(e.message);
        reviewBtn.disabled = false;
      }
    });
  }

  let lastPaintKey = `${g.moves}|${g.status}`;
  let pollSeq = 0;
  const poll = setInterval(async () => {
    if (document.hidden || g.status !== 'ongoing') return;
    const mySeq = ++pollSeq;
    try {
      await load();
      if (stale() || mySeq !== pollSeq) return;
      const key = `${g.moves}|${g.status}`;
      if (key !== lastPaintKey) { lastPaintKey = key; paint(); } // full repaint only on change
      else paintClocks();
    } catch {}
  }, 2000);
  const tick = setInterval(() => { if (!document.hidden && !stale() && g.status === 'ongoing') paintClocks(); }, 500);
  cleanup = () => { clearInterval(poll); clearInterval(tick); window.removeEventListener('keydown', onKey); };
}

/** Engine profile: rating history + full game history with replay/review/analysis. */
async function renderArenaEngine(key, stale = () => false) {
  const main = shell('', 'arena', false);
  main.innerHTML = skeleton('page');
  let d;
  try { d = await api(`/api/arena/engine/${encodeURIComponent(key)}`); }
  catch (e) { main.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (stale()) return;
  const { bot, rank, ranked, names, h2h } = d;
  let games = d.games;
  let hasMore = d.hasMore;
  const half = (n) => {
    const i = Math.floor(n);
    const h = n - i >= 0.5 ? '½' : '';
    return i === 0 && h ? h : `${i}${h}`;
  };
  h2h.sort((a, b) => (b.w + b.d / 2) / Math.max(1, b.games) - (a.w + a.d / 2) / Math.max(1, a.games));
  const resColor = { W: '#4caf7d', L: 'var(--red,#e4553a)', D: 'rgba(128,128,128,0.9)' };

  main.innerHTML = `
    <div class="lb-wrap">
      <div class="section-title">
        <h1 style="font-size:1.3em">${esc(bot.name)}</h1>
        <span class="sub"><a href="/arena">back to the arena</a></span>
      </div>
      <div class="card" style="display:flex;gap:26px;flex-wrap:wrap;align-items:baseline">
        <span><span class="sub">Rating</span> <b class="mono" style="font-size:1.3em">${bot.elo}</b></span>
        <span><span class="sub">Rank</span> <b class="mono">${rank ? `${rank} / ${ranked}` : 'retired'}</b></span>
        <span><span class="sub">Record</span> <b class="mono">${bot.wins}-${bot.losses}-${bot.draws}</b> <span class="sub-inline">in ${bot.games} games</span></span>
      </div>
      <div class="card" style="margin-top:14px"><h3>Rating history</h3><div id="ae-chart"></div></div>
      <div class="card" style="margin-top:14px"><h3>Openings</h3>
        <p class="sub" style="margin:0 0 8px">This engine's score per opening (wins plus half of draws), best first. Openings with at least 4 games.</p>
        ${(() => {
    const rows = (d.openings || []).filter((o) => o.games >= 4);
    if (!rows.length) return '<p class="sub">Not enough games per opening yet.</p>';
    return `<details data-open-details>
        <summary class="btn" style="display:inline-block;cursor:pointer;list-style:none;user-select:none">Show openings (${rows.length})</summary>
        <div style="overflow-x:auto;margin-top:10px"><table class="lb-table" style="width:100%"><thead><tr><th>Opening</th><th>Games</th><th>W-L-D</th><th>Score</th></tr></thead>
        <tbody>${rows.map((o) => `
          <tr><td class="mono" style="font-size:0.85em"><a href="/analysis?m=${encodeURIComponent(o.opening.split(' ').join('.'))}">${esc(o.opening)}</a></td>
            <td class="mono">${o.games}</td>
            <td class="mono">${o.w}-${o.l}-${o.d}</td>
            <td class="mono"><b style="color:${o.pct >= 55 ? '#4caf7d' : o.pct <= 45 ? 'var(--red,#e4553a)' : 'inherit'}">${o.pct}%</b></td></tr>`).join('')}</tbody></table></div>
      </details>`;
  })()}
      </div>
      <div style="display:flex;gap:14px;margin-top:14px;flex-wrap:wrap;align-items:flex-start">
        <div class="card" style="flex:1;min-width:320px"><h3>Versus the field</h3><div id="ae-h2h">${h2h.length
          ? `<table class="lb-table" style="width:100%"><thead><tr><th>Opponent</th><th>W-L-D</th><th>Points</th><th title="rating edge implied by each head-to-head record alone">Elo edge</th></tr></thead>
             <tbody>${h2h.map((r) => `
              <tr><td><a href="/arena/engine/${esc(r.opp)}">${esc(names[r.opp] || r.opp)}</a></td>
              <td class="mono">${r.w}-${r.l}-${r.d}</td>
              <td class="mono"><b>${half(r.w + r.d / 2)}</b><span class="sub-inline">/${r.games}</span></td>
              ${h2hEloCell(r)}</tr>`).join('')}</tbody></table>`
          : '<p class="sub">No finished games yet.</p>'}</div></div>
        <div class="card" style="flex:2;min-width:340px"><h3>Game history</h3>
          <div id="ae-search">${arenaSearchBarHTML(names, { fixed: key })}</div>
          <div id="ae-games"></div>
          <button class="btn" id="ae-more" style="margin-top:10px;display:none">Load more</button>
        </div>
      </div>
    </div>`;

  const od = main.querySelector('[data-open-details]');
  if (od) {
    const sum = od.querySelector('summary');
    const base = sum.textContent.replace(/^Show /, '');
    od.addEventListener('toggle', () => { sum.textContent = `${od.open ? 'Hide' : 'Show'} ${base}`; });
  }

  // ---- rating chart: this engine's Elo after each of its games ----
  const chartBox = document.getElementById('ae-chart');
  let chartWin = null; // null = all, else last N points
  // hover tooltip on <body> (fixed inside the card gets clipped/re-anchored)
  document.querySelector('body > [data-ae-tip]')?.remove();
  const aeTip = document.createElement('div');
  aeTip.className = 'ar-pop';
  aeTip.setAttribute('data-ae-tip', '1');
  aeTip.style.cssText = 'min-width:210px;z-index:1000;position:fixed;display:none;pointer-events:none';
  document.body.appendChild(aeTip);
  const oldCleanup = cleanup;
  cleanup = () => { document.querySelector('body > [data-ae-tip]')?.remove(); if (oldCleanup) oldCleanup(); };
  // cumulative vs-the-field record up to global game index gi. The timeline
  // is ordered, so keep a running cursor — scrubbing is incremental instead
  // of a rescan per mousemove (rewinds rebuild from zero, still cheap).
  const timeline = d.timeline || [];
  let tlPos = 0;
  const tlRec = {};
  const standingsAt = (gi) => {
    if (timeline[tlPos - 1] && timeline[tlPos - 1][0] > gi) {
      for (const k2 of Object.keys(tlRec)) delete tlRec[k2];
      tlPos = 0;
    }
    while (tlPos < timeline.length && timeline[tlPos][0] <= gi) {
      const [, opp, r] = timeline[tlPos++];
      (tlRec[opp] ??= { w: 0, l: 0, d: 0 })[r]++;
    }
    return tlRec;
  };
  const drawEngineChart = () => {
    const pts = d.history;
    if (!pts.length) { chartBox.innerHTML = '<p class="sub">No rated games yet.</p>'; return; }
    const view = chartWin && chartWin < pts.length ? pts.slice(-chartWin) : pts;
    let ymin = Infinity, ymax = -Infinity;
    for (const [, e] of view) { if (e < ymin) ymin = e; if (e > ymax) ymax = e; }
    ymin = Math.floor((ymin - 25) / 50) * 50;
    ymax = Math.ceil((ymax + 25) / 50) * 50;
    const W = 940, H = 240, L = 46, R = 12, T = 10, B = 20;
    const x = (i) => L + (i / Math.max(1, view.length - 1)) * (W - L - R);
    const y = (e) => T + (1 - (e - ymin) / (ymax - ymin)) * (H - T - B);
    let grid = '';
    const step = ymax - ymin > 400 ? 100 : 50;
    for (let e = ymin; e <= ymax; e += step) {
      grid += `<line x1="${L}" y1="${y(e)}" x2="${W - R}" y2="${y(e)}" stroke="rgba(128,128,128,0.18)"/>`
        + `<text x="${L - 6}" y="${y(e) + 3.5}" text-anchor="end" font-size="10" style="fill:currentColor;opacity:0.55">${e}</text>`;
    }
    let path = '';
    for (let i = 0; i < view.length; i++) path += `${i ? ' L' : 'M'}${x(i).toFixed(1)} ${y(view[i][1]).toFixed(1)}`;
    const winBtn = (n, label) => `<button type="button" data-w="${n ?? ''}" style="all:unset;cursor:pointer;padding:2px 10px;border-radius:9px;font-size:0.78em;border:1px solid var(--line-soft,rgba(128,128,128,0.3));${(n === null ? !chartWin : chartWin === n) ? 'background:rgba(217,130,47,0.18);border-color:var(--ember,#d9822f);' : 'opacity:0.75;'}">${label}</button>`;
    chartBox.innerHTML = `
      <div style="display:flex;gap:6px;margin-bottom:7px;flex-wrap:wrap">${winBtn(100, 'Last 100')}${winBtn(500, 'Last 500')}${winBtn(1000, 'Last 1000')}${winBtn(null, 'All')}</div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:480px;display:block">${grid}
        <path d="${path}" fill="none" stroke="var(--ember,#d9822f)" stroke-width="2" stroke-linejoin="round"/>
        <g data-aexh style="display:none"><line y1="${T}" y2="${H - B}" stroke="rgba(128,128,128,0.5)" stroke-dasharray="3 3"/>
          <circle r="3.5" fill="var(--ember,#d9822f)" stroke="rgba(0,0,0,0.4)"/></g>
      </svg>
      <div class="sub mono" data-aelbl style="min-height:1.3em;text-align:right"></div>`;
    for (const btn of chartBox.querySelectorAll('button[data-w]')) {
      btn.addEventListener('click', () => { chartWin = btn.dataset.w ? Number(btn.dataset.w) : null; drawEngineChart(); });
    }
    const svg = chartBox.querySelector('svg');
    const xh = svg.querySelector('[data-aexh]');
    const lbl = chartBox.querySelector('[data-aelbl]');
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(view.length - 1, Math.round(((((e.clientX - r.left) / r.width) * W) - L) / (W - L - R) * (view.length - 1))));
      xh.style.display = '';
      xh.querySelector('line').setAttribute('x1', x(i));
      xh.querySelector('line').setAttribute('x2', x(i));
      const c = xh.querySelector('circle');
      c.setAttribute('cx', x(i)); c.setAttribute('cy', y(view[i][1]));
      lbl.textContent = `game ${view[i][0]} · rating ${view[i][1]}`;
      // vs-the-field table AS OF this point on the chart
      const rec = standingsAt(view[i][0]);
      const rows2 = Object.entries(rec)
        .map(([opp, rr]) => ({ opp, ...rr, n: rr.w + rr.l + rr.d, pts: rr.w + rr.d / 2 }))
        .sort((a2, b2) => b2.pts / Math.max(1, b2.n) - a2.pts / Math.max(1, a2.n));
      aeTip.innerHTML = `<div class="sub" style="margin-bottom:4px">after game ${view[i][0]} · rating <b class="mono">${view[i][1]}</b></div>`
        + (rows2.length
          ? `<table class="lb-table" style="width:100%"><thead><tr><th>Opponent</th><th>W-L-D</th><th>Points</th><th title="rating edge implied by this head-to-head record alone">Elo edge</th></tr></thead>
             <tbody>${rows2.map((rw) => `
              <tr><td>${esc(names[rw.opp] || rw.opp)}</td>
              <td class="mono">${rw.w}-${rw.l}-${rw.d}</td>
              <td class="mono"><b>${half(rw.pts)}</b><span class="sub-inline">/${rw.n}</span></td>
              ${h2hEloCell(rw)}</tr>`).join('')}</tbody></table>`
          : '<p class="sub" style="margin:4px 0 0">no games yet at this point</p>');
      aeTip.style.display = 'block';
      const tw = aeTip.offsetWidth, th = aeTip.offsetHeight;
      let lx = e.clientX + 18;
      if (lx + tw > window.innerWidth - 8) lx = e.clientX - tw - 18;
      let ty = e.clientY - 12;
      if (ty + th > window.innerHeight - 8) ty = window.innerHeight - th - 8;
      if (ty < 8) ty = 8;
      aeTip.style.left = `${Math.max(8, lx)}px`;
      aeTip.style.top = `${ty}px`;
    });
    svg.addEventListener('mouseleave', () => { xh.style.display = 'none'; lbl.textContent = ''; aeTip.style.display = 'none'; });
  };
  drawEngineChart();

  // ---- game history table ----
  const gameRow = (g) => {
    const mySide = g.p0 === key ? 0 : 1;
    const opp = mySide === 0 ? g.p1 : g.p0;
    const res = g.winner === null || g.winner === undefined ? 'D' : g.winner === mySide ? 'W' : 'L';
    const eloAfter = mySide === 0 ? g.elo0_after : g.elo1_after;
    const plies = g.moves ? g.moves.split(' ').length : 0;
    return `<tr>
      <td class="mono" style="color:${resColor[res]};font-weight:700">${res}</td>
      <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${mySide === 0 ? 'var(--red,#e4553a)' : 'var(--blue,#3e7bd6)'};margin-right:6px" title="played as ${mySide === 0 ? 'red' : 'blue'}"></span><a href="/arena/engine/${esc(opp)}">${esc(names[opp] || opp)}</a></td>
      <td>${esc(g.reason || '')}</td>
      <td class="mono">${plies}</td>
      <td class="mono">${eloAfter ?? ''}</td>
      <td><a href="/arena/game/${g.id}" title="Replay with the eval bars and graph">replay</a>
        · <a href="#" data-arreview="${g.id}" title="Grade every move with the site engine">review</a>
        · <a href="/analysis?m=${encodeURIComponent((g.moves || '').split(' ').join('.'))}">analyze</a></td>
    </tr>`;
  };
  const gamesBox = document.getElementById('ae-games');
  const moreBtn = document.getElementById('ae-more');
  const gamesTable = (rows) => `<table class="lb-table" style="width:100%"><thead><tr><th></th><th>Opponent</th><th>End</th><th>Moves</th><th>Rating after</th><th></th></tr></thead>
         <tbody>${rows.map(gameRow).join('')}</tbody></table>`;
  // initial list comes from the profile payload; the search endpoint (fixed
  // to this engine) takes over on any search — including the default one
  gamesBox.innerHTML = games.length ? gamesTable(games) : '<p class="sub">No finished games yet.</p>';
  moreBtn.style.display = hasMore ? '' : 'none';
  const searchCtl = wireArenaSearch(main, {
    fixed: key,
    pageSize: 50,
    renderRows: (dd, append) => {
      if (!dd.games.length && !append) { gamesBox.innerHTML = '<p class="sub">No games match.</p>'; return; }
      if (append) gamesBox.querySelector('tbody')?.insertAdjacentHTML('beforeend', dd.games.map(gameRow).join(''));
      else gamesBox.innerHTML = gamesTable(dd.games);
    },
    onSearchState: (_, hasMoreNow) => { moreBtn.style.display = hasMoreNow ? '' : 'none'; searchActive = true; },
  });
  let searchActive = false;
  gamesBox.addEventListener('click', (e) => {
    const a = e.target.closest('[data-arreview]');
    if (!a) return;
    e.preventDefault();
    openArenaReview(a.dataset.arreview, a);
  });
  moreBtn.addEventListener('click', async () => {
    moreBtn.disabled = true;
    try {
      if (searchActive) {
        const r = await searchCtl.loadMore();
        moreBtn.style.display = r.hasMore ? '' : 'none';
      } else {
        const more = await api(`/api/arena/engine/${encodeURIComponent(key)}?before=${games[games.length - 1].id}`);
        games = games.concat(more.games);
        hasMore = more.hasMore;
        gamesBox.innerHTML = gamesTable(games);
        moreBtn.style.display = hasMore ? '' : 'none';
      }
    } catch (e) { toast(e.message); }
    moreBtn.disabled = false;
  });
}

