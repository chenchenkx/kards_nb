/* 单卡诊断：打印解析 + 部署/阵亡后引擎日志，定位"没生效"的具体原因
 * 用法: node tools/diag_one.js card_unit_xxx [card_unit_yyy ...]
 */
const fs = require('fs'), path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);
const FILL = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3);

function mk() {
  const d = FILL.slice(0, 6).map(c => c.id);
  const deck = []; for (let i = 0; i < 39; i++) deck.push(d[i % d.length]);
  const g = new Engine.Game({ db, seed: 41, decks: [deck, deck.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  g.players[0].kredits = 30; g.players[0].slots = 12;
  g.players[1].kredits = 30; g.players[1].slots = 12;
  const foe = new Engine.CardInst(FILL[1], 1, g);
  foe.loc = 'board'; foe.slot = 0; foe.summonedTurn = 0; foe.defense = 20;
  foe.keywords.delete('guard'); foe.keywords.delete('covert');
  g.players[1].board.push(foe);
  const foeFront = new Engine.CardInst(FILL[5], 1, g);
  foeFront.loc = 'front'; foeFront.summonedTurn = 0;
  g.frontline.push(foeFront); g.frontlineOwner = 1;
  const ally = new Engine.CardInst(FILL[3], 0, g);
  ally.loc = 'board'; ally.slot = 0; ally.summonedTurn = 0;
  g.players[0].board.push(ally);
  return { g, foe, foeFront, ally };
}

function summarize(g) {
  return {
    hq: [g.players[0].hqDef, g.players[1].hqDef].join('/'),
    k: [g.players[0].kredits, g.players[1].kredits].join('/'),
    hand0: g.players[0].hand.map(c => c.name).join(','),
    b0: g.players[0].board.map(u => `${u.name}(${u.defense}${u._pinned ? 'P' : ''})`).join(','),
    front: g.frontline.map(u => `${u.name}@${u.owner}(${u.defense})`).join(','),
    disc0: g.players[0].discard.length, disc1: g.players[1].discard.length,
    deck1: g.players[1].deck.length,
  };
}

const ids = process.argv.slice(2);
for (const id of ids) {
  const def = cards.find(c => c.id === id);
  if (!def) { console.log('NOT FOUND', id); continue; }
  console.log('='.repeat(70));
  console.log(def.name, '|', def.type, def.attack + '/' + def.defense, '|', def.text);
  const cls = Engine.parseClauses(def.text);
  console.log('PARSE:', JSON.stringify(cls));
  const mode = (process.env.MODE || (cls.some(c => c.kind === 'destruction') && !cls.some(c => c.kind === 'deployment') ? 'die' : 'play'));
  const { g, foe, foeFront, ally } = mk();
  const s = new Engine.CardInst(def, 0, g);
  if (mode === 'die') {
    s.loc = 'board'; s.slot = 1; s.summonedTurn = 0; g.players[0].board.push(s);
    console.log('BEFORE:', JSON.stringify(summarize(g)));
    g.logLines.length = 0;
    g.destroyCard(s, null);
    console.log('AFTER :', JSON.stringify(summarize(g)));
    console.log('LOG   :', g.logLines.join(' | '));
  } else {
    s.loc = 'hand'; g.players[0].hand.push(s);
    console.log('BEFORE:', JSON.stringify(summarize(g)));
    g.logLines.length = 0;
    const r = g.playCard(0, g.players[0].hand.indexOf(s), { target: (foeFront || foe).uid });
    console.log('play ->', JSON.stringify(r));
    console.log('AFTER :', JSON.stringify(summarize(g)));
    console.log('LOG   :', g.logLines.join(' | '));
  }
}
