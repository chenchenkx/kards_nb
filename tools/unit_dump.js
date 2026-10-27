/* 导出全部疑似无效单位卡（完整卡面文本，按类别分组）→ .work/unit_todo.md */
const fs = require('fs'), path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);
const UNITS = db.cards.filter(c => ['infantry', 'tank', 'artillery', 'fighter', 'bomber'].includes(c.type) && (c.text || '').trim());
const FILL = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3);

function sig(g, excludeUid) {
  const b = s => g.players[s].board.filter(c => c.uid !== excludeUid)
    .map(c => [c.id, c.defense, c.buffAttack, c.buffDefense, [...c.keywords].sort().join('+')].join(':')).sort().join('|');
  return JSON.stringify({
    hq: [g.players[0].hqDef, g.players[1].hqDef],
    b0: b(0), b1: b(1),
    front: g.frontline.filter(c => c.uid !== excludeUid).map(c => [c.id, c.defense].join(':')).sort().join('|'),
    hand: g.players[0].hand.filter(c => c.uid !== excludeUid).map(c => c.id).sort().join(','),
    deck: [g.players[0].deck.length, g.players[1].deck.length],
    discard: g.players[0].discard.map(c => c.id).sort().join(','),
  });
}
function game() {
  const d = FILL.slice(0, 5).map(c => c.id); const deck = [];
  for (let i = 0; i < 39; i++) deck.push(d[i % d.length]);
  const g = new Engine.Game({ db, seed: 7, decks: [deck, deck.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  const pick = t => db.deckPool.find(c => c.type === t && (c.cost || 0) <= 4 && !c.text) || db.deckPool.find(c => c.type === t);
  const foe = new Engine.CardInst(pick('infantry'), 1, g); foe.loc = 'board'; foe.summonedTurn = 0; g.players[1].board.push(foe);
  const ally = new Engine.CardInst(pick('infantry'), 0, g); ally.loc = 'board'; ally.summonedTurn = 0; g.players[0].board.push(ally);
  for (let i = 0; i < 3; i++) { const c = new Engine.CardInst(db.byId[d[i % d.length]], 0, g); c.loc = 'hand'; g.players[0].hand.push(c); }
  return g;
}
const bad = [];
for (const def of UNITS) {
  let g; try { g = game(); } catch (e) { continue; }
  const inst = new Engine.CardInst(def, 0, g); inst.loc = 'hand';
  g.players[0].hand.push(inst);
  g.players[0].kredits = 20; g.players[0].slots = 20;
  const hi = g.players[0].hand.indexOf(inst);
  const before = sig(g, inst.uid);
  let r; try { r = g.playCard(0, hi, { target: g.players[1].board[0].uid, toFront: false }); } catch (e) { r = { ok: false, error: String(e) }; }
  if (!r.ok) { bad.push({ name: def.name, id: def.id, kind: 'REJECT', text: def.text || '' }); continue; }
  const after = sig(g, inst.uid);
  const selfDef = inst.defense !== (def.defense || 0) || inst.buffAttack !== 0 || inst.buffDefense !== 0;
  const staticKw = new Set((def.keywords || []).map(k => String(k).toLowerCase()));
  const selfKw = [...inst.keywords].some(k => !staticKw.has(k));
  if (!(before !== after || selfDef || selfKw)) {
    const t = (def.text || '').toLowerCase();
    let k = '无变化';
    if (!t) k = '空文本';
    else if (/^deployment:/.test(t)) k = '部署';
    else if (/\bwhen\b|\bwhenever\b/.test(t)) k = '触发';
    else if (/\bif\b/.test(t)) k = '条件';
    else if (/for each|per /.test(t)) k = 'for-each';
    bad.push({ name: def.name, id: def.id, kind: k, text: def.text || '' });
  }
}
const order = ['部署', '触发', 'for-each', '条件', '无变化', 'REJECT', '空文本'];
const groups = {};
for (const b of bad) (groups[b.kind] = groups[b.kind] || []).push(b);
let out = `# 未实现单位卡完整清单（${bad.length}/${UNITS.length}）\n\n`;
for (const k of order) {
  if (!groups[k]) continue;
  out += `\n## ${k}（${groups[k].length}）\n\n`;
  for (const b of groups[k]) out += `- **${b.name}** (${b.id})\n  > ${b.text.replace(/\n/g, ' / ')}\n`;
}
fs.writeFileSync(path.join(__dirname, '..', '.work', 'unit_todo.md'), out);
console.log(`dumped ${bad.length}/${UNITS.length} -> .work/unit_todo.md`);
for (const k of order) if (groups[k]) console.log(`  ${k}: ${groups[k].length}`);
