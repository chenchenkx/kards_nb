"""
整段视频的逐帧分析：把一场对局拆成「出牌 / 施法(指令牌) / 攻击 / 死亡 / 回合切换 / 胜负」
的完整时间线，并输出可核对的帧条与 Markdown 报告。

逐帧特征：
  motion   与上一帧的平均绝对差（整体动作量）
  fire     橙色火焰像素数
  smoke    亮而低饱和的烟像素数
  dark     暗色烟像素数
  luma     全帧平均亮度
  big_gap  中央检出的大卡矩形高度（占屏高比例，0 表示没有）
  big_str  该矩形上下边的梯度强度
  center   中央 36% 区域平均亮度
  flash    接近纯白的像素数（白闪/金爆）

用法：
  python tools/fullscan.py <视频> [--rate 15] [--width 640]
"""
import argparse
import json
import os
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw

FFMPEG = os.environ.get("FFMPEG", "E:/REA/ffmpeg/ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, ".work", "fullscan")


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


def extract(path, tmp, width, rate):
    run([FFMPEG, "-y", "-i", path, "-vf", f"fps={rate},scale={width}:-1", "-q:v", "2",
         os.path.join(tmp, "f_%05d.jpg")])
    return sorted(f for f in os.listdir(tmp) if f.startswith("f_"))


def big_card(a):
    """中央区域是否有一张「大卡」：上下边间距占屏高 26%~62%"""
    h, w = a.shape
    band = a[:, int(w * 0.25):int(w * 0.75)]
    g = np.abs(np.diff(band, axis=0)).mean(axis=1)
    if g.max() <= 0:
        return 0.0, 0.0
    k = min(26, len(g))
    idx = np.sort(np.argpartition(g, -k)[-k:])
    best = (0.0, 0.0)
    for i in range(len(idx)):
        for j in range(i + 1, len(idx)):
            gap = (idx[j] - idx[i]) / h
            c = (idx[i] + idx[j]) / 2.0 / h
            if 0.26 <= gap <= 0.62 and 0.25 <= c <= 0.80:
                st = float(g[idx[i]] + g[idx[j]])
                if st > best[0]:
                    best = (st, gap)
    return best


def analyse(path, rate, width):
    tmp = tempfile.mkdtemp()
    names = extract(path, tmp, width, rate)
    prev = None
    rows = []
    for i, n in enumerate(names):
        rgb = np.asarray(Image.open(os.path.join(tmp, n)).convert("RGB"), dtype=np.int16)
        a = np.asarray(Image.open(os.path.join(tmp, n)).convert("L"), dtype=np.float32)
        h, w = a.shape
        r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
        motion = 0.0 if prev is None else float(np.abs(a - prev).mean())
        prev = a
        fire = int(((r > 168) & (r > g + 46) & (g > b) & (b < 130)).sum())
        mx = np.maximum(np.maximum(r, g), b)
        mn = np.minimum(np.minimum(r, g), b)
        smoke = int(((mx > 176) & ((mx - mn) < 26)).sum())
        dark = int(((mx < 62) & ((mx - mn) < 24)).sum())
        flash = int((mx > 238).sum())
        st, gap = big_card(a)
        rows.append({
            "i": i, "t": round(i / rate, 3),
            "motion": round(motion, 2),
            "fire": fire, "smoke": smoke, "dark": dark, "flash": flash,
            "luma": round(float(a.mean()), 1),
            "center": round(float(a[int(h * .30):int(h * .72), int(w * .32):int(w * .68)].mean()), 1),
            "big_gap": round(gap, 3), "big_str": round(st, 1),
        })
    return rows, tmp, names


def classify(rows, rate):
    """按阈值把帧标成事件，再合并成段"""
    if not rows:
        return []
    mo = np.array([r["motion"] for r in rows])
    fi = np.array([r["fire"] for r in rows])
    st = np.array([r["big_str"] for r in rows])
    fl = np.array([r["flash"] for r in rows])
    base_fire = float(np.percentile(fi, 40))
    mo_thr = max(1.2, float(np.percentile(mo, 80)))

    labels = []
    for r in rows:
        lab = None
        if r["fire"] > base_fire + 380:
            lab = "fire"
        elif r["big_str"] > 0 and r["big_gap"] > 0:
            lab = "bigcard"
        elif r["motion"] >= mo_thr:
            lab = "motion"
        elif r["flash"] > 4000:
            lab = "flash"
        labels.append(lab)

    segs = []
    i, n = 0, len(labels)
    while i < n:
        lab = labels[i]
        if lab is None:
            i += 1
            continue
        j = i
        gap = 0
        while j + 1 < n:
            if labels[j + 1] == lab:
                j += 1
                gap = 0
            elif labels[j + 1] is None and gap < 2:   # 允许 2 帧空档
                j += 1
                gap += 1
            else:
                break
        segs.append({
            "type": lab,
            "start": round(rows[i]["t"], 2),
            "end": round(rows[j]["t"], 2),
            "frames": j - i + 1,
            "dur_ms": int(round((j - i + 1) * 1000 / rate)),
            "peak_motion": round(float(mo[i:j + 1].max()), 1),
            "peak_fire": int(fi[i:j + 1].max()),
            "peak_flash": int(fl[i:j + 1].max()),
        })
        i = j + 1
    # 合并同类型相邻段（间隔 < 0.25s）
    merged = []
    for s in segs:
        if merged and merged[-1]["type"] == s["type"] and s["start"] - merged[-1]["end"] < 0.25:
            m = merged[-1]
            m["end"] = s["end"]
            m["frames"] += s["frames"]
            m["dur_ms"] += s["dur_ms"]
            m["peak_motion"] = max(m["peak_motion"], s["peak_motion"])
            m["peak_fire"] = max(m["peak_fire"], s["peak_fire"])
            m["peak_flash"] = max(m["peak_flash"], s["peak_flash"])
        else:
            merged.append(dict(s))
    return merged


def sheet(path, t0, t1, out_png, cols=5, fps=12):
    tmp = tempfile.mkdtemp()
    run([FFMPEG, "-y", "-ss", f"{t0:.2f}", "-t", f"{max(0.35, t1 - t0):.2f}", "-i", path,
         "-vf", f"fps={fps}", os.path.join(tmp, "s_%03d.jpg")])
    files = sorted(f for f in os.listdir(tmp) if f.startswith("s_"))
    if not files:
        return None
    ims = []
    for f in files[:20]:
        im = Image.open(os.path.join(tmp, f)).convert("RGB")
        im.thumbnail((330, 210))
        ims.append(im)
    W, H = ims[0].size
    rows = (len(ims) + cols - 1) // cols
    s = Image.new("RGB", (cols * W, rows * H), (10, 10, 10))
    dr = ImageDraw.Draw(s)
    for k, im in enumerate(ims):
        x, y = (k % cols) * W, (k // cols) * H
        s.paste(im, (x, y))
        dr.rectangle([x, y, x + 62, y + 15], fill=(0, 0, 0))
        dr.text((x + 3, y + 2), f"{t0 + k / fps:.2f}s", fill=(255, 210, 120))
    s.save(out_png)
    return out_png


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--rate", type=int, default=15)
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--sheets", type=int, default=8)
    args = ap.parse_args()

    name = os.path.splitext(os.path.basename(args.path))[0]
    os.makedirs(OUT, exist_ok=True)
    d = os.path.join(OUT, name)
    os.makedirs(d, exist_ok=True)

    print(f"分析 {name} …")
    rows, tmp, names = analyse(args.path, args.rate, args.width)
    print(f"  帧数 {len(rows)}  时长 {rows[-1]['t']:.1f}s")
    segs = classify(rows, args.rate)
    print(f"  事件段 {len(segs)}")

    # 汇总统计
    by_type = {}
    for s in segs:
        by_type.setdefault(s["type"], []).append(s["dur_ms"])
    with open(os.path.join(d, "frames.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f)
    with open(os.path.join(d, "segments.json"), "w", encoding="utf-8") as f:
        json.dump(segs, f, ensure_ascii=False, indent=1)

    # 每类挑最长的几段出帧条
    picked = []
    for t, durs in by_type.items():
        cand = sorted([s for s in segs if s["type"] == t], key=lambda s: -s["dur_ms"])[:3]
        for s in cand:
            picked.append(s)
    picked.sort(key=lambda s: s["start"])
    for k, s in enumerate(picked[: args.sheets]):
        png = os.path.join(d, f"{k + 1:02d}_{s['type']}_t{int(s['start']):03d}s.png")
        sheet(args.path, s["start"], s["end"], png)
        s["sheet"] = os.path.basename(png)

    # Markdown 报告
    lines = [f"# 整片分析：{name}", "",
             f"- 时长 {rows[-1]['t']:.1f}s，抽帧 {len(rows)} 张（{args.rate}fps，宽 {args.width}px）",
             f"- 检出事件段 {len(segs)} 个", "", "## 事件统计", "",
             "| 类型 | 段数 | 总时长 | 最短 | 最长 | 平均 |", "|---|---|---|---|---|---|"]
    for t, durs in sorted(by_type.items(), key=lambda kv: -sum(kv[1])):
        lines.append(f"| {t} | {len(durs)} | {sum(durs)}ms | {min(durs)}ms | {max(durs)}ms | {int(sum(durs) / len(durs))}ms |")
    lines += ["", "## 时间线（前 60 段）", "", "| # | 起 | 止 | 类型 | 时长 | 峰值动作 | 峰值火焰 | 帧条 |", "|---|---|---|---|---|---|---|---|"]
    for i, s in enumerate(segs[:60], 1):
        lines.append(f"| {i} | {s['start']}s | {s['end']}s | {s['type']} | {s['dur_ms']}ms | "
                     f"{s['peak_motion']} | {s['peak_fire']} | {s.get('sheet', '')} |")
    with open(os.path.join(d, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print("\n" + "\n".join(lines[6:6 + 12]))
    print(f"\n报告：.work/fullscan/{name}/report.md")


if __name__ == "__main__":
    main()
