/* 单位卡"接线"审计：按卡自身声明的子句逐条验证是否真的生效
 * 对照法：同一张卡「原文」vs「清空文本」，各跑该卡声明的动作，比对世界状态 delta。
 * 只有原文卡多出来的变化才算"已接线"。
 *
 * 覆盖：deployment（打出）、trigger（派发对应事件）、destruction（阵亡）、pincer（第二张）、static（部署后观察）
 * 输出 .work/unit_wiring.md
 */
const fs = require('fs'), path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);
const UNITS = db.cards.filter(c => ['infantry', 'tank', 'artillery', 'fighter', 'bomber'].includes(c.type) && (c.text || '').trim());
const FILL = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3);
const ORDER = db.cards.find(c => c.type === 'order' && (c.cost || 0) <= 2);

function mkGame(extraAlly) {
  const d = FILL.slice(0, 6).map(c => c.id);
  const deck = []; for (let i = 0; i < 39; i++) deck.push(d[i % d.length]);
  const g = new Engine.Game({ db, seed: 41, decks: [deck, deck.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  g.players[0].kredits = 30; g.players[0].slots = 12;
  g.players[1].kredits = 30; g.players[1].slots = 12;
  const foe = new Engine.CardInst(FILL[1], 1, g);
  foe.loc = 'board'; foe.slot = 0; foe.summonedTurn = 0; foe.defense = 20;
  foe.keywords.delete('guard'); foe.keywords.delete('covert');
  g.players[1].board.push(foe);
  const foeAir = new Engine.CardInst(db.cards.find(c => c.type === 'fighter' && (c.cost || 0) <= 3) || FILL[4], 1, g);
  foeAir.loc = 'board'; foeAir.slot = 2; foeAir.summonedTurn = 0;
  g.players[1].board.push(foeAir);
  const foeFront = new Engine.CardInst(FILL[5], 1, g);
  foeFront.loc = 'front'; foeFront.summonedTurn = 0;
  g.frontline.push(foeFront); g.frontlineOwner = 1;
  if (extraAlly) {
    const ally = new Engine.CardInst(FILL[3], 0, g);
    ally.loc = 'board'; ally.slot = 0; ally.summonedTurn = 0;
    g.players[0].board.push(ally);
  }
  return { g, foe };
}

function snap(g) {
  const units = {};
  for (const side of [0, 1]) {
    for (const u of g.unitsOf(side)) {
      units[side + '|' + u.name + '|' + u.loc] = [u.defense, u.buffAttack, u.buffDefense, [...u.keywords].sort().join('+'),
        [u._pinOnDamage, u._hqDamageRedirect, u._destructionTwice, u._noRetreat, u._pinImmune, u._dmgAddsDefense,
         u._handWatch ? 1 : 0, u._redirectName || '', (u._dmgMods || []).length, (u._teamAuras || []).length,
         u._opCostMod || 0, u._costMod || 0, u._hqFloor || 0, u._hqLossCap || 0].join('/'),
        u._pinned ? 'P' : '', u._suppressed ? 'S' : '', u.effOpCost, u.loc].join(',');
    }
  }
  return {
    units,
    hq: [g.players[0].hqDef, g.players[1].hqDef, g.players[0].hqMaxDef, g.players[1].hqMaxDef].join(','),
    k: [g.players[0].kredits, g.players[1].kredits, g.players[0].slots, g.players[1].slots].join(','),
    hand: g.players[0].hand.length, deck: g.players[0].deck.length,
    handCost: g.players[0].hand.map(c => (c.effCost || 0)).join(','),
    disc: g.players[0].discard.length, front: g.frontlineOwner + '/' + g.frontline.length,
  };
}

function delta(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.units), ...Object.keys(b.units)])) {
    if (a.units[k] !== b.units[k]) out.push(`u:${k}:${a.units[k]}->${b.units[k]}`);
  }
  for (const f of ['hq', 'k', 'hand', 'deck', 'disc', 'front', 'handCost']) {
    if (a[f] !== b[f]) out.push(`${f}:${a[f]}->${b[f]}`);
  }
  return out.sort();
}

function place(g, d) {
  const s = new Engine.CardInst(d, 0, g);
  s.loc = 'board'; s.slot = 1; s.summonedTurn = 0;
  g.players[0].board.push(s);
  return s;
}

