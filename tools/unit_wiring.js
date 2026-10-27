/* 单位卡"接线"审计 v2：按卡自身声明的子句逐条验证是否真的生效
 *
 * 方法：同一张卡「原文」vs「清空文本（同 id、同数值）」，各跑同一动作，比对世界状态 delta。
 * 只有原文卡多出来的变化才算"已接线"——排除通用规则（部署本身、费用扣除）的噪声，
 * 又能抓出"解析了但执行没接上"。
 *
 * 覆盖：deployment（打出）、trigger（派发对应事件）、destruction（阵亡）、pincer（先打一张再打它）
 *      static（部署后二阶探针：打一拳 / 再部署一个）
 * 输出：.work/unit_wiring.md
 */
const fs = require('fs'), path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);
const UNITS = db.cards.filter(c => ['infantry', 'tank', 'artillery', 'fighter', 'bomber'].includes(c.type) && (c.text || '').trim());
const FILL = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3);

/** 陪练环境：己方/敌方各 1 支援线单位（解除守护/隐蔽）
 *  opts: air（敌方空军）/ front（敌方前线单位）/ allyTank（己方坦克）/ manyAllies（己方 4 单位）
 *        foeBlitz（敌方带闪击）/ hqLow（己方总部残血）/ hqHigh（己方总部远高于敌方） */
function mkGame(opts = {}) {
  const d = FILL.slice(0, 6).map(c => c.id);
  const deck = []; for (let i = 0; i < 39; i++) deck.push(d[i % d.length]);
  // 混入其它国籍单位与指令（供"检索某国单位/指令"类效果命中）
  if (opts.deckMix) {
    const extra = db.cards.filter(c => c.type === 'order' && (c.cost || 0) <= 3).slice(0, 3)
      .concat(db.cards.filter(c => c.nation === 'Japan' && c.type === 'infantry' && (c.cost || 0) <= 1).slice(0, 2))
      .concat(db.cards.filter(c => c.nation === 'Soviet' && (c.cost || 0) <= 1).slice(0, 2))
      .concat(db.cards.filter(c => c.type === 'fighter' && (c.cost || 0) <= 3).slice(0, 2));
    for (const e of extra) deck.splice(Math.floor(deck.length * 0.5), 0, e.id);
  }
  const g = new Engine.Game({ db, seed: 41, decks: [deck, deck.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  g.players[0].kredits = 30; g.players[0].slots = 12;
  g.players[1].kredits = 30; g.players[1].slots = 12;
  const foe = new Engine.CardInst(FILL[1], 1, g);
  foe.loc = 'board'; foe.slot = 0; foe.summonedTurn = 0; foe.defense = 20;
  foe.keywords.delete('guard'); foe.keywords.delete('covert');
  if (opts.foeBlitz) foe.keywords.add('blitz');
  g.players[1].board.push(foe);
  let foeAir = null;
  if (opts.air) {
    foeAir = new Engine.CardInst(db.cards.find(c => c.type === 'fighter' && (c.cost || 0) <= 3) || FILL[4], 1, g);
    foeAir.loc = 'board'; foeAir.slot = 2; foeAir.summonedTurn = 0;
    g.players[1].board.push(foeAir);
  }
  let foeFront = null;
  if (opts.front) {
    foeFront = new Engine.CardInst(FILL[5], 1, g);
    foeFront.loc = 'front'; foeFront.summonedTurn = 0;
    g.frontline.push(foeFront); g.frontlineOwner = 1;
  }
  const ally = new Engine.CardInst(FILL[3], 0, g);
  ally.loc = 'board'; ally.slot = 0; ally.summonedTurn = 0;
  ally.keywords.delete('guard');
  g.players[0].board.push(ally);
  if (opts.allyTank) {
    const tankDef = db.cards.find(c => c.type === 'tank' && !(c.text || '').trim() && (c.cost || 0) <= 3) || FILL[2];
    const t = new Engine.CardInst(tankDef, 0, g);
    t.loc = 'board'; t.slot = 2; t.summonedTurn = 0;
    g.players[0].board.push(t);
  }
  if (opts.manyAllies) {
    for (let i = 0; i < 3; i++) {
      const a = new Engine.CardInst(FILL[i % FILL.length], 0, g);
      a.loc = 'board'; a.summonedTurn = 0;
      g.players[0].board.push(a);
    }
  }
  if (opts.hqLow) g.players[0].hqDef = 6;
  if (opts.hqHigh) g.players[0].hqDef = 30;
  return { g, foe, foeAir, foeFront, ally };
}

/** 世界状态快照：同名单位聚合成排序数组，避免"多生一个同名单位"被键合并吃掉 */
function snap(g) {
  const units = {};
  for (const side of [0, 1]) {
    for (const u of g.unitsOf(side)) {
      const k = side + '|' + u.name + '|' + u.loc;
      (units[k] = units[k] || []).push([u.defense, u.buffAttack, u.buffDefense, [...u.keywords].sort().join('+'),
        [u._pinOnDamage, u._hqDamageRedirect, u._destructionTwice, u._noRetreat, u._pinImmune, u._dmgAddsDefense,
         u._handWatch ? 1 : 0, u._redirectName || '', (u._dmgMods || []).length, (u._teamAuras || []).length,
         u._opCostMod || 0, u._costMod || 0, u._hqFloor || 0, u._hqLossCap || 0,
         u._noHQAttack ? 1 : 0, u._noAttack ? 1 : 0, u._pinImmune ? 1 : 0, u._ignoreArmor ? 1 : 0,
         u._dmgTakenTo == null ? '' : u._dmgTakenTo, u._dmgTakenMult || 1, u._splashAdjacent || 0,
         u._destroyTanksOnDamage ? 1 : 0, u._pinOnDamageAdj ? 1 : 0, u._pinAirOnCombat ? 1 : 0,
         u._excessToHq ? 1 : 0, u._splashHq ? 1 : 0, u._salvage ? 1 : 0].join('/'),
        u._pinned ? 'P' : '', u._suppressed ? 'S' : '', u.effOpCost, u.loc].join(','));
    }
  }
  for (const k of Object.keys(units)) units[k] = units[k].sort().join(';');
  return {
    units,
    hq: [g.players[0].hqDef, g.players[1].hqDef, g.players[0].hqMaxDef, g.players[1].hqMaxDef].join(','),
    k: [g.players[0].kredits, g.players[1].kredits, g.players[0].slots, g.players[1].slots].join(','),
    hand: g.players[0].hand.length, deck: g.players[0].deck.length,
    deck1: g.players[1].deck.length,
    handCost: g.players[0].hand.map(c => (c.effCost || 0)).join(','),
    handNames: g.players[0].hand.map(c => c.name).sort().join(','),
    disc: g.players[0].discard.length, disc1: g.players[1].discard.length,
    front: g.frontlineOwner + '/' + g.frontline.length,
    flags: [g.players[0]._hqHealBonus || 0, g.players[0]._hqDmgReduce || 0, g.players[0]._deployTwice ? 1 : 0,
      g.players[0]._enemyDeployOpCost || 0, g.players[0]._notFromDeckDiscount || 0,
      g.players[1]._deployGate || 0].join(','),
  };
}

function delta(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.units), ...Object.keys(b.units)])) {
    if (a.units[k] !== b.units[k]) out.push(`u:${k}:${a.units[k]}->${b.units[k]}`);
  }
  for (const f of ['hq', 'k', 'hand', 'deck', 'deck1', 'disc', 'disc1', 'front', 'handCost', 'handNames', 'flags']) {
    if (a[f] !== b[f]) out.push(`${f}:${a[f]}->${b[f]}`);
  }
  return out.sort();
}

