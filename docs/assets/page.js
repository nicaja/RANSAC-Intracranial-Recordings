// How RANSAC finds bad contacts on the EMBC 2025 arrays: sample contacts, predict the rest, compare,
// repeat, reject over epochs, rebuild. Traces come from ../traces (int16, 0.1 µV, [filtered|ransac][channel][sample]).
// Steps 1-4 replay autoreject's procedure on the averaged response, with inverse-distance weighting in
// place of spherical splines. Step 5 uses the paper's per-epoch flags and step 6 its RANSAC output.

const ROOT = new URL('../', import.meta.url);
const TRACES = new URL('traces/', ROOT);
const params = new URLSearchParams(location.search);
const CAPTURE = params.has('capture');
if (CAPTURE) document.body.classList.add('capture');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const NS = 'http://www.w3.org/2000/svg';
const W = 920;
const GAP = 8;
const CELL_H = 76;
const GRID_Y = 58;
const UNBROKEN_TIME = 0.4;
const SETTINGS = {
  tuned: { min_channels: 0.125, n_resample: 7, min_corr: 0.85 },
  default: { min_channels: 0.25, n_resample: 50, min_corr: 0.75 },
};
const RECORDINGS = {
  epidural: { title: 'Epidural µECoG', settings: 'tuned', note: 'We tuned these for the epidural data.' },
  intracortical: { title: 'Intracortical MEA', settings: 'default', note: 'Default autoreject settings, as in the paper. Our tuned settings attenuated this signal.' },
  noise: { title: 'Noise only (µECoG)', settings: 'tuned', note: 'We did not report settings for this example; here it uses the tuned ones.' },
};
const STEPS = [
  {
    label: 'sample', ms: 2600,
    title: (x) => `Pick ${x.k} random contacts`,
    caption: (x) => `RANSAC starts with a random ${x.s.min_channels * 100}% of the contacts (${x.k} of ${x.n}) and predicts the rest from them.`,
  },
  {
    label: 'predict', ms: 2800,
    title: () => 'Predict every other contact from them',
    caption: () => 'In autoreject the prediction is a spherical-spline interpolation. We use a simpler distance-weighted average here, which makes the correlations in steps 3 and 4 illustrative only.',
  },
  {
    label: 'compare', ms: 2800,
    title: (x) => `Correlate with the prediction · below ${x.s.min_corr} is bad`,
    caption: (x) => {
      const unlucky = x.subsets[0].filter((i) => x.m.channels[i].bad).map((i) => x.m.channels[i].name);
      const note = unlucky.length ? ` This subset includes ${unlucky.length > 1 ? 'bad contacts' : 'a bad contact'} (${unlucky.join(', ')}), so nearby good contacts can score low too.` : '';
      return `RANSAC runs this test on every epoch; here we run it once, on the averaged response.${note}`;
    },
  },
  {
    label: 'repeat', ms: 4600,
    title: (x) => `Repeat with ${x.s.n_resample} subsets, keep the median`,
    caption: (x) => `Each contact is now compared with the median of ${x.s.n_resample} predictions. One unlucky subset can no longer make it look bad.`,
  },
  {
    label: 'reject', ms: 3400,
    title: (x) => `Reject contacts bad in more than 40% of the ${x.m.n_ave} epochs`,
    caption: () => "The percentages are approximate: we read them off a rasterised image of the paper's bad-epoch log.",
  },
  {
    label: 'rebuild', ms: 3800,
    title: () => 'Rebuild rejected contacts from the good ones',
    caption: () => "The blue traces are the paper's RANSAC output, rebuilt with MNE's interpolate_bads. The faint red lines are the traces before RANSAC.",
  },
];
const HOLD_END = 2400;
const STARTS = STEPS.reduce((acc, s, i) => [...acc, acc[i] + s.ms], [0]);
const TOTAL = STARTS[STEPS.length] + HOLD_END;

const state = { mode: 'epidural', t: 0, playing: false, shown: null };
let meta, model;
const data = {};

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}
function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

async function load(key) {
  if (data[key]) return data[key];
  const m = meta.modes[key];
  const res = await fetch(new URL(m.file, TRACES));
  if (!res.ok) throw new Error(`${res.status} loading ${m.file}`);
  const raw = new Int16Array(await res.arrayBuffer());
  const nc = m.channels.length;
  const series = [0, 1].map((s) => m.channels.map((_, c) => Float32Array.from(raw.subarray((s * nc + c) * m.n_t, (s * nc + c + 1) * m.n_t), (v) => v / 10)));
  let lo = 0, hi = 0;
  for (const st of series) for (const ch of st) for (const v of ch) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  data[key] = { series, lo: lo - 0.04 * (hi - lo), hi: hi + 0.04 * (hi - lo) };
  return data[key];
}

