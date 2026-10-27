"""
在录像里精确定位「打出指令牌时中央出现的大卡」。

判别依据（不依赖颜色，只看几何）：卡牌有两条很强的水平边（上下边）和两条垂直边。
- 对中央 50% 宽度区域逐行求水平梯度（Sobel-y），得到行梯度曲线；
- 卡牌上下边会在曲线上形成一对显著峰值，两峰间距 ≈ 卡牌高度；
- 场上单位卡很小（约屏高 20%），出牌大卡约屏高 30%~55%，据此区分；
- 且要求该几何形态在连续 ≥ 3 帧（0.75s @4fps）内稳定。

输出：每个命中点前后各 0.5s 的 12fps 帧条，供人工核对。

用法：python tools/bigcard_scan.py <目录或视频> [--width 640]
"""
import argparse
import json
import os
import re
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw

FFMPEG = os.environ.get("FFMPEG", "E:/REA/ffmpeg/ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".work", "bigcard")


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, errors="ignore")


def probe(path):
    txt = run([FFMPEG, "-i", path]).stderr
    dur = 0.0
    for line in txt.splitlines():
        if "Duration:" in line:
            hms = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = hms.split(":")
            dur = int(h) * 3600 + int(m) * 60 + float(s)
    return dur


def frames(path, tmp, width, rate):
    run([FFMPEG, "-y", "-i", path, "-vf", f"fps={rate},scale={width}:-1", "-q:v", "4",
         os.path.join(tmp, "f_%05d.jpg")])
    return sorted(f for f in os.listdir(tmp) if f.startswith("f_"))


def card_pairs(path, tmp, width=640, rate=4):
    """返回每帧检出的「大卡上下边间距（占屏高比例）」与中心度，0 表示无"""
    names = frames(path, tmp, width, rate)
    out = []
    for n in names:
        im = Image.open(os.path.join(tmp, n)).convert("L")
        a = np.asarray(im, dtype=np.float32)
        h, w = a.shape
        # 中央 50% 宽度
        cx0, cx1 = int(w * 0.25), int(w * 0.75)
        band = a[:, cx0:cx1]
        # 行方向梯度
        g = np.abs(np.diff(band, axis=0)).mean(axis=1)
        if g.max() <= 0:
            out.append((0.0, 0.0))
            continue
        # 取最强的若干行，配对求间距
        k = min(26, len(g))
        idx = np.argpartition(g, -k)[-k:]
        idx = np.sort(idx)
        best = (0.0, 0.0)
        for i in range(len(idx)):
            for j in range(i + 1, len(idx)):
                gap = (idx[j] - idx[i]) / h
                if not (0.26 <= gap <= 0.62):
                    continue
                # 两峰都要够强，且两点都要落在画面中部（避开顶部手牌区/底部手牌区）
                center = (idx[i] + idx[j]) / 2.0 / h
                if not (0.25 <= center <= 0.80):
                    continue
                strength = float(g[idx[i]] + g[idx[j]])
                if strength > best[0]:
                    best = (strength, gap)
        out.append(best)
    return out, rate


def segments(det, rate, min_len=3):
    vals = [d[1] for d in det]
    strengths = [d[0] for d in det]
    thr = max(6.0, float(np.percentile([s for s in strengths if s > 0] or [0], 75)))
    mask = [(v > 0 and s > thr) for v, s in zip(vals, strengths)]
    segs, i, n = [], 0, len(mask)
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and mask[j + 1]:
            j += 1
        if j - i + 1 >= min_len:
            segs.append((i, j, max(strengths[i:j + 1])))
        i = j + 1
    segs.sort(key=lambda s: -s[2])
    return segs


def strip(path, t0, out_png, cols=4, fps=12, dur=1.4):
    tmp = tempfile.mkdtemp()
    run([FFMPEG, "-y", "-ss", f"{max(0, t0 - 0.4):.2f}", "-t", f"{dur:.2f}", "-i", path,
         "-vf", f"fps={fps}", os.path.join(tmp, "s_%03d.jpg")])
    files = sorted(f for f in os.listdir(tmp) if f.startswith("s_"))
    if not files:
        return None
    ims = []
    for f in files[:20]:
        im = Image.open(os.path.join(tmp, f)).convert("RGB")
        im.thumbnail((400, 240))
        ims.append(im)
    W, H = ims[0].size
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * W, rows * H), (10, 10, 10))
    dr = ImageDraw.Draw(sheet)
    for k, im in enumerate(ims):
        x, y = (k % cols) * W, (k // cols) * H
        sheet.paste(im, (x, y))
        dr.rectangle([x, y, x + 58, y + 15], fill=(0, 0, 0))
        dr.text((x + 3, y + 2), f"{max(0, t0 - 0.4) + k / fps:.2f}s", fill=(255, 210, 120))
    sheet.save(out_png)
    return out_png


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--rate", type=int, default=4)
    ap.add_argument("--clips", type=int, default=3)
    args = ap.parse_args()

    files = ([os.path.join(args.path, f) for f in sorted(os.listdir(args.path))
              if f.lower().endswith((".mp4", ".mkv", ".mov", ".webm"))]
             if os.path.isdir(args.path) else [args.path])
    os.makedirs(OUT, exist_ok=True)
    index = []
    for path in files:
        name = os.path.splitext(os.path.basename(path))[0]
        dur = probe(path)
        if dur < 5:
            continue
        tmp = tempfile.mkdtemp()
        det, rate = card_pairs(path, tmp, args.width, args.rate)
        segs = segments(det, rate)[: args.clips]
        if not segs:
            print(f"{name}: 无大卡候选")
            continue
        d = os.path.join(OUT, name)
        os.makedirs(d, exist_ok=True)
        for i, (s, e, st) in enumerate(segs):
            t0 = s / rate
            png = os.path.join(d, f"card{i + 1:02d}_t{int(t0):03d}s.png")
            if strip(path, t0, png):
                gap = det[s][1]
                print(f"{name}: {t0:.1f}s~{(e + 1) / rate:.1f}s 卡高 {gap * 100:.0f}%屏高 强度 {st:.0f}")
                index.append({"video": name, "start": round(t0, 2),
                              "height_pct": round(gap * 100), "strength": round(st),
                              "sheet": os.path.relpath(png, OUT)})
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print(f"\n候选 {len(index)} 段 → .work/bigcard/index.json")


if __name__ == "__main__":
    main()
