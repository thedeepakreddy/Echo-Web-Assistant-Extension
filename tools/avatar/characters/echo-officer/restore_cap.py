"""Rebuild the top of the officer's cap, which the original picture cuts off.

    python3 tools/avatar/characters/echo-officer/restore_cap.py

Reads original.jpg / original_cutout.png and writes source.jpg / cutout.png
with PAD extra rows on top, where the crown is completed:
  * the crown's two side edges (fitted from the picture) continue upward and
    close into a rounded dome, as a peaked cap looks from slightly below;
  * the dome is filled with the cap's own fabric colours, continuing the
    left-warm / right-cool shading, darkening toward the top with a soft rim;
  * the gold badge gets its missing top by mirroring its own upper rows under
    an arched shield outline.
config.json coordinates are in the padded picture (original y + PAD).
"""
import os

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
PAD = 90                   # rows added above the original picture
OVERLAP = 4                # original rows the rebuilt crown also covers (the cut edge is soft)
DOME_START = -18           # original-y where the straight sides turn into the dome
DOME_TOP = -62             # original-y of the top of the crown
BADGE = (1009, 1111)       # gold badge span on the top row
BADGE_TOP = -24            # original-y of the rebuilt badge peak


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def main():
    rgb = np.asarray(Image.open(os.path.join(HERE, 'original.jpg')).convert('RGB'), np.float32)
    alpha = np.asarray(Image.open(os.path.join(HERE, 'original_cutout.png')).convert('RGBA'), np.float32)[..., 3]
    h, w = alpha.shape

    # Fit the crown's side edges on the rows just below the cut.
    ys = np.arange(2, 50)
    left = np.polyfit(ys, [np.nonzero(alpha[y] > 128)[0].min() for y in ys], 1)
    right = np.polyfit(ys, [np.nonzero(alpha[y] > 128)[0].max() for y in ys], 1)
    xl = lambda y: np.polyval(left, y)
    xr = lambda y: np.polyval(right, y)

    # New canvas: the background above is mirrored so edge colours stay natural.
    out = np.zeros((h + PAD, w, 3), np.float32)
    out[PAD:] = rgb
    out[:PAD] = rgb[PAD:0:-1]
    out_a = np.zeros((h + PAD, w), np.float32)
    out_a[PAD:] = alpha / 255

    Y, X = np.mgrid[-PAD:OVERLAP, 0:w].astype(np.float32)    # original-y coordinates for the pad
    # Crown outline: straight sides up to DOME_START, then an elliptical dome.
    a0, b0 = xl(DOME_START), xr(DOME_START)
    cx, hw = (a0 + b0) / 2, (b0 - a0) / 2
    u = np.clip((X - cx) / hw, -1, 1)
    dome_y = DOME_START - (DOME_START - DOME_TOP) * np.sqrt(1 - u * u)
    sides = (X >= xl(Y)) & (X <= xr(Y))
    inside_dome = (np.abs(X - cx) <= hw) & (Y >= dome_y)
    crown = np.where(Y >= DOME_START, sides, inside_dome).astype(np.float32)
    crown = np.clip(ndimage.gaussian_filter(crown, 0.9) * 1.15, 0, 1)   # soft, anti-aliased edge

    # Fabric: each column's colour from the rows just below the cut (badge
    # columns interpolated from their neighbours), shaded like a dome.
    base = rgb[3:9].mean(0)                                    # (w, 3)
    cols = np.arange(w)
    fabric_cols = (cols < BADGE[0] - 12) | (cols > BADGE[1] + 12)
    for c in range(3):
        base[:, c] = np.interp(cols, cols[fabric_cols], ndimage.uniform_filter1d(base[:, c], 25)[fabric_cols])
    depth = np.clip((Y - dome_y) / 24, 0, 1)                  # 0 at the dome edge, 1 inside
    shade = 0.78 + 0.22 * np.clip((Y - DOME_TOP) / (0 - DOME_TOP), 0, 1)   # darker toward the top
    rim = (1 - depth) * 0.35                                   # a soft highlight along the top rim
    fabric = base[None, :, :] * shade[..., None] + np.array([70, 60, 70], np.float32) * rim[..., None] * (Y < DOME_START + 6)[..., None]

    # Badge: mirror its top rows up under an arched shield top.
    bcx, bhw = (BADGE[0] + BADGE[1]) / 2, (BADGE[1] - BADGE[0]) / 2
    bu = np.clip((X - bcx) / bhw, -1, 1)
    arch = BADGE_TOP * np.sqrt(np.clip(1 - bu ** 2, 0, 1)) ** 0.6
    badge = ((np.abs(X - bcx) <= bhw) & (Y >= arch)).astype(np.float32)
    badge = ndimage.gaussian_filter(badge, 0.8)
    mirror_rows = np.clip((-Y).astype(int), 0, h - 1)
    badge_px = rgb[mirror_rows, np.clip(X.astype(int), 0, w - 1)]
    edge = np.clip((Y - arch) / 3, 0, 1)[..., None]            # darker gold outline on the arch
    badge_px = badge_px * (0.62 + 0.38 * edge)

    pad_rgb = fabric * (1 - badge[..., None]) + badge_px * badge[..., None]
    n = PAD + OVERLAP
    # In the overlap rows the original's own pixels win wherever they are solid.
    orig_a = out_a[:n].copy()
    fill = crown * (1 - orig_a)
    out[:n] = out[:n] * (1 - fill[..., None]) + pad_rgb * fill[..., None]
    out_a[:n] = np.maximum(orig_a, crown)

    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(os.path.join(HERE, 'source.jpg'), quality=95)
    rgba = np.dstack([np.clip(out, 0, 255), np.clip(out_a * 255, 0, 255)]).astype(np.uint8)
    Image.fromarray(rgba, 'RGBA').save(os.path.join(HERE, 'cutout.png'))
    print('restored cap: picture is now', w, 'x', h + PAD)


if __name__ == '__main__':
    main()