// ---------- the RANSAC replay on the averaged response ----------
function buildModel(key) {
  const m = meta.modes[key];
  const d = data[key];
  const s = SETTINGS[RECORDINGS[key].settings];
  const n = m.channels.length;
  const k = Math.round(s.min_channels * n);
  const rand = rng(17 + key.length * 31);
  const subsets = Array.from({ length: s.n_resample }, () => {
    const pool = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool.slice(0, k);
  });
  const pos = m.channels.map((c) => [c.col, c.row]);
  const predict = (subset) => m.channels.map((_, c) => {
    if (subset.includes(c)) return d.series[0][c];
    const w = subset.map((j) => 1 / ((pos[c][0] - pos[j][0]) ** 2 + (pos[c][1] - pos[j][1]) ** 2));
    const total = w.reduce((a, b) => a + b, 0);
    const out = new Float32Array(m.n_t);
    subset.forEach((j, q) => { const src = d.series[0][j]; for (let t = 0; t < m.n_t; t++) out[t] += (w[q] / total) * src[t]; });
    return out;
  });
  const preds = subsets.map(predict);
  const medians = [];
  const median = (count) => {
    if (medians[count]) return medians[count];
    const buf = new Float32Array(count);
    medians[count] = m.channels.map((_, c) => {
      const out = new Float32Array(m.n_t);
      for (let t = 0; t < m.n_t; t++) {
        for (let i = 0; i < count; i++) buf[i] = preds[i][c][t];
        buf.sort();
        out[t] = count % 2 ? buf[(count - 1) / 2] : (buf[count / 2 - 1] + buf[count / 2]) / 2;
      }
      return out;
    });
    return medians[count];
  };
  // autoreject's correlation: uncentred, between each channel and its (median) prediction
  const corr = (count) => median(count).map((p, c) => {
    const x = d.series[0][c];
    let xy = 0, xx = 0, pp = 0;
    for (let t = 0; t < m.n_t; t++) { xy += x[t] * p[t]; xx += x[t] * x[t]; pp += p[t] * p[t]; }
    return xy / Math.sqrt(xx * pp);
  });
  const share = m.flags.bits.map((b) => [...b].filter((v) => v === '1').length / b.length);
  return { key, m, d, s, n, k, subsets, median, corr, share, cache: {} };
}

