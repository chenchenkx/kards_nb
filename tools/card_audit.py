"""卡牌数据全量审计（结构 / 数值 / 关键词 / 卡图 / 重复 / HQ）→ .work/card_audit.md
用法: python tools/card_audit.py
"""
import json, os, re, sys, collections
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
cards = json.load(open(ROOT / 'data' / 'cards.json', encoding='utf-8'))
hqs = json.load(open(ROOT / 'data' / 'hqs.json', encoding='utf-8'))
IMG = Path(os.environ.get('KARDS_IMG_DIR') or (ROOT / 'kards-img'))

VALID_NATIONS = {'Germany', 'USA', 'Soviet', 'Japan', 'Britain', 'France', 'Italy', 'Poland', 'Finland', 'Anzac', 'Neutral'}
VALID_TYPES = {'infantry', 'tank', 'artillery', 'fighter', 'bomber', 'order', 'gotcha'}
VALID_RARITY = {'Common', 'Uncommon', 'Rare', 'Unique', 'HQ'}
UNIT_TYPES = {'infantry', 'tank', 'artillery', 'fighter', 'bomber'}
KW = {'guard', 'blitz', 'fury', 'smokescreen', 'ambush', 'shock', 'mobilize', 'alpine', 'pincer',
      'covert', 'veteran', 'heavyarmor', 'deployment', 'destruction', 'salvage', 'scrying', 'intel'}
KW_TEXT = {'guard': 'guard', 'blitz': 'blitz', 'fury': 'fury', 'smokescreen': 'smoke', 'ambush': 'ambush',
           'shock': 'shock', 'mobilize': 'mobilize', 'alpine': 'alpine', 'pincer': 'pincer', 'covert': 'covert'}

issues = collections.defaultdict(list)

# 已知官方原值（来源 kards-sim/cards.json raw，经核对为官方设计而非数据错误）
KNOWN_OFFICIAL = {
    'card_unit_tbf_avanger': 'TBF-1 AVENGER 官方 range=4（轰炸机远程）',
    'card_unit_superman': 'SUPERMAN 官方 infantry range=2（彩蛋卡）',
    'card_unit_641st_rifles_vet': '641st RIFLES 老兵官方 8/1（攻击换防御的老兵设计）',
    'card_location_special_event': 'THEATERS OF WAR 官方 defense=0 且 playable=false（战役特殊总部）',
}
def skip(ident):
    return ident in KNOWN_OFFICIAL

def add(kind, ident, msg):
    if not skip(ident):
        issues[kind].append((ident, msg))

ids = [c.get('id') for c in cards]
hqids = [h.get('id') for h in hqs]
allids = ids + hqids

# ---------- 1. ID / 名称重复 ----------
dup_ids = [i for i, n in collections.Counter(allids).items() if n > 1]
for i in dup_ids:
    add('重复ID', i, f'出现 {collections.Counter(allids)[i]} 次')

# 同名卡（不同 id）：区分合法变体（_vet/_cam/不同国家）与可疑重复
by_name = collections.defaultdict(list)
for c in cards:
    by_name[c.get('name', '?')].append(c)
for nm, lst in by_name.items():
    if len(lst) < 2:
        continue
    # 完全同属性同国家同文本 → 可疑重复
    sigs = collections.Counter((c.get('nation'), c.get('type'), c.get('cost'), c.get('attack'), c.get('defense'), (c.get('text') or '').strip()) for c in lst)
    for sig, n in sigs.items():
        if n > 1:
            dup = [c['id'] for c in lst if (c.get('nation'), c.get('type'), c.get('cost'), c.get('attack'), c.get('defense'), (c.get('text') or '').strip()) == sig]
            add('同名同属性重复', nm, f'{n} 张完全相同: {dup}')

# ---------- 2. 必填字段 ----------
REQ = ['id', 'name', 'type', 'nation', 'rarity', 'cost', 'image']
for c in cards + hqs:
    for k in REQ:
        if c.get(k) in (None, ''):
            add('字段缺失', c.get('id', '?'), f'缺少 {k}')

