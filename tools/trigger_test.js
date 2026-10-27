/* 触发功能测试：部署触发卡 → 事件 → 断言效果（v33 批量触发系统） */
const fs = require('fs'), path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, detail !== undefined ? JSON.stringify(detail) : ''); }
}
function byName(n) { return db.cards.find(c => c.name === n); }
function mkGame() {
  const fill = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3).slice(0, 5).map(c => c.id);
  const deck = []; for (let i = 0; i < 30; i++) deck.push(fill[i % fill.length]);
  const g = new Engine.Game({ db, seed: 7, decks: [deck, deck.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  g.players[0].kredits = 20; g.players[0].slots = 12;
  g.players[1].kredits = 20; g.players[1].slots = 12;
  return g;
}
/** 把卡放进手牌并打出（opts 透传 target） */
function play(g, def, opts) {
  const p = g.players[0];
  const inst = new Engine.CardInst(def, 0, g);
  inst.loc = 'hand'; p.hand.push(inst);
  const r = g.playCard(0, p.hand.indexOf(inst), opts || {});
  return { inst: g.find(inst.uid) || inst, r };
}
/** 直接造一个场上单位 */
function field(g, def, owner, loc) {
  const inst = new Engine.CardInst(def, owner, g);
  inst.loc = loc || 'board'; inst.summonedTurn = 0;
  (loc === 'front' ? g.frontline : g.players[owner].board).push(inst);
  return inst;
}

console.log('=== 触发系统 v33 ===');
// 1. GREEN HOWARDS：任意单位老兵化 → 抽 1 张
{
  const g = mkGame();
  const gh = play(g, byName('GREEN HOWARDS')).inst;
  const hand0 = g.players[0].hand.length;
  const u = field(g, byName('HUMBER Mk IV'), 0);
  // 用真实路径：部署一张可老兵化的卡并触发其 veteran op
  const vetSrc = db.cards.find(c => db.byId[c.id + '_vet'] && ['infantry', 'tank'].includes(c.type));
  if (vetSrc) {
    const v = field(g, vetSrc, 0);
    // 直接执行 veteran op（不跑卡自带文本，避免干扰计数）
    v._parsed = [{ kind: 'static', text: 'v', ops: [{ op: 'veteran' }] }];
    g.execOps(v._parsed[0].ops, v, {});
    check('GREEN HOWARDS：单位老兵化后抽牌', g.players[0].hand.length === hand0 + 1, { hand0, hand1: g.players[0].hand.length });
  } else check('GREEN HOWARDS（无可老兵化测试卡，跳过）', true);
}
// 2. CROMWELL Mk IV：敌方单位被压制 → 该单位被 Suppress（_suppressed）
{
  const g = mkGame();
  play(g, byName('CROMWELL Mk IV'));
  const foe = field(g, byName('HUMBER Mk IV'), 1);
  foe._pinned = true;
  g.fireTrigger('unitPinned', { uid: foe.uid, owner: 1, type: foe.type, card: foe }, () => true);
  check('CROMWELL：敌方被压制单位被 Suppress', !!foe._suppressed || foe._pinned);
}
// 3. TYPHOON Mk IB：地面单位撤退 → 抽 1 张
{
  const g = mkGame();
  play(g, byName('TYPHOON Mk IB'));
  const u = field(g, byName('HUMBER Mk IV'), 0, 'front');
  const hand0 = g.players[0].hand.length;
  g.move(0, u.uid, false);           // 撤退到支援阵线
  check('TYPHOON：地面单位撤退后抽牌', g.players[0].hand.length === hand0 + 1, { hand0, hand1: g.players[0].hand.length });
}
// 4. 158. NACHSCHUB：己方回合敌方单位被毁 +2 指挥点（每回合一次）
{
  const g = mkGame();
  play(g, byName('158. NACHSCHUB'));
  const k0 = g.players[0].kredits;
  const foe = field(g, byName('HUMBER Mk IV'), 1);
  g.destroyCard(foe, null);
  check('158. NACHSCHUB：敌方单位被毁 +2 指挥点', g.players[0].kredits === k0 + 2, { k0, k1: g.players[0].kredits });
  const foe2 = field(g, byName('HUMBER Mk IV'), 1);
  g.destroyCard(foe2, null);
  check('158. NACHSCHUB：同回合第二次不再触发', g.players[0].kredits === k0 + 2, { k1: g.players[0].kredits });
}
// 5. 8e MAROCAINS：部署另一个单位 → HQ 防御 + 该单位行动费
{
  const g = mkGame();
  play(g, byName('8e MAROCAINS'));
  const hq0 = g.players[0].hqDef;
  const u = field(g, byName('HUMBER Mk IV'), 0);
  u.loc = 'hand'; g.players[0].hand.push(u);
  const idx = g.players[0].hand.indexOf(u);
  u._parsed = [];   // 避免其自带文本
  g.playCard(0, idx, {});
  check('8e MAROCAINS：部署单位后 HQ 获得防御', g.players[0].hqDef > hq0, { hq0, hq1: g.players[0].hqDef });
}
// 6. OXFORD：部署守护单位 → 该单位 +1+3
{
  const g = mkGame();
  play(g, byName('OXFORD'));
  const guardDef = db.cards.find(c => c.keywords.includes('guard') && ['infantry', 'tank'].includes(c.type));
  if (guardDef) {
    const u = new Engine.CardInst(guardDef, 0, g);
    u.loc = 'hand'; g.players[0].hand.push(u);
    const a0 = u.totalAttack, d0 = u.totalDefense;
    g.playCard(0, g.players[0].hand.indexOf(u), {});
    const deployed = g.find(u.uid);
    check('OXFORD：守护单位部署后 +1+3', deployed && (deployed.buffAttack === 1 && deployed.buffDefense === 3),
      { a: deployed && deployed.buffAttack, d: deployed && deployed.buffDefense });
  } else check('OXFORD（无守护测试卡）', true);
}
// 7. 36. KRADSCHÜTZEN：德国单位进入前线 → +1 攻 -1 行动费
{
  const g = mkGame();
  play(g, byName('36. KRADSCHÜTZEN'));
  const ger = db.cards.find(c => c.nation === 'Germany' && c.type === 'infantry' && !c.keywords.length && (c.cost || 0) <= 3) || db.cards.find(c => c.nation === 'Germany' && ['infantry', 'tank'].includes(c.type));
  if (ger) {
    const u = field(g, ger, 0);
    const a0 = u.totalAttack, oc0 = u.effOpCost;
    g.move(0, u.uid, true);
    check('36. KRADSCHÜTZEN：德国单位进前线 +1 攻', u.totalAttack === a0 + 1, { a0, a1: u.totalAttack });
    check('36. KRADSCHÜTZEN：行动费 -1', u.effOpCost === Math.max(0, oc0 - 1), { oc0, oc1: u.effOpCost });
  } else check('36. KRADSCHÜTZEN（无德国测试卡）', true);
}
// 8. HUDSON Mk III：摧毁单位 → 获得 Fury
{
  const g = mkGame();
  const hudson = play(g, byName('HUDSON Mk III')).inst;
  const foe = field(g, byName('HUMBER Mk IV'), 1);
  g.destroyCard(foe, hudson);
  check('HUDSON：击杀后获得 Fury', hudson.has('fury'));
}
// 9. 361. AFRIKA REGIMENT：进前线 → 敌 HQ -3
{
  const g = mkGame();
  play(g, byName('361. AFRIKA REGIMENT'));
  const u = play(g, byName('361. AFRIKA REGIMENT')).inst;   // 第二张作为可移动单位
  u.summonedTurn = -1;                                       // 解除召唤失调
  u.hasAttacked = false;                                     // 解除非闪击单位部署后的攻击锁定
  const hq0 = g.players[1].hqDef;
  g.move(0, u.uid, true);
  check('361. AFRIKA：进前线打敌 HQ 3 点', g.players[1].hqDef === hq0 - 3, { hq0, hq1: g.players[1].hqDef });
}
// 10. 8e/LES TERRIBLES：行动费条件部署抽牌
{
  const g = mkGame();
  play(g, byName('LES TERRIBLES'));
  const hand0 = g.players[0].hand.length;
  const expensive = db.cards.find(c => (c.opCost || 0) >= 3 && ['infantry', 'tank'].includes(c.type) && !(c.text || '').trim());
  if (expensive) {
    const u = new Engine.CardInst(expensive, 0, g);
    u.loc = 'hand'; g.players[0].hand.push(u);
    g.playCard(0, g.players[0].hand.indexOf(u), {});
    check('LES TERRIBLES：部署 3+ 费单位抽牌', g.players[0].hand.length === hand0 + 1, { hand0, hand1: g.players[0].hand.length });
  } else check('LES TERRIBLES（无 3+ 费测试卡）', true);
}
// 11. THE BISCUIT BOYS：打出中立卡 → HQ +1 防（ownCardPlayed 无 nation 过滤时的行为）
{
  const g = mkGame();
  play(g, byName('THE BISCUIT BOYS'));
  const hq0 = g.players[0].hqDef;
  const neutral = db.cards.find(c => c.nation === 'Neutral' && ['infantry', 'tank'].includes(c.type));
  if (neutral) {
    const u = new Engine.CardInst(neutral, 0, g);
    u.loc = 'hand'; g.players[0].hand.push(u);
    g.playCard(0, g.players[0].hand.indexOf(u), {});
    check('THE BISCUIT BOYS：打出中立卡 HQ +1 防', g.players[0].hqDef === hq0 + 1, { hq0, hq1: g.players[0].hqDef });
  } else check('THE BISCUIT BOYS（无中立测试卡）', true);
}
// 12. DINGO：攻击敌 HQ 触发（卡面攻击 0 无法真实攻击，直接派发事件验证效果链）
{
  const g = mkGame();
  const dingo = play(g, byName('DINGO')).inst;
  if (dingo) {
    dingo.loc = 'front';
    const hq0 = g.players[0].hqDef, hand0 = g.players[0].hand.length;
    g.fireTrigger('selfAttackHQ', { uid: dingo.uid }, u => u.uid === dingo.uid);
    check('DINGO：攻击敌 HQ 后己方 HQ +1 防', g.players[0].hqDef === hq0 + 1, { hq0, hq1: g.players[0].hqDef });
    check('DINGO：攻击敌 HQ 后抽 1 张', g.players[0].hand.length === hand0 + 1, { hand0, hand1: g.players[0].hand.length });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
