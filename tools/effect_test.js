/* 新机制功能验证：伤害修正 / 指令免疫 / 回合触发 / 攻击触发 */
const fs = require('fs');
const path = require('path');
const Engine = require('../public/js/engine.js');

const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);
const FILL = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3);

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
};

function game() {
  const d = FILL.slice(0, 4).map(c => c.id);
  const deck = [];
  for (let i = 0; i < 39; i++) deck.push(d[i % d.length]);
  return new Engine.Game({ db, seed: 9, decks: [deck, deck.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
}
const pick = (t) => db.deckPool.find(c => c.type === t && (c.cost || 0) <= 4 && !c.text) || db.deckPool.find(c => c.type === t);

function put(g, side, def, opts) {
  const inst = new Engine.CardInst(def, side, g);
  inst.loc = (opts && opts.front) ? 'front' : 'board';
  inst.summonedTurn = 0;
  if (inst.loc === 'front') g.frontline.push(inst); else g.players[side].board.push(inst);
  return inst;
}
/** 走真实出牌流程部署（会执行部署/静态效果） */
function deploy(g, side, def, opts) {
  const prev = g.current;
  g.current = side;                       // 测试：允许为任意一方部署
  const inst = new Engine.CardInst(def, side, g);
  inst.loc = 'hand';
  g.players[side].hand.push(inst);
  g.players[side].kredits = 20;
  g.players[side].slots = 20;
  const idx = g.players[side].hand.indexOf(inst);
  const r = g.playCard(side, idx, { toFront: !!(opts && opts.front) });
  g.current = prev;
  if (!r.ok) throw new Error('deploy failed: ' + r.error);
  // 测试：解除召唤失调，便于当回合攻击
  inst.summonedTurn = -1;
  inst.hasAttacked = false;
  inst.attacksLeft = 1;
  return inst;
}

// 1) "Deals double damage against tanks"（6 POUNDER）
{
  const def = cards.find(c => /^6 POUNDER$/i.test(c.name));
  console.log('\n[1] 6 POUNDER:', def && def.text);
  check('6 POUNDER 解析出伤害修正', Engine.parseClauses(def.text).some(cl => cl.ops.some(o => o.op === 'dmgMod')));
  const g = game();
  const atk = deploy(g, 0, def, { front: true });
  const tank = put(g, 1, pick('tank'), { front: true });
  tank.defense = 30;
  g.players[0].kredits = 20;
  const before = tank.defense;
  g.attack(0, atk.uid, tank.uid);
  const dealt = before - tank.defense;
  check('对坦克造成双倍伤害', dealt === atk.totalAttack * 2, { dealt, atk: atk.totalAttack });
  // 对非坦克：正常伤害
  const g2 = game();
  const atk2 = deploy(g2, 0, def, { front: true });
  const inf = put(g2, 1, pick('infantry'), { front: true });
  inf.defense = 30;
  g2.players[0].kredits = 20;
  const b2 = inf.defense;
  g2.attack(0, atk2.uid, inf.uid);
  check('对步兵为普通伤害', b2 - inf.defense === atk2.totalAttack, { dealt: b2 - inf.defense });
}

// 2) 指令免疫（141. GEBIRGSJÄGER）
{
  const def = cards.find(c => /GEBIRGSJ/i.test(c.name) && /cannot be targeted by enemy orders/i.test(c.text || ''));
  console.log('\n[2]', def && def.name, ':', def && def.text);
  if (def) {
    check('解析出 orderImmune', Engine.parseClauses(def.text).some(cl => cl.ops.some(o => o.op === 'orderImmune')));
    const g = game();
    const u = deploy(g, 1, def);        // 敌方受保护单位（走真实部署以触发效果）
    const order = cards.find(c => c.type === 'order' && /^Deal \d+ damage to a unit/i.test(c.text));
    const oc = new Engine.CardInst(order, 0, g); oc.loc = 'hand'; g.players[0].hand.push(oc);
    const targets = g.playTargetsFor(oc);
    check('受保护单位不在指令目标列表', !targets.includes(u.uid), { targets: targets.length });
  }
}

// 3) 回合结束触发（PZL.23 KARAS / 任一 "At the end of your turn, add ..."）
{
  const def = cards.find(c => /^PZL\.23 KARAS$/i.test(c.name)) ||
              cards.find(c => /at the end of your turn, add/i.test(c.text || ''));
  console.log('\n[3]', def && def.name, ':', def && def.text);
  const g = game();
  const u = deploy(g, 0, def);
  const handBefore = g.players[0].hand.length;
  g.endTurn();
  g.endTurn();   // 回到 P0，期间 P0 的 endOfTurn 已结算一次
  check('回合结束触发加入手牌', g.players[0].hand.length > handBefore, { before: handBefore, after: g.players[0].hand.length });
}

// 4) 攻击触发（"When this unit attacks"）
{
  const def = cards.find(c => /^PAK 36/i.test(c.name)) ||
              cards.find(c => /when this unit attacks/i.test(c.text || '') && /infantry|tank|artillery/i.test(c.type));
  console.log('\n[4]', def && def.name, ':', def && def.text);
  const parsed = Engine.parseClauses(def.text);
  check('解析出 selfAttack 触发', parsed.some(cl => cl.kind === 'trigger' && cl.event === 'selfAttack'));
}


// 5) Pincer：只有本回合第 2 张及以上的卡才获得加成
{
  const def = cards.find(c => /^CRUISER Mk III$/i.test(c.name)) ||
              cards.find(c => /^pincer:\s*\+\d+ attack/i.test((c.text || '').trim()));
  console.log('\n[5]', def && def.name, ':', def && def.text);
  if (def) {
    const g = game();
    const first = deploy(g, 0, def, { front: false });   // 本回合第 1 张
    check('Pincer 第 1 张不触发', first.buffAttack === 0, { buff: first.buffAttack });
    const second = deploy(g, 0, def, { front: false });  // 第 2 张
    check('Pincer 第 2 张触发', second.buffAttack > 0, { buff: second.buffAttack });
  }
}

// 6) 手牌费用修正（敌对增费 / 减免）真正生效
{
  const taxCard = cards.find(c => /orders? in enemy hand costs? \d+ more/i.test(c.text || ''));
  console.log('\n[6]', taxCard && taxCard.name, ':', taxCard && taxCard.text);
  if (taxCard) {
    const g = game();
    deploy(g, 0, taxCard, { front: false });            // 我方部署，敌方手牌指令涨价
    const order = cards.find(c => c.type === 'order' && (c.cost || 0) >= 2);
    const oc = new Engine.CardInst(order, 1, g);
    oc.loc = 'hand';
    g.players[1].hand.push(oc);
    g.players[1].kredits = 1;
    g.current = 1;
    const r = g.playCard(1, g.players[1].hand.indexOf(oc), {});
    g.current = 0;
    check('敌方指令因税无法用 1 费打出', !r.ok, { error: r.error, cost: order.cost });
  }
  // Develop 免费（_costMod 生效）
  const g2 = game();
  const dev = cards.find(c => /^develop/i.test((c.text || '').trim()) && c.type === 'order');
  if (dev) {
    const dc = new Engine.CardInst(dev, 0, g2);
    dc.loc = 'hand'; dc._costMod = -(dc.cost || 0);
    g2.players[0].hand.push(dc);
    g2.players[0].kredits = 0;
    const r2 = g2.playCard(0, g2.players[0].hand.indexOf(dc), {});
    check('费用修正为 0 的卡可以免费打出', r2.ok, r2);
  }
}

// 7) 相邻费用光环（左侧单位行动费 -1）
{
  const aura = cards.find(c => /units to the (left|right) of this unit operate for \d+ less/i.test(c.text || ''));
  console.log('\n[7]', aura && aura.name, ':', aura && aura.text);
  if (aura) {
    const g = game();
    // 先放普通单位（占左槽），再放光环单位 —— 光环影响它左侧的单位
    const plainDef = db.deckPool.find(c => c.type === 'infantry' && (c.opCost || 0) >= 1 && !c.text) || pick('infantry');
    const plain = deploy(g, 0, plainDef, { front: false });
    const a = deploy(g, 0, aura, { front: false });
    g.applyAuras();
    const leftmost = plain.slot < a.slot ? plain : a;
    const base = leftmost.opCost || 0;
    check('光环使左侧单位行动费下降', leftmost.effOpCost < base, { now: leftmost.effOpCost, base });
  }
}

// 8) 手牌监听："每当你使用一张指令，此牌费用 -2"（WELLINGTON）
{
  const wt = cards.find(c => /^WELLINGTON$/i.test(c.name));
  console.log('\n[8]', wt && wt.name, ':', wt && wt.text);
  if (wt) {
    const g = game();
    const w = new Engine.CardInst(wt, 0, g);
    w.loc = 'hand';
    g.players[0].hand.push(w);
    const base = w.effCost;
    const order = cards.find(c => c.type === 'order' && (c.cost || 0) === 1 && /draw|damage/i.test(c.text || ''));
    if (order) {
      const oc = new Engine.CardInst(order, 0, g);
      oc.loc = 'hand';
      g.players[0].hand.push(oc);
      g.players[0].kredits = 20;
      g.playCard(0, g.players[0].hand.indexOf(oc), {});
      check('使用指令后手牌费用下降', w.effCost < base, { before: base, after: w.effCost });
    }
  }
}

// 9) 伤害转移："对 STIRLING 的伤害转移给本单位"（GLADIATOR ESCORT）
{
  const ge = cards.find(c => /is dealt to this unit instead/i.test(c.text || ''));
  console.log('\n[9]', ge && ge.name, ':', ge && ge.text);
  if (ge) {
    const m = /damage to (.+?) is dealt to this unit instead/i.exec(ge.text);
    const targetName = m[1].trim();
    const target = cards.find(c => c.name.toLowerCase().includes(targetName.toLowerCase()));
    if (target) {
      const g = game();
      const guard = deploy(g, 0, ge, { front: false });
      const victim = put(g, 0, target);
      victim.defense = 10;
      const beforeGuard = guard.defense;
      const beforeVictim = victim.defense;
      g.damageCard(victim, 3, null);
      check('伤害被转移到守护单位', victim.defense === beforeVictim && guard.defense === beforeGuard - 3,
        { victim: victim.defense, guard: guard.defense });
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