# ---------- 3. 数值合法性 ----------
for c in cards:
    cid, t = c.get('id', '?'), c.get('type', '')
    cost = c.get('cost')
    atk, df = c.get('attack'), c.get('defense')
    opc = c.get('opCost')
    rng = c.get('range')
    name = c.get('name', '?')
    if not isinstance(cost, int) or cost < 0 or cost > 12:
        add('费用异常', cid, f'{name} cost={cost}')
    if not isinstance(atk, int) or atk < 0 or atk > 20:
        add('攻击异常', cid, f'{name} attack={atk}')
    if not isinstance(df, int) or df < 0 or df > 30:
        add('防御异常', cid, f'{name} defense={df}')
    if t in UNIT_TYPES:
        if df == 0:
            add('单位防御为0', cid, f'{name} ({t}) defense=0')
        if opc is None:
            add('行动费缺失', cid, f'{name} ({t}) opCost 缺失')
        elif opc < 0 or opc > 6:
            add('行动费异常', cid, f'{name} opCost={opc}')
    else:
        # 指令牌不应有攻防/行动费/射程
        if atk not in (0, None):
            add('指令牌有攻击', cid, f'{name} attack={atk}')
        if df not in (0, None):
            add('指令牌有防御', cid, f'{name} defense={df}')
        if opc not in (0, None):
            add('指令牌有行动费', cid, f'{name} opCost={opc}')
    if t in UNIT_TYPES and (not isinstance(rng, int) or rng < 1 or rng > 3):
        add('射程异常', cid, f'{name} range={rng}')
    # 兵种射程约定：火炮/飞机 2，地面近战 1
    if t in ('artillery', 'fighter', 'bomber') and rng == 1:
        add('射程与兵种不符', cid, f'{name} ({t}) range=1')
    if t in ('infantry', 'tank') and rng and rng > 1:
        add('射程与兵种不符', cid, f'{name} ({t}) range={rng}')
    if c.get('nation') not in VALID_NATIONS:
        add('国家非法', cid, f'{name} nation={c.get("nation")}')
    if t not in VALID_TYPES:
        add('类型非法', cid, f'{name} type={t}')
    if c.get('rarity') not in VALID_RARITY:
        add('稀有度非法', cid, f'{name} rarity={c.get("rarity")}')

# ---------- 4. 关键词一致性 ----------
for c in cards:
    cid, name = c.get('id', '?'), c.get('name', '?')
    kws = [str(k).lower() for k in (c.get('keywords') or [])]
    text = (c.get('text') or '')
    tl = text.lower()
    for k in kws:
        if k not in KW:
            add('未知关键词', cid, f'{name} keywords 含 {k}')
    # 卡面文本"本体静态关键词"缺失检查：只认 <kw>. / has <kw>. / unit has <kw> 这类
    # 明确声明本体关键词的句式；"gains/give/get + <kw>" 都是效果授予，不算数据缺失
    for k in ['guard', 'blitz', 'fury', 'smokescreen', 'ambush', 'shock', 'mobilize']:
        if k in kws:
            continue
        static_pat = re.compile(r'(?:^|[.;]\s*)(?:this unit |it )?(?:has |have )?' + k + r'\s*\.?\s*$', re.I)
        if static_pat.search(text.strip()):
            add('文本有关键词但数据缺失', cid, f'{name}: 文本静态声明 {k}，keywords={kws}')

# ---------- 5. 卡图存在性 ----------
missing_img = []
for c in cards + hqs:
    img = c.get('image')
    if not img:
        add('卡图缺失', c.get('id', '?'), f'{c.get("name")} 无 image 字段')
        continue
    p = IMG / img
    alt = IMG / re.sub(r'^thumb/', 'img/', re.sub(r'\.jpg$', '.png', img))
    alt2 = IMG / re.sub(r'^img/', 'thumb/', re.sub(r'\.png$', '.jpg', img))
    if not p.exists() and not alt.exists() and not alt2.exists():
        missing_img.append((c.get('id'), c.get('name'), img))