// ---------- drawing ----------
function decimate(arr, bins, xOf, yOf) {
  // min/max per pixel column keeps narrow peaks; both states share the bins so they can blend
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

function build() {
  const svg = $('#array');
  svg.replaceChildren();
  const { m, d } = model;
  const [cols, rows] = m.grid;
  const cw = (W - (cols - 1) * GAP) / cols;
  const inner = { x0: 6, x1: cw - 6, y0: 17, y1: CELL_H - 6 };
  const xs = (k) => inner.x0 + (k / (m.n_t - 1)) * (inner.x1 - inner.x0);
  const yV = (v) => inner.y0 + ((d.hi - v) / (d.hi - d.lo)) * (inner.y1 - inner.y0);
  const bins = Math.round(inner.x1 - inner.x0);
  const span = (m.n_t - 1) * m.dt_s;
  const x0ms = inner.x0 + (-m.t0_s / span) * (inner.x1 - inner.x0);
  const gridH = rows * CELL_H + (rows - 1) * GAP;
  const legendY = GRID_Y + gridH + 30;
  svg.setAttribute('viewBox', `0 0 ${W} ${legendY + 8}`);

  const num = el('text', { class: 'f-num', x: 0, y: 22 }, svg);
  const title = el('text', { class: 'f-step', x: 22, y: 22 }, svg);
  const right = el('text', { class: 'f-right', x: W - 2, y: 44 }, svg);
  el('text', { class: 'f-right', x: W - 2, y: 22 }, svg).textContent = `${RECORDINGS[model.key].title} · average of ${m.n_ave} epochs`;

  const cells = m.channels.map((c, i) => {
    const x = c.col * (cw + GAP);
    const y = GRID_Y + (rows - 1 - c.row) * (CELL_H + GAP);
    const g = el('g', { transform: `translate(${x.toFixed(1)},${y})` }, svg);
    const bg = el('rect', { class: 'cell-bg', width: cw.toFixed(1), height: CELL_H }, g);
    el('text', { class: 'ch', x: 6, y: 12 }, g).textContent = c.name;
    const r = el('text', { class: 'r', x: cw - 6, y: 12 }, g);
    el('line', { class: 'stim', x1: x0ms, x2: x0ms, y1: inner.y0 - 2, y2: inner.y1 }, g);
    const before = decimate(d.series[0][i], bins, xs, yV);
    const after = decimate(d.series[1][i], bins, xs, yV);
    const ghost = el('path', { class: 'ghost', d: pathOf(before) }, g);
    const trace = el('path', { class: 'trace', d: pathOf(before) }, g);
    const pred = el('path', { class: 'pred', opacity: 0 }, g);
    const bar = el('g', { opacity: 0 }, g);
    const tw = cw - 48;
    el('rect', { class: 'track', x: 6, y: CELL_H - 12, width: tw, height: 5 }, bar);
    const fill = el('rect', { class: 'fill', x: 6, y: CELL_H - 12, width: 0, height: 5 }, bar);
    el('line', { class: 'tick', x1: 6 + UNBROKEN_TIME * tw, x2: 6 + UNBROKEN_TIME * tw, y1: CELL_H - 16, y2: CELL_H - 4 }, bar);
    const share = el('text', { class: 'share', x: cw - 6, y: CELL_H - 6 }, bar);
    return { bg, r, ghost, trace, pred, bar, fill, share, tw, before, after, predKey: null };
  });

  // legend and scale bar
  const lg = el('g', { transform: `translate(0,${legendY})` }, svg);
  el('rect', { class: 'swatch-sample', x: 0.75, y: -9.25, width: 11, height: 11 }, lg);
  el('text', { class: 'legend', x: 18, y: 0 }, lg).textContent = 'sampled contact';
  el('line', { class: 'swatch-pred', x1: 126, x2: 144, y1: -4, y2: -4 }, lg);
  el('text', { class: 'legend', x: 150, y: 0 }, lg).textContent = 'prediction / rebuilt signal';
  el('rect', { class: 'swatch-low', x: 316, y: -10, width: 12, height: 12 }, lg);
  el('text', { class: 'legend', x: 334, y: 0 }, lg).textContent = 'correlation below threshold';
  el('rect', { class: 'swatch-bad', x: 509, y: -9, width: 10, height: 10 }, lg);
  el('text', { class: 'legend', x: 527, y: 0 }, lg).textContent = 'rejected contact';
  el('line', { class: 'swatch-ghost', x1: 640, x2: 658, y1: -4, y2: -4 }, lg);
  el('text', { class: 'legend', x: 664, y: 0 }, lg).textContent = 'before RANSAC';
  const uv = [10, 20, 25, 50, 100, 200, 250, 500].reduce((best, v) => (Math.abs(v - (d.hi - d.lo) / 3) < Math.abs(best - (d.hi - d.lo) / 3) ? v : best));
  const hPx = (0.1 / span) * (inner.x1 - inner.x0);
  const vPx = (uv / (d.hi - d.lo)) * (inner.y1 - inner.y0);
  const sx = W - hPx - 50;
  el('path', { class: 'scalebar', d: `M${sx} ${-4 - vPx} L${sx} -4 l${hPx.toFixed(1)} 0` }, lg);
  el('text', { class: 'legend', x: sx - 6, y: -vPx / 2, 'text-anchor': 'end' }, lg).textContent = `${uv} µV`;
  el('text', { class: 'legend', x: sx + hPx + 6, y: 0 }, lg).textContent = '100 ms';

  model.view = { cells, num, title, right, bins, xs, yV };
  state.shown = null;
}

function locate(t) {
  const i = Math.max(0, STARTS.findIndex((s, j) => t < STARTS[j + 1]));
  if (t >= STARTS[STEPS.length]) return { step: STEPS.length - 1, p: 1 };
  return { step: i, p: clamp((t - STARTS[i]) / STEPS[i].ms, 0, 1) };
}

function predPath(cell, c, count) {
  const key = `${count}`;
  if (cell.predKey !== key) {
    const { bins, xs, yV } = model.view;
    cell.pred.setAttribute('d', pathOf(decimate(model.median(count)[c], bins, xs, yV)));
    cell.predKey = key;
  }
}

function render(t) {
  const { step, p } = locate(t);
  const { m, s, n, k, subsets, share, view } = model;
  const x = { m, s, n, k, subsets };
  // which subset and how many resamples are in play at this moment
  let subset = null, count = 1, showPred = 0, showR = 0;
  if (step <= 3) subset = subsets[0];
  if (step === 1) showPred = ease(p);
  if (step >= 2 && step <= 3) { showPred = 1; showR = step === 2 ? ease(p) : 1; }
  if (step === 3) {
    count = clamp(1 + Math.floor(Math.min(1, p * 1.15) * s.n_resample), 1, s.n_resample);
    subset = subsets[count - 1];
  }
  const r = showR ? model.corr(count) : null;
  const decide = step === 4 ? ease(clamp(p * 1.4, 0, 1)) : 0;
  const rebuild = step === 5 ? ease(p) : 0;

  m.channels.forEach((c, i) => {
    const cell = view.cells[i];
    const sampled = subset?.includes(i);
    const rv = r && !sampled ? Math.round(r[i] * 100) / 100 : null;
    const low = rv !== null && rv < s.min_corr;
    cell.bg.classList.toggle('sampled', !!sampled);
    cell.bg.classList.toggle('low', low && showR > 0.5);
    cell.bg.classList.toggle('rejected', c.bad && (step === 5 || (step === 4 && share[i] * decide > UNBROKEN_TIME)));
    if (showPred && !sampled) predPath(cell, i, count);
    cell.pred.setAttribute('opacity', sampled ? 0 : showPred.toFixed(2));
    cell.r.textContent = rv === null ? '' : rv.toFixed(2).replace('-', '−');
    cell.r.setAttribute('opacity', showR.toFixed(2));
    cell.r.classList.toggle('low', low);
    cell.bar.setAttribute('opacity', step === 4 ? 1 : 0);
    if (step === 4) {
      const v = share[i] * decide;
      cell.fill.setAttribute('width', (v * cell.tw).toFixed(1));
      cell.fill.classList.toggle('over', v > UNBROKEN_TIME);
      cell.share.textContent = `${Math.round(v * 100)}%`;
      cell.share.classList.toggle('over', v > UNBROKEN_TIME);
    }
    if (c.bad) {
      cell.trace.setAttribute('d', pathOf(cell.before, cell.after, rebuild));
      cell.trace.style.stroke = step === 5 ? (rebuild < 0.5 ? 'var(--bad)' : 'var(--pred)') : step === 4 && share[i] * decide > UNBROKEN_TIME ? 'var(--bad)' : '';
      cell.ghost.style.opacity = (0.3 * rebuild).toFixed(2);
    }
  });
  view.num.textContent = `${step + 1}`;
  view.title.textContent = STEPS[step].title(x);
  view.right.textContent = step === 3 ? `subset ${count} of ${s.n_resample}` : '';

  if (state.shown !== step) {
    state.shown = step;
    const cap = $('#caption');
    if (cap) { cap.setAttribute('aria-live', state.playing ? 'off' : 'polite'); cap.textContent = STEPS[step].caption(x); }
    document.querySelectorAll('#steps button').forEach((b, j) => { if (j === step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
  }
}

// ---------- playback ----------
let last = null;
function frame(now) {
  const dt = last === null ? 0 : Math.min(now - last, 100);
  last = now;
  if (state.playing) {
    state.t = (state.t + dt) % TOTAL;
    render(state.t);
  }
  requestAnimationFrame(frame);
}
function setPlaying(p) {
  state.playing = p;
  const b = $('#play');
  if (b) { b.textContent = p ? 'pause' : 'play'; b.setAttribute('aria-label', p ? 'Pause' : 'Play'); }
}

let request = 0;
async function setMode(key) {
  const mine = ++request;
  await load(key);
  if (mine !== request) return;
  state.mode = key;
  model = buildModel(key);
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === key)));
  const set = $('#settings');
  if (set) {
    const { s, k, n } = model;
    set.textContent = `n_resample ${s.n_resample}, min_channels ${s.min_channels} (${k} of ${n} contacts), min_corr ${s.min_corr}, unbroken_time ${UNBROKEN_TIME}. ${RECORDINGS[key].note}`;
  }
  build();
  render(state.t);
}

async function init() {
  meta = await (await fetch(new URL('meta.json', TRACES))).json();
  const requested = params.get('mode');
  if (requested in meta.modes) state.mode = requested;
  await setMode(state.mode);
  if (CAPTURE) return;
  const list = $('#steps');
  STEPS.forEach((st, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="n">${i + 1}</span> ${st.label}`;
    b.addEventListener('click', () => { setPlaying(false); state.t = STARTS[i] + st.ms - 1; render(state.t); });
    li.appendChild(b);
    list.appendChild(li);
  });
  state.shown = null;
  render(state.t);
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { state.t = 0; setMode(b.dataset.mode); }));
  $('#play').addEventListener('click', () => setPlaying(!state.playing));
  setPlaying(false);
  if (!REDUCED) {
    new IntersectionObserver((entries, obs) => {
      if (entries.some((e) => e.isIntersecting)) { setPlaying(true); obs.disconnect(); }
    }, { threshold: 0.3 }).observe($('#array'));
  }
  requestAnimationFrame(frame);
}

const ready = init();
window.page = {
  ready, setMode, total: TOTAL, starts: STARTS,
  frameAt: (t) => { state.t = t; render(t); },
};