/** 用一套 cfg 跑「原文 vs 清空文本」，返回原文是否多出变化 */
function runPair(def, cl, cfg) {
  const runOne = (d) => {
    const env = cfg.env || {};
    const { g, foe, foeAir, foeFront } = mkGame({ deckMix: true, air: cfg.target === 'air' || env.air, front: cfg.front, allyTank: env.allyTank, manyAllies: env.manyAllies, foeBlitz: env.foeBlitz, hqLow: env.hqLow, hqHigh: env.hqHigh });
    const s = new Engine.CardInst(d, 0, g);
    let before;
    try {
      if (cl.kind === 'deployment') {
        s.loc = 'hand'; g.players[0].hand.push(s);
        before = snap(g);
        let tgt = foe;
        if (cfg.target === 'front') tgt = foeFront || foe;
        else if (cfg.target === 'air') tgt = foeAir || foe;
        else if (cfg.target === 'ground') tgt = foe;
        else if (cfg.target === 'ally') tgt = g.players[0].board[0] || foe;
        const r = g.playCard(0, g.players[0].hand.indexOf(s), {
          target: tgt && tgt.uid, fromRightmost: cfg.fromRightmost, fromLeftmost: cfg.fromLeftmost,
        });
        if (!r || !r.ok) return 'ERR:playCard';
      } else if (cl.kind === 'destruction') {
        s.loc = 'board'; s.slot = 1; s.summonedTurn = 0; g.players[0].board.push(s);
        before = snap(g);
        g.destroyCard(s, null);
      } else if (cl.kind === 'trigger') {
        s.loc = 'board'; s.slot = 1; s.summonedTurn = 0; g.players[0].board.push(s);
        before = snap(g);
        const payload = { uid: s.uid, owner: 0, type: s.type, nation: s.nation, attack: s.totalAttack, card: s, amount: 2, side: 0 };
        g.fireTrigger(cl.event, payload, u => u.uid === s.uid);
      } else if (cl.kind === 'pincer') {
        const c1 = new Engine.CardInst(FILL[2], 0, g);
        c1.loc = 'hand'; g.players[0].hand.push(c1);
        g.playCard(0, g.players[0].hand.indexOf(c1), {});
        s.loc = 'hand'; g.players[0].hand.push(s);
        before = snap(g);
        g.playCard(0, g.players[0].hand.indexOf(s), {});
      } else {
        s.loc = 'hand'; g.players[0].hand.push(s);
        before = snap(g);
        const r = g.playCard(0, g.players[0].hand.indexOf(s), {});
        if (!r || !r.ok) return 'ERR:playCard';
        // 二阶探针：打一拳（伤害修正类）、再部署一个（部署授予类）
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
    } catch (e) { return 'ERR:' + e.message; }
    if (g.pendingChoose) { try { g.resolveChoose(0, 0); } catch (e) { /* ignore */ } }
    return JSON.stringify(delta(before, snap(g)));
  };
  const control = { ...def, text: '' };
  const a = runOne(def), b = runOne(control);
  if (String(a).startsWith('ERR') || String(b).startsWith('ERR')) return { ok: false, err: String(a).startsWith('ERR') ? a : b };
  const ea = JSON.parse(a), eb = JSON.parse(b);
  return { ok: ea.some(x => !eb.includes(x)), delta: ea };
}

/** 对某个子句尝试多套环境/目标组合，命中即停 */
function probe(def, cl) {
  const ENVS = [
    {},                              // 基线
    { allyTank: true },              // 己方有坦克（"给友方坦克…"）
    { allyTank: true, manyAllies: true }, // 单位数量优势
    { foeBlitz: true },              // 敌方有闪击单位
    { hqLow: true },                 // 己方总部残血
    { hqHigh: true, allyTank: true },// 己方总部高防
  ];
  const cfgs = [];
  const targetsFor = (front) => [
    { target: 'ground', front }, { target: 'air', front }, { target: 'front', front },
    { target: 'ally', front }, { target: 'ground', front, fromRightmost: true },
    { target: 'ground', front, fromLeftmost: true },
  ];
  if (cl.kind === 'deployment') {
    for (const env of ENVS) for (const front of [false, true]) for (const c of targetsFor(front)) cfgs.push({ ...c, env });
  } else {
    for (const env of ENVS) cfgs.push({ env, front: false });
  }
  for (const cfg of cfgs) {
    const r = runPair(def, cl, cfg);
    if (r.ok) return { ok: true, cfg };
  }
  return { ok: false, err: `${cl.kind}${cl.event ? '/' + cl.event : ''}: no delta` };
}

const wired = [], unwired = [], staticParsed = [], detail = {};
let total = 0;
for (const def of UNITS) {
  total++;
  const clauses = Engine.parseClauses(def.text || '');
  if (!clauses.length) {
    // 侧通道机制（手牌监听 / 伤害转移）算已接线
    const { g: g0 } = mkGame({});
    const inst = new Engine.CardInst(def, 0, g0);
    if (inst._handWatch || inst._redirectName) { wired.push(def); continue; }
    unwired.push(def); detail[def.id] = '无可解析子句'; continue;
  }
  const notes = [];
  let hit = false;
  for (const cl of clauses) {
    const r = probe(def, cl);
    if (r.ok) { hit = true; break; }
    notes.push(r.err || 'fail');
  }
  if (hit) { wired.push(def); continue; }
  const onlyStatic = clauses.every(cl => cl.kind === 'static');
  const hasOps = clauses.some(cl => (cl.ops || []).length > 0);
  if (onlyStatic && hasOps) { staticParsed.push(def); detail[def.id] = notes.join(' | '); }
  else { unwired.push(def); detail[def.id] = notes.join(' | '); }
}

let out = `# 单位卡接线审计（行为级 ${wired.length}/${total}，静态已解析 ${staticParsed.length}，真缺口 ${unwired.length}）\n\n## 真缺口（解析了没生效 / 无子句）\n\n`;
for (const u of unwired) out += `- **${u.name}** (${u.id}) — ${(u.text || '').replace(/\n/g, ' / ')}\n   ↳ ${detail[u.id] || ''}\n`;
out += `\n## 静态光环（已解析，行为探针不覆盖）\n\n`;
for (const u of staticParsed) out += `- ${u.name} (${u.id})\n`;
fs.writeFileSync(path.join(__dirname, '..', '.work', 'unit_wiring.md'), out);
console.log(`带文本单位 ${total} | 行为级接线 ${wired.length} | 静态已解析 ${staticParsed.length} | 真缺口 ${unwired.length}`);
