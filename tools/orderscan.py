"""
指令牌（技能牌）出牌镜头自动定位。

KARDS 打出指令牌时的画面特征：中央出现一张**明显大于场上卡牌**的卡面，
带高光/辉光，停留约 0.5~1.5 秒，然后效果结算、卡牌燃烧消失。

检测思路（不依赖色相，避免被红色/橙色卡面骗到）：
1) 把画面缩到 480 宽，按 4fps 抽帧；
2) 取中央判定框（横 32%~68%，纵 20%~80%），统计
   - 高亮像素占比 fill（luma > 阈值，卡面比木纹桌面亮得多）
   - 该框的亮度均值 center_luma 与全帧均值 frame_luma 的差 delta
3) 用**前后各 3 秒的中位数**做基线，找出 delta 连续 3 帧以上显著高于基线的段
   —— 桌面本身是静态的，中央突然变亮且持续，就是打出了大卡
4) 每段输出全分辨率帧拼图，供人工确认

用法：
  python tools/orderscan.py <视频目录或单个视频> [--clips 6] [--width 480]
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

FFMPEG = os.environ.get("FFMPEG", "E:/REA/ffmpeg/ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe")
OUT_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".work", "orderscan")

import numpy as np
from PIL import Image, ImageDraw


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, errors="ignore")


def probe(path):
    r = run([FFMPEG, "-i", path])
    txt = r.stderr
    dur, fps = 0.0, 0.0
    for line in txt.splitlines():
        if "Duration:" in line:
            hms = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = hms.split(":")
            dur = int(h) * 3600 + int(m) * 60 + float(s)
        if "Stream #0:0" in line and "fps" in line:
            for tok in line.split(","):
                tok = tok.strip()
                if tok.endswith("fps"):
                    try:
                        fps = float(tok.split()[0])
                    except Exception:
                        pass
    w, h = 0, 0
    for line in txt.splitlines():
        if "Stream #0:0" in line and "x" in line:
            import re
            m = re.search(r"(\d{3,4})x(\d{3,4})", line)
            if m:
                w, h = int(m.group(1)), int(m.group(2))
                break
    return {"duration": dur, "fps": fps, "w": w, "h": h}


def frames_of(path, tmpdir, width=480, rate=4):
    out = os.path.join(tmpdir, "f_%05d.jpg")
    run([FFMPEG, "-y", "-i", path, "-vf", f"fps={rate},scale={width}:-1", "-q:v", "4", out])
    return sorted(f for f in os.listdir(tmpdir) if f.startswith("f_") and f.endswith(".jpg"))


def metrics(path, tmpdir, width=480, rate=4):
    names = frames_of(path, tmpdir, width, rate)
    if not names:
        return None
    deltas, fills, lumas = [], [], []
    for n in names:
        im = Image.open(os.path.join(tmpdir, n)).convert("L")
        a = np.asarray(im, dtype=np.float32)
        h, w = a.shape
        cy0, cy1 = int(h * 0.20), int(h * 0.80)
        cx0, cx1 = int(w * 0.32), int(w * 0.68)
        cbox = a[cy0:cy1, cx0:cx1]
        deltas.append(float(cbox.mean() - a.mean()))
        fills.append(float((cbox > 140).mean()))
        lumas.append(float(a.mean()))
    return {"names": names, "delta": deltas, "fill": fills, "luma": lumas, "rate": rate}


def find_segments(m, min_len=3, k=3.0):
    """delta 连续高于「前后 3s 中位数」的段"""
    d = np.array(m["delta"])
    n = len(d)
    if n < 8:
        return []
    win = 12  # 3s @4fps
    base = np.zeros(n)
    for i in range(n):
        lo, hi = max(0, i - win), min(n, i + win + 1)
        seg = np.concatenate([d[lo:i], d[i + 1:hi]]) if hi - lo > 2 else d[lo:hi]
        base[i] = np.median(seg) if len(seg) else 0.0
    dev = d - base
    thr = max(6.0, float(np.percentile(dev, 92)))
    mask = dev > thr
    segs = []
    i = 0
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and mask[j + 1]:
            j += 1
        if j - i + 1 >= min_len:
            segs.append((i, j, float(dev[i:j + 1].max()), float(dev[i:j + 1].mean())))
        i = j + 1
    segs.sort(key=lambda s: -(s[2] * 0.6 + s[3] * 0.4))
    return segs


def sheet_for(path, t0, t1, out_png, cols=4):
    tmp = tempfile.mkdtemp()
    run([FFMPEG, "-y", "-ss", f"{t0:.2f}", "-t", f"{max(0.4, t1 - t0):.2f}", "-i", path,
         "-vf", "fps=12", os.path.join(tmp, "s_%03d.jpg")])
    files = sorted(f for f in os.listdir(tmp) if f.startswith("s_"))
    if not files:
        return None
    ims = []
    for f in files[:24]:
        im = Image.open(os.path.join(tmp, f)).convert("RGB")
        im.thumbnail((360, 220))
        ims.append((f, im))
    if not ims:
        return None
    W, H = ims[0][1].size
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * W, rows * H), (12, 12, 12))
    dr = ImageDraw.Draw(sheet)
    for k, (f, im) in enumerate(ims):
        x, y = (k % cols) * W, (k // cols) * H
        sheet.paste(im, (x, y))
        dr.rectangle([x, y, x + 60, y + 15], fill=(0, 0, 0))
        dr.text((x + 3, y + 2), f"{(k / 12.0):.2f}s", fill=(255, 210, 120))
    sheet.save(out_png)
    return out_png


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--clips", type=int, default=6, help="每个视频输出的候选段数")
    ap.add_argument("--width", type=int, default=480)
    ap.add_argument("--rate", type=int, default=4)
    args = ap.parse_args()

    files = []
    if os.path.isdir(args.path):
        for f in sorted(os.listdir(args.path)):
            if f.lower().endswith((".mp4", ".mkv", ".mov", ".webm")):
                files.append(os.path.join(args.path, f))
    else:
        files = [args.path]
    if not files:
        print("没有找到视频文件")
        return

    os.makedirs(OUT_ROOT, exist_ok=True)
    index = []
    for path in files:
        name = os.path.splitext(os.path.basename(path))[0]
        info = probe(path)
        print(f"\n=== {name}  {info['duration']:.0f}s {info['w']}x{info['h']} {info['fps']:.1f}fps")
        if info["duration"] < 3:
            continue
        tmp = tempfile.mkdtemp()
        m = metrics(path, tmp, args.width, args.rate)
        if not m:
            print("  抽帧失败")
            continue
        segs = find_segments(m)[: args.clips]
        outdir = os.path.join(OUT_ROOT, name)
        os.makedirs(outdir, exist_ok=True)
        for k, (i, j, mx, mean) in enumerate(segs):
            t0 = i / m["rate"]
            t1 = (j + 1) / m["rate"]
            png = os.path.join(outdir, f"seg{k + 1:02d}_t{int(t0):03d}s.png")
            got = sheet_for(path, t0, t1, png)
            if got:
                print(f"  段{k + 1}: {t0:.1f}s~{t1:.1f}s  峰值dev {mx:.1f}  均值 {mean:.1f}  → {os.path.relpath(png, OUT_ROOT)}")
                index.append({"video": name, "start": round(t0, 2), "end": round(t1, 2),
                              "peak": round(mx, 1), "sheet": os.path.relpath(png, OUT_ROOT)})
    with open(os.path.join(OUT_ROOT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print(f"\n共 {len(index)} 段，索引：.work/orderscan/index.json")


if __name__ == "__main__":
    main()