for cid, name, img in missing_img:
    add('卡图文件不存在', cid, f'{name} -> {img}')

# ---------- 6. 老兵变体一致性 ----------
for c in cards:
    cid = c.get('id', '')
    if cid.endswith('_vet'):
        base_id = cid[:-4]
        base = next((x for x in cards if x.get('id') == base_id), None)
        if not base:
            add('老兵变体孤立', cid, f'{c.get("name")} 找不到基础卡 {base_id}')
            continue
        if (c.get('attack') or 0) < (base.get('attack') or 0) or (c.get('defense') or 0) < (base.get('defense') or 0):
            add('老兵变体数值低于基础卡', cid,
                f'{base.get("name")} {base.get("attack")}/{base.get("defense")} -> vet {c.get("attack")}/{c.get("defense")}')
        if c.get('cost') != base.get('cost'):
            add('老兵变体费用不同', cid, f'{base.get("name")} cost {base.get("cost")} -> {c.get("cost")}')

# ---------- 7. HQ 数据 ----------
for h in hqs:
    hid, name = h.get('id', '?'), h.get('name', '?')
    df = h.get('defense')
    if not isinstance(df, int) or df < 1 or df > 40:
        add('HQ防御异常', hid, f'{name} defense={df}')
    if h.get('attack') not in (0, None):
        add('HQ有攻击', hid, f'{name} attack={h.get("attack")}')
    if h.get('cost') not in (0, None) or h.get('opCost') not in (0, None):
        add('HQ有费用', hid, f'{name} cost={h.get("cost")} opCost={h.get("opCost")}')
    if h.get('nation') not in VALID_NATIONS:
        add('HQ国家非法', hid, f'{name} nation={h.get("nation")}')
    if not h.get('image'):
        add('HQ卡图缺失', hid, f'{name} 无 image')

# ---------- 8. 文本异常 ----------
for c in cards:
    text = c.get('text') or ''
    if '  ' in text:
        add('文本多余空格', c.get('id', '?'), f'{c.get("name")}: {text[:60]!r}')
    if re.search(r'\s+[.,;]', text):
        add('文本标点前空格', c.get('id', '?'), f'{c.get("name")}: {text[:60]!r}')
    if text.count('(') != text.count(')'):
        add('括号不配对', c.get('id', '?'), f'{c.get("name")}: {text[:70]!r}')
    if re.search(r'\bthat that\b|\bthe the\b', text, re.I):
        add('文本重复词', c.get('id', '?'), f'{c.get("name")}: {text[:70]!r}')

# ---------- 输出 ----------
order = ['重复ID', '同名同属性重复', '字段缺失', '费用异常', '攻击异常', '防御异常', '单位防御为0',
         '行动费缺失', '行动费异常', '指令牌有攻击', '指令牌有防御', '指令牌有行动费', '射程异常',
         '射程与兵种不符', '国家非法', '类型非法', '稀有度非法', '未知关键词',
         '文本有关键词但数据缺失', '卡图缺失', '卡图文件不存在', '老兵变体孤立',
         '老兵变体数值低于基础卡', '老兵变体费用不同', 'HQ防御异常', 'HQ有攻击', 'HQ有费用',
         'HQ国家非法', 'HQ卡图缺失', '文本多余空格', '文本标点前空格', '括号不配对', '文本重复词']

total = sum(len(v) for v in issues.values())
lines = [f'# 卡牌数据审计报告\n', f'卡牌 {len(cards)} 张 + 总部 {len(hqs)} 张 · 共发现 **{total}** 处问题\n']
for k in order:
    if k not in issues:
        continue
    lines.append(f'\n## {k}（{len(issues[k])}）\n')
    for ident, msg in issues[k][:200]:
        lines.append(f'- `{ident}` — {msg}')
out = ROOT / '.work' / 'card_audit.md'
out.write_text('\n'.join(lines), encoding='utf-8')
print(f'问题总数 {total}')
for k in order:
    if k in issues:
        print(f'  {k}: {len(issues[k])}')
print('->', out)
