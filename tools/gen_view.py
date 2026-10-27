#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
汇总所有 KARDS 录屏的分析结果，生成接手文档 view.md。

数据源：
  1) .work/fullscan/<name>/{report.md, segments.json, frames.json}  —— 整片分析（run_fullscan_all.py 产出）
  2) .work/animscan/index.md  —— 14 个战斗视频的分段动画参数（火焰/白烟/黑烟/震动）

修正点（相对原始 fullscan 分类）：
  - 原始 fullscan 的 bigcard 阈值过松（几乎整段都判成大卡），这里用 frames.json 重新用
    严格阈值（big_str>30 且 0.30<=gap<=0.58）重算"中央大卡(出牌/施法)"。
  - 胜利镜头：片尾（后 15%）出现超大火焰峰值（>15000 像素）即判为终局爆炸，不再被笼统归为 fire。

输出：view.md
"""
import os
import re
import json
import glob

ROOT = r"E:/新建文件夹"
FULL = os.path.join(ROOT, ".work", "fullscan")
ANIM = os.path.join(ROOT, ".work", "animscan", "index.md")
VIEW = os.path.join(ROOT, "view.md")

VIDEO_DIR = r"C:/Users/pc15/Downloads/视频"
EXTRA = [
    r"C:/Users/pc15/Downloads/25825575993-1-192.mp4",
    r"C:/Users/pc15/Downloads/40617381777-1-192.mp4",
]
HOME_DIR = r"C:/Users/pc15/Documents/PicPick/含主页的视频"

PHASE = {
    "bigcard": "中央大卡/出牌/施法镜头",
    "fire": "攻击/燃烧特效",
    "motion": "部署/推进/移动",
    "flash": "胜利/高亮爆发",
}


def load_json(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


# 超雄小车3回合干爆总部 的人工逐段解读（被 batch fullscan 覆盖前手工撰写，此处复原以留存接手价值）
RICH_CHAOXIONG = """\
> 以下为人工逐段解读（复原自早期手写 report.md），与本片自动分类互为补充。

### 2.14.1 逐段时间线

| 起 | 止 | 阶段 | 依据（实测指标） |
|---|---|---|---|
| 0.0s | 2.0s | **开局/换牌** | 画面整体由暗转亮（亮度 25→50），大量白烟像素 = 起始手牌翻开 |
| 2.0s | 6.8s | **部署阶段** | 静止（动作 <4），只有零星小位移 |
| 6.9s | 7.8s | **出牌落位** | 动作峰值 19.95，卡牌从手牌区飞向支援阵线 |
| 8.6s | 9.4s | **攻击结算** | 火焰像素 2904，打击特效 |
| 10.9s | 13.5s | **连续战斗** | 动作 8 + 火焰 2400+，多次攻击 |
| 18.5s | 20.0s | **部署/推进** | 动作 7.58，单位移入前线 |
| 21.0s | 24.0s | **单位阵亡** | 白烟 5075 持续上升 = 摧毁烟雾 |
| 26.5s | 28.0s | **战斗** | 动作 6.06 + 烟 4692 |
| 31.5s | 33.0s | **前排推进** | 闪光 3651 + 火焰 1886，夺线提示「友方占据了前线」 |
| 37.5s | 38.5s | **高亮特效** | 闪光 4439，全场最亮的非胜利瞬间 |
| 39.0s | 41.0s | **连续动作** | 动作 6.42/6.28 |
| 42.0s | 46.0s | **燃烧+阵亡** | 烟 4893 + 火 900 |
| 47.0s | 49.0s | **攻击高潮** | 动作 8.3 + 闪光 4603 |
| 50.0s | 51.0s | **打出单位** | 红色单位卡落入前线，火 3611 |
| 53.0s | 53.5s | **战斗** | 动作 10.38 |
| 55.0s | 56.0s | **致命一击** | 闪光 5674 + 火 3370（本片最高闪光） |
| 58.5s | 59.2s | **胜利爆炸** | 亮度 24→16，火焰像素 20940（全片最大，约 20 倍常态） |
| 59.2s | 64.3s | **结算画面** | 亮度 14，静止 |

