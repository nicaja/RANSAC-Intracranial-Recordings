"""Digitise the paper's RANSAC example figures for the interactive page.

MNE drew the figures as vector PDFs, so every channel's averaged response is stored as a path.
This reads the paths back into seconds and microvolts, matches each trace to its electrode
through MNE's spatial colours, and writes 0.1 µV int16 traces next to this file. No recording is
reanalysed, so the output is only as precise as the published figures.

    python -m pip install pymupdf
    python docs/traces/build_data.py
"""
from __future__ import annotations

import json
import re
import struct
from pathlib import Path

import pymupdf

HERE = Path(__file__).resolve().parent
FIGURES = HERE.parent / 'figures'

# Grid positions (column, row) in channel order, from general/loader.py (µECoG) and
# montage_remap('Experiment 09') in preprocessing_MEA/utils.py. The figure legends confirm both.
ECOG = [(7, 0), (7, 1), (7, 2), (7, 3), (6, 0), (6, 1), (6, 2), (6, 3), (5, 0), (5, 1), (5, 2), (5, 3),
        (4, 0), (4, 1), (4, 2), (4, 3), (3, 3), (3, 2), (3, 1), (3, 0), (2, 3), (2, 2), (2, 1), (2, 0),
        (1, 3), (1, 2), (1, 1), (1, 0), (0, 3), (0, 2), (0, 1), (0, 0)]
MEA = [(x, y) for y in range(4) for x in range(4)]

SOURCES = {
    'epidural': ('epidural-response-original.pdf', ECOG),
    'intracortical': ('intracortical-response-original.pdf', MEA),
    'noise': ('noise-response-original.pdf', ECOG),
}


def spatial_colours(positions):
    # MNE's _rgb: each coordinate scaled to 0-1 across the montage; the flat grid has z = 0.
    xs, ys = zip(*positions)
    scale = lambda v, vs: (v - min(vs)) / max(max(vs) - min(vs), 1e-16)
    return [(scale(x, xs), scale(y, ys), 0.0) for x, y in positions]


def close(a, b, tol=0.02):
    return all(abs(p - q) < tol for p, q in zip(a, b))


def numeric_spans(page):
    out = []
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            for span in line['spans']:
                out.append((span['text'].strip(), pymupdf.Rect(span['bbox']), span['size']))
    return out


def tick_value(text, rect, minus_marks):
    # Matplotlib draws the minus sign as a filled bar just left of the digits.
    negative = any(rect.x0 - 3 < m.x1 <= rect.x0 + 1 and rect.y0 < (m.y0 + m.y1) / 2 < rect.y1 for m in minus_marks)
    return -float(text) if negative else float(text)


def fit(pairs):
    # Least-squares line value = a * position + b; residual check guards against a mismatched label.
    n = len(pairs)
    mx = sum(p for p, _ in pairs) / n
    mv = sum(v for _, v in pairs) / n
    a = sum((p - mx) * (v - mv) for p, v in pairs) / sum((p - mx) ** 2 for p, _ in pairs)
    b = mv - a * mx
    worst = max(abs(a * p + b - v) for p, v in pairs)
    step = abs(pairs[1][1] - pairs[0][1])
    if n < 3 or worst > 0.01 * step:
        raise ValueError(f'Axis calibration failed (worst residual {worst:g}).')
    return a, b


def calibrate(panel, drawings, spans, minus_marks):
    ticks = [d['items'][0] for d in drawings if d['type'] == 'fs' and len(d['items']) == 1 and d['items'][0][0] == 'l']
    labels = [(t, r) for t, r, _ in spans if re.fullmatch(r'\d+(\.\d+)?', t)]
    xs, ys = [], []
    for _, a, b in ticks:
        if abs(a.x - b.x) < 0.01 and abs(a.y - panel.y1) < 0.5 and panel.x0 - 1 <= a.x <= panel.x1 + 1:
            near = [(abs((r.x0 + r.x1) / 2 - a.x), t, r) for t, r in labels if panel.y1 < r.y0 < panel.y1 + 20]
            _, t, r = min(near)
            xs.append((a.x, tick_value(t, r, minus_marks)))
        elif abs(a.y - b.y) < 0.01 and abs(a.x - panel.x0) < 0.5:
            near = [(abs((r.y0 + r.y1) / 2 - a.y), t, r) for t, r in labels if panel.x0 - 30 < r.x1 <= panel.x0]
            _, t, r = min(near)
            ys.append((a.y, tick_value(t, r, minus_marks)))
    return fit(xs), fit(ys)


def sample_grid(panels):
    # Matplotlib drops near-collinear vertices but keeps the rest on the sample grid, so the
    # smallest vertex spacing is one sample. Decimated TDT recordings sit near, not at, 2000 Hz.
    paths = [pts for panel in panels for pts in panel.values()]
    step = min(b[0] - a[0] for pts in paths for a, b in zip(pts, pts[1:]))
    t0 = min(pts[0][0] for pts in paths)
    span = max(pts[-1][0] for pts in paths) - t0
    n = round(span / step) + 1
    dt = span / (n - 1)
    off = max(abs((t - t0) / dt - round((t - t0) / dt)) for pts in paths for t, _ in pts)
    if off > 0.05:
        raise ValueError(f'Trace vertices are {off:.2f} samples off a regular grid.')
    return t0, dt, n


