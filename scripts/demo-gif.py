# Animerad demo till README av bildrutorna från scripts/readme-art.mjs.
# python scripts/demo-gif.py  ->  docs/screenshots/demo.gif
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
cards = sorted((root / 'release' / 'demo-frames' / 'cards').glob('*.png'))
width = 960
imgs = []
for c in cards:
    im = Image.open(c).convert('RGB')
    imgs.append(im.resize((width, round(im.height * width / im.width)), Image.LANCZOS))

frames, durations = [], []
steps = 4
for i, im in enumerate(imgs):
    frames.append(im)
    durations.append(2600)
    nxt = imgs[(i + 1) % len(imgs)]
    for s in range(1, steps):
        frames.append(Image.blend(im, nxt, s / steps))
        durations.append(50)

pal = [f.quantize(colors=160, method=Image.MEDIANCUT, dither=Image.NONE) for f in frames]
out = root / 'docs' / 'screenshots' / 'demo.gif'
pal[0].save(out, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(out, round(out.stat().st_size / 1e6, 2), 'MB')
