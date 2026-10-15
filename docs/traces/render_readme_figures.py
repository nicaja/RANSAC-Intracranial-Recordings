"""Render the README figures from the interactive page, in GitHub's light and dark themes.

Writes docs/figures/ransac-steps-{light,dark}.gif (the page's RANSAC timeline for one recording, from its
capture mode) and docs/figures/reported-changes-{light,dark}.png (the Table II changes, drawn with the
page's stylesheet). Serve docs/ locally first:

    python -m pip install playwright pillow
    python -m http.server 8765 --directory docs
    python docs/traces/render_readme_figures.py --browser "path/to/msedge.exe"

Without --browser, Playwright's own Chromium is used (python -m playwright install chromium).
"""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

FIGURES = Path(__file__).resolve().parents[1] / 'figures'
THEMES = {'light': (255, 255, 255), 'dark': (13, 17, 23)}  # GitHub's page backgrounds
STEP_MS = 100  # sampling interval along the page's timeline


def render_steps(browser, url, mode, theme):
    page = browser.new_page(viewport={'width': 1000, 'height': 900}, device_scale_factor=1)
    page.goto(f'{url}?capture&mode={mode}&theme={theme}')
    page.evaluate('async () => { await window.page.ready; await document.fonts.ready; }')
    total = page.evaluate('window.page.total')
    figure = page.locator('#figure')
    frames, durations = [], []
    for t in range(0, total, STEP_MS):
        page.evaluate(f'window.page.frameAt({t})')
        png = figure.screenshot()
        if frames and png == frames[-1]:  # hold unchanged frames instead of repeating them
            durations[-1] += STEP_MS
            continue
        frames.append(png)
        durations.append(STEP_MS)
    page.close()
    images = [Image.open(io.BytesIO(png)).convert('RGB') for png in frames]
    if len({im.size for im in images}) != 1:
        raise ValueError('Capture frames differ in size.')
    # One palette for every frame, built from frames across all steps so colours that appear in only
    # some steps keep their hue. The background's entry is then set to GitHub's exact colour.
    picks = images[:: max(1, len(images) // 16)]
    sheet = Image.new('RGB', (images[0].width, images[0].height * len(picks)))
    for k, im in enumerate(picks):
        sheet.paste(im, (0, k * im.height))
    palette = sheet.quantize(colors=96, method=Image.Quantize.MEDIANCUT)
    images = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in images]
    colours = images[0].getpalette()
    index = images[0].getpixel((1, 1))  # a background pixel
    colours[3 * index:3 * index + 3] = THEMES[theme]
    for im in images:
        im.putpalette(colours)
    out = FIGURES / f'ransac-steps-{theme}.gif'
    images[0].save(out, save_all=True, append_images=images[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f'{out.name}: {len(images)} frames, {sum(durations) / 1000:.1f} s, {out.stat().st_size / 1e6:.2f} MB')


def chart_svg(data):
    # Grouped bars of the reported percent changes, one group per metric and one bar per recording.
    w, h, left, right, top, bottom = 760, 320, 58, 14, 46, 34
    lo, hi = -60, 40
    y = lambda v: top + (hi - v) / (hi - lo) * (h - top - bottom)
    metrics = [('Standard deviation', 'SD'), ('Variance', 'Variance'), ('Correlation', 'Correlation')]
    colours = ['var(--c1)', 'var(--c2)', 'var(--c3)']
    group = (w - left - right) / len(metrics)
    bar, gap = 38, 6
    parts = [f'<svg id="chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">']
    for v in range(lo, hi + 1, 20):
        cls = 'c-zero' if v == 0 else 'c-grid'
        parts.append(f'<line class="{cls}" x1="{left}" x2="{w - right}" y1="{y(v):.1f}" y2="{y(v):.1f}"/>')
        label = f'{v:+d}'.replace('-', '−') if v else '0'
        parts.append(f'<text class="c-tick" x="{left - 8}" y="{y(v) + 4:.1f}" text-anchor="end">{label}</text>')
    parts.append(f'<text class="c-axis" transform="translate(16 {(top + h - bottom) / 2:.0f}) rotate(-90)" text-anchor="middle">change after RANSAC (%)</text>')
    for j, (key, name) in enumerate(metrics):
        cx = left + group * (j + 0.5)
        x0 = cx - (3 * bar + 2 * gap) / 2
        for k, v in enumerate(data['percent_changes'][key]):
            x = x0 + k * (bar + gap)
            top_y, bot_y = sorted((y(0), y(v)))
            parts.append(f'<rect x="{x:.1f}" y="{top_y:.1f}" width="{bar}" height="{bot_y - top_y:.1f}" style="fill:{colours[k]}"/>')
            label = f'{v:+.1f}%'.replace('-', '−')
            ly = y(v) - 6 if v >= 0 else y(v) + 15
            parts.append(f'<text class="c-value" x="{x + bar / 2:.1f}" y="{ly:.1f}" text-anchor="middle">{label}</text>')
        parts.append(f'<text class="c-group" x="{cx:.1f}" y="{h - 10}" text-anchor="middle">{name}</text>')
    lx = left
    for k, name in enumerate(data['profiles']):
        parts.append(f'<rect x="{lx}" y="12" width="12" height="12" style="fill:{colours[k]}"/>')
        parts.append(f'<text class="c-key" x="{lx + 18}" y="22.5">{name}</text>')
        lx += 18 + 6.6 * len(name) + 26
    parts.append('</svg>')
    return '\n'.join(parts)


def render_chart(browser, url, theme):
    data = json.loads((FIGURES / 'reported-changes.json').read_text(encoding='utf-8'))
    html = f"""<!doctype html><html data-theme="{theme}"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{url}assets/page.css">
<style>
  :root {{ --c1: #0969da; --c2: #8250df; --c3: #818b98; }}
  :root[data-theme="dark"] {{ --c1: #58a6ff; --c2: #a371f7; --c3: #6e7681; }}
  body {{ margin: 0; }}
  #wrap {{ display: inline-block; padding: 14px 18px 10px; background: var(--bg); }}
  svg text {{ font-family: var(--sans); font-variant-numeric: tabular-nums; }}
  .c-grid {{ stroke: var(--rule); stroke-dasharray: 2 3; }}
  .c-zero {{ stroke: var(--muted); stroke-width: 1.2; }}
  .c-tick, .c-axis {{ font-size: 12.5px; fill: var(--muted); }}
  .c-value {{ font-size: 12.5px; fill: var(--text); }}
  .c-group {{ font-size: 14.5px; font-weight: 600; fill: var(--text); }}
  .c-key {{ font-size: 13.5px; fill: var(--text); }}
</style></head><body><div id="wrap">{chart_svg(data)}</div></body></html>"""
    page = browser.new_page(viewport={'width': 900, 'height': 500}, device_scale_factor=2)
    page.set_content(html, wait_until='networkidle')
    page.evaluate('async () => { await document.fonts.ready; }')
    out = FIGURES / f'reported-changes-{theme}.png'
    page.locator('#wrap').screenshot(path=str(out))
    page.close()
    print(f'{out.name}: {out.stat().st_size / 1e3:.0f} kB')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', default='http://localhost:8765/')
    parser.add_argument('--mode', default='epidural', choices=('epidural', 'intracortical', 'noise'))
    parser.add_argument('--browser', help='Chromium-based browser executable, e.g. Microsoft Edge.')
    args = parser.parse_args()
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.browser, headless=True)
        for theme in THEMES:
            render_steps(browser, args.url, args.mode, theme)
            render_chart(browser, args.url, theme)
        browser.close()


if __name__ == '__main__':
    main()
