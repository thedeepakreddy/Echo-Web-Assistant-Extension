"""Build ECHO's animated character layers from one flat illustration.

    swift tools/avatar/cutout.swift tools/avatar/characters/<id>/source.jpg tools/avatar/characters/<id>/cutout.png
    python3 tools/avatar/build_avatar.py <id>

Each character lives in tools/avatar/characters/<id>/ with its picture and a
config.json of hand-traced geometry; the layers land in
src/assets/characters/<id>/. See tools/avatar/README.md to add a character.

Every layer is written at the same canvas size so the content script can stack
them with `inset: 0`:

    body        shoulders and neck (static, fades out at the bottom)
    head        face and hair, with the irises painted out of the eyes
    iris        both irises, moved to follow the cursor, clipped by eyemask
    eyemask     the eye openings (alpha mask)
    blink1..5   the upper eyelid lowered in five steps, drawn over the irises
    mouth-*     mouth shapes (visemes, see VISEMES), drawn over the head

plus portrait.webp (a square face crop) and layout.json (anchor points for
the animation, in % of the canvas).
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, '..', '..', 'src', 'assets', 'characters')
OUT_W = 480                           # canvas width; height follows the crop's aspect

# Filled from characters/<id>/config.json by load_character().
CFG = {}
OUT = CROP = L_EYE = R_EYE = IRISES = MOUTH_X = NECK_PIVOT = None
OUT_H = 0
# Pixel sizes below (lash thickness, mouth opening, blurs...) were tuned on
# Echo, whose irises sit 366 px apart; `scale` in config.json adjusts them
# for a face drawn larger or smaller.
S = 1.0


def px(v):
    """A size tuned on Echo, scaled to this character."""
    return v * S


def ipx(v):
    return max(1, int(round(v * S)))


def almond(spec):
    """An eye outline: either a traced polygon, or four traced points —
    {"corners": [[x,y],[x,y]], "top": [x,y], "bottom": [x,y]} — joined by
    smooth lid curves (quadratic curves through the top and bottom points)."""
    if isinstance(spec, list):
        return [tuple(p) for p in spec]
    if 'ellipse' in spec:          # round cartoon eyeballs
        cx, cy, rx, ry = spec['ellipse']
        a = np.linspace(0, 2 * np.pi, 32, endpoint=False)
        return [(round(cx + rx * np.cos(t)), round(cy + ry * np.sin(t))) for t in a]
    (ax, ay), (bx, by) = spec['corners']
    def lid(through, steps=12):
        # control point so the curve passes through `through` at its middle
        cx, cy = 2 * through[0] - (ax + bx) / 2, 2 * through[1] - (ay + by) / 2
        pts = []
        for i in range(steps + 1):
            t = i / steps
            pts.append((round((1 - t) ** 2 * ax + 2 * (1 - t) * t * cx + t * t * bx),
                        round((1 - t) ** 2 * ay + 2 * (1 - t) * t * cy + t * t * by)))
        return pts
    upper = lid(spec['top'])
    lower = lid(spec['bottom'])[1:-1][::-1]
    return upper + lower


def load_character(cid):
    global CFG, OUT, CROP, L_EYE, R_EYE, IRISES, MOUTH_X, NECK_PIVOT, OUT_H, S
    with open(os.path.join(HERE, 'characters', cid, 'config.json')) as fh:
        CFG = json.load(fh)
    OUT = os.path.join(ASSETS, cid)
    CROP = tuple(CFG['crop'])
    L_EYE = almond(CFG['eyes']['left'])
    R_EYE = almond(CFG['eyes']['right'])
    IRISES = [tuple(i) for i in CFG['eyes']['irises']]
    MOUTH_X = tuple(CFG['mouth']['corners'])
    NECK_PIVOT = tuple(CFG['neck']['pivot'])
    OUT_H = round(OUT_W * (CROP[3] - CROP[1]) / (CROP[2] - CROP[0]))
    S = float(CFG.get('scale', 1.0))


# The shared contract with src/content/avatar.tsx: every character provides
# these blink steps and mouth shapes, under these file names.
BLINK_STEPS = [0.2, 0.4, 0.6, 0.8, 1.0]  # eyelid positions, one frame each
# Mouth shapes (visemes). open: lip gap in px; width: mouth width factor;
# round: gap profile (<1 rounder); up: share of the gap from the upper lip.
VISEMES = {
    'C': dict(open=9, width=1.0, round=0.9, up=0.25, teeth=0.5, tongue=0),    # t d n s k ...
    'E': dict(open=16, width=1.1, round=1.2, up=0.25, teeth=0.55, tongue=0, lower_teeth=True),  # ee, i
    'A1': dict(open=26, width=0.96, round=0.8, up=0.2, teeth=0.35, tongue=0.6, flat=0.2),  # short ah
    'A2': dict(open=42, width=0.9, round=0.7, up=0.2, teeth=0.3, tongue=1, flat=0.35),     # wide ah
    'O': dict(open=34, width=0.62, round=0.45, up=0.3, teeth=0.15, tongue=0.4, flat=0.75),  # oh
    'U': dict(open=15, width=0.5, round=0.5, up=0.4, teeth=0, tongue=0, flat=0.7),          # oo, w
}
NECK_PIVOT = (1000, 1400)             # the head turns around the base of the neck


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def poly_mask(poly, size):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).polygon(poly, fill=255)
    return np.asarray(m, np.float32) / 255


def sample(img, ys, xs):
    """Bilinear sample of an HxWxC image at float coordinates."""
    return np.stack([ndimage.map_coordinates(img[..., c], [ys, xs], order=1, mode='nearest')
                     for c in range(img.shape[2])], -1)


def decontaminate(rgb, alpha):
    """Remove the old background's tint from semi-transparent edge pixels."""
    h, w = alpha.shape
    ys, xs = np.nonzero(alpha[::8, ::8] == 0)
    ys, xs = ys * 8, xs * 8
    def basis(y, x):
        y, x = y / h, x / w
        return np.stack([np.ones_like(x), x, y, x * y, x * x, y * y], -1)
    coef, *_ = np.linalg.lstsq(basis(ys, xs), rgb[ys, xs], rcond=None)
    gy, gx = np.mgrid[0:h, 0:w].astype(np.float32)
    bg = basis(gy, gx) @ coef
    a = alpha[..., None]
    fg = (rgb - (1 - a) * bg) / np.maximum(a, 0.05)
    edge = ((alpha > 0) & (alpha < 1))[..., None]
    return np.where(edge, np.clip(fg, 0, 255), rgb)


