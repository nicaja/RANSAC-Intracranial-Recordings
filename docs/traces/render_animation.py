"""Render the README animation from the interactive page's capture mode.

Serve docs/ locally, then render light and dark GIFs of Fig. 1 blending from filtered to RANSAC:

    python -m pip install playwright pillow
    python -m http.server 8765 --directory docs
    python docs/traces/render_animation.py --browser "path/to/msedge.exe"

Without --browser, Playwright's own Chromium is used (python -m playwright install chromium).
"""
from __future__ import annotations

import argparse
import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

MODES = ('epidural', 'intracortical', 'noise')


def ease(x):
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


# (blend, milliseconds) per frame for one recording: hold, blend in, hold, blend back.
SEQUENCE = ([(0, 1300)] + [(ease(k / 22), 55) for k in range(1, 22)] + [(1, 2000)]
            + [(1 - ease(k / 14), 55) for k in range(1, 14)])


def render(page, url, theme):
    frames, durations = [], []
    for mode in MODES:
        page.goto(f'{url}?capture&theme={theme}&mode={mode}')
        page.evaluate('async () => { await window.consensus.ready; await document.fonts.ready; }')
        plate = page.locator('#plate-array')
        for mix, ms in SEQUENCE:
            page.evaluate(f'window.consensus.setMix({mix})')
            frames.append(Image.open(io.BytesIO(plate.screenshot())).convert('RGB'))
            durations.append(ms)
    if len({f.size for f in frames}) != 1:
        raise ValueError('Capture frames differ in size; keep every recording the same height.')
    # One shared palette keeps colours stable across frames.
    palette = frames[len(SEQUENCE) // 2].quantize(colors=96, method=Image.Quantize.MEDIANCUT)
    return [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames], durations


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', default='http://localhost:8765/')
    parser.add_argument('--browser', help='Chromium-based browser executable, e.g. Microsoft Edge.')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'figures')
    args = parser.parse_args()
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.browser, headless=True)
        for theme in ('dark', 'light'):
            page = browser.new_page(viewport={'width': 1160, 'height': 900}, device_scale_factor=1)
            frames, durations = render(page, args.url, theme)
            page.close()
            out = args.output / f'ransac-consensus-{theme}.gif'
            frames[0].save(out, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True, disposal=1)
            print(f'{out}: {len(frames)} frames, {out.stat().st_size / 1e6:.2f} MB')
        browser.close()


if __name__ == '__main__':
    main()
