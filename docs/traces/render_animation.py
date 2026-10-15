"""Render the README animation from the interactive page's capture mode.

Serve docs/ locally, then step through the page's RANSAC timeline for one recording and save it as a GIF:

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

STEP_MS = 100  # sampling interval along the page's timeline


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', default='http://localhost:8765/')
    parser.add_argument('--mode', default='epidural', choices=('epidural', 'intracortical', 'noise'))
    parser.add_argument('--browser', help='Chromium-based browser executable, e.g. Microsoft Edge.')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'figures' / 'ransac-steps.gif')
    args = parser.parse_args()
    frames, durations = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.browser, headless=True)
        page = browser.new_page(viewport={'width': 1000, 'height': 900}, device_scale_factor=1)
        page.goto(f'{args.url}?capture&mode={args.mode}')
        page.evaluate('async () => { await window.page.ready; await document.fonts.ready; }')
        total = page.evaluate('window.page.total')
        figure = page.locator('#figure')
        for t in range(0, total, STEP_MS):
            page.evaluate(f'window.page.frameAt({t})')
            png = figure.screenshot()
            # hold unchanged frames instead of repeating them
            if frames and png == frames[-1][0]:
                durations[-1] += STEP_MS
                continue
            frames.append((png, None))
            durations.append(STEP_MS)
        browser.close()
    images = [Image.open(io.BytesIO(png)).convert('RGB') for png, _ in frames]
    if len({im.size for im in images}) != 1:
        raise ValueError('Capture frames differ in size.')
    # One shared palette keeps colours stable across frames.
    palette = images[len(images) // 2].quantize(colors=96, method=Image.Quantize.MEDIANCUT)
    images = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in images]
    images[0].save(args.output, save_all=True, append_images=images[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f'{args.output}: {len(images)} frames, {sum(durations) / 1000:.1f} s, {args.output.stat().st_size / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
