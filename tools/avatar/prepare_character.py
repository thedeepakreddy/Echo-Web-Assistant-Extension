"""Draft a character's config.json from its face landmarks and cutout.

    swift tools/avatar/landmarks.swift characters/<id>/source.jpg characters/<id>/landmarks.json
    swift tools/avatar/cutout.swift characters/<id>/source.jpg characters/<id>/cutout.png <face x> <face y>
    python3 tools/avatar/prepare_character.py <id> "<Name>"
    python3 tools/avatar/prepare_character.py <id> --check out.png   # overlay to verify

The draft frames the character like Echo (same eye spacing to canvas width)
and derives every other measurement from the landmarks. Always look at the
--check overlay and fix anything that is off before building.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import interpolate

HERE = os.path.dirname(os.path.abspath(__file__))
ECHO_IRIS_GAP = 366.0          # Echo's iris spacing; the builder's sizes were tuned on it
ASPECT = 0.8                   # every character's canvas is 4:5, like the on-page widget


def smooth_ring(points, n=24):
    """A closed spline through the eye outline, resampled to n points."""
    p = np.array(points + [points[0]], dtype=float)
    tck, _ = interpolate.splprep([p[:, 0], p[:, 1]], s=0, per=True)
    x, y = interpolate.splev(np.linspace(0, 1, n, endpoint=False), tck)
    return [[int(round(a)), int(round(b))] for a, b in zip(x, y)]


def iris_radius(rgb, cx, cy, eye_w):
    """Walk out from the pupil until the pixels turn to bright, low-colour sclera."""
    lum = rgb @ np.array([0.299, 0.587, 0.114])
    sat = (rgb.max(-1) - rgb.min(-1)) / (rgb.max(-1) + 1)
    found = []
    for dy in range(-3, 4):
        y = int(cy) + dy
        for step in (-1, 1):
            for d in range(int(eye_w * 0.12), int(eye_w * 0.48)):
                x = int(cx) + step * d
                if lum[y, x] > 150 and sat[y, x] < 0.28:
                    found.append(d)
                    break
    return int(np.median(found)) if len(found) >= 4 else int(eye_w * 0.3)


def draft(cid, name):
    d = os.path.join(HERE, 'characters', cid)
    L = json.load(open(os.path.join(d, 'landmarks.json')))
    rgb = np.asarray(Image.open(os.path.join(d, 'source.jpg')).convert('RGB'), float)
    alpha = np.asarray(Image.open(os.path.join(d, 'cutout.png')).convert('RGBA'))[..., 3]
    img_w, img_h = L['size']

    eyes = sorted([L['leftEye'], L['rightEye']], key=lambda e: np.mean([p[0] for p in e]))
    pupils = sorted([L['leftPupil'][0], L['rightPupil'][0]], key=lambda p: p[0])
    gap = float(np.hypot(pupils[1][0] - pupils[0][0], pupils[1][1] - pupils[0][1]))
    scale = gap / ECHO_IRIS_GAP
    irises = []
    for eye, pupil in zip(eyes, pupils):
        eye_w = max(p[0] for p in eye) - min(p[0] for p in eye)
        irises.append([int(pupil[0]), int(pupil[1]), iris_radius(rgb, pupil[0], pupil[1], eye_w)])

    lips = L.get('innerLips') or L['outerLips']
    outer = L['outerLips']
    corners = [int(min(p[0] for p in outer)), int(max(p[0] for p in outer))]
    lip_search = [int(min(p[1] for p in lips) - 6 * scale), int(max(p[1] for p in lips) + 6 * scale)]

    chin = max(L['faceContour'], key=lambda p: p[1])
    fx, fy, fw, fh = L['face']
    neck = {
        'pivot': [int(chin[0]), int(chin[1] + 0.15 * fh)],
        'body_from': [int(chin[1] - 0.015 * fh), int(chin[1] + 0.05 * fh)],
        'head_to': [int(chin[1] + 0.11 * fh), int(chin[1] + 0.2 * fh)],
    }

    # Frame like Echo: from just above the head to about one face-height
    # below the chin (head and shoulders), 4:5, centred on the face.
    cx = fx + fw / 2
    cols = alpha[:, int(max(0, cx - 1.5 * gap)):int(min(img_w, cx + 1.5 * gap))] > 128
    head_top = int(np.argmax(cols.any(axis=1)))
    bottom_want = chin[1] + 1.1 * fh
    ch = (bottom_want - head_top) / 0.97
    cw = ch * ASPECT
    # Big hair or a wide hat must fit whole: the head has no side fade.
    head_rows = alpha[head_top:int(chin[1])] > 128
    xs = np.nonzero(head_rows.any(axis=0))[0]
    if len(xs) and (xs[-1] - xs[0]) * 1.08 > cw:
        cw = (xs[-1] - xs[0]) * 1.08
        ch = cw / ASPECT
        cx = (xs[0] + xs[-1]) / 2
    top = head_top - 0.03 * ch
    crop = [int(cx - cw / 2), int(top), int(cx + cw / 2), int(top + ch)]
    bottom = min(img_h, crop[3])

    cfg = {
        'name': name,
        'note': 'Drafted by prepare_character.py from Vision landmarks, then checked by eye.',
        'scale': round(scale, 3),
        'crop': crop,
        'eyes': {
            'left': smooth_ring(eyes[0]),
            'right': smooth_ring(eyes[1]),
            'irises': irises,
            'iris_travel': [int(18 * scale), max(2, int(5 * scale))],
        },
        'mouth': {'corners': corners, 'lip_search': lip_search},
        'neck': neck,
        'body_fade': [int(bottom - 0.12 * ch), int(bottom)],
        'side_fade': 0.07,
    }
    with open(os.path.join(d, 'config.json'), 'w') as fh_out:
        json.dump(cfg, fh_out, indent=2)
    return cfg


def check(cid, out_path):
    """Draw the config over the picture: crop, eye outlines, irises, mouth band, neck."""
    d = os.path.join(HERE, 'characters', cid)
    cfg = json.load(open(os.path.join(d, 'config.json')))
    im = Image.open(os.path.join(d, 'source.jpg')).convert('RGB')
    dr = ImageDraw.Draw(im)
    dr.rectangle(cfg['crop'], outline=(255, 255, 0), width=4)
    for poly in (cfg['eyes']['left'], cfg['eyes']['right']):
        dr.line([tuple(p) for p in poly + [poly[0]]], fill=(0, 255, 0), width=2)
    for x, y, r in cfg['eyes']['irises']:
        dr.ellipse([x - r, y - r, x + r, y + r], outline=(255, 0, 255), width=2)
    x0, x1 = cfg['mouth']['corners']
    y0, y1 = cfg['mouth']['lip_search']
    dr.rectangle([x0, y0, x1, y1], outline=(255, 64, 64), width=2)
    px, py = cfg['neck']['pivot']
    dr.ellipse([px - 8, py - 8, px + 8, py + 8], fill=(0, 200, 255))
    for key, colour in (('body_from', (0, 200, 255)), ('head_to', (255, 160, 0))):
        for y in cfg['neck'][key]:
            dr.line([(px - 120, y), (px + 120, y)], fill=colour, width=2)
    im.save(out_path)


if __name__ == '__main__':
    if len(sys.argv) >= 4 and sys.argv[2] == '--check':
        check(sys.argv[1], sys.argv[3])
    elif len(sys.argv) == 3:
        print(json.dumps(draft(sys.argv[1], sys.argv[2]), indent=1)[:600])
    else:
        sys.exit(__doc__)