def paint_out_iris(rgb, open_mask, iris):
    """Fill the iris with sclera sampled from each row, so a moved iris leaves eye-white behind."""
    cx, cy, r = iris
    out = rgb.copy()
    filled = np.zeros(open_mask.shape, bool)
    last = None
    rows = [y for y in range(cy - r - 2, cy + r + 3) if 0 <= y < open_mask.shape[0] and open_mask[y].any()]
    # Work bottom-up so rows hidden under the upper lid inherit the row below.
    for y in sorted(rows, reverse=True):
        span = np.nonzero(open_mask[y] > 0.5)[0]
        if len(span) == 0:
            continue
        half = np.sqrt(max(r * r - (y - cy) ** 2, 0)) + px(3)
        il, ir = int(cx - half), int(cx + half)
        left = span[span < il - 1]
        right = span[span > ir + 1]
        lc = rgb[y, left[-4:]].mean(0) if len(left) >= 2 else None
        rc = rgb[y, right[:4]].mean(0) if len(right) >= 2 else None
        if lc is None and rc is None:
            if last is None:
                continue
            lc, rc = last[0] * 0.85, last[1] * 0.85
        lc = rc if lc is None else lc
        rc = lc if rc is None else rc
        last = (lc, rc)
        xs = np.arange(max(il, span[0]), min(ir, span[-1]) + 1)
        t = ((xs - il) / max(ir - il, 1))[:, None]
        out[y, xs] = lc * (1 - t) + rc * t
        filled[y, xs] = True
    # Soften banding inside the painted area only.
    blurred = np.stack([ndimage.gaussian_filter(out[..., c], px(2.5)) for c in range(3)], -1)
    out[filled] = blurred[filled]
    return out