def resample(points, t0, dt, n):
    out, j = [], 0
    for k in range(n):
        t = t0 + k * dt
        while j < len(points) - 2 and points[j + 1][0] < t:
            j += 1
        (ta, va), (tb, vb) = points[j], points[j + 1]
        f = 0.0 if tb == ta else min(1.0, max(0.0, (t - ta) / (tb - ta)))
        out.append(va + (vb - va) * f)
    return out


def flags(doc, page, n_ch):
    # RANSAC's bad log (epochs x channels) as rasterised into the figure; one row per image row.
    info = page.get_image_info(xrefs=True)[0]
    pix = pymupdf.Pixmap(doc, info['xref'])
    if pix.n != 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    cols = []
    for c in range(n_ch):
        x = int((c + 0.5) * pix.width / n_ch)
        cols.append(''.join('1' if sum(pix.pixel(x, y)) < 3 * 128 else '0' for y in range(pix.height)))
    return cols


def digitise(key, filename, positions):
    doc = pymupdf.open(FIGURES / filename)
    page = doc[0]
    drawings = page.get_drawings()
    spans = numeric_spans(page)
    minus_marks = [d['rect'] for d in drawings if d['type'] == 'f' and d['fill'] == (0.0, 0.0, 0.0)
                   and d['rect'].height < 1.5 and 4 < d['rect'].width < 9]
    frames = sorted((d['rect'] for d in drawings if d['type'] == 'f' and d['fill'] == (1.0, 1.0, 1.0)
                     and d['rect'] != page.rect), key=lambda r: (r.y0, r.x0))
    panels, matrix = frames[:2], frames[2]

    colours = spatial_colours(positions)
    names = [t for t, r, _ in sorted(spans, key=lambda s: s[1].x0) if matrix.y1 < r.y0 < matrix.y1 + 10]
    titles = [t for t, _, size in spans if size == 16]
    bads = [b.strip() for b in titles[1].removeprefix('Bads:').split(',')]
    metrics = [dict(zip(('std', 'var', 'corr'), map(float, re.findall(r'[-\d.e]+(?=[,)])', t))))
               for t, r, size in sorted(spans, key=lambda s: s[1].x0) if size == 12 and t.startswith('(std')]
    n_ave = int(next(t for t, _, _ in spans if t.startswith('=')).strip('='))
    if len(names) != len(positions) or not set(bads) <= set(names):
        raise ValueError(f'{filename}: channel labels do not match the montage.')

    paths = []
    for panel in panels:
        (ax, bx), (ay, by) = calibrate(panel, drawings, spans, minus_marks)
        legend = [d for d in drawings if d['type'] == 'fs' and d['items'][0][0] == 'c' and panel.contains(d['rect'])]
        if len(legend) != len(positions) or not all(close(d['fill'], c) for d, c in zip(legend, colours)):
            raise ValueError(f'{filename}: legend colours do not follow the montage order.')
        by_channel = {}
        for d in drawings:
            if d['type'] != 's' or abs((d['width'] or 0) - 0.5) > 0.01 or len(d['items']) < 20:
                continue
            if not (panel.x0 - 1 <= d['rect'].x0 and d['rect'].x1 <= panel.x1 + 1 and panel.y0 - 1 <= d['rect'].y0 <= panel.y1):
                continue
            ch = next(i for i, c in enumerate(colours) if close(d['color'], c))
            pts = [d['items'][0][1]] + [it[2] for it in d['items']]
            by_channel[ch] = sorted((ax * p.x + bx, ay * p.y + by) for p in pts)
        if sorted(by_channel) != list(range(len(positions))):
            raise ValueError(f'{filename}: expected one trace per channel.')
        paths.append(by_channel)

    t0, dt, n_t = sample_grid(paths)
    traces = [[resample(panel[c], t0, dt, n_t) for c in range(len(positions))] for panel in paths]
    values = [round(v * 10) for panel in traces for ch in panel for v in ch]
    (HERE / f'{key}.bin').write_bytes(struct.pack(f'<{len(values)}h', *values))
    cols = max(x for x, _ in positions) + 1
    rows = max(y for _, y in positions) + 1
    print(f'{key}: {len(positions)} channels x {n_t} samples at {1 / dt:.1f} Hz from {t0 * 1000:.2f} ms')
    bits = flags(doc, page, len(positions))
    return {
        'title': titles[0], 'file': f'{key}.bin', 't0_s': round(t0, 7), 'dt_s': round(dt, 10), 'n_t': n_t, 'n_ave': n_ave,
        'grid': [cols, rows], 'metrics': metrics,
        'channels': [{'name': n, 'col': x, 'row': y, 'bad': n in bads} for n, (x, y) in zip(names, positions)],
        'flags': {'epochs': n_ave, 'rows': len(bits[0]), 'bits': bits},
    }


def main():
    meta = {
        'source': "Vector paths of the paper's figures in docs/figures, digitised by build_data.py.",
        'encoding': 'int16 little-endian in 0.1 µV, ordered [panel][channel][sample]; panels are Filtered, Filtered + RANSAC.',
        'flags': 'RANSAC bad-epoch log as rasterised in each figure: one string per channel, one character per image row (1 = flagged).',
        'modes': {key: digitise(key, *source) for key, source in SOURCES.items()},
    }
    (HERE / 'meta.json').write_text(json.dumps(meta, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
