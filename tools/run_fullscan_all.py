#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量整片分析所有 KARDS 实战视频。

对 C:/Users/pc15/Downloads/视频/ 下的 14 个 mp4，外加 Downloads 根目录的
2 个编号视频，逐个调用 tools/fullscan.py 做整片抽帧+事件分类。

用 subprocess 的列表参数（不使用 shell），避免文件名里的 `!` / 中文标点
触发 bash 历史展开或引号问题。

用法：
  python tools/run_fullscan_all.py
"""
import os
import sys
import glob
import subprocess

ROOT = r"E:/新建文件夹"
VID_DIR = r"C:/Users/pc15/Downloads/视频"
OUT = os.path.join(ROOT, ".work", "fullscan")
FULLSCAN = os.path.join(ROOT, "tools", "fullscan.py")

os.makedirs(OUT, exist_ok=True)

videos = sorted(glob.glob(os.path.join(VID_DIR, "*.mp4")))
extra = [
    r"C:/Users/pc15/Downloads/25825575993-1-192.mp4",
    r"C:/Users/pc15/Downloads/40617381777-1-192.mp4",
]
for v in extra:
    if os.path.exists(v):
        videos.append(v)

print(f"待分析视频 {len(videos)} 个", flush=True)
for i, v in enumerate(videos, 1):
    name = os.path.splitext(os.path.basename(v))[0]
    print(f"\n===== [{i}/{len(videos)}] {name} =====", flush=True)
    try:
        p = subprocess.run(
            [sys.executable, FULLSCAN, v],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="ignore",
        )
        sys.stdout.write(p.stdout[-3000:])
        print(f"  exit={p.returncode}", flush=True)
    except Exception as e:  # noqa
        print(f"  ERROR: {e}", flush=True)

print("\n========== ALL DONE ==========", flush=True)