def iris_sprite(rgb, open_mask, iris, canvas):
    """A whole iris disc: visible part from the image, the part under the lids filled in darker."""
    cx, cy, r = iris
    h, w = open_mask.shape
    gy, gx = np.mgrid[0:h, 0:w]
    disc = np.clip(r + 1.5 - np.hypot(gx - cx, gy - cy), 0, 1)
    inside = ndimage.binary_erosion(open_mask > 0.5, iterations=ipx(2))
    for x in range(cx - r - 2, cx + r + 3):
        col = np.nonzero(inside[:, x])[0]
        col = col[(col > cy - r - 2) & (col < cy + r + 2)]
        for y in range(cy - r - 2, cy + r + 3):
            if disc[y, x] <= 0:
                continue
            if len(col) and col[0] <= y <= col[-1]:
                c = rgb[y, x]
            elif len(col) and y < col[0]:
                c = rgb[min(col[0] + ipx(2), col[-1]), x] * 0.55   # under the upper lid, in its shadow
            elif len(col):
                c = rgb[max(col[-1] - ipx(2), col[0]), x] * 0.8
            else:
                c = np.array([40, 26, 22], np.float32)
            canvas[y, x, :3] = c
            canvas[y, x, 3] = disc[y, x]


def lid_bounds(poly, size):
    m = poly_mask(poly, size) > 0.5
    cols = {}
    for x in range(min(p[0] for p in poly), max(p[0] for p in poly) + 1):
        ys = np.nonzero(m[:, x])[0]
        if len(ys):
            cols[x] = (ys[0], ys[-1])
    return cols


def lash_top(lum, x, u):
    """Top of the dark upper lash line in column x, scanning up from the lid edge u."""
    y = u - 1
    while y > u - px(40) and not (lum[y - ipx(3):y, x] > 120).all():
        y -= 1
    return int(np.clip(y, u - px(34), u - px(10)))


