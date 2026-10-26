#!/usr/bin/env python3
"""Build the web card database from kards-sim's official card definitions.

Reads:  kards-sim/cards.json   (1906 official card definitions, incl. 178 locations)
        tree.json              (kards-img repo file listing, for artwork slugs)
Writes: data/cards.json        (all playable cards: units / orders / gotcha)
        data/hqs.json          (all location cards = chooseable headquarters)

设计要点（对应 AI-PROMPT.md 3.2 / 3.3 / 3.6）：
- 不再因为「没有卡图」就丢弃卡牌：缺图保留数据，image=null，前端用占位。
- location 卡（官方 178 张）全部输出到 hqs.json，保留官方 id 与真实 defense
  （官方存在 10/12/14/16/20/30 等多档；campaign 变体标记 campaign=true）。
- HQ 卡图按 id 精确映射到 public/assets/hq/*.jpg，修掉「名字与图不一致」。
"""
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

# 项目已移到仓库根：server/ public/ data/ tools/ 与本文件同级
ROOT = Path(__file__).resolve().parent.parent
CARDS_SRC = ROOT / "kards-sim" / "cards.json"
TREE_SRC = ROOT / "tree.json"
OUT_DIR = ROOT / "data"

NATIONS = ["Germany", "USA", "Soviet", "Japan", "Britain",
           "France", "Italy", "Poland", "Finland", "Anzac", "Neutral"]

# 官方五大主国的默认总部（location 卡 id），其余国家是副国（无 HQ）
DEFAULT_HQ = {
    "Germany": "card_location_berlin",          # DANZIG
    "USA": "card_location_cherbourg",           # CHERBOURG
    "Soviet": "card_location_stalingrad",       # STALINGRAD
    "Japan": "card_location_changchun",         # TRUK
    "Britain": "card_location_london_waw",      # LONDON
    "Neutral": "card_location_concrete_bunker_neutral",
}

# location id → public/assets/hq/ 里已有的官方 HQ 卡图
HQ_IMAGE_BY_ID = {
    "card_location_berlin": "Danzig.jpg",
    "card_location_london_waw": "London.jpg",
    "card_location_stalingrad": "Stalingrad.jpg",
    "card_location_cherbourg": "Cherbourg.jpg",
    "card_location_changchun": "Truk.jpg",
    "card_location_arnhem": "Arnhem.jpg",
    "card_location_tunis_city": "Tunis.jpg",
    "card_location_kursk": "Kursk.jpg",
    "card_location_moscow": "Moscow.jpg",
    "card_location_villers_bocage": "Villers_Bocage.jpg",
    "card_location_fortress_darwin_neutral": "Darwin_Fortress_Blank.jpg",
    "card_location_concrete_bunker_neutral": "Bunker_Blank.jpg",
}

# 缺图时的国家兜底（同国家不同 HQ 只要有精确图就优先用精确图）
NATION_FALLBACK_IMAGE = {
    "Germany": "Danzig.jpg", "USA": "Cherbourg.jpg", "Soviet": "Stalingrad.jpg",
    "Japan": "Truk.jpg", "Britain": "London.jpg", "France": "Villers_Bocage.jpg",
    "Italy": "Tunis.jpg", "Poland": "Arnhem.jpg",
    "Finland": "Bunker_Blank.jpg", "Anzac": "Darwin_Fortress_Blank.jpg",
    "Neutral": "Bunker_Blank.jpg",
}

SET_NAMES = {
    "Basic": "Base Set", "Special": "Special", "Expansion2019": "Allegiance",
    "BloodAndIron": "Blood & Iron", "Homefront": "Homefront", "NavalWarfare": "Naval Warfare",
    "Breakthrough": "Breakthrough", "Legions": "Legions", "OnlySpawnable": "Spawnable",
    "BrothersInArms": "Brothers in Arms", "OceaniaStorm": "Oceania Storm",
    "CurrentExpansion": "Current Expansion", "WinterWar": "Winter War",
    "WorldAtWar": "World at War", "Campaign2020": "Campaign",
}

FLAG_TO_KEYWORD = {
    "hasBlitz": "blitz", "hasFury": "fury", "hasGuard": "guard",
    "hasSmokescreen": "smokescreen", "hasAmbush": "ambush", "hasShock": "shock",
    "hasAlpine": "alpine", "hasPincer": "pincer", "hasCovert": "covert",
    "hasMobilize": "mobilize", "hasSalvage": "salvage", "hasDestruction": "destruction",
    "hasDeployment": "deployment", "hasScrying": "scrying",
}

