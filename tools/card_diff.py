"""权威数据 diff：我们的 data/cards.json + hqs.json ←→ kards-sim/cards.json(官方 raw)
输出 .work/card_diff.md，按字段分类列出所有不一致。
用法: python tools/card_diff.py
"""
import json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ours = json.load(open(ROOT / 'data' / 'cards.json', encoding='utf-8'))
our_hqs = json.load(open(ROOT / 'data' / 'hqs.json', encoding='utf-8'))
raw = json.load(open(ROOT / 'kards-sim' / 'cards.json', encoding='utf-8'))

FLAG_TO_KW = {
    'hasGuard': 'guard', 'hasBlitz': 'blitz', 'hasFury': 'fury', 'hasSmokescreen': 'smokescreen',
    'hasAmbush': 'ambush', 'hasShock': 'shock', 'hasMobilize': 'mobilize', 'hasAlpine': 'alpine',
    'hasPincer': 'pincer', 'hasCovert': 'covert',
}

by_id = {c['id']: c for c in raw}
our_all = {c['id']: c for c in ours}
our_all.update({c['id']: c for c in our_hqs})

def norm_text(t):
    t = (t or '').replace('\u2019', "'").replace('\u2018', "'").replace('\u201c', '"').replace('\u201d', '"')
    t = re.sub(r'\s+', ' ', t).strip().lower()
    return t

diffs = {}
def add(kind, cid, msg):
    diffs.setdefault(kind, []).append((cid, msg))

for cid, o in our_all.items():
    r = by_id.get(cid)
    if not r:
        add('数据源缺失（我方独有）', cid, f'{o.get("name")} {o.get("type")}')
        continue
    rr = r.get('raw') or {}
    name = o.get('name') or cid
    # 数值
    for field, rawkey in [('attack', 'attack'), ('defense', 'defense'), ('cost', 'kredits')]:
        ov = o.get(field)
        rv = rr.get(rawkey)
        if rv is None and ov in (0, None):
            continue
        if rv is not None and ov != rv:
            add(f'数值不符-{field}', cid, f'{name}: 我方 {ov} ≠ 官方 {rv}')
    ov = o.get('opCost')
    rv = rr.get('operationCost')
    if rv is not None and ov != rv:
        add('数值不符-opCost', cid, f'{name}: 我方 {ov} ≠ 官方 {rv}')
    ov = o.get('range')
    rv = rr.get('range')
    if rv is not None and ov != rv:
        add('数值不符-range', cid, f'{name}: 我方 {ov} ≠ 官方 {rv}')
    # 文本
    if norm_text(o.get('text')) != norm_text(rr.get('Text')):
        add('文本不符', cid, f'{name}:\n    我方: {o.get("text")!r}\n    官方: {rr.get("Text")!r}')
    # 关键词（官方 flags）
    flags = r.get('flags') or {}
    want = {kw for f, kw in FLAG_TO_KW.items() if flags.get(f)}
    have = {str(k).lower() for k in (o.get('keywords') or [])}
    for kw in sorted(want - have):
        add('关键词缺失', cid, f'{name}: 官方有 {kw}，我方 keywords={sorted(have)}')
    # 重型装甲
    if flags.get('heavyArmor') and not (o.get('heavyArmor') or 0):
        add('重甲缺失', cid, f'{name}: 官方有重型装甲，我方 {o.get("heavyArmor")}')

# 官方有、我方完全没有
for cid, r in by_id.items():
    if cid in our_all:
        continue
    add('我方缺失', cid, f'{r.get("name")} ({r.get("type")})')

order = ['数值不符-attack', '数值不符-defense', '数值不符-cost', '数值不符-opCost', '数值不符-range',
         '文本不符', '关键词缺失', '重甲缺失', '我方缺失', '数据源缺失（我方独有）']
total = sum(len(v) for v in diffs.values())
lines = [f'# 官方数据 diff（我方 {len(our_all)} / 官方 {len(by_id)}）\n', f'不一致 **{total}** 处\n']
for k in order:
    if k not in diffs:
        continue
    lines.append(f'\n## {k}（{len(diffs[k])}）\n')
    for cid, msg in diffs[k][:400]:
        lines.append(f'- `{cid}` — {msg}')
out = ROOT / '.work' / 'card_diff.md'
out.write_text('\n'.join(lines), encoding='utf-8')
print(f'不一致 {total}')
for k in order:
    if k in diffs:
        print(f'  {k}: {len(diffs[k])}')
print('->', out)