def blink_frame(rgb, lum, closed, size):
    """Lower the upper lid over the eye; `closed` 0..1 is how far it has travelled.

    The lid is painted as rounded, shaded skin (stretching the real lid smears
    the lashes) and the lash line rides on its edge, casting a soft shadow on
    the eye below. Fully closed, the lash line is flipped so the lashes hang
    down from the shut lid.
    """
    h, w = size[1], size[0]
    out = np.zeros((h, w, 4), np.float32)
    shadow = np.array([45, 22, 24], np.float32)
    for poly in (L_EYE, R_EYE):
        bounds = lid_bounds(poly, size)
        cols = sorted(bounds)
        # Lashes have gaps, so per-column readings are noisy: smooth them across the eye.
        lts = ndimage.median_filter(np.array([lash_top(lum, x, bounds[x][0]) for x in cols], np.float32), 9)
        # Err upward so no lash tips poke out above the lowered lid.
        lts = np.round(ndimage.gaussian_filter1d(lts, px(2))).astype(int) - ipx(5)
        # The lid shades from the skin above the lashes to the skin under the eye,
        # so it meets the face on both sides.
        def skin(x, y0, y1):
            # The brighter half of the samples: skips the crease and stray lashes.
            px = rgb[y0:y1, x]
            l = px @ np.array([0.299, 0.587, 0.114], np.float32)
            return px[l >= np.median(l)].mean(0)
        above = np.array([skin(x, lt - ipx(14), lt - 1) for x, lt in zip(cols, lts)])
        below = np.array([rgb[bounds[x][1] + ipx(10):bounds[x][1] + ipx(10) + ipx(6), x].mean(0) for x in cols])
        above = ndimage.gaussian_filter1d(above, px(8), axis=0)
        below = ndimage.gaussian_filter1d(below, px(8), axis=0)
        span = cols[-1] - cols[0]
        for x, lt, sa, sb in zip(cols, lts, above, below):
            u, b = bounds[x]
            across = (x - cols[0]) / span
            side = smoothstep(0, px(10), min(x - cols[0], cols[-1] - x))
            band = rgb[lt:u + 1, x]                     # lash line, top (tips) to bottom (lid edge)
            k = len(band)
            edge = u + closed * (b - u)
            ys = np.arange(lt, h)
            line = (b - px(2)) if closed >= 1 else edge
            lid_end = line if closed >= 1 else edge - k
            g = np.clip((ys - lt) / max(lid_end - lt, 1), 0, 1)
            # A lid is a rounded surface: lit across the middle, darker into the
            # lash line and toward the corners of the eye.
            shade = (1 + 0.07 * np.sin(np.pi * g) - 0.16 * smoothstep(0.7, 1.0, g) * (closed >= 1)
                     ) * (1 - 0.07 * (1 - np.sin(np.pi * across)))
            col = (sa + (sb - sa) * g[:, None]) * shade[:, None]
            cover = np.zeros(len(ys), np.float32)
            if closed < 1:
                j = (ys - lid_end).astype(int)
                on = (j >= 0) & (j < k)
                col[on] = band[j[on]]
                cover[:] = np.clip(edge + 1 - ys, 0, 1)
                # The lid's shadow falls on the eye just below its edge.
                below_edge = (ys > edge) & (ys < edge + px(8))
                sh = 0.45 * (1 - (ys[below_edge] - edge) / px(8)) * min(1, closed * 3)
                col[below_edge] = shadow
                cover[below_edge] = sh
            else:
                # Near the corners the eye is too thin to flip the lashes cleanly.
                flip = smoothstep(px(4), px(14), b - u)
                cover[:] = (ys <= line).astype(np.float32)
                fb = band[::-1]
                lum_fb = fb @ np.array([0.299, 0.587, 0.114], np.float32)
                for n in range(k):
                    y = int(line) + n
                    if y - lt >= len(ys):
                        break
                    a = (np.clip((150 - lum_fb[n]) / 60, 0, 1) if n > px(4) else 1.0) * flip
                    col[y - lt] = col[y - lt] * (1 - a) + fb[n] * a if cover[y - lt] else fb[n]
                    cover[y - lt] = max(cover[y - lt], a)
                # Where the flip fades out, keep the original lash line on the lid edge instead.
                if flip < 1:
                    for n in range(k):
                        y = int(line) - k + 1 + n
                        col[y - lt] = col[y - lt] * flip + band[n] * (1 - flip)
            # Blend into the untouched skin above the lid.
            t = np.clip((ys - lt) / px(10), 0, 1)[:, None]
            col = rgb[ys, x] * (1 - t) + col * t
            keep = cover > 0
            out[ys[keep], x, :3] = col[keep]
            out[ys[keep], x, 3] = cover[keep] * side
    return out


def lip_line(lum):
    """The line between the lips, per column. A traced `mouth.line` polyline
    guides the search (needed when a tilted mouth shares rows with the
    nostrils); otherwise the darkest row inside `mouth.lip_search` wins."""
    xs = np.arange(MOUTH_X[0] - ipx(12), MOUTH_X[1] + ipx(12) + 1)
    traced = CFG['mouth'].get('line')
    if traced:
        tx, ty = zip(*sorted(traced))
        guide = np.interp(xs, tx, ty)
        r = ipx(4)
        ys = np.array([g - r + np.argmin(lum[int(g) - r:int(g) + r + 1, x]) for x, g in zip(xs, guide)], np.float32)
    else:
        y0, y1 = CFG['mouth']['lip_search']
        ys = np.array([y0 + np.argmin(lum[y0:y1, x]) for x in xs], np.float32)
    ys = ndimage.gaussian_filter1d(ys, px(3))
    return xs.astype(np.float32), ys

