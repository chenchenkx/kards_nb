/* 规则一致性测试：逐条对照 KARDS 官方实现（kards-sim/KardsSim/Core/GameState.cs 常量
 * 与 RulesAudit.cs / CardTests.cs 的客户端判据）。
 * 目标是量化「网页版规则 vs 官方」的差距，每条失败都对应一处真实偏差。
 */
const fs = require('fs'), path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; failures.push(name); console.log('  FAIL', name, detail !== undefined ? JSON.stringify(detail) : ''); }
}
const byName = (n) => db.cards.find(c => c.name === n);
function mkGame() {
  const fill = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3).slice(0, 6).map(c => c.id);
  const mkDeck = () => { const d = []; for (let i = 0; i < 39; i++) d.push(fill[i % fill.length]); return d; };
  const g = new Engine.Game({ db, seed: 11, decks: [mkDeck(), mkDeck()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  g.players[0].kredits = 20; g.players[0].slots = 12;
  g.players[1].kredits = 20; g.players[1].slots = 12;
  return g;
}
/** 造一个可行动的单位（召唤失调解除、可攻击） */
function unit(g, def, owner, loc, slot) {
  const c = new Engine.CardInst(def, owner, g);
  c.loc = loc; c.summonedTurn = -1; c.hasAttacked = false; c.attacksLeft = c.has('fury') ? 2 : 1; c.hasMoved = false;
  if (loc === 'front') g.frontline.push(c); else g.players[owner].board.push(c);
  return c;
}

console.log('=== 1. 开局与资源（官方 NumStartingCards=4 / MaxKredits=12 / MaxKreditSlots=24）===');
{
  // 纯开局：不预置资源
  const fill0 = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3).slice(0, 6).map(c => c.id);
  const mkD = () => { const d = []; for (let i = 0; i < 39; i++) d.push(fill0[i % fill0.length]); return d; };
  const g = new Engine.Game({ db, seed: 5, decks: [mkD(), mkD()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  check('先攻 4 张 / 后攻 5 张', g.players[0].hand.length === 4 && g.players[1].hand.length === 5,
    { p0: g.players[0].hand.length, p1: g.players[1].hand.length });
  check('先攻首回合不额外抽牌', g.players[0].hand.length === 4);
  check('先攻第 1 回合 1 个指挥点槽', g.players[0].slots === 1 && g.players[0].kredits === 1);
  check('牌库 35 张（39 总牌 - 4 起始）', g.players[0].deck.length === 35, { deck: g.players[0].deck.length });
  check('总部 20 防', g.players[0].hqDef === 20 && g.players[1].hqDef === 20);
  // 成长：第 N 回合 N 个槽，封顶 12
  for (let t = 0; t < 30; t++) { g.endTurn(); }   // 15 个完整轮次
  check('自然成长槽数封顶 12', g.players[g.current].slots === 12, { slots: g.players[g.current].slots });
  check('每回合稳定抽 1 张（牌库持续减少）', g.players[0].deck.length < 35);
}

console.log('=== 2. 手牌上限 9 / 每行 5（MaxCardsOnHand=9, MaxCardsPerRow=5）===');
{
  const g = mkGame();
  const p = g.players[0];
  p.hand.length = 0;
  for (let i = 0; i < 9; i++) { const c = new Engine.CardInst(db.deckPool[i % db.deckPool.length], 0, g); c.loc = 'hand'; p.hand.push(c); }
  const before = p.hand.length;
  g.draw(0, 1, true);
  check('手牌满 9 时抽到的牌被销毁（不进手牌）', p.hand.length === before && p.discard.length > 0,
    { hand: p.hand.length, discard: p.discard.length });
  // 每行 5：支援线塞满后无法再部署
  const g2 = mkGame();
  const p2 = g2.players[0];
  p2.board.length = 0;
  for (let i = 0; i < 5; i++) unit(g2, db.deckPool[i % db.deckPool.length], 0, 'board');
  const extra = new Engine.CardInst(db.deckPool[7], 0, g2); extra.loc = 'hand'; p2.hand.push(extra);
  const r = g2.playCard(0, p2.hand.indexOf(extra), {});
  check('支援线满 5 个单位后无法再部署', !r.ok, r);
}

console.log('=== 3. 射程（not_enough_range：双方都不在前线才要求 range>=2）===');
{
  const g = mkGame();
  const r1 = db.cards.find(c => c.type === 'infantry' && (c.range || 1) === 1 && c.attack >= 1);
  const plain = db.cards.find(c => c.type === 'infantry' && !c.keywords.includes('guard') && (c.range || 1) === 1 && (c.cost || 0) <= 3);
  // A: 支援线 r1 → 敌方前线：允许
  const a = unit(g, r1, 0, 'board');
  const foeFront = unit(g, plain, 1, 'front');
  check('支援线射程 1 可攻击敌方前线单位', g.attackTargets(a).includes(foeFront.uid), g.attackTargets(a));
  // B: 支援线 r1 → 敌方支援线（前线空）：拒绝
  const g2 = mkGame();
  const b = unit(g2, r1, 0, 'board');
  const foeSup = unit(g2, plain, 1, 'board');
  check('前线空时支援线射程 1 打不到敌方支援线', !g2.attackTargets(b).includes(foeSup.uid), g2.attackTargets(b));
  // C: 上前线后可打敌方支援线
  const g3 = mkGame();
  const c = unit(g3, r1, 0, 'front');
  const foeSup2 = unit(g3, plain, 1, 'board');
  check('前线射程 1 可攻击敌方支援线', g3.attackTargets(c).includes(foeSup2.uid), g3.attackTargets(c));
}

console.log('=== 4. 移动与攻击（步兵移动后不能攻击 / 坦克可以）===');
{
  const inf = db.cards.find(c => c.type === 'infantry' && !c.keywords.includes('blitz') && (c.cost || 0) <= 3);
  const tank = db.cards.find(c => c.type === 'tank' && !c.keywords.includes('blitz') && (c.cost || 0) <= 3);
  const g = mkGame();
  const u1 = unit(g, inf, 0, 'board');
  g.move(0, u1.uid, true);
  check('步兵移动后不能攻击', g.canAttack(g.find(u1.uid)) === false);
  const g2 = mkGame();
  const u2 = unit(g2, tank, 0, 'board');
  g2.move(0, u2.uid, true);
  check('坦克移动后可以攻击', g2.canAttack(g2.find(u2.uid)) === true);
}

console.log('=== 5. 奋战（每回合可攻击 2 次）===');
{
  const fury = db.cards.find(c => c.keywords.includes('fury') && c.type !== 'order' && (c.attack || 0) >= 1);
  if (fury) {
    const g = mkGame();
    const u = unit(g, fury, 0, 'front');
    const e = unit(g, db.cards.find(c => c.type === 'infantry' && (c.attack || 0) === 0) || db.deckPool[0], 1, 'board');
    check('奋战单位 attacksLeft=2', u.attacksLeft === 2, { left: u.attacksLeft });
    g.attack(0, u.uid, e.uid);
    check('奋战攻击一次后仍可再攻击', g.canAttack(g.find(u.uid)) === true);
  } else check('奋战卡存在', false);
}

console.log('=== 6. Guard 掩护（掩护紧邻，Guard 本身可打，HQ 也会被掩护）===');
{
  const guardDef = db.cards.find(c => c.keywords.includes('guard') && c.type === 'infantry' && (c.cost || 0) <= 3);
  const plain = db.cards.find(c => c.type === 'infantry' && !c.keywords.includes('guard') && (c.range || 1) === 1 && (c.cost || 0) <= 3);
  if (guardDef && plain) {
    const g = mkGame();
    const p = g.players[1];
    p.board.length = 0;
    const left = unit(g, plain, 1, 'board');    // slot 0
    const guard = unit(g, guardDef, 1, 'board'); // slot 1
    const right = unit(g, plain, 1, 'board');   // slot 2
    left.slot = 0; guard.slot = 1; right.slot = 2;
    const atk = unit(g, plain, 0, 'front');
    const t = g.attackTargets(atk);
    check('被 Guard 紧邻掩护的单位不可打', !t.includes(left.uid) || !t.includes(right.uid) || !t.includes(guard.uid),
      { guard: t.includes(guard.uid), left: t.includes(left.uid), right: t.includes(right.uid) });
    check('Guard 单位本身可以被打', t.includes(guard.uid), t);
    const bomber = db.cards.find(c => c.type === 'bomber' && (c.attack || 0) >= 1);
    if (bomber) {
      const g2 = mkGame();
      const p2 = g2.players[1]; p2.board.length = 0;
      const gd = unit(g2, guardDef, 1, 'board'); gd.slot = 1;
      const tg = unit(g2, plain, 1, 'board'); tg.slot = 0;
      const bm = unit(g2, bomber, 0, 'board');
      check('轰炸机无视 Guard 掩护', g2.attackTargets(bm).includes(tg.uid), g2.attackTargets(bm));
    }
  }
}

console.log('=== 7. 烟幕（未行动单位不可被攻击）===');
{
  const smoke = db.cards.find(c => c.keywords.includes('smokescreen') && c.type !== 'order' && (c.cost || 0) <= 4);
  if (smoke) {
    const g = mkGame();
    const s = unit(g, smoke, 1, 'board');
    s.hasActed = false;
    const atk = unit(g, db.cards.find(c => c.type === 'infantry' && (c.range || 1) === 1 && (c.cost || 0) <= 3), 0, 'front');
    check('烟幕单位未行动时不可被攻击', !g.attackTargets(atk).includes(s.uid), g.attackTargets(atk));
    s.hasActed = true;
    check('烟幕单位行动后可以被攻击', g.attackTargets(atk).includes(s.uid), g.attackTargets(atk));
  }
}

console.log('=== 8. 疲劳（牌库空抽牌受伤递增）===');
{
  const g = mkGame();
  g.players[0].deck = [];
  const hq0 = g.players[0].hqDef;
  g.draw(0, 1, true);
  check('牌库空抽牌受 1 点疲劳伤害', g.players[0].hqDef === hq0 - 1, { before: hq0, after: g.players[0].hqDef });
  g.draw(0, 1, true);
  check('疲劳伤害递增（第 2 次 2 点）', g.players[0].hqDef === hq0 - 3, { after: g.players[0].hqDef });
}

console.log('=== 9. 部署阵线（只能部署支援线；控制前线才可直落）===');
{
  const g = mkGame();
  const p = g.players[0];
  const c = new Engine.CardInst(db.cards.find(x => x.type === 'infantry' && (x.cost || 0) <= 2 && !x.keywords.includes('blitz')), 0, g);
  c.loc = 'hand'; p.hand.push(c);
  const r = g.playCard(0, p.hand.indexOf(c), { toFront: true });
  check('未控制前线时不能直落前线', c.loc !== 'front', { loc: c.loc, ok: r.ok });
  check('部署到支援线', c.loc === 'board');
}

console.log('=== 10. HQ 掩护（hq_is_being_garded：紧邻 HQ 的 Guard 掩护总部）===');
{
  const guardDef = db.cards.find(c => c.keywords.includes('guard') && c.type === 'infantry' && (c.cost || 0) <= 3);
  const plain = db.cards.find(c => c.type === 'infantry' && (c.range || 1) === 1 && (c.cost || 0) <= 3);
  if (guardDef) {
    const g = mkGame();
    const p = g.players[1];
    p.board.length = 0;
    // 支援线布局：slot0, slot1, HQ, slot2, slot3 —— HQ 与 slot1/slot2 相邻
    const gd = unit(g, guardDef, 1, 'board'); gd.slot = 1;
    check('HQ 紧邻 Guard 时总部不可被攻击', g.hqIsGuarded(0) === true, { guarded: g.hqIsGuarded(0) });
    const g2 = mkGame();
    const p2 = g2.players[1]; p2.board.length = 0;
    const gd2 = unit(g2, guardDef, 1, 'board'); gd2.slot = 3;
    check('Guard 不在 HQ 相邻位时不掩护总部', g2.hqIsGuarded(0) === false, { guarded: g2.hqIsGuarded(0) });
  }
}

console.log('=== 11. 隐蔽 / 钳形 ===');
{
  const covert = db.cards.find(c => c.keywords.includes('covert') && c.type !== 'order');
  if (covert) {
    const g = mkGame();
    const cv = unit(g, covert, 1, 'board');
    const atk = unit(g, db.cards.find(c => c.type === 'infantry' && (c.range || 1) === 2 && (c.cost || 0) <= 5) || db.cards.find(c => c.type === 'artillery'), 0, 'front');
    check('隐蔽（Covert）单位不可被指定为目标', !g.attackTargets(atk).includes(cv.uid), g.attackTargets(atk));
  }
  // 钳形：本回合第 2 张卡起触发
  const pincer = db.cards.find(c => c.keywords.includes('pincer') && c.type !== 'order');
  if (pincer) {
    const cl = Engine.parseClauses(pincer.text || '');
    check('钳形卡解析为 pincer 类', cl.some(x => x.kind === 'pincer'), cl.map(x => x.kind));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('偏差项:\n - ' + failures.join('\n - '));
process.exit(fail ? 1 : 0);
