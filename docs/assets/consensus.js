// Consensus on the array: how RANSAC judged and rebuilt channels in the EMBC 2025 examples.
// Traces come from ../traces (int16, 0.1 µV, [filtered|ransac][channel][sample]), digitised from
// the paper's vector figures by traces/build_data.py. Percent changes come from Table II.

const ROOT = new URL('../', import.meta.url);
const TRACES = new URL('traces/', ROOT);
const REPORTED = new URL('figures/reported-changes.json', ROOT);
const params = new URLSearchParams(location.search);
if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme');
const CAPTURE = params.has('capture');
if (CAPTURE) document.body.classList.add('capture');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const NS = 'http://www.w3.org/2000/svg';
const W = 1100;
const GAP = 8;
const THRESHOLD = 0.4; // unbroken_time: share of flagged epochs above which a channel is interpolated
const RECORDINGS = {
  epidural: {
    name: 'Epidural', array: '32-channel µECoG', settings: 'tuned settings', profile: 0, cellH: 92, tallyH: 62,
    story: 'Faulty channels on the surface grid are replaced, and the rebuilt traces follow the response of the good channels.',
  },
  intracortical: {
    name: 'Intracortical', array: '16-channel MEA', settings: 'default settings', profile: 1, cellH: 92, tallyH: 62,
    story: 'Penetrating electrodes differ for real reasons. Half the array is flagged, and the rebuilt traces exaggerate and align the peaks.',
  },
  noise: {
    name: 'Noise only', array: '32-channel µECoG', settings: null, profile: 2, cellH: 92, tallyH: 62,
    story: 'Every channel is noise, yet seven are still flagged and rebuilt to match the rest, so the array ends up looking consistent.',
  },
};
// Auto-morph cycle (ms): hold filtered, blend, hold RANSAC, blend back.
const CYCLE = [1100, 1700, 1900, 1200];

const state = { mode: 'epidural', mix: 0, cursor: null, hover: null, playing: false };
let meta, reported, colours, fig, tally;
const data = {};

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const tEnd = (m) => m.t0_s + (m.n_t - 1) * m.dt_s;
function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

