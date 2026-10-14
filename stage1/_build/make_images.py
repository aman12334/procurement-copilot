"""Turns the Chrome screenshot of the Vendor 4 rate card into imperfect 'photo' variants."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "images"
OUT.mkdir(exist_ok=True)
rng = np.random.default_rng(14)

raw = Image.open(sys.argv[1]).convert("RGB")
a = np.asarray(raw)
# crop to the cream sheet (rows that are not pure white)
nonwhite = np.where((a < 250).any(axis=2).any(axis=1))[0]
sheet = raw.crop((0, 0, raw.width, int(nonwhite.max()) + 4))
SCALE = 2  # Chrome device scale factor
ROW22 = (int(1605), int(1662))  # CP-022 row band in screenshot pixels


def noise(img, sigma=4.0):
    arr = np.asarray(img).astype(np.float32)
    arr += rng.normal(0, sigma, arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def lighting(img, strength=0.18, direction="tl"):
    w, h = img.size
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    g = (x / w + y / h) / 2 if direction == "tl" else (1 - x / w + y / h) / 2
    shade = 1 - strength * g
    arr = np.asarray(img).astype(np.float32) * shade[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def glare(img, cx, cy, r, amount=0.55):
    w, h = img.size
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((x - cx) / r) ** 2 + ((y - cy) / (r * 0.6)) ** 2)
    m = np.clip(1 - d, 0, 1) ** 1.6 * amount
    arr = np.asarray(img).astype(np.float32)
    arr = arr * (1 - m[..., None]) + 255 * m[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def perspective(img, corners, bg=(92, 74, 58), pad=140):
    """Place img on a desk background, mapping its corners to `corners` (tl,tr,br,bl offsets in px)."""
    w, h = img.size
    W, H = w + 2 * pad, h + 2 * pad
    dst = [(pad + dx, pad + dy) for dx, dy in [(corners[0][0], corners[0][1]), (w + corners[1][0], corners[1][1]),
                                                 (w + corners[2][0], h + corners[2][1]), (corners[3][0], h + corners[3][1])]]
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    A, B = [], []
    for (X, Y), (u, v) in zip(dst, src):
        A.append([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); B.append(u)
        A.append([0, 0, 0, X, Y, 1, -v * X, -v * Y]); B.append(v)
    coeffs = np.linalg.solve(np.array(A, float), np.array(B, float))
    desk = Image.new("RGB", (W, H), bg)
    desk = noise(desk, 9).filter(ImageFilter.GaussianBlur(1.2))
    mask = Image.new("L", img.size, 255)
    warped = img.transform((W, H), Image.PERSPECTIVE, tuple(coeffs), Image.BICUBIC)
    wmask = mask.transform((W, H), Image.PERSPECTIVE, tuple(coeffs), Image.BICUBIC)
    shadow = wmask.filter(ImageFilter.GaussianBlur(18))
    desk.paste((40, 30, 22), (14, 18), shadow)
    desk.paste(warped, (0, 0), wmask)
    return desk


def finish(img, width=1600, blur=0.6, sigma=3.5):
    img = img.filter(ImageFilter.GaussianBlur(blur))
    img = img.resize((width, int(img.height * width / img.width)), Image.LANCZOS)
    return noise(img, sigma)


# 1. clear – straight capture, mild sensor noise
finish(sheet, width=1800, blur=0.3, sigma=2.0).save(OUT / "vendor_4_rate_card_clear.png")

# 2. angled – perspective + rotation + uneven lighting
ang = perspective(lighting(sheet, 0.16), [(30, 6), (-18, 22), (12, -4), (-4, -16)])
ang = ang.rotate(1.6, resample=Image.BICUBIC, expand=True, fillcolor=(88, 70, 55))
finish(lighting(ang, 0.22, "tr"), width=1700, blur=0.9, sigma=4.5).save(OUT / "vendor_4_rate_card_angled.png")

# 3. partial – imperfect framing (header & footer cut, left edge clipped), smudged CP-022 row
p = sheet.copy()
band = p.crop((0, ROW22[0], p.width, ROW22[1])).filter(ImageFilter.GaussianBlur(2.0))
p.paste(band, (0, ROW22[0]))
d = ImageDraw.Draw(p, "RGBA")
d.ellipse((1500, ROW22[0] - 18, 2140, ROW22[1] + 22), fill=(120, 110, 95, 70))  # ink/finger smudge over rate cell
p = p.crop((70, 130, p.width - 10, 2560))
p = p.rotate(-1.4, resample=Image.BICUBIC, expand=False, fillcolor=(60, 50, 42))
finish(lighting(p, 0.20), width=1600, blur=0.7, sigma=4.0).save(OUT / "vendor_4_rate_card_partial.png")

# 4. glare – overhead light reflection across middle rows
g = perspective(sheet, [(20, 10), (-15, 20), (0, 0), (0, -10)], pad=90)
g = glare(g, cx=g.width * 0.62, cy=g.height * 0.42, r=g.width * 0.35, amount=0.72)
finish(lighting(g, 0.25), width=1700, blur=0.8, sigma=4.0).save(OUT / "vendor_4_rate_card_glare.png")
print("images written")
