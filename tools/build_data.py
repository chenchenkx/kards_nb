#!/usr/bin/env python3
"""Build the web card database from kards-sim's cards.json.

Reads:  ../kards-sim/cards.json   (1906 official card definitions)
        ../tree.json              (kards-img repo file listing)
Writes: ../kards-web/data/cards.json  (normalized card database)
        ../kards-web/data/hqs.json    (HQ cards per nation)
"""
import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CARDS_SRC = ROOT / "kards-sim" / "cards.json"
TREE_SRC = ROOT / "tree.json"
OUT_DIR = ROOT / "kards-web" / "data"

NATIONS = ["Germany", "USA", "Soviet", "Japan", "Britain",
           "France", "Italy", "Poland", "Finland", "Anzac", "Neutral"]

# Default HQ per nation (official Kards default headquarters).
HQ_DATA = {
    "Germany":  {"name": "BERLIN", "id": "card_location_berlin"},
    "USA":      {"name": "CHERBOURG", "id": "card_location_cherbourg"},
    "Soviet":   {"name": "STALINGRAD", "id": "card_location_stalingrad"},
    "Japan":    {"name": "CHANGCHUN", "id": "card_location_changchun"},
    "Britain":  {"name": "LONDON", "id": "card_location_london_waw"},
    "France":   {"name": "PARIS", "id": None},
    "Italy":    {"name": "ROME", "id": None},
    "Poland":   {"name": "WARSAW", "id": None},
    "Finland":  {"name": "HELSINKI", "id": None},
    "Anzac":    {"name": "CANBERRA", "id": None},
    "Neutral":  {"name": "HQ", "id": None},
}

# Set display names (English, as on the cards).
SET_NAMES = {
    "Basic": "Base Set", "Special": "Special", "Expansion2019": "Allegiance",
    "BloodAndIron": "Blood & Iron", "Homefront": "Homefront", "NavalWarfare": "Naval Warfare",
    "Breakthrough": "Breakthrough", "Legions": "Legions", "OnlySpawnable": "Spawnable",
    "BrothersInArms": "Brothers in Arms", "OceaniaStorm": "Oceania Storm",
    "CurrentExpansion": "Current Expansion", "WinterWar": "Winter War",
    "WorldAtWar": "World at War", "Campaign2020": "Campaign",
}

FLAG_TO_KEYWORD = {
    "hasBlitz": "blitz",
    "hasFury": "fury",
    "hasGuard": "guard",
    "hasSmokescreen": "smokescreen",
    "hasAmbush": "ambush",
    "hasShock": "shock",
    "hasAlpine": "alpine",
    "hasPincer": "pincer",
    "hasCovert": "covert",
    "hasMobilize": "mobilize",
    "hasSalvage": "salvage",
    "hasDestruction": "destruction",
    "hasDeployment": "deployment",
    "hasScrying": "scrying",
}


def deaccent(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def image_variants(title: str):
    """Generate candidate image file slugs for a card title."""
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
    """Extract heavy armor level from flags/raw/text."""
    raw = card.get("raw") or {}
    for key in raw:
        if "heavyarmor" in key.lower():
            m = re.search(r"(\d)", key)
            if m:
                return int(m.group(1))
    text = card.get("text") or ""
    m = re.search(r"heavy armour (\d)", text, re.I) or re.search(r"heavy armor (\d)", text, re.I)
    if m:
        return int(m.group(1))
    return 0


def main():
    cards = json.loads(CARDS_SRC.read_text(encoding="utf-8"))
    tree = json.loads(TREE_SRC.read_text(encoding="utf-8"))
    # filename -> (folder, size)
    img_index = {}
    for t in tree["tree"]:
        if t["type"] != "blob":
            continue
        p = t["path"]
        if p.startswith(("img/", "thumb/", "altart/")):
            img_index.setdefault(p.split("/")[-1], p)

    out = []
    stats = {"matched_img": 0, "matched_thumb": 0, "no_image": 0}
    for c in cards:
        raw = c.get("raw") or {}
        ctype = c.get("type")
        if ctype not in ("infantry", "tank", "artillery", "fighter", "bomber",
                         "order", "gotcha", "location"):
            continue
        title = raw.get("title") or c.get("name") or c["id"]

        # resolve image
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
            stats["no_image"] += 1

        keywords = set()
        for flag, kw in FLAG_TO_KEYWORD.items():
            if (c.get("flags") or {}).get(flag):
                keywords.add(kw)
        # heavy armor in text like "Heavy Armor 1" as unit keyword
        ha = parse_heavy_armor(c)
        if ha:
            keywords.add("heavyArmor%d" % ha)

        # deployment / destruction effect text
        text = c.get("text") or ""
        deploy_text = None
        if (c.get("flags") or {}).get("hasDeployment"):
            # deployment text usually appears in the card text; keep whole text
            deploy_text = text

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
        }
        # skip non-playable spawnable tokens unless they have real stats
        if ctype == "location" and card_obj["cost"] == 0 and card_obj["defense"] == 0:
            continue
        # user requirement: only keep cards that have official artwork
        if not image:
            continue
        out.append(card_obj)

    # dedupe by id
    seen = {}
    for c in out:
        seen[c["id"]] = c
    out = sorted(seen.values(), key=lambda c: (c["nation"], c["name"]))

    # HQ cards
    hqs = []
    for nation in NATIONS:
        info = HQ_DATA[nation]
        hqs.append({
            "id": "hq_" + nation.lower(),
            "name": info["name"],
            "type": "hq",
            "nation": nation,
            "rarity": "HQ",
            "set": "HQ",
            "cost": 0,
            "defense": 20,
            "text": "Headquarters of the " + nation + " forces. Destroy it to win the battle.",
            "keywords": [],
            "image": None,
        })

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "cards.json").write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT_DIR / "hqs.json").write_text(
        json.dumps(hqs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print("cards:", len(out), "| stats:", stats)
    from collections import Counter
    print("by type:", dict(Counter(c["type"] for c in out)))
    print("by nation:", dict(Counter(c["nation"] for c in out)))


if __name__ == "__main__":
    main()