def mouth_frame(rgb, alpha, line, shape, size):
    """One mouth shape (viseme): lips parted by `open` px and the mouth made
    `width` times as wide, with teeth, tongue and a slight jaw drop.

    The warp is the identity at the patch border, so the patch drops onto the
    face without a seam.
    """
    h, w = size[1], size[0]
    out = np.zeros((h, w, 4), np.float32)
    # A grin or a tilted smirk distorts if its corners are pulled far in, so
    # `mouth.rounding` (0..1) tones down how much "oh"/"oo" narrow the mouth.
    k = float(CFG['mouth'].get('rounding', 1.0))
    shape = {**shape, 'width': 1 - (1 - shape['width']) * k, 'flat': shape.get('flat', 0) * k}
    opening, width, roundness = px(shape['open']), shape['width'], shape['round']
    if CFG['mouth'].get('grin'):
        # The picture already shows teeth: keep them fixed and drop the jaw,
        # rather than drawing a second row of teeth.
        shape = {**shape, 'teeth': 0, 'lower_teeth': False, 'up': 0.0}
    flat = shape.get('flat', 0)            # 1 = corners pulled level with the centre (no smile)
    lx, ly = line
    x0, x1 = MOUTH_X
    xc, half = (x0 + x1) / 2, (x1 - x0) / 2
    reach = half * 1.7                      # horizontal influence of the warp
    top_y, bot_y = int(ly.min() - px(80)), int(ly.max() + px(125))
    left, right = int(xc - reach) - 2, int(xc + reach) + 2
    Y, X = np.mgrid[top_y:bot_y + 1, left:right + 1].astype(np.float32)

    # Horizontal: pull the corners in (rounded vowels) or out (spread vowels),
    # only around the lips.
    ln_out = np.interp(X, lx, ly)
    u = np.abs(X - xc)
    a = half * width * 1.05
    d = np.where(u < a, u / width, a / width + (u - a) * (reach - a / width) / (reach - a))
    d = np.where(u > reach, u, d)
    gy = 1 - smoothstep(px(20), px(65), np.abs(Y - ln_out))
    xs = xc + np.sign(X - xc) * (u + (d - u) * gy)

    # Vertical: part the lips along the lip line.
    ln = np.interp(xs, lx, ly)
    tt = np.clip((X - (xc - half * width)) / (2 * half * width), 0, 1)
    gap = opening * np.clip(np.sin(np.pi * tt), 0, 1) ** roundness
    up, down = shape['up'] * gap, (1 - shape['up']) * gap
    above, below = px(45.0), px(115.0)
    # Rounded vowels lose the smile: the parting line drops toward the centre's height.
    lnf = ln + flat * (ly.max() - ln) * (1 - smoothstep(0.8, 1.25, np.abs(X - xc) / (half * width)))
    top, bot = lnf - up, lnf + down
    ys = Y.copy()
    m = (Y < top) & (Y > ln - above)
    ys[m] = (ln - above)[m] + (Y - (ln - above))[m] * above / np.maximum(above - up, 1e-3)[m]
    m = (Y > bot) & (Y < ln + below)
    ys[m] = ln[m] + (Y - bot)[m] * below / np.maximum(below - down, 1e-3)[m]
    m = (Y >= top) & (Y <= bot)
    ys[m] = ln[m]
    pix = np.stack([ndimage.map_coordinates(rgb[..., c], [ys, xs], order=1, mode='nearest')
                   for c in range(3)], -1)

    # Inside the mouth: upper teeth, dark interior, tongue at the back.
    g = np.clip((Y - top) / np.maximum(gap, 1e-3), 0, 1)
    side = 1 - smoothstep(0.5, 0.95, np.abs(X - xc) / (half * width))
    dark = np.array([52, 16, 22], np.float32)
    tongue = np.array([160, 66, 74], np.float32)
    teeth = np.array([238, 232, 228], np.float32)
    col = dark + (tongue - dark) * (smoothstep(0.55, 1.0, g) * smoothstep(px(14), px(30), gap) * shape['tongue'])[..., None]
    col *= (0.55 + 0.45 * side)[..., None]
    th = np.minimum(shape['teeth'] * gap, px(11))
    tw = (1 - smoothstep(th - px(1.5), th + px(0.5), Y - top)) * side * smoothstep(px(4), px(10), gap) * (shape['teeth'] > 0)
    col = col * (1 - tw[..., None]) + teeth * (0.78 + 0.22 * side)[..., None] * tw[..., None]
    if shape.get('lower_teeth'):
        lb = np.minimum(0.18 * gap, px(5))
        lw = (1 - smoothstep(lb - px(1), lb + px(0.5), bot - Y)) * side * smoothstep(px(8), px(14), gap)
        col = col * (1 - lw[..., None]) + teeth * 0.85 * lw[..., None]
    cover = np.clip(np.minimum(Y - top + 1, bot + 1 - Y), 0, 1) * (gap > 0.5)
    pix = pix * (1 - cover[..., None]) + col * cover[..., None]

    fade = (smoothstep(0, px(10), Y - top_y) * smoothstep(0, px(10), bot_y - Y) *
            smoothstep(0, px(10), X - left) * smoothstep(0, px(10), right - X))
    src_a = ndimage.map_coordinates(alpha, [ys, xs], order=1, mode='nearest')
    out[top_y:bot_y + 1, left:right + 1, :3] = pix
    out[top_y:bot_y + 1, left:right + 1, 3] = fade * np.maximum(src_a, cover)
    return out