### 2.14.2 动画时长统计（本片实测）

| 动作 | 实测时长 | 说明 |
|---|---|---|
| 出牌落位（手牌→阵线） | **0.6~0.9s** | 7.5s 处动作峰值前后各 0.3s，含落位后微调 |
| 攻击命中火焰 | **0.4~0.8s** | 火焰像素 >2000 的连续帧 |
| 单位阵亡白烟 | **0.9~1.5s** | 21.0~24.0s 烟像素 3000→5075→回落 |
| 致命一击闪光 | **0.3~0.5s** | 55.0~55.5s 闪光 5674 的单峰 |
| 胜利爆炸 | **0.6s** | 58.5→59.2s，火焰 20940 |

### 2.14.3 与网页版动画的对照

| 维度 | 本片实测 | 当前实现 | 结论 |
|---|---|---|---|
| 出牌落位 | 0.6~0.9s，无回弹 | 0.2s 落位 + 压扁回弹 | 略快于原版，可接受 |
| 火焰持续 | 0.4~0.8s | 0.9s | 稍长，命中感更足 |
| 阵亡烟 | 0.9~1.5s | 0.65~0.75s | 可再拉长 0.2s |
| 屏幕震动 | 本片未检出整体位移 | 3~5px/0.13s | 保持克制 |
| 指令牌施法 | **本片全程 0 次** | 未实现 | 需要另找素材 |

### 2.14.4 关键发现