# campaign / 教学关的 HQ 变体：数据要保留，但不在构筑器里当可选总部
CAMPAIGN_SUFFIX = re.compile(r"_(unlock\d+|scen\d*|ai|tut|base.*|event)$")


def deaccent(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def image_variants(title: str):
    s = deaccent(title)
    for ch in ["\u2019", "'", "\u201d", "\u201c", '"', ",", "(", ")", "/"]:
        s = s.replace(ch, "")
    s2 = s.replace(".", "")
    v = {
        re.sub(r"[^a-z0-9]+", "_", s2).strip("_"),
        re.sub(r"[^a-z0-9]+", "_", s2.replace("-", "")).strip("_"),
        s.replace(" ", "_"),
        re.sub(r"[^a-z0-9]+", "", s2),
        re.sub(r"[^a-z0-9]+", "_", s).strip("_"),
    }
    v.discard("")
    return v


def parse_heavy_armor(card):
    raw = card.get("raw") or {}
    for key in raw:
        if "heavyarmor" in key.lower():
            m = re.search(r"(\d)", key)
            if m:
                return int(m.group(1))
    text = card.get("text") or ""
    m = re.search(r"heavy armour (\d)", text, re.I) or re.search(r"heavy armor (\d)", text, re.I)
    return int(m.group(1)) if m else 0


def base_location_id(loc_id: str) -> str:
    """把 campaign 变体 id 归到基础 id（用于继承卡图）。"""
    return CAMPAIGN_SUFFIX.sub("", loc_id)


def build_hq(card):
    raw = card.get("raw") or {}
    loc_id = card["id"]
    title = raw.get("title") or card.get("name") or loc_id
    nation = card.get("faction") or "Neutral"
    defense = raw.get("defense")
    base_id = base_location_id(loc_id)

    image = HQ_IMAGE_BY_ID.get(loc_id) or HQ_IMAGE_BY_ID.get(base_id) \
        or NATION_FALLBACK_IMAGE.get(nation)

    is_campaign = bool(CAMPAIGN_SUFFIX.search(loc_id))
    # 官方数据里 defense 缺失的 location（如 THEATERS OF WAR）是事件卡，不当作可选总部
    playable = bool(defense) and not is_campaign

    return {
        "id": loc_id,
        "name": title,
        "type": "hq",
        "nation": nation,
        "rarity": "HQ",
        "set": card.get("cardSet") or "Basic",
        "setName": SET_NAMES.get(card.get("cardSet") or "Basic", card.get("cardSet") or "Basic"),
        "cost": 0,
        "opCost": 0,
        "attack": 0,
        "defense": int(defense) if defense else 0,
        "text": card.get("text") or "",
        "keywords": [],
        "image": image,
        "campaign": is_campaign,
        "playable": playable,
        "isDefault": loc_id in DEFAULT_HQ.values(),
    }


def main():
    cards = json.loads(CARDS_SRC.read_text(encoding="utf-8"))
    img_index = {}
    if TREE_SRC.exists():
        tree = json.loads(TREE_SRC.read_text(encoding="utf-8"))
        for t in tree.get("tree", []):
            if t.get("type") != "blob":
                continue
            p = t["path"]
            if p.startswith(("img/", "thumb/", "altart/")):
                img_index.setdefault(p.split("/")[-1], p)

    out = []
    hqs = []
    stats = {"matched_img": 0, "matched_thumb": 0, "no_image": 0, "locations": 0}

    for c in cards:
        raw = c.get("raw") or {}
        ctype = c.get("type")

        if ctype == "location":
            hq = build_hq(c)
            hqs.append(hq)
            stats["locations"] += 1
            continue

        if ctype not in ("infantry", "tank", "artillery", "fighter", "bomber",
                         "order", "gotcha"):
            continue

        title = raw.get("title") or c.get("name") or c["id"]

        # ---- artwork ----
        image = None
        for slug in image_variants(title):
            if slug + ".png" in img_index:
                image = "img/" + slug + ".png"
                stats["matched_img"] += 1
                break
            if slug + ".jpg" in img_index:
                image = "img/" + slug + ".jpg"
                stats["matched_img"] += 1
                break
        if image is None:
            for slug in image_variants(title):
                if slug + ".jpg" in img_index:
                    image = "thumb/" + slug + ".jpg"
                    stats["matched_thumb"] += 1
                    break
                if slug + ".png" in img_index:
                    image = "thumb/" + slug + ".png"
                    stats["matched_thumb"] += 1
                    break
        if image is None:
            # 卡图客观缺失：保留数据（3.6），前端用占位卡面
            stats["no_image"] += 1

        keywords = set()
        for flag, kw in FLAG_TO_KEYWORD.items():
            if (c.get("flags") or {}).get(flag):
                keywords.add(kw)
        ha = parse_heavy_armor(c)
        if ha:
            keywords.add("heavyArmor%d" % ha)

        text = c.get("text") or ""
        card_obj = {
            "id": c["id"],
            "name": title,
            "type": ctype,
            "nation": c.get("faction") or "Neutral",
            "rarity": c.get("rarity") or "Standard",
            "set": c.get("cardSet") or "Basic",
            "setName": SET_NAMES.get(c.get("cardSet") or "Basic", c.get("cardSet") or "Basic"),
            "cost": raw.get("kredits", 0) or 0,
            "opCost": raw.get("operationCost", 0) or 0,
            "attack": raw.get("attack", 0) or 0,
            "defense": raw.get("defense", 0) or 0,
            "range": raw.get("range", 0) or 0,
            "text": text,
            "flavor": raw.get("flavorText") or "",
            "keywords": sorted(keywords),
            "heavyArmor": ha,
            "image": image,
            "needsTarget": bool((c.get("flags") or {}).get("selectTargetOnPlayedFromHand")),
            "isDirectDamage": bool((c.get("flags") or {}).get("isDirectDamage")),
            "isDraw": bool((c.get("flags") or {}).get("isDraw")),
            "isRemoval": bool((c.get("flags") or {}).get("isRemoval")),
            "isHQDamage": bool((c.get("flags") or {}).get("isHQDamage")),
            "isHQRepair": bool((c.get("flags") or {}).get("isHQRepair")),
            "isDefenseBuff": bool((c.get("flags") or {}).get("isDefenseBuff")),
            "isAttackBuff": bool((c.get("flags") or {}).get("isAttackBuff")),
            "isKreditsBuff": bool((c.get("flags") or {}).get("isKreditsBuff")),
            "spawn": c.get("spawnCardName"),
            "chooseOne": c.get("chooseOneCards") is not None,
            "usedTriggers": c.get("usedTriggers") or [],
            "artist": raw.get("artist") or "",
            "inPermanentPool": bool((c.get("flags") or {}).get("isInPermanentPool")),
            "isElite": (c.get("rarity") or "") in ("Unique", "Elite"),
        }
        out.append(card_obj)

    # dedupe by id
    seen = {}
    for c in out:
        seen[c["id"]] = c
    out = sorted(seen.values(), key=lambda c: (c["nation"], c["name"]))

    hq_seen = {}
    for h in hqs:
        hq_seen[h["id"]] = h
    hqs = sorted(hq_seen.values(), key=lambda h: (h["nation"], not h["isDefault"], h["campaign"], h["name"], h["defense"]))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # 只写运行时真的会用到的字段（flavor/artist/各类 is* 标记在 v15 之后已无引用，
    # 占原文件一半以上体积；客户端首屏要 parse 这份 JSON）
    KEEP = ("id", "name", "type", "nation", "rarity", "set", "cost", "opCost",
            "attack", "defense", "range", "text", "keywords", "heavyArmor",
            "image", "spawn")
    out = [{k: c[k] for k in KEEP if k in c} for c in out]
    (OUT_DIR / "cards.json").write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT_DIR / "hqs.json").write_text(
        json.dumps(hqs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print("cards:", len(out), "| hqs:", len(hqs), "| 合计:", len(out) + len(hqs))
    print("stats:", stats)
    print("by type:", dict(Counter(c["type"] for c in out)))
    print("by nation:", dict(Counter(c["nation"] for c in out)))
    print("HQ defense 分布:", dict(Counter(h["defense"] for h in hqs)))
    print("可选 HQ（playable）:", sum(1 for h in hqs if h["playable"]))
    print("缺图卡牌:", [c["name"] for c in out if not c["image"]][:10])


if __name__ == "__main__":
    main()