function readColours() {
  const css = getComputedStyle(document.documentElement);
  const hex = (name) => {
    const h = css.getPropertyValue(name).trim().replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  colours = { flag: hex('--flag'), fix: hex('--fix') };
}
const blend = (a, b, f) => `rgb(${a.map((x, k) => Math.round(x + (b[k] - x) * f)).join(',')})`;

async function load(key) {
  if (data[key]) return data[key];
  const m = meta.modes[key];
  const res = await fetch(new URL(m.file, TRACES));
  if (!res.ok) throw new Error(`${res.status} loading ${m.file}`);
  const raw = new Int16Array(await res.arrayBuffer());
  const n = m.n_t;
  const nc = m.channels.length;
  const series = [0, 1].map((s) => m.channels.map((_, c) => {
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = raw[(s * nc + c) * n + k] / 10;
    return out;
  }));
  let lo = 0, hi = 0;
  for (const st of series) for (const ch of st) for (const v of ch) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const pad = 0.06 * (hi - lo);
  data[key] = { series, lo: lo - pad, hi: hi + pad };
  return data[key];
}

function valueAt(key, s, c, t) {
  const m = meta.modes[key];
  const f = clamp((t - m.t0_s) / m.dt_s, 0, m.n_t - 1.001);
  const k = Math.floor(f);
  const arr = data[key].series[s][c];
  return arr[k] + (arr[k + 1] - arr[k]) * (f - k);
}
const mixedAt = (c, t) => {
  const a = valueAt(state.mode, 0, c, t);
  return meta.modes[state.mode].channels[c].bad ? a + (valueAt(state.mode, 1, c, t) - a) * state.mix : a;
};

// Min/max per pixel column keeps narrow peaks visible at small sizes; both states share the bins
// so a blended path is a point-by-point blend of the two.
function decimate(arr, bins, xOf, yOf) {
  const n = arr.length;
  const out = new Float32Array(bins * 4);
  for (let b = 0; b < bins; b++) {
    const i0 = Math.floor((b * n) / bins);
    const i1 = Math.max(i0 + 1, Math.floor(((b + 1) * n) / bins));
    let lo = i0, hi = i0;
    for (let i = i0; i < i1; i++) { if (arr[i] < arr[lo]) lo = i; if (arr[i] > arr[hi]) hi = i; }
    const [a, z] = lo < hi ? [lo, hi] : [hi, lo];
    out.set([xOf(a), yOf(arr[a]), xOf(z), yOf(arr[z])], b * 4);
  }
  return out;
}

function pathOf(a, b = null, f = 0) {
  let d = '';
  for (let i = 0; i < a.length; i += 2) {
    const x = b ? a[i] + (b[i] - a[i]) * f : a[i];
    const y = b ? a[i + 1] + (b[i + 1] - a[i + 1]) * f : a[i + 1];
    d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

// ---------- Fig. 1: every electrode, in place ----------
function buildArray() {
  const svg = $('#array');
  svg.replaceChildren();
  const key = state.mode;
  const m = meta.modes[key];
  const rec = RECORDINGS[key];
  const d = data[key];
  const [cols, rows] = m.grid;
  const top = CAPTURE ? 62 : 0;
  const cw = (W - (cols - 1) * GAP) / cols;
  const ch = rec.cellH;
  const inner = { x0: 8, x1: cw - 8, y0: 24, y1: ch - 8 };
  const t0 = m.t0_s;
  const t1 = tEnd(m);
  const xT = (t) => inner.x0 + ((t - t0) / (t1 - t0)) * (inner.x1 - inner.x0);
  const yV = (v) => inner.y0 + ((d.hi - v) / (d.hi - d.lo)) * (inner.y1 - inner.y0);
  const bins = Math.round(inner.x1 - inner.x0);
  const xs = (k) => inner.x0 + (k / (m.n_t - 1)) * (inner.x1 - inner.x0);
  const dec = [0, 1].map((s) => m.channels.map((_, c) => decimate(d.series[s][c], bins, xs, yV)));

  const envTop = top + rows * ch + (rows - 1) * GAP + 22;
  const envH = 88;
  const env = { x0: 8, x1: W - 8, y0: envTop + 22, y1: envTop + envH - 8 };
  const axisY = envTop + envH + 20;
  svg.setAttribute('viewBox', `0 0 ${W} ${axisY + 4}`);

  let header = null;
  if (CAPTURE) {
    el('text', { class: 'cap-title', x: 0, y: 24 }, svg).textContent = `${rec.name} · ${rec.array}`;
    const nb = m.channels.filter((c) => c.bad).length;
    el('text', { class: 'cap-sub', x: 0, y: 46 }, svg).textContent = `${m.n_ave} stimuli · ${nb} of ${m.channels.length} channels flagged by RANSAC`;
    const a = el('text', { class: 'cap-sub', x: W - 392, y: 30 }, svg);
    a.textContent = 'FILTERED';
    el('line', { class: 'track', x1: W - 318, x2: W - 186, y1: 26, y2: 26 }, svg);
    const fill = el('line', { class: 'track-fill', x1: W - 318, x2: W - 318, y1: 26, y2: 26 }, svg);
    const b = el('text', { class: 'cap-sub', x: W, y: 30, 'text-anchor': 'end' }, svg);
    b.textContent = 'FILTERED + RANSAC';
    header = { a, b, fill };
  }

  const cells = m.channels.map((c, i) => {
    const x = c.col * (cw + GAP);
    const y = top + (rows - 1 - c.row) * (ch + GAP);
    const g = el('g', { transform: `translate(${x.toFixed(1)},${y.toFixed(1)})` }, svg);
    const frame = el('rect', { class: `cell${c.bad ? ' flagged' : ''}`, width: cw.toFixed(1), height: ch, rx: 6 }, g);
    el('text', { class: `label${c.bad ? ' flagged' : ''}`, x: 8, y: 16 }, g).textContent = c.name;
    const note = c.bad ? el('text', { class: 'note', x: cw - 8, y: 16 }, g) : null;
    el('line', { class: 'zero', x1: inner.x0, x2: inner.x1, y1: yV(0), y2: yV(0) }, g);
    el('line', { class: 'stim', x1: xT(0), x2: xT(0), y1: inner.y0 - 4, y2: inner.y1 + 2 }, g);
    const ghost = c.bad ? el('path', { class: 'ghost', d: pathOf(dec[0][i]), opacity: 0 }, g) : null;
    const trace = el('path', { class: `trace ${c.bad ? 'bad' : 'good'}`, d: pathOf(dec[0][i]) }, g);
    const cursor = el('line', { class: 'cursor', y1: inner.y0 - 4, y2: inner.y1 + 2, visibility: 'hidden' }, g);
    const dot = el('circle', { class: 'dot', r: 2.4, visibility: 'hidden' }, g);
    return { x, y, frame, note, ghost, trace, cursor, dot };
  });

  // spread across channels: all channels (blended) against good channels alone
  const ebins = Math.round(env.x1 - env.x0);
  const eY = (v) => env.y0 + ((d.hi - v) / (d.hi - d.lo)) * (env.y1 - env.y0);
  const range = (arr, b) => {
    const i0 = Math.floor((b * m.n_t) / ebins);
    const i1 = Math.max(i0 + 1, Math.floor(((b + 1) * m.n_t) / ebins));
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i < i1; i++) { lo = Math.min(lo, arr[i]); hi = Math.max(hi, arr[i]); }
    return [lo, hi];
  };
  const spans = [0, 1].map((s) => m.channels.map((_, c) => Array.from({ length: ebins }, (_, b) => range(d.series[s][c], b))));
  el('rect', { class: 'cell', x: 0, y: envTop, width: W, height: envH, rx: 6 }, svg);
  el('text', { class: 'label', x: 8, y: envTop + 16 }, svg).textContent = 'spread across channels';
  const eX = (t) => env.x0 + ((t - t0) / (t1 - t0)) * (env.x1 - env.x0);
  el('line', { class: 'stim', x1: eX(0), x2: eX(0), y1: env.y0 - 4, y2: env.y1 + 2 }, svg);
  const bandAll = el('path', { class: 'band-all' }, svg);
  const goodIdx = m.channels.map((c, i) => i).filter((i) => !m.channels[i].bad);
  el('path', { class: 'band-good', d: bandPath(goodIdx.map((i) => spans[0][i]), null, 0, ebins, env, eY) }, svg);
  const envCursor = el('line', { class: 'cursor', y1: env.y0 - 4, y2: env.y1 + 2, visibility: 'hidden' }, svg);

  for (let ms = -200; ms <= 500; ms += 100) {
    const t = ms / 1000;
    if (t < t0 - 1e-6 || t > t1 + 1e-6) continue;
    el('line', { class: 'tick', x1: eX(t), x2: eX(t), y1: envTop + envH, y2: envTop + envH + 5 }, svg);
    const label = ms < 0 ? `−${-ms}` : `${ms}`;
    el('text', { class: 'axis', x: eX(t), y: axisY, 'text-anchor': 'middle' }, svg).textContent = ms === 400 ? `${label} ms` : label;
  }
  el('text', { class: 'axis', x: eX(0) + 4, y: env.y0 - 8 }, svg).textContent = 'stimulus';

  fig = { svg, m, cw, ch, inner, xT, yV, dec, cells, spans, bandAll, ebins, env, eY, eX, envTop, envH, envCursor, header };
}

function bandPath(lists, alt, f, bins, env, eY) {
  // lists: per channel arrays of [lo, hi] per bin; alt (optional) blends towards a second set.
  const lo = new Float32Array(bins).fill(Infinity);
  const hi = new Float32Array(bins).fill(-Infinity);
  lists.forEach((spans, c) => {
    for (let b = 0; b < bins; b++) {
      let [l, h] = spans[b];
      if (alt?.[c]) { l += (alt[c][b][0] - l) * f; h += (alt[c][b][1] - h) * f; }
      lo[b] = Math.min(lo[b], l); hi[b] = Math.max(hi[b], h);
    }
  });
  const x = (b) => (env.x0 + ((b + 0.5) / bins) * (env.x1 - env.x0)).toFixed(1);
  let d = '';
  for (let b = 0; b < bins; b++) d += `${b ? 'L' : 'M'}${x(b)} ${eY(hi[b]).toFixed(1)}`;
  for (let b = bins - 1; b >= 0; b--) d += `L${x(b)} ${eY(lo[b]).toFixed(1)}`;
  return `${d}Z`;
}

function applyMix() {
  if (!fig) return;
  const { m, cells, dec } = fig;
  const f = state.mix;
  const tone = blend(colours.flag, colours.fix, ease(f));
  m.channels.forEach((c, i) => {
    if (!c.bad) return;
    cells[i].trace.setAttribute('d', pathOf(dec[0][i], dec[1][i], f));
    cells[i].trace.style.stroke = tone;
    cells[i].ghost.setAttribute('opacity', (0.32 * clamp(f * 2, 0, 1)).toFixed(3));
    cells[i].note.textContent = f < 0.5 ? 'flagged' : 'rebuilt';
    cells[i].note.style.fill = f < 0.5 ? 'var(--flag)' : 'var(--fix)';
  });
  const alt = m.channels.map((c, i) => (c.bad ? fig.spans[1][i] : null));
  fig.bandAll.setAttribute('d', bandPath(fig.spans[0], alt, f, fig.ebins, fig.env, fig.eY));
  if (fig.header) {
    const { a, b, fill } = fig.header;
    fill.setAttribute('x2', (W - 318 + 132 * f).toFixed(1));
    a.style.fill = f < 0.5 ? 'var(--ink)' : 'var(--muted)';
    b.style.fill = f >= 0.5 ? 'var(--fix)' : 'var(--muted)';
  }
  const slider = $('#mix');
  if (slider && document.activeElement !== slider) slider.value = Math.round(f * 1000);
  applyCursor();
}

function applyCursor() {
  const { m, cells, xT, yV, eX, envCursor } = fig;
  const t = state.cursor;
  const show = t === null ? 'hidden' : 'visible';
  cells.forEach((cell, i) => {
    cell.cursor.setAttribute('visibility', show);
    cell.dot.setAttribute('visibility', show);
    cell.frame.classList.toggle('hover', state.hover === i);
    if (t === null) return;
    const x = xT(t).toFixed(1);
    cell.cursor.setAttribute('x1', x); cell.cursor.setAttribute('x2', x);
    cell.dot.setAttribute('cx', x); cell.dot.setAttribute('cy', yV(mixedAt(i, t)).toFixed(1));
  });
  envCursor.setAttribute('visibility', show);
  if (t !== null) { envCursor.setAttribute('x1', eX(t)); envCursor.setAttribute('x2', eX(t)); }
  const out = $('#readout');
  if (!out) return;
  if (t === null) { out.textContent = 'Hover the array to read values'; return; }
  let s = `t = ${(t * 1000).toFixed(1)} ms`;
  if (state.hover !== null) {
    const c = m.channels[state.hover];
    const a = valueAt(state.mode, 0, state.hover, t);
    s += c.bad
      ? ` · ch ${c.name}, flagged: ${a.toFixed(1)} µV filtered → ${valueAt(state.mode, 1, state.hover, t).toFixed(1)} µV rebuilt`
      : ` · ch ${c.name}: ${a.toFixed(1)} µV, unchanged`;
  }
  out.textContent = s;
}

function pointerOnArray(e) {
  const pt = fig.svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(fig.svg.getScreenCTM().inverse());
  const { m, cells, cw, ch, inner, env } = fig;
  const t0 = m.t0_s;
  const span = tEnd(m) - t0;
  const i = cells.findIndex((c) => p.x >= c.x && p.x <= c.x + cw && p.y >= c.y && p.y <= c.y + ch);
  if (i >= 0) {
    state.hover = i;
    state.cursor = t0 + clamp((p.x - cells[i].x - inner.x0) / (inner.x1 - inner.x0), 0, 1) * span;
  } else if (p.y >= fig.envTop && p.y <= fig.envTop + fig.envH) {
    state.hover = null;
    state.cursor = t0 + clamp((p.x - env.x0) / (env.x1 - env.x0), 0, 1) * span;
  } else {
    state.hover = null; state.cursor = null;
  }
  applyCursor();
}

// auto-morph
let cycleAt = 0, lastNow = null;
function mixAtCycle(ms) {
  const [h0, up, h1, down] = CYCLE;
  const total = h0 + up + h1 + down;
  const x = ((ms % total) + total) % total;
  if (x < h0) return 0;
  if (x < h0 + up) return ease((x - h0) / up);
  if (x < h0 + up + h1) return 1;
  return 1 - ease((x - h0 - up - h1) / down);
}
function frame(now) {
  if (!state.playing) { lastNow = null; return; }
  if (lastNow !== null) cycleAt += Math.min(now - lastNow, 100);
  lastNow = now;
  state.mix = mixAtCycle(cycleAt);
  applyMix();
  requestAnimationFrame(frame);
}
function setPlaying(p) {
  if (p === state.playing) return;
  state.playing = p;
  const b = $('#play');
  if (b) { b.textContent = p ? 'Pause' : 'Play'; b.setAttribute('aria-pressed', String(p)); }
  if (p) {
    // continue the cycle from the current blend
    const [h0, up] = CYCLE;
    cycleAt = state.mix >= 0.999 ? h0 + up : h0 + up * state.mix;
    requestAnimationFrame(frame);
  }
}

// ---------- Fig. 2: how the verdict builds up ----------
function buildTally() {
  const svg = $('#tally');
  if (!svg) return;
  svg.replaceChildren();
  const m = meta.modes[state.mode];
  const rec = RECORDINGS[state.mode];
  const [cols, rows] = m.grid;
  const cw = (W - (cols - 1) * GAP) / cols;
  const ch = rec.tallyH;
  const track = { x0: 8, x1: cw - 8, y: ch - 22, h: 10 };
  svg.setAttribute('viewBox', `0 0 ${W} ${rows * ch + (rows - 1) * GAP}`);
  const cells = m.channels.map((c) => {
    const g = el('g', { transform: `translate(${(c.col * (cw + GAP)).toFixed(1)},${(rows - 1 - c.row) * (ch + GAP)})` }, svg);
    const frame = el('rect', { class: 'cell', width: cw.toFixed(1), height: ch, rx: 6 }, g);
    const label = el('text', { class: 'label', x: 8, y: 16 }, g);
    label.textContent = c.name;
    const share = el('text', { class: 'share', x: cw - 8, y: 16 }, g);
    el('rect', { class: 'bar-track', x: track.x0, y: track.y, width: track.x1 - track.x0, height: track.h, rx: 2 }, g);
    const bar = el('rect', { class: 'bar', x: track.x0, y: track.y, width: 0, height: track.h, rx: 2 }, g);
    const tx = track.x0 + THRESHOLD * (track.x1 - track.x0);
    el('line', { class: 'threshold', x1: tx, x2: tx, y1: track.y - 4, y2: track.y + track.h + 4 }, g);
    return { frame, label, share, bar, width: track.x1 - track.x0 };
  });
  const counts = new Int32Array(m.channels.length);
  tally = { m, cells, counts, row: 0, acc: 0, playing: false, last: null };
  drawTally();
}

function drawTally(final = false) {
  const { m, cells, counts, row } = tally;
  const rowsSeen = Math.max(row, 1);
  m.channels.forEach((c, i) => {
    const share = row ? counts[i] / rowsSeen : 0;
    const over = final ? c.bad : share > THRESHOLD;
    const hit = !final && row > 0 && m.flags.bits[i][row - 1] === '1';
    cells[i].bar.setAttribute('width', (share * cells[i].width).toFixed(1));
    cells[i].bar.classList.toggle('over', over);
    cells[i].frame.classList.toggle('flagged', over);
    cells[i].frame.classList.toggle('hit', hit);
    cells[i].label.classList.toggle('flagged', over);
    cells[i].share.textContent = row ? `${Math.round(share * 100)}%` : '';
    cells[i].share.classList.toggle('over', over);
  });
  const out = $('#epoch');
  if (!out) return;
  const epoch = Math.round((row / m.flags.rows) * m.flags.epochs);
  const bad = m.channels.filter((c) => c.bad);
  out.textContent = final
    ? `${m.flags.epochs} epochs · interpolated: ${bad.map((c) => c.name).join(', ')}`
    : `epoch ${epoch} of ${m.flags.epochs} · ${m.channels.filter((_, i) => row && counts[i] / rowsSeen > THRESHOLD).length} channels above 40%`;
}

function stepTally(now) {
  if (!tally.playing) return;
  const stepMs = 7000 / tally.m.flags.rows;
  if (tally.last !== null) tally.acc += Math.min(now - tally.last, 100);
  tally.last = now;
  while (tally.acc >= stepMs && tally.row < tally.m.flags.rows) {
    tally.acc -= stepMs;
    tally.m.flags.bits.forEach((bits, i) => { if (bits[tally.row] === '1') tally.counts[i]++; });
    tally.row++;
  }
  const done = tally.row >= tally.m.flags.rows;
  drawTally(done);
  if (done) { tally.playing = false; return; }
  requestAnimationFrame(stepTally);
}

function playTally() {
  if (!tally) return;
  tally.counts.fill(0);
  tally.row = 0; tally.acc = 0; tally.last = null;
  if (REDUCED) {
    tally.m.flags.bits.forEach((bits, i) => { tally.counts[i] = [...bits].filter((b) => b === '1').length; });
    tally.row = tally.m.flags.rows;
    drawTally(true);
    return;
  }
  tally.playing = true;
  requestAnimationFrame(stepTally);
}

// ---------- Fig. 3: what the summary numbers said ----------
function buildNumbers() {
  const svg = $('#numbers');
  if (!svg || !reported) return;
  svg.replaceChildren();
  const metrics = [['Standard deviation', 'SD'], ['Variance', 'Variance'], ['Correlation', 'Correlation']];
  const colW = 340;
  const half = 140;
  const scale = half / 55;
  const rowH = 46;
  const top = 48;
  svg.setAttribute('viewBox', `0 0 ${W} ${top + 3 * rowH + 34}`);
  const active = RECORDINGS[state.mode].profile;
  metrics.forEach(([key, title], j) => {
    const x0 = j * (colW + 40);
    const zero = x0 + colW / 2 + 20;
    el('text', { class: 'metric-title', x: x0, y: 20 }, svg).textContent = title;
    el('line', { class: 'tick', x1: zero, x2: zero, y1: top - 14, y2: top + 3 * rowH - 6 }, svg);
    reported.profiles.forEach((name, r) => {
      const v = reported.percent_changes[key][r];
      const y = top + r * rowH;
      const on = r === active;
      el('text', { class: `row-label${on ? ' on' : ''}`, x: x0, y: y + 12 }, svg).textContent = name;
      const w = Math.abs(v) * scale;
      const cls = key === 'Correlation' && r === 2 ? 'hbar noise-corr' : `hbar${on ? ' on' : ''}`;
      el('rect', { class: cls, x: v < 0 ? zero - w : zero, y: y + 18, width: Math.max(w, 1.5), height: 13, rx: 2 }, svg);
      const label = `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
      el('text', { class: `value${on ? ' on' : ''}`, x: v < 0 ? zero - w - 6 : zero + w + 6, y: y + 29, 'text-anchor': v < 0 ? 'end' : 'start' }, svg).textContent = label;
    });
    for (const p of [-50, 0, 50]) {
      el('text', { class: 'axis', x: zero + p * scale, y: top + 3 * rowH + 18, 'text-anchor': 'middle' }, svg).textContent = p ? `${p > 0 ? '+' : '−'}${Math.abs(p)}%` : '0';
    }
  });
  const nx = 2 * (colW + 40) + colW / 2 + 20 + reported.percent_changes.Correlation[2] * scale + 52;
  el('text', { class: 'annot', x: Math.min(nx, W), y: top + 2 * rowH + 12, 'text-anchor': 'end' }, svg).textContent = 'pure noise';
}

// ---------- wiring ----------
let modeRequest = 0;
async function setMode(key) {
  const request = ++modeRequest;
  await load(key);
  if (request !== modeRequest) return;
  state.mode = key;
  state.hover = null; state.cursor = null;
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === key)));
  const m = meta.modes[key];
  const rec = RECORDINGS[key];
  const note = $('#recording-note');
  if (note) {
    const nb = m.channels.filter((c) => c.bad).length;
    note.textContent = `${rec.story} ${m.n_ave} stimuli${rec.settings ? `, ${rec.settings}` : ''}, ${nb} of ${m.channels.length} channels flagged.`;
  }
  buildArray();
  applyMix();
  if (!CAPTURE) {
    buildTally();
    buildNumbers();
    if (tallyVisible) playTally();
  }
}

let tallyVisible = false;
function wire() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#play').addEventListener('click', () => setPlaying(!state.playing));
  $('#mix').addEventListener('input', (e) => { setPlaying(false); state.mix = Number(e.target.value) / 1000; applyMix(); });
  $('#replay').addEventListener('click', playTally);
  const svg = $('#array');
  svg.addEventListener('pointermove', pointerOnArray);
  svg.addEventListener('pointerdown', pointerOnArray);
  svg.addEventListener('pointerleave', () => { state.hover = null; state.cursor = null; applyCursor(); });
  new IntersectionObserver((entries) => {
    for (const e of entries) {
      const was = tallyVisible;
      tallyVisible = e.isIntersecting;
      if (tallyVisible && !was && !tally.playing && tally.row === 0) playTally();
    }
  }, { threshold: 0.35 }).observe($('#tally'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColours(); applyMix(); });
}

async function init() {
  meta = await (await fetch(new URL('meta.json', TRACES))).json();
  try { reported = await (await fetch(REPORTED)).json(); } catch { reported = null; }
  readColours();
  const requested = params.get('mode');
  if (requested in meta.modes) state.mode = requested;
  if (params.has('mix')) state.mix = clamp(Number(params.get('mix')), 0, 1);
  await setMode(state.mode);
  if (!CAPTURE) {
    wire();
    applyCursor();
    if (!REDUCED) setPlaying(true);
  }
}

const ready = init();
window.consensus = {
  ready, setMode,
  setMix: (v) => { state.mix = v; applyMix(); },
  get svg() { return $('#array'); },
};