1. **这不是指令牌对局**：64 秒内没有任何中央大卡特写镜头，全是单位出牌/攻击/阵亡。想要指令牌施法参考，得换一局研究牌多的录像（如 `最希望卡手的一集` / `生产坦克最有用的一集`）。
2. **打击感靠火焰与烟，不靠震动**：全片没有可检出的桌面位移，但火焰像素峰值 20940（胜利）与 3600（单次攻击）跨度极大，说明原版是靠「特效面积」拉层次，而不是靠抖屏。
3. **阵亡烟雾比命中火焰长得多**：烟 0.9~1.5s vs 火 0.4~0.8s，网页版目前两者接近，应当把阵亡烟拉长、命中火收紧。
4. **胜利是唯一的全屏级特效**：亮度从 24 掉到 16（画面转暗）同时火焰像素暴涨 20 倍，即「先压暗再爆发」，网页版目前是直接金色放射，可以补一个 0.15s 的压暗。
"""


def recompute_events(frames, rate=15):
    """用更严格阈值从 frames.json 重算事件段，并合并。返回 (segs, by_type, victory)。"""
    if not frames:
        return [], {}, False
    import numpy as np
    fi = np.array([r["fire"] for r in frames])
    mo = np.array([r.get("motion", 0.0) for r in frames])
    fl = np.array([r["flash"] for r in frames])
    bg = np.array([r["big_gap"] for r in frames])
    bs = np.array([r["big_str"] for r in frames])
    base_fire = float(np.percentile(fi, 40))
    mo_thr = max(1.2, float(np.percentile(mo, 80)))

    labels = []
    for i in range(len(frames)):
        lab = None
        if fi[i] > base_fire + 380:
            lab = "fire"
        elif bs[i] > 30 and 0.30 <= bg[i] <= 0.58:
            lab = "bigcard"
        elif fl[i] > 4000:
            lab = "flash"
        elif mo[i] >= mo_thr:
            lab = "motion"
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
            elif labels[j + 1] is None and gap < 2:
                j += 1
                gap += 1
            else:
                break
        segs.append({
            "type": lab,
            "start": round(frames[i]["t"], 2),
            "end": round(frames[j]["t"], 2),
            "frames": j - i + 1,
            "dur_ms": int(round((j - i + 1) * 1000 / rate)),
            "peak_motion": round(float(mo[i:j + 1].max()), 1),
            "peak_fire": int(fi[i:j + 1].max()),
            "peak_flash": int(fl[i:j + 1].max()),
        })
        i = j + 1

    by_type = {}
    for s in segs:
        by_type.setdefault(s["type"], 0)
        by_type[s["type"]] += 1

    dur = frames[-1]["t"]
    maxf = max(frames, key=lambda r: r["fire"])
    victory = (maxf["fire"] > 15000) and (maxf["t"] / dur > 0.85)
    return segs, by_type, victory


def parse_anim_index():
    rows = []
    if not os.path.exists(ANIM):
        return rows
    with open(ANIM, encoding="utf-8") as f:
        lines = f.readlines()
    for ln in lines:
        if not ln.strip().startswith("|"):
            continue
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if len(cells) < 7:
            continue
        if cells[0] in ("视频", "") or cells[0].startswith("---"):
            continue
        name = cells[0]
        try:
            start = float(cells[1].replace("s", ""))
        except Exception:
            start = 0.0
        fire_ms = 0
        m = re.search(r"(\d+)", cells[2])
        if m:
            fire_ms = int(m.group(1))
        rows.append({"name": name, "start": start, "fire_ms": fire_ms,
                     "white": cells[3], "black": cells[4], "shake": cells[5]})
    agg = {}
    for r in rows:
        a = agg.setdefault(r["name"], {"fire_ms": 0, "whites": [], "blacks": [], "shakes": []})
        a["fire_ms"] = max(a["fire_ms"], r["fire_ms"])
        for col, key in ((r["white"], "whites"), (r["black"], "blacks")):
            if "到" in col:
                nums = re.findall(r"\d+", col)
                if nums:
                    a[key].append((int(nums[0]), int(nums[-1])))
        sm = re.search(r"(\d+)/(\d+)", r["shake"])
        if sm:
            a["shakes"].append((int(sm.group(1)), int(sm.group(2))))
    return agg


def smoke_span(ranges):
    if not ranges:
        return "未检出"
    lo = min(r[0] for r in ranges)
    hi = max(r[1] for r in ranges)
    return f"{lo}→{hi} 帧（段内）"


def shake_txt(shakes):
    if not shakes:
        return "0"
    fr = max(s[0] for s in shakes)
    px = max(s[1] for s in shakes)
    return f"{fr} 帧 / 最大 {px}px"


def fullscan_summary(name):
    d = os.path.join(FULL, name)
    fr = load_json(os.path.join(d, "frames.json")) or []
    dur = fr[-1]["t"] if fr else 0.0
    nframes = len(fr)
    segs, by_type, victory = recompute_events(fr)
    sheets = sorted(glob.glob(os.path.join(d, "*.png")))
    return {
        "dur": dur, "nframes": nframes, "segs": segs, "by_type": by_type,
        "victory": victory, "sheets": [os.path.relpath(s, ROOT) for s in sheets],
    }


def main():
    anim = parse_anim_index()

    combat = []
    for p in sorted(glob.glob(os.path.join(VIDEO_DIR, "*.mp4"))):
        combat.append(os.path.splitext(os.path.basename(p))[0])
    for p in EXTRA:
        if os.path.exists(p):
            combat.append(os.path.splitext(os.path.basename(p))[0])

    home = []
    if os.path.isdir(HOME_DIR):
        for p in sorted(glob.glob(os.path.join(HOME_DIR, "*.mp4"))):
            home.append(p)

    out = []
    out.append("# KARDS 录屏整片分析 · 接手文档\n")
    out.append("> 自动汇总：`.work/fullscan/` 的整片时间线 + `.work/animscan/index.md` 的分段动画参数。\n")
    out.append(f"> 收录 **{len(combat)}** 个实战视频（14 个 `Downloads/视频/` + 2 个编号原视频）+ **{len(home)}** 个主页/菜单参考录屏。\n")
    out.append("> 脚本链：`fullscan.py`（整片）、`animscan.py`（分段）、`run_fullscan_all.py`（批量）、`gen_view.py`（本文）。\n")

    # ---- 一、跨视频动画参数总表 ----
    out.append("\n## 一、实战视频 · 动画参数总表（接手基线）\n")
    out.append("列：**最长燃烧**=分段火焰>阈值的连续时长；**白烟/黑烟**=阵亡烟雾段内帧区间；**震动**=整屏位移检出帧/最大位移；"
               "**中央强边缘段**=自动化检测的中央强水平边缘（噪声高，棋盘/HUD 也会触发，仅作粗略参考，非可靠出牌/施法信号）；"
               "**终局爆炸**=片尾超大火焰峰值（胜利，可靠）。\n")
    out.append("| # | 视频 | 时长 | 最长燃烧 | 白烟(阵亡) | 黑烟 | 震动 | 中央强边缘段(噪声高) | 终局爆炸(胜利) |")
    out.append("|---|---|---|---|---|---|---|---|---|")
    for i, n in enumerate(combat, 1):
        s = fullscan_summary(n)
        a = anim.get(n, {})
        fire = a.get("fire_ms", 0)
        white = smoke_span(a.get("whites", []))
        black = smoke_span(a.get("blacks", []))
        shake = shake_txt(a.get("shakes", []))
        big = f"{s['by_type'].get('bigcard', 0)}段/{sum(x['dur_ms'] for x in s['segs'] if x['type']=='bigcard')//1000}s"
        vic = "是" if s["victory"] else "否"
        dur = f"{s['dur']:.0f}s" if s["dur"] else "—"
        out.append(f"| {i} | {n} | {dur} | {fire}ms | {white} | {black} | {shake} | {big} | {vic} |")

    out.append("\n> ⚠️ **关于「中央强边缘段」**：fullscan 的 bigcard 检测本质是「画面中央出现一道上下强边缘」，"
               "在 KARDS 棋盘/HUD 布局上几乎持续触发（严格阈值下仍占 60%~97% 帧），**不能等同于出牌/施法特写**。"
               "可靠的动画信号是 `最长燃烧 / 白烟 / 黑烟 / 震动`（来自人工校订的 `animscan/index.md`）与 `终局爆炸`（片尾超大火焰）。"
               "若需研究指令牌施法，请直接看 `animscan/index.md` 里各视频的**拼图(sheet)** 人工挑选段，优先 `最希望卡手的一集`、`生产坦克最有用的一集`。\n")

    vic_videos = [n for n in combat if fullscan_summary(n)["victory"]]
    out.append("\n**快速定位**：\n")
    out.append(f"- 含**终局爆炸/胜利**（片尾超大火焰，可靠）：`{'、'.join(vic_videos) or '无'}`")
    out.append(f"- 标题即提示「牌多/多指令」的两局（指令牌施法干净参考优先）：`最希望卡手的一集`、`生产坦克最有用的一集`\n")

    # ---- 二、逐视频整片分析（实战） ----
    out.append("\n## 二、逐视频整片分析（实战）\n")
    for i, n in enumerate(combat, 1):
        s = fullscan_summary(n)
        out.append(f"\n### 2.{i} {n}\n")
        src = os.path.join(VIDEO_DIR, n + ".mp4")
        if not os.path.exists(src):
            src = [e for e in EXTRA if n in e][0]
        out.append(f"- 时长：**{s['dur']:.1f}s**，抽帧 **{s['nframes']}** 张（15fps，宽 640px）")
        out.append(f"- 源视频：`{src}`")
        a = anim.get(n, {})
        if a:
            out.append(f"- 分段动画参数：最长燃烧 **{a.get('fire_ms',0)}ms**，白烟 `{smoke_span(a.get('whites',[]))}`，黑烟 `{smoke_span(a.get('blacks',[]))}`，震动 `{shake_txt(a.get('shakes',[]))}`")
        if s["by_type"]:
            out.append("\n**事件类型统计**（严格阈值重算）：\n")
            out.append("| 类型 | 段数 | 总时长 | 含义 |")
            out.append("|---|---|---|---|")
            for t, c in sorted(s["by_type"].items(), key=lambda kv: -kv[1]):
                tot = sum(x["dur_ms"] for x in s["segs"] if x["type"] == t)
                out.append(f"| {t} | {c} | {tot//1000}s | {PHASE.get(t, t)} |")
            out.append("\n> 注：`bigcard` 为中央强边缘段，噪声高（见第一节说明），不单独解读；`fire` 含攻击火焰与终局爆炸，`victory` 真值在下方提示。")
        if s["segs"]:
            out.append("\n**关键时间线**（按峰值动作/火焰排序的若干段）：\n")
            out.append("| 起 | 止 | 类型 | 时长 | 峰值动作 | 峰值火焰 |")
            out.append("|---|---|---|---|---|---|")
            top = sorted(s["segs"], key=lambda x: -(x.get("peak_motion", 0) + x.get("peak_fire", 0) / 100.0))[:16]
            for sg in top:
                note = " ← 终局爆炸" if (sg["type"] == "fire" and sg["peak_fire"] > 15000) else ""
                out.append(f"| {sg['start']}s | {sg['end']}s | {sg['type']} | {sg['dur_ms']}ms | {sg['peak_motion']} | {sg['peak_fire']}{note} |")
        if s["sheets"]:
            out.append("\n**帧条/拼图**：" + "、".join(s["sheets"]))
        out.append("\n**接手提示**：")
        if s["victory"]:
            out.append("- 本片片尾有超大火焰峰值，是**胜利画面**，可用于校准胜利金爆（先压暗再爆发）。")
        if a.get("fire_ms", 0) >= 1500:
            out.append(f"- 燃烧特效较长（{a.get('fire_ms')}ms），注意阵亡/摧毁烟雾时长基线。")
        if n == "超雄小车3回合干爆总部":
            out.append(RICH_CHAOXIONG)
        out.append("")

    # ---- 三、主页/菜单参考录屏 ----
    out.append("\n## 三、主页/菜单参考录屏（UI 重做素材）\n")
    out.append("> 用户于 2026-10-27 录屏，包含**官方 KARDS 主页/主菜单**界面，用于网页版 UI 重做参考"
               "（当前网页版主菜单/构筑器/对局 HUD 被评价为「太丑」，需按原版重做）。\n")
    if home:
        out.append("| # | 文件 | 时长 | 内容提示 |")
        out.append("|---|---|---|---|")
        for i, p in enumerate(home, 1):
            name = os.path.basename(p)
            fr = load_json(os.path.join(FULL, os.path.splitext(name)[0], "frames.json"))
            dur = fr[-1]["t"] if fr else 0.0
            out.append(f"| {i} | `{name}` | {dur:.0f}s | 官方主页/菜单/导航（见下方帧条） |")
        out.append("\n**已整片分析的帧条/拼图**：")
        for p in home:
            name = os.path.splitext(os.path.basename(p))[0]
            sheets = sorted(glob.glob(os.path.join(FULL, name, "*.png")))
            if sheets:
                out.append(f"- `{name}`：" + "、".join(os.path.relpath(s, ROOT) for s in sheets))
        out.append("\n**接手建议**：用这些录屏的静止帧作为主菜单/构筑器/HUD 的视觉基准；"
                   "官方主页的配色、按钮层级、卡牌展示方式应作为 `public/` 前端重做的对照。")
        out.append("\n**已抽样确认的内容**（抽帧查看 2/4）：\n")
        out.append("- **主菜单（如 `2026-10-27 11 05 32` @3s）**：顶部条含头像/用户名 + 资源计数（如 8/10/20）；"
                   "左栏三个竖排按钮 `开始 / 卡牌 / 商店`；中央大轮播横幅 `最新卡组列表`（「需要一个实用的卡组…」），带轮播点；"
                   "右栏 `bilibili / 竞技场 / 打开卡包`；底栏 `军需箱`（带进度条）+ `任务`（带计数 16）。"
                   "整体为**木纹暗色军事风**（橄榄绿/卡其/暗红/哑光金），按钮深色配橙金高亮。")
        out.append("- **对局内 HUD（如 `2026-10-27 11 11 46` @6s）**：竖向战场，上下分敌我，中央锯齿状白色**前线**分隔；"
                   "左上对手头像+名称+HQ 血量、左下己方头像+HQ 血量；右侧齿轮(设置)/聊天图标 + 白色描边 `结束回合` 按钮；"
                   "中央 `友方回合` 金色横幅；底部扇形手牌。卡牌为二战宣传画风，带攻防数值与费用 pip。")
        out.append("- 这些正是当前网页版被评价为「太丑」、需要按原版重做的对照基准（主菜单/构筑器/对局 HUD）。")
    else:
        out.append("（未找到 `C:/Users/pc15/Documents/PicPick/含主页的视频` 目录）\n")

    # ---- 四、接手指南 ----
    out.append("\n## 四、接手指南（给下一个接手的人）\n")
    out.append("1. **素材位置**：\n"
               "   - 实战视频：`C:/Users/pc15/Downloads/视频/`（14 个）+ `Downloads/` 根目录两个编号视频。\n"
               "   - 主页录屏：`C:/Users/pc15/Documents/PicPick/含主页的视频/`（4 个，2026-10-27 录制）。\n"
               "   - 本机若已清理，需重新获取。\n")
    out.append("2. **分析工具链**：\n"
               "   - `tools/animscan.py <视频目录>`：4fps 低分辨率扫描，挑运动最强段，量化火焰/白烟/黑烟/震动，输出 `animscan/index.md`。\n"
               "   - `tools/fullscan.py <单个视频>`：整片 15fps 抽帧，事件分类，输出 `fullscan/<name>/{report.md,segments.json,frames.json,帧条PNG}`。\n"
               "   - `tools/run_fullscan_all.py`：批量跑全部视频。\n"
               "   - `tools/gen_view.py`：本脚本，把上面结果汇总成 `view.md`。\n")
    out.append("3. **动画基线结论**（来自全片，重点）：\n"
               "   - 出牌落位 0.6~0.9s，原版**无回弹无震屏**，靠火焰面积+持续+帧间闪烁拉层次。\n"
               "   - 攻击命中火焰 0.4~0.8s；阵亡白烟 0.9~1.5s（比命中火长，需把死亡烟拉长、命中火收紧）。\n"
               "   - 胜利是唯一全屏级特效：**先压暗再爆发**（亮度先降 0.15s 再金爆 0.6s）。\n"
               "   - 屏幕震动在原版极少检出（多数 0 帧），网页版保持克制（3~5px/0.13s）。\n"
               "   - 指令牌施法目前缺干净录屏素材，按惯例 + 实测时长基线实现。\n")
    out.append("4. **与网页版对照**：当前实现见 `public/js/ui.js`（fxPuffs/fxScorch/fxBurst/fxVictory 等）、"
               "`public/js/sfx.js`（WebAudio 合成音效）、`public/js/vendor/gsap.min.js`（动画库）。\n")
    out.append("5. **未覆盖**：实战视频里指令牌施法镜头稀少，仍需针对性补录一局「牌多/多指令」的对局做逐帧对齐；"
               "主页 UI 已录屏但前端重做尚未开始（见第三节）。\n")

    with open(VIEW, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print(f"view.md 已生成：{VIEW}")
    print(f"  实战视频 {len(combat)}（含胜利 {len(vic_videos)}）；主页录屏 {len(home)}")


if __name__ == "__main__":
    main()
