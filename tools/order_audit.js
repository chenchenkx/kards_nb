/* 指令牌效果审计：逐张在合成局面中打出，比较状态签名，统计有效/无效 */
const fs = require('fs');
const path = require('path');
const Engine = require('../public/js/engine.js');

const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

const ORDERS = db.cards.filter(c => c.type === 'order');
const FILL = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3);

function sig(g) {
  const board = (side) => g.players[side].board
    .map(c => [c.id, c.defense, c.buffAttack, c.buffDefense, [...c.keywords].sort().join('+')].join(':'))
    .sort().join('|');
  const front = g.frontline.map(c => [c.id, c.defense, c.buffAttack, c.buffDefense].join(':')).sort().join('|');
  return JSON.stringify({
    hq: [g.players[0].hqDef, g.players[1].hqDef, g.players[0].hqArmor, g.players[1].hqArmor],
    b0: board(0), b1: board(1), front,
    hand: [g.players[0].hand.length, g.players[1].hand.length],
    deck: [g.players[0].deck.length, g.players[1].deck.length],
    discard: [g.players[0].discard.length, g.players[1].discard.length],
    slots: [g.players[0].slots, g.players[1].slots],
    frontOwner: g.frontlineOwner,
    extra: [g.players[0]._noOrders ? 1 : 0, g.players[1]._noOrders ? 1 : 0,
            g.players[0].kreditsSpent, g.players[1].kreditsSpent],
  });
}

function buildGame() {
  const deck = FILL.slice(0, 6).map(c => c.id);
  const filler = [];
  for (let i = 0; i < 39; i++) filler.push(deck[i % deck.length]);
  const g = new Engine.Game({ db, seed: 11, decks: [filler, filler.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });

  // 我方：步兵/坦克/火炮/飞机 各一
  const pick = (type) => db.deckPool.find(c => c.type === type && (c.cost || 0) <= 4 && !c.text) || db.deckPool.find(c => c.type === type);
  for (const t of ['infantry', 'tank', 'artillery', 'fighter', 'bomber']) {
    const inst = new Engine.CardInst(pick(t), 0, g);
    inst.loc = 'board'; inst.summonedTurn = 0;
    g.players[0].board.push(inst);
  }
  // 敌方：两个单位（保证有合法目标）
  for (let i = 0; i < 2; i++) {
    const inst = new Engine.CardInst(pick(i === 0 ? 'infantry' : 'tank'), 1, g);
    inst.loc = 'board'; inst.summonedTurn = 0;
    g.players[1].board.push(inst);
  }
  // 手牌与牌库各留一些
  for (let i = 0; i < 3; i++) {
    const c = new Engine.CardInst(db.byId[deck[i % deck.length]], 0, g);
    c.loc = 'hand'; g.players[0].hand.push(c);
  }
  return g;
}

const results = { ok: [], noeffect: [], rejected: [] };
for (const def of ORDERS) {
  let g;
  try { g = buildGame(); } catch (e) { continue; }
  const inst = new Engine.CardInst(def, 0, g);
  inst.loc = 'hand';
  g.players[0].hand.push(inst);
  g.players[0].kredits = 20;
  g.players[0].slots = 20;
  const hi = g.players[0].hand.indexOf(inst);
  const target = g.players[1].board[0] ? g.players[1].board[0].uid : null;
  const before = sig(g);
  let r;
  try { r = g.playCard(0, hi, { target }); } catch (e) { r = { ok: false, error: String(e) }; }
  if (!r.ok) { results.rejected.push([def.name, r.error]); continue; }
  const after = sig(g);
  if (before === after) results.noeffect.push([def.id, def.name, def.text]);
  else results.ok.push(def.name);
}

const total = ORDERS.length;
console.log(`指令牌总数 ${total}`);
console.log(`有效果   ${results.ok.length}  (${(results.ok.length / total * 100).toFixed(1)}%)`);
console.log(`无效果   ${results.noeffect.length}  (${(results.noeffect.length / total * 100).toFixed(1)}%)`);
console.log(`被拒绝   ${results.rejected.length}`);

// 无效果按文本特征归类
const buckets = {};
for (const [id, name, text] of results.noeffect) {
  const t = (text || '').toLowerCase();
  let k = 'other';
  if (!t) k = '(空文本)';
  else if (/\bchoose (one|between)\b/.test(t)) k = 'choose-one';
  else if (/\bwhen\b|\bwhenever\b/.test(t)) k = 'when-触发句';
  else if (/for each/.test(t)) k = 'for-each';
  else if (/\bgains? .*\buntil\b/.test(t)) k = 'until 持续';
  else if (/\bif\b/.test(t)) k = '条件句';
  else if (/destroy|damage|draw|heal|add|reduce|increase/.test(t)) k = '其余动词未匹配';
  buckets[k] = buckets[k] || [];
  buckets[k].push(name);
}
console.log('\n无效果分类:');
for (const k of Object.keys(buckets).sort((a, b) => buckets[k] ? 0 : 0)) {
  console.log(`  ${k}: ${buckets[k].length}`);
}
fs.writeFileSync(path.join(__dirname, '..', '.work', 'order_audit.json'),
  JSON.stringify({ total, ok: results.ok.length, noeffect: results.noeffect, rejected: results.rejected }, null, 1));
console.log('\n样例（无效果）:');
for (const [, name, text] of results.noeffect.slice(0, 12)) console.log(` - ${name}: ${(text || '').slice(0, 80)}`);