def portrait(rgb, head_rgb, head_a, open_masks):
    """A square head-and-shoulders crop for the settings picker and chat header."""
    ex = (IRISES[0][0] + IRISES[1][0]) / 2
    ey = (IRISES[0][1] + IRISES[1][1]) / 2
    side = (IRISES[1][0] - IRISES[0][0]) * 3.1
    box = (int(ex - side / 2), int(ey - side * 0.52), int(ex + side / 2), int(ey + side * 0.48))
    # Use the untouched eyes (the head layer has its irises painted out).
    eyes = np.maximum(*open_masks)[..., None]
    face = head_rgb * (1 - eyes) + rgb * eyes
    img = Image.fromarray(np.clip(np.dstack([face, head_a * 255]), 0, 255).astype(np.uint8), 'RGBA').crop(box)
    img = img.convert('RGBa').resize((192, 192), Image.LANCZOS).convert('RGBA')
    img.save(os.path.join(OUT, 'portrait.webp'), 'WEBP', quality=90, method=6)


def save(arr, name, mode='RGBA', lossless=False):
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode).crop(CROP)
    if mode == 'RGBA':
        img = img.convert('RGBa').resize((OUT_W, OUT_H), Image.LANCZOS).convert('RGBA')
        img.save(os.path.join(OUT, name + '.webp'), 'WEBP', quality=90, method=6, lossless=lossless)
    else:
        img.resize((OUT_W, OUT_H), Image.LANCZOS).save(os.path.join(OUT, name + '.png'), optimize=True)


