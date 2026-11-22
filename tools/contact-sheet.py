#!/usr/bin/env python3
"""Contact sheet for Crescent Bay (Builder C-2).

Composes the four screenshots exactly as the make.fun judge sees them:
cover large on top (768x320), three small below (256x160 each), total
768x480, JPEG quality ~80. Also writes a grayscale twin so the
two-second readability test can be checked without colour.

Usage: python3 tools/contact-sheet.py [repo-root]
Reads screenshots/1-cover.jpg, 2-mission.jpg, 3-night.jpg, 4-start.jpg
and writes contact-sheet/shots-contact-sheet.jpg plus
contact-sheet/shots-contact-sheet-gray.jpg.
"""

import sys
from pathlib import Path

from PIL import Image

SHEET_W = 768
SHEET_H = 480
COVER_H = 320
SMALL_W = 256
SMALL_H = 160
QUALITY = 80

ORDER = ["1-cover.jpg", "2-mission.jpg", "3-night.jpg", "4-start.jpg"]


def cover_crop(img, w, h):
    """Centre-crop an image to the target aspect ratio, then resize."""
    tw, th = img.size
    target = w / h
    have = tw / th
    if have > target:
        nw = int(th * target)
        x0 = (tw - nw) // 2
        img = img.crop((x0, 0, x0 + nw, th))
    else:
        nh = int(tw / target)
        y0 = (th - nh) // 2
        img = img.crop((0, y0, tw, y0 + nh))
    return img.resize((w, h), Image.LANCZOS)


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    shots_dir = root / "screenshots"
    out_dir = root / "contact-sheet"
    out_dir.mkdir(parents=True, exist_ok=True)

    frames = []
    for name in ORDER:
        path = shots_dir / name
        if not path.is_file():
            raise SystemExit(f"missing screenshot: {path}")
        frames.append(Image.open(path).convert("RGB"))

    sheet = Image.new("RGB", (SHEET_W, SHEET_H), (16, 18, 28))
    sheet.paste(cover_crop(frames[0], SHEET_W, COVER_H), (0, 0))
    for i, frame in enumerate(frames[1:]):
        sheet.paste(cover_crop(frame, SMALL_W, SMALL_H), (i * SMALL_W, COVER_H))

    colour_path = out_dir / "shots-contact-sheet.jpg"
    sheet.save(colour_path, "JPEG", quality=QUALITY)
    gray_path = out_dir / "shots-contact-sheet-gray.jpg"
    sheet.convert("L").convert("RGB").save(gray_path, "JPEG", quality=QUALITY)

    print(f"contact sheet: {colour_path} ({colour_path.stat().st_size} bytes)")
    print(f"grayscale twin: {gray_path} ({gray_path.stat().st_size} bytes)")
    print(f"sheet size: {sheet.size[0]}x{sheet.size[1]} (target 768x480)")


if __name__ == "__main__":
    main()