/** 用指定配置跑一次"原文 vs 清空文本"，返回 extra delta */
function runPair(def, cl, cfg) {
  const runOne = (d) => {
    const { g, foe } = mkGame(true);
    const s = place(g, d);
    const before = snap(g);
    try {
      if (cl.kind === 'deployment') {
        s.loc = 'hand'; g.players[0].hand.push(s);
        let tgt = foe;
        if (cfg.target === 'front') tgt = g.frontline.find(u => u.owner === 1) || foe;
        else if (cfg.target === 'air') tgt = g.unitsOf(1).find(u => u.type === 'fighter') || foe;
        else if (cfg.target === 'ground') tgt = g.unitsOf(1).find(u => u.type !== 'fighter') || foe;
        g.playCard(0, g.players[0].hand.indexOf(s), { target: tgt && tgt.uid, fromRightmost: cfg.fromRightmost, fromLeftmost: cfg.fromLeftmost });
      } else if (cl.kind === 'destruction') {
        g.destroyCard(s, null);
      } else if (cl.kind === 'trigger') {
        const payload = { uid: s.uid, owner: 0, type: s.type, nation: s.nation, attack: s.totalAttack, card: s, amount: 2, side: 0 };
        g.fireTrigger(cl.event, payload, u => u.uid === s.uid);
      } else if (cl.kind === 'pincer') {
        const c1 = new Engine.CardInst(FILL[2], 0, g); c1.loc = 'hand'; g.players[0].hand.push(c1);
        g.playCard(0, g.players[0].hand.indexOf(c1), {});
        s.loc = 'hand'; g.players[0].hand.push(s);
        g.playCard(0, g.players[0].hand.indexOf(s), {});
      } else {
        s.loc = 'hand'; g.players[0].hand.push(s);
        g.playCard(0, g.players[0].hand.indexOf(s), {});
        // 二阶探针：打一拳（伤害修正）、再部署一个（部署授予）
        try {
          s.loc = 'front'; s.summonedTurn = -1; s.hasAttacked = false; s.attacksLeft = 1;
          const bi = g.players[0].board.indexOf(s); if (bi >= 0) g.players[0].board.splice(bi, 1);
          if (!g.frontline.includes(s)) g.frontline.push(s);
          g.frontlineOwner = 0; s.buffAttack += 2;
          const foeUnit = [...g.unitsOf(1)].find(u => u.type !== 'fighter');
          if (foeUnit) g.attack(0, s.uid, foeUnit.uid);
        } catch (e) { /* ignore */ }
        try {
          const extra = new Engine.CardInst(FILL[4], 0, g);
          extra.loc = 'hand'; g.players[0].hand.push(extra);
          g.playCard(0, g.players[0].hand.indexOf(extra), {});
        } catch (e) { /* ignore */ }
      }
    } catch (e) { return 'ERR'; }
    if (g.pendingChoose) { try { g.resolveChoose(0, 0); } catch (e) { /* ignore */ } }
    return JSON.stringify(delta(before, snap(g)));
  };
  const a = runOne(def), b = runOne({ ...def, text: '' });
  if (a === 'ERR' || b === 'ERR') return false;
  const ea = JSON.parse(a), eb = JSON.parse(b);
  return ea.some(x => !eb.includes(x));
}

/** 子句在所有配置尝试中是否至少一处生效 */
function probe(def, cl) {
  const cfgs = [];
  if (cl.kind === 'deployment') {
    const { g } = mkGame(true);
    for (const target of ['front', 'air', 'ground']) for (const pos of [{}, { fromRightmost: true }, { fromLeftmost: true }]) {
      cfgs.push({ target, ...pos });
    }
  } else {
    cfgs.push({});
  }
  for (const cfg of cfgs) if (runPair(def, cl, cfg)) return { ok: true };
  return { ok: false, err: `${cl.kind}${cl.event ? '/' + cl.event : ''}: no delta` };
}

const wired = [], unwired = [], staticParsed = [], detail = {};
for (const def of UNITS) {
  const clauses = Engine.parseClauses(def.text);
  if (!clauses.length) {
    // 侧通道机制（手牌监听 / 伤害转移）也算已接线
    const { g: g0 } = mkGame(true);
    const inst = new Engine.CardInst(def, 0, g0);
    if (inst._handWatch || inst._redirectName) { wired.push(def); continue; }
    unwired.push(def); detail[def.id] = '无可解析子句'; continue;
  }
  let hit = false, notes = [];
  for (const cl of clauses) {
    const r = probe(def, cl, cl.kind);
    if (r.ok) { hit = true; break; }
    notes.push(`${cl.kind}${cl.event ? '/' + cl.event : ''}: ${r.err || 'no delta'}`);
  }
  if (hit) { wired.push(def); continue; }
  // 未通过行为探针：区分「静态光环（已解析）」与「真缺口」
  const onlyStatic = clauses.every(cl => cl.kind === 'static');
  const hasOps = clauses.some(cl => (cl.ops || []).length > 0);
  if (onlyStatic && hasOps) { staticParsed.push(def); detail[def.id] = notes.join(' | '); }
  else { unwired.push(def); detail[def.id] = notes.join(' | '); }
}

const total = UNITS.length;
let out = `# 单位卡接线审计（行为级 ${wired.length}/${total}，静态已解析 ${staticParsed.length}，真缺口 ${unwired.length}）\n\n## 真缺口（解析了没生效 / 无子句）\n\n`;
for (const u of unwired) out += `- **${u.name}** (${u.id}) — ${(u.text || '').replace(/\n/g, ' / ')}\n   ↳ ${detail[u.id] || ''}\n`;
out += `\n## 静态光环（已解析，行为探针不覆盖）\n\n`;
for (const u of staticParsed) out += `- ${u.name} (${u.id})\n`;
fs.writeFileSync(path.join(__dirname, '..', '.work', 'unit_wiring.md'), out, 'utf8');
console.log(`带文本单位 ${total} | 行为级接线 ${wired.length} | 静态已解析 ${staticParsed.length} | 真缺口 ${unwired.length}`);
console.log('-> .work/unit_wiring.md');