def main(cid):
    load_character(cid)
    src = os.path.join(HERE, 'characters', cid)
    os.makedirs(OUT, exist_ok=True)
    rgb = np.asarray(Image.open(os.path.join(src, 'source.jpg')).convert('RGB'), np.float32)
    alpha = np.asarray(Image.open(os.path.join(src, 'cutout.png')).convert('RGBA'), np.float32)[..., 3] / 255
    alpha = np.clip((alpha - 0.08) / 0.92, 0, 1)          # choke the matte slightly
    rgb = decontaminate(rgb, alpha)
    h, w = alpha.shape
    size = (w, h)
    gy = np.mgrid[0:h, 0:w][0].astype(np.float32)

    # The source is cropped at the chest; fade the body out instead of a hard edge.
    fade = 1 - smoothstep(*CFG['body_fade'], gy)
    body_a = alpha * smoothstep(*CFG['neck']['body_from'], gy) * fade
    # Shoulders cut off by the picture's (or the crop's) sides fade out
    # instead of ending in a hard vertical edge.
    if CFG.get('side_fade'):
        gx = np.mgrid[0:h, 0:w][1].astype(np.float32)
        left, right = max(CROP[0], 0), min(CROP[2], w)
        edge = CFG['side_fade'] * (CROP[2] - CROP[0])
        body_a *= smoothstep(left, left + edge, gx) * smoothstep(right, right - edge, gx)
    head_a = alpha * (1 - smoothstep(*CFG['neck']['head_to'], gy))

    open_masks = [poly_mask(p, size) for p in (L_EYE, R_EYE)]
    head_rgb = rgb.copy()
    for m, iris in zip(open_masks, IRISES):
        head_rgb = paint_out_iris(head_rgb, m, iris)

    save(np.dstack([rgb, body_a * 255]), 'body')
    save(np.dstack([head_rgb, head_a * 255]), 'head')

    iris = np.zeros((h, w, 4), np.float32)
    for m, ir in zip(open_masks, IRISES):
        iris_sprite(rgb, m, ir, iris)
    iris[..., 3] *= 255
    save(iris, 'iris', lossless=True)

    eyemask = ndimage.gaussian_filter(np.maximum(*open_masks), px(1.0))
    save(np.dstack([np.full((h, w, 3), 255, np.float32), eyemask * 255]), 'eyemask', lossless=True)

    lum = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    for i, closed in enumerate(BLINK_STEPS, 1):
        f = blink_frame(rgb, lum, closed, size)
        f[..., 3] *= 255
        save(f, f'blink{i}', lossless=True)

    line = lip_line(lum)
    for name, shape in VISEMES.items():
        f = mouth_frame(rgb, head_a, line, shape, size)
        f[..., 3] *= 255
        save(f, f'mouth-{name.lower()}', lossless=True)   # lower-case: macOS paths ignore case

    cw, ch = CROP[2] - CROP[0], CROP[3] - CROP[1]
    def pct(x, y):
        return [round((x - CROP[0]) / cw * 100, 2), round((y - CROP[1]) / ch * 100, 2)]
    eyes_mid = ((IRISES[0][0] + IRISES[1][0]) / 2, (IRISES[0][1] + IRISES[1][1]) / 2)
    meta = {
        'aspect': round(cw / ch, 4),
        'pivot': pct(*NECK_PIVOT),                 # % of the canvas
        'eyes': pct(*eyes_mid),                    # % of the canvas
        'irisTravel': [round(CFG['eyes']['iris_travel'][0] / cw * 100, 3),
                       round(CFG['eyes']['iris_travel'][1] / ch * 100, 3)],   # max % shift x / y
        'tearL': pct(*L_EYE[0]),                   # outer eye corners, where tears well up
        'tearR': pct(*max(R_EYE)),
        'blinkSteps': len(BLINK_STEPS),
        'mouths': [n.lower() for n in VISEMES],
    }
    portrait(rgb, head_rgb, head_a, open_masks)
    with open(os.path.join(OUT, 'layout.json'), 'w') as fh:
        json.dump(meta, fh, indent=2)
    print(json.dumps(meta))


if __name__ == '__main__':
    import sys
    if len(sys.argv) != 2:
        sys.exit('usage: build_avatar.py <character-id>   (a folder in tools/avatar/characters/)')
    main(sys.argv[1])
