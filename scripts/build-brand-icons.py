"""Render the Coach Studio raster icons from the SVGs.

    python scripts/build-brand-icons.py

Needs Python Playwright (Chromium) and Pillow, as the test harness does.
Sources: favicon.svg (the mark tuned for 16-48 px) and coach-studio-logo.svg
(the master). Writes, all committed:

    favicon.ico                          16, 32, 48 (PNG frames)   favicon.svg
    apple-touch-icon.png                 180, white background     coach-studio-logo.svg
    studio-assets/coach-studio-48.png    transparent               favicon.svg
    studio-assets/coach-studio-96.png    transparent               coach-studio-logo.svg
    studio-assets/coach-studio-192.png   transparent               coach-studio-logo.svg
    studio-assets/coach-studio-512.png   transparent               coach-studio-logo.svg
    studio-assets/coach-studio-app-icon.png  512, white background (upload
                                         it where an app icon is asked for,
                                         e.g. a ChatGPT app)

The master's inner shadow is dropped from the rasters: on a light background
it reads as a grey wedge inside the C. Backgrounds are opaque where the icon
may be flattened onto a colour we do not choose (iOS home screen, uploads).
"""
import io
import pathlib
import re
import struct
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SMALL = (ROOT / 'favicon.svg').read_text(encoding='utf-8')
MASTER = (ROOT / 'coach-studio-logo.svg').read_text(encoding='utf-8')

shadow = re.compile(r'\s*<path[^>]*opacity="\.16"[^>]*/>')
if not shadow.search(MASTER) or 'viewBox="0 0 128 128"' not in MASTER:
    sys.exit('coach-studio-logo.svg changed shape: update the variants in this script')
FLAT = shadow.sub('', MASTER)
LARGE = FLAT.replace('viewBox="0 0 128 128"', 'viewBox="7 7 114 114"', 1)      # cropped to the mark
PADDED = FLAT.replace('viewBox="0 0 128 128"', 'viewBox="-6 -6 140 140"', 1)    # iOS rounds the corners


def render(page, svg, size, background=None):
    sized = svg.replace('<svg ', '<svg width="%d" height="%d" ' % (size, size), 1)
    bg = background or 'transparent'
    page.set_content('<html><body style="margin:0;background:%s">%s</body></html>' % (bg, sized))
    png = page.screenshot(clip={'x': 0, 'y': 0, 'width': size, 'height': size}, omit_background=background is None)
    image = Image.open(io.BytesIO(png))
    image = image.convert('RGBA' if background is None else 'RGB')
    out = io.BytesIO()
    image.save(out, 'PNG', optimize=True)
    return out.getvalue()


def ico(frames):
    """An ICO whose frames are PNGs (every browser since IE9 reads these)."""
    head = struct.pack('<HHH', 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries, blobs = b'', b''
    for size, png in frames:
        entries += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(png), offset)
        blobs += png
        offset += len(png)
    return head + entries + blobs


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(device_scale_factor=1)
        files = {
            'favicon.ico': ico([(s, render(page, SMALL, s)) for s in (16, 32, 48)]),
            'apple-touch-icon.png': render(page, PADDED, 180, '#ffffff'),
            'studio-assets/coach-studio-48.png': render(page, SMALL, 48),
            'studio-assets/coach-studio-96.png': render(page, LARGE, 96),
            'studio-assets/coach-studio-192.png': render(page, LARGE, 192),
            'studio-assets/coach-studio-512.png': render(page, LARGE, 512),
            'studio-assets/coach-studio-app-icon.png': render(page, PADDED, 512, '#ffffff'),
        }
        browser.close()
    for rel, data in files.items():
        (ROOT / rel).write_bytes(data)
        print('%-42s %7d B' % (rel, len(data)))


if __name__ == '__main__':
    main()
