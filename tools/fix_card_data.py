"""按审计结果修复卡牌数据（v35）
修复项：
1. 恢复 52 张卡的重甲（heavyArmor）——官方 raw.heavyArmor 曾丢失
2. HQ 卡图路径补 res/hq-cards/ 前缀（178 个 HQ 共用 12 张图）
3. 文本空白规范化（连续空格、标点前空格）
用法: python tools/fix_card_data.py
"""
import json, re, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
raw = json.load(open(ROOT / 'kards-sim' / 'cards.json', encoding='utf-8'))
raw_by_id = {c['id']: c for c in raw}

# 备份
shutil.copy(DATA / 'cards.json', DATA / 'cards.json.bak')
shutil.copy(DATA / 'hqs.json', DATA / 'hqs.json.bak')

cards = json.load(open(DATA / 'cards.json', encoding='utf-8'))
hqs = json.load(open(DATA / 'hqs.json', encoding='utf-8'))

fixed_armor, fixed_text = [], []

# 1) 重甲
for c in cards:
    r = raw_by_id.get(c['id'])
    if not r:
        continue
    armor = (r.get('raw') or {}).get('heavyArmor')
    if armor and (c.get('heavyArmor') or 0) != armor:
        c['heavyArmor'] = armor
        fixed_armor.append((c['name'], armor))

# 2) HQ 卡图路径
hq_dir = ROOT / 'kards-img' / 'res' / 'hq-cards'
have = set(p.name for p in hq_dir.iterdir()) if hq_dir.is_dir() else set()
fixed_img = 0
for h in hqs:
    img = h.get('image') or ''
    if img and '/' not in img and img in have:
        h['image'] = 'res/hq-cards/' + img
        fixed_img += 1

# 3) 文本规范化
def tidy(t):
    if not t:
        return t
    t = t.replace('\u00a0', ' ')
    t = re.sub(r'[ \t]{2,}', ' ', t)
    t = re.sub(r'\s+([.,;:!?])', r'\1', t)
    return t.strip()

for c in cards + hqs:
    before = c.get('text')
    after = tidy(before)
    if before != after:
        c['text'] = after
        fixed_text.append(c['id'])

json.dump(cards, open(DATA / 'cards.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
json.dump(hqs, open(DATA / 'hqs.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

print(f'重甲恢复 {len(fixed_armor)} 张')
for n, a in fixed_armor[:8]:
    print('  ', n, 'heavyArmor=', a)
print(f'HQ 卡图路径修正 {fixed_img} 个')
print(f'文本规范化 {len(fixed_text)} 张: {fixed_text[:6]}')
print('备份: data/*.json.bak')
