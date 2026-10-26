#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
animscan.py — KARDS 原版录像批量动画参数扫描器

用法：
  python tools/animscan.py <视频目录或单个视频> [--clips 3] [--clip-sec 4] [--gap 8] [--width 640]

对每个视频：
  1) 4fps 低分辨率抽帧做运动差分，挑出运动最强的 N 段（互不重叠）
  2) 对每段按原生帧率抽帧（宽度 --width），生成帧拼图 sheet.png
  3) 逐帧量化：火焰面积 / 白烟面积 / 黑烟面积 / 屏幕位移(震动) / 全屏亮度
  4) 输出 metrics.json + 总览 index.md

依赖：ffmpeg（路径见 FFMPEG_BIN）、numpy、Pillow
"""
import os
import sys
import json
import shutil
import argparse
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw

FFMPEG_BIN = r"E:/REA/ffmpeg/ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe"
OUT_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".work", "animscan")


def run_ffmpeg(args):
    p = subprocess.run([FFMPEG_BIN] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-1200:])
    return p.stderr


def probe(path):
    # 只查信息时 ffmpeg 会返回非 0，这里直接读 stderr，不做成功判定
    p = subprocess.run([FFMPEG_BIN, "-i", path], stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, text=True)
    err = p.stderr
    duration, fps, size = 0.0, 25.0, (0, 0)
    for line in err.splitlines():
        if "Duration" in line:
            t = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = t.split(":")
            duration = int(h) * 3600 + int(m) * 60 + float(s)
        if "Stream #0:0" in line and "Video" in line:
            import re
            mf = re.search(r"([\d.]+)\s+fps", line)
            if mf:
                fps = float(mf.group(1))
            ms = re.search(r"(\d{2,5})x(\d{2,5})", line)
            if ms:
                size = (int(ms.group(1)), int(ms.group(2)))
    return {"duration": duration, "fps": fps, "size": size}


def motion_scan(path, duration, probe_fps=4, w=160, h=90):
    tmp = tempfile.mkdtemp(prefix="animscan_")
    try:
        pat = os.path.join(tmp, "p%05d.png")
        run_ffmpeg(["-y", "-i", path, "-vf", f"fps={probe_fps},scale={w}:{h},format=gray",
                    "-frames:v", str(int(duration * probe_fps) + 2), pat])
        files = sorted(f for f in os.listdir(tmp) if f.endswith(".png"))
        prev, diffs = None, []
        for f in files:
            arr = np.asarray(Image.open(os.path.join(tmp, f)).convert("L"), dtype=np.float32)
            diffs.append(0.0 if prev is None else float(np.abs(arr - prev).mean()))
            prev = arr
        sec = []
        for s in range(int(duration) + 1):
            seg = diffs[s * probe_fps:(s + 1) * probe_fps]
            sec.append(sum(seg) / max(1, len(seg)))
        return sec
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def pick_windows(sec, clip_sec, gap, clips):
    cand = [(sum(sec[i:i + clip_sec]), i) for i in range(max(0, len(sec) - clip_sec + 1))]
    cand.sort(reverse=True)
    chosen = []
    for score, start in cand:
        if len(chosen) >= clips:
            break
        if all(abs(start - c[1]) >= gap for c in chosen):
            chosen.append((score, start))
    return sorted(chosen, key=lambda x: x[1])


def analyze_frames(files):
    """返回逐帧指标：火焰/白烟/黑烟像素数、位移、亮度。"""
    frames = [np.asarray(Image.open(f).convert("RGB"), dtype=np.int16) for f in files]
    out = {"fire": [], "white": [], "dark": [], "shift": [], "bright": []}
    ref = frames[0]
    h, w, _ = ref.shape
    # 取左上角静态条带做位移估计（震动检测）
    x0, x1 = int(w * 0.01), int(w * 0.08)
    y0, y1 = int(h * 0.06), int(h * 0.35)
    for idx, f in enumerate(frames):
        r, g, b = f[:, :, 0], f[:, :, 1], f[:, :, 2]
        out["fire"].append(int(((r > 195) & (r > g + 60) & (g > b) & (b < 120)).sum()))
        mx = np.maximum(np.maximum(r, g), b)
        mn = np.minimum(np.minimum(r, g), b)
        out["white"].append(int(((mx > 170) & ((mx - mn) < 30)).sum()))
        out["dark"].append(int(((mx < 55) & ((mx - mn) < 22)).sum()))
        out["bright"].append(round(float(f.mean()), 2))
        if idx == 0:
            out["shift"].append([0, 0])
            continue
        best = (0, 0, 1e18)
        a = ref[y0:y1, x0:x1].astype(np.float32)
        a = (a - a.mean()) / (a.std() + 1e-3)      # 亮度归一化：排除爆炸导致的整体变亮误判为位移
        for dx in (-3, -2, -1, 0, 1, 2, 3):
            for dy in (-3, -2, -1, 0, 1, 2, 3):
                ys, xs = y0 + dy, x0 + dx
                if ys < 0 or xs < 0 or ys + (y1 - y0) > h or xs + (x1 - x0) > w:
                    continue
                bpatch = f[ys:ys + (y1 - y0), xs:xs + (x1 - x0)].astype(np.float32)
                bpatch = (bpatch - bpatch.mean()) / (bpatch.std() + 1e-3)
                d = float(np.abs(a - bpatch).mean())
                if d < best[2]:
                    best = (dx, dy, d)
        # 仅当平移后匹配质量显著优于不平移（差值下降 >25%）才算真位移
        out["shift"].append([best[0], best[1]] if best[2] < 0.75 else [0, 0])
    return out


def sheet(files, dst, cols=6, thumb_w=260):
    ims = [Image.open(f) for f in files]
    w, h = ims[0].size
    tw, th = thumb_w, int(h * thumb_w / w)
    rows = (len(ims) + cols - 1) // cols
    sh = Image.new("RGB", (cols * tw, rows * th), (18, 18, 18))
    dr = ImageDraw.Draw(sh)
    for i, im in enumerate(ims):
        x, y = (i % cols) * tw, (i // cols) * th
        sh.paste(im.resize((tw, th)), (x, y))
        dr.rectangle([x, y, x + 40, y + 14], fill=(0, 0, 0))
        dr.text((x + 3, y + 2), str(i), fill=(255, 214, 120))
    sh.save(dst)
    return sh.size


def process_video(path, args, index_rows):
    info = probe(path)
    name = os.path.splitext(os.path.basename(path))[0]
    vdir = os.path.join(OUT_ROOT, name)
    os.makedirs(vdir, exist_ok=True)
    print(f"[{name}] {info['size'][0]}x{info['size'][1]} {info['fps']:.2f}fps {info['duration']:.1f}s")

    sec = motion_scan(path, info["duration"])
    wins = pick_windows(sec, args.clip_sec, args.gap, args.clips)

    for k, (score, start) in enumerate(wins, 1):
        sdir = os.path.join(vdir, f"seg{k:02d}_t{start:03d}s")
        os.makedirs(sdir, exist_ok=True)
        fps = min(info["fps"], args.fps_cap)
        run_ffmpeg(["-y", "-ss", str(start), "-t", str(args.clip_sec), "-i", path,
                    "-vf", f"fps={fps},scale={args.width}:-1", "-q:v", "3",
                    os.path.join(sdir, "f_%04d.jpg")])
        files = sorted(os.path.join(sdir, f) for f in os.listdir(sdir) if f.startswith("f_"))
        if not files:
            continue
        m = analyze_frames(files)
        base_fire = int(np.median(m["fire"][:2]))
        fire_th = max(200, base_fire * 2.5)
        fire_frames = [i for i, v in enumerate(m["fire"]) if v > fire_th]
        smoke_frames = [i for i, v in enumerate(m["white"]) if v > int(np.median(m["white"])) + 900]
        dark_frames = [i for i, v in enumerate(m["dark"]) if v > int(np.median(m["dark"])) + 900]
        shifts = [s for s in m["shift"] if s != [0, 0]]
        metrics = {
            "video": name, "video_info": info, "start_sec": start, "motion": round(score, 1),
            "frames": len(files), "fps": fps,
            "fire_frames": [fire_frames[0], fire_frames[-1]] if fire_frames else None,
            "fire_ms": round((fire_frames[-1] - fire_frames[0]) / fps * 1000) if fire_frames else 0,
            "smoke_frames": [smoke_frames[0], smoke_frames[-1]] if smoke_frames else None,
            "dark_frames": [dark_frames[0], dark_frames[-1]] if dark_frames else None,
            "shake_events": len(shifts), "shake_max_px": max([max(abs(s[0]), abs(s[1])) for s in shifts], default=0),
            "bright_min": min(m["bright"]), "bright_max": max(m["bright"]),
        }
        with open(os.path.join(sdir, "metrics.json"), "w", encoding="utf-8") as fh:
            json.dump({"metrics": metrics, "per_frame": m}, fh)
        sh = sheet(files, os.path.join(sdir, "sheet.png"))
        index_rows.append((name, start, metrics, sdir, sh))
        print(f"  seg{k}: t{start}s motion={score:.1f} 火焰{metrics['fire_ms']}ms "
              f"烟{len(smoke_frames)}帧 黑{len(dark_frames)}帧 位移{metrics['shake_events']}帧")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", help="视频文件或目录")
    ap.add_argument("--clips", type=int, default=3, help="每个视频取几段")
    ap.add_argument("--clip-sec", type=int, default=4, help="每段时长（秒）")
    ap.add_argument("--gap", type=int, default=8, help="段间最小间隔（秒）")
    ap.add_argument("--width", type=int, default=640, help="抽帧宽度")
    ap.add_argument("--fps-cap", type=float, default=30, help="抽帧帧率上限")
    args = ap.parse_args()

    if not os.path.isfile(FFMPEG_BIN):
        print("[ERROR] 找不到 ffmpeg:", FFMPEG_BIN, file=sys.stderr)
        sys.exit(1)
    os.makedirs(OUT_ROOT, exist_ok=True)

    vids = []
    if os.path.isdir(args.target):
        for root, _, names in os.walk(args.target):
            for n in sorted(names):
                if n.lower().endswith((".mp4", ".mov", ".mkv", ".webm")):
                    vids.append(os.path.join(root, n))
    else:
        vids = [args.target]
    if not vids:
        print("[ERROR] 没有找到视频文件", file=sys.stderr)
        sys.exit(1)

    rows = []
    for v in vids:
        try:
            process_video(v, args, rows)
        except Exception as e:
            print(f"[FAIL] {os.path.basename(v)}: {e}", file=sys.stderr)

    md = ["# 动画参数扫描报告", "", f"来源：`{args.target}`", "",
          "| 视频 | 起点 | 火焰时长 | 白烟帧 | 黑烟帧 | 震动帧/最大位移 | 拼图 |",
          "|---|---|---|---|---|---|---|"]
    for name, start, m, sdir, sh in rows:
        md.append(f"| {name} | {start}s | {m['fire_ms']}ms | "
                  f"{'到'.join(map(str, m['smoke_frames'])) if m['smoke_frames'] else '-'} | "
                  f"{'到'.join(map(str, m['dark_frames'])) if m['dark_frames'] else '-'} | "
                  f"{m['shake_events']}/{m['shake_max_px']}px | "
                  f"[sheet]({os.path.relpath(os.path.join(sdir, 'sheet.png'), OUT_ROOT)}) |")
    md += ["", "## 说明", "- 火焰时长按原生帧率换算，>600ms 视为一次完整燃烧特效",
           "- 白烟/黑烟帧号为段内帧序号，`-` 表示未检出",
           "- 震动帧 = 检测到整屏位移的帧数（多数原版战斗为 0）"]
    with open(os.path.join(OUT_ROOT, "index.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(md))
    print(f"\n[DONE] 报告：{os.path.join(OUT_ROOT, 'index.md')}")


if __name__ == "__main__":
    main()
