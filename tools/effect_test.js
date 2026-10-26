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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
