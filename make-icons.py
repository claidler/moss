#!/usr/bin/env python3
"""Rasterize the Moss blob icon to PNG sizes without extra deps."""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def png_rgba(w, h, pixels):
    def chunk(tag, data):
        raw = tag + data
        return struct.pack(">I", len(data)) + raw + struct.pack(">I", zlib.crc32(raw) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + bytes(pixels[y * w * 4 : (y + 1) * w * 4]) for y in range(h))
    return b"".join(
        [
            b"\x89PNG\r\n\x1a\n",
            chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)),
            chunk(b"IDAT", zlib.compress(rows, 9)),
            chunk(b"IEND", b""),
        ]
    )


def mix_rgb(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))


def over(dst, src_rgb, a):
    if a <= 0:
        return dst
    if a >= 1:
        return (src_rgb[0], src_rgb[1], src_rgb[2], 255)
    da = dst[3] / 255.0
    out_a = a + da * (1 - a)
    if out_a <= 0:
        return (0, 0, 0, 0)
    rgb = tuple(
        int(round((src_rgb[i] * a + dst[i] * da * (1 - a)) / out_a)) for i in range(3)
    )
    return (rgb[0], rgb[1], rgb[2], int(round(out_a * 255)))


def ellipse_cover(x, y, cx, cy, rx, ry):
    dx = (x - cx) / rx
    dy = (y - cy) / ry
    d = math.sqrt(dx * dx + dy * dy)
    # ~1px AA in ellipse-space
    edge = 0.5 * ((1 / rx) + (1 / ry))
    if d <= 1 - edge:
        return 1.0
    if d >= 1 + edge:
        return 0.0
    return max(0.0, min(1.0, (1 + edge - d) / (2 * edge)))


def render(size, *, pad=0.08, bg=(0, 0, 0, 0)):
    pix = bytearray(size * size * 4)
    # blob path roughly fills a 64x64 viewBox; map into padded square
    inner = size * (1 - 2 * pad)
    origin = size * pad
    scale = inner / 64.0

    def to_px(x, y):
        return origin + x * scale, origin + y * scale

    bcx, bcy = to_px(32.2, 33.0)
    brx, bry = 26.2 * scale, 27.4 * scale
    e1 = (*to_px(24.5, 30.0), 6.2 * scale, 7.8 * scale)
    e2 = (*to_px(40.2, 31.2), 5.4 * scale, 7.1 * scale)
    hi_cx, hi_cy = to_px(24.0, 20.0)
    cream = bg
    teal_hi = (138, 238, 224, 255)
    teal = (62, 197, 168, 255)
    teal_lo = (31, 143, 122, 255)
    white = (255, 255, 255, 255)

    for y in range(size):
        for x in range(size):
            i = (y * size + x) * 4
            col = cream
            cover = ellipse_cover(x + 0.5, y + 0.5, bcx, bcy, brx, bry)
            if cover > 0:
                hx = (x + 0.5 - hi_cx) / (brx * 1.2)
                hy = (y + 0.5 - hi_cy) / (bry * 1.2)
                t = min(1.0, math.sqrt(hx * hx + hy * hy))
                if t < 0.45:
                    blob = mix_rgb(teal_hi, teal, t / 0.45)
                else:
                    blob = mix_rgb(teal, teal_lo, min(1.0, (t - 0.45) / 0.55))
                col = over(col, blob, cover)

            for ex, ey, erx, ery in (e1, e2):
                ec = ellipse_cover(x + 0.5, y + 0.5, ex, ey, erx, ery)
                if ec > 0:
                    col = over(col, white[:3], ec)

            pix[i : i + 4] = bytes(col)
    return png_rgba(size, size, pix)


def main():
    (ROOT / "favicon-32.png").write_bytes(render(32))
    (ROOT / "apple-touch-icon.png").write_bytes(render(180))
    (ROOT / "icon-192.png").write_bytes(render(192))
    (ROOT / "icon-512.png").write_bytes(render(512))
    (ROOT / "icon-512-maskable.png").write_bytes(render(512, pad=0.18))
    print("wrote icons")


if __name__ == "__main__":
    main()
