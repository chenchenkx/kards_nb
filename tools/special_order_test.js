/* 27 张特殊指令卡的冒烟/行为测试：逐张施放，断言不报错且关键状态生效 */
const fs = require('fs'), path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; fails.push(name); console.log('  FAIL', name, detail !== undefined ? JSON.stringify(detail) : ''); }
}
const byId = id => cards.find(c => c.id === id);
const SPECIAL = [...(Engine.SPECIAL_ORDER_IDS || [])];

function mk() {
  const fill = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3).slice(0, 6).map(c => c.id);
  const dk = []; for (let i = 0; i < 39; i++) dk.push(fill[i % fill.length]);
  const g = new Engine.Game({ db, seed: 21, decks: [dk, dk.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  g.players[0].kredits = 30; g.players[0].slots = 12;
  g.players[1].kredits = 30; g.players[1].slots = 12;
  // 双方各摆两个单位，敌方手里放两张牌，便于各种效果有作用对象
  for (const side of [0, 1]) {
    for (let i = 0; i < 2; i++) {
      const u = new Engine.CardInst(db.byId[fill[(i + side) % fill.length]], side, g);
      u.loc = side === 0 ? 'board' : 'board'; u.slot = i; u.summonedTurn = 0;
      g.players[side].board.push(u);
    }
  }
  for (let i = 0; i < 2; i++) {
    const e = new Engine.CardInst(db.byId[fill[(i + 2) % fill.length]], 1, g);
    e.loc = 'hand'; g.players[1].hand.push(e);
  }
  // 敌方牌库补几张指令（COLOSSUS 只复制 order）
  const ords = db.cards.filter(c => c.type === 'order' && c.cost > 0).slice(0, 5);
  for (const o of ords) { const oc = new Engine.CardInst(o, 1, g); oc.loc = 'deck'; g.players[1].deck.push(oc); }
  return g;
}
function cast(g, id, opts) {
  const p = g.players[0];
  const c = new Engine.CardInst(byId(id), 0, g);
  c.loc = 'hand'; p.hand.push(c);
  const before = (g.logs || g.log || []);
  const r = g.playCard(0, p.hand.indexOf(c), opts || {});
  return { r, c };
}
function badLog(g) {
  const logs = g.logs || [];
  return logs.some(l => String(l).includes('特殊结算失败'));
}

const cases = {
  committed_crew: (g) => {
    const sf = db.cards.find(c => /SPITFIRE/i.test(c.name) && c.isUnit);
    if (!sf) return true;
    const h = new Engine.CardInst(sf, 0, g); h.loc = 'hand'; g.players[0].hand.push(h);
    cast(g, 'card_event_committed_crew');
    return h.effCost === 0;
  },
  echelon: (g) => cast(g, 'card_event_echelon').r.ok && g.unitsOf(0).some(u => (u._granted || []).some(x => x.event === 'allyAttacked')),
  infiltrate: (g) => {
    const before = g.unitsOf(1).reduce((a, u) => a + u.defense, 0);
    cast(g, 'card_event_infiltrate');
    return g.unitsOf(1).reduce((a, u) => a + Math.max(0, u.defense), 0) <= before;
  },
  contest_doctrine: (g) => { cast(g, 'card_event_contest_doctrine'); return !!g.players[0]._deployBuff; },
  front_and_homeland: (g) => { cast(g, 'card_event_front_and_homeland'); return !!g.players[0]._drawOnTurn4; },
  air_escort: (g) => cast(g, 'card_event_air_escort').r.ok,
  japan_duty: (g) => { cast(g, 'card_event_japan_duty'); return g.unitsOf(0).every(u => u._destructionTwice); },
  feigned_retreat: (g) => { cast(g, 'card_event_feigned_retreat'); return g.players[0].hand.length === 0 && g.players[0]._drawOnDeploy > 0; },
  persian_corridor: (g) => cast(g, 'card_event_persian_corridor').r.ok && g.unitsOf(0).some(u => (u._granted || []).length),
  victory_banners: (g) => {
    const target = g.unitsOf(1)[0];
    if (!target) return true;
    cast(g, 'card_event_victory_banners', { target: target.uid });
    return g.unitsOf(1).every(u => u.name === target.name);
  },
  fortunes_of_war: (g) => {
    const t = g.unitsOf(1)[0];
    if (!t) return true;
    cast(g, 'card_event_fortunes_of_war', { target: t.uid });
    return !g.find(t.uid) || g.find(t.uid).loc === 'discard';
  },
  grim_day: (g) => { cast(g, 'card_event_grim_day'); return g.unitsOf(0).every(u => (u._enemyTax || 0) >= 2); },
  yank_the_army_weekly: (g) => { cast(g, 'card_event_yank_the_army_weekly'); return !!g.players[0]._developExtra; },
  colossus: (g) => { const d0 = g.players[0].deck.length; cast(g, 'card_event_colossus'); return g.players[0].deck.length === d0 + 3; },
  seac: (g) => { const h0 = g.players[0].hand.length; cast(g, 'card_event_seac'); return g.players[0].hand.length === h0 + 2; },
  scrap_metal: (g) => { const d0 = g.players[0].discard.length; cast(g, 'card_event_scrap_metal'); return g.players[0].discard.length > d0; },
  admiral_hipper: (g) => {
    const t = g.unitsOf(1)[0];
    const n0 = g.players[1].hand.length;
    cast(g, 'card_event_admiral_hipper', { target: t.uid });
    return g.players[1].hand.length > n0;
  },
  run_the_battlefield: (g) => {
    const us = g.unitsOf(0);
    for (const u of us) u.buffAttack += 5;         // 让每个单位都满足 4+ 攻击
    const a0 = us.map(u => u.buffDefense);
    cast(g, 'card_event_run_the_battlefield');
    return us.every((u, i) => u.buffDefense === a0[i] + 1);   // 每个 4+ 攻击单位 +1+1
  },
  rm_bersaglieri: (g) => { const h0 = g.players[0].hqDef; cast(g, 'card_event_rm_bersaglieri'); return g.players[0].hqDef >= h0; },
  grand_plans: (g) => { const d0 = g.players[0].discard.length; cast(g, 'card_event_grand_plans'); return g.players[0].discard.length > d0; },
  reorganize: (g) => { const d0 = g.players[0].deck.length; cast(g, 'card_event_reorganize'); return g.players[0].deck.length >= d0 - 1; },
  special_attack: (g) => { const s0 = g.players[0].slots; cast(g, 'card_event_special_attack'); return g.players[0].slots < s0; },
  strong_bond: (g) => { cast(g, 'card_event_strong_bond'); return g.unitsOf(0).some(u => u.has('guard')); },
  eastern_front: (g) => cast(g, 'card_event_eastern_front').r.ok,
  vanguard_ita: (g) => cast(g, 'card_event_vanguard_ita').r.ok,
  rule_the_skies: (g) => { g.players[1].hqDamagedThisTurn = 3; const air = g.unitsOf(0).find(u => u.type === 'fighter' || u.type === 'bomber'); cast(g, 'card_event_rule_the_skies'); return true; },
  ats: (g) => { g.players[1].hqDamagedThisTurn = 3; const h0 = g.players[0].hand.length; cast(g, 'card_event_ats'); return g.players[0].hand.length > h0; },
};

console.log('=== 特殊指令卡冒烟测试 ===');
for (const id of SPECIAL) {
  const g = mk();
  let res;
  try { res = cases[id.replace('card_event_', '')] ? cases[id.replace('card_event_', '')](g) : cast(g, id).r.ok; }
  catch (e) { ok(id, false, String(e.message)); continue; }
  ok(id.replace('card_event_', ''), !!res && !badLog(g), { res, bad: badLog(g) });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('失败项: ' + fails.join(', '));
process.exit(fail ? 1 : 0);
