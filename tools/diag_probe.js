/* 诊断剩余探针 no-delta 卡：复现精准场景，打印触发链关键状态 */
const fs = require('fs'), path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);
const FILL = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3);
const byId = id => db.byId[id] || cards.find(c => c.id === id);

function mk() {
  const d = FILL.slice(0, 5).map(c => c.id);
  const deck = []; for (let i = 0; i < 39; i++) deck.push(d[i % d.length]);
  const g = new Engine.Game({ db, seed: 11, decks: [deck, deck.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  g.current = 0; g.players[0].kredits = 40; g.players[1].kredits = 40;
  g.players[0].slots = 12; g.players[1].slots = 12;
  return g;
}
const logs = [];
function tlog(...a) { logs.push(a.join(' ')); }
function show(g, label) { tlog(`--- ${label} ---`); }

// 1. PZL P.7：敌方 move 进前线
{
  const g = mk();
  const s = new Engine.CardInst(byId('card_unit_pzl_7'), 0, g);
  s.loc = 'front'; s.summonedTurn = -1; g.frontline.push(s); g.frontlineOwner = 0;
  const mv = new Engine.CardInst(FILL[2], 1, g);
  mv.loc = 'board'; mv.summonedTurn = -1; mv.hasAttacked = false;
  g.players[1].board.push(mv);
  const r = g.move(1, mv.uid, true);
  tlog('PZL: move 返回', JSON.stringify(r), '| s.loc =', s.loc, '| front含s =', g.frontline.includes(s));
  tlog('PZL 日志:', (g.logText ? '' : ''), '');
}

// 2. FIAT：受伤 → hqDef
{
  const g = mk();
  const s = new Engine.CardInst(byId('card_unit_fiat_cr_32'), 0, g);
  s.loc = 'board'; s.summonedTurn = -1; g.players[0].board.push(s);
  s.defense = Math.max(1, s.defense - 2);
  g.execOp({ op: 'hqDef', n: 2 }, s, {});
  tlog('FIAT: def =', s.defense, '/', s.totalDefense);
}

// 3. 266th：部署 4+攻 _vet 坦克
{
  const g = mk();
  const s = new Engine.CardInst(byId('card_unit_266th_guards_rifles_vet'), 0, g);
  s.loc = 'board'; s.summonedTurn = -1; g.players[0].board.push(s);
  const tank = db.cards.find(c => c.type === 'tank' && (c.attack || 0) >= 4 && !/_vet\d*$/i.test(c.id) && (db.byId[c.id + '_vet'] || db.byId[c.id.replace(/_vet$/, '') + '_vet']));
  tlog('266th: 选中坦克 =', tank && tank.id);
  if (tank) {
    const tk = new Engine.CardInst(tank, 0, g); tk.loc = 'hand'; g.players[0].hand.push(tk);
    g.playCard(0, g.players[0].hand.indexOf(tk), {});
    tlog('266th: 场上 =', g.unitsOf(0).map(x => x.id).join(','));
  }
}

// 4. 77th：部署 FILL → randomKeyword
{
  const g = mk();
  const s = new Engine.CardInst(byId('card_unit_77th_guards'), 0, g);
  s.loc = 'board'; s.summonedTurn = -1; g.players[0].board.push(s);
  const nd = new Engine.CardInst(FILL[1], 0, g); nd.loc = 'hand'; g.players[0].hand.push(nd);
  g.playCard(0, g.players[0].hand.indexOf(nd), {});
  tlog('77th: 新单位关键词 =', [...nd.keywords].join('+') || '(无)');
}

// 5. LIGHT DETACHMENT 15：部署更高攻单位
{
  const g = mk();
  const s = new Engine.CardInst(byId('card_unit_light_detachment_15'), 0, g);
  s.loc = 'board'; s.summonedTurn = -1; g.players[0].board.push(s);
  const nd0 = db.cards.find(c => !/_vet\d*$/i.test(c.id) && c.type !== 'order' && c.type !== 'gotcha' && (c.attack || 0) > (s.def.attack || 0) + 2);
  tlog('LD15: s.attack =', s.def.attack, '选中 =', nd0 && nd0.id, 'attack =', nd0 && nd0.attack);
  if (nd0) {
    const nd = new Engine.CardInst(nd0, 0, g); nd.loc = 'hand'; g.players[0].hand.push(nd);
    const b0 = s.buffAttack;
    g.playCard(0, g.players[0].hand.indexOf(nd), {});
    tlog('LD15: buffAttack', b0, '->', s.buffAttack);
  }
}

// 6. H75-C1：部署 → friendlyUnit mobilize
{
  const g = mk();
  const ally = new Engine.CardInst(FILL[0], 0, g); ally.loc = 'board'; ally.summonedTurn = 0; g.players[0].board.push(ally);
  const s = new Engine.CardInst(byId('card_unit_french_p_36'), 0, g);
  s.loc = 'hand'; g.players[0].hand.push(s);
  g.playCard(0, g.players[0].hand.indexOf(s), {});
  tlog('H75: ally 关键词 =', [...ally.keywords].join('+') || '(无)');
}

// 7. 222nd / KING'S OWN：pincer 部署 + 后续
for (const [id, act] of [
  ['card_unit_222th_guard_rifles', 'repair'],
  ['card_unit_kings_own_scottish', 'redirect'],
]) {
  const g = mk();
  const pincerFiller = db.cards.find(x => (x.keywords || []).includes('pincer')) || FILL[2];
  const c1 = new Engine.CardInst(pincerFiller, 0, g); c1.loc = 'hand'; g.players[0].hand.push(c1);
  g.playCard(0, g.players[0].hand.indexOf(c1), {});
  const s = new Engine.CardInst(byId(id), 0, g); s.loc = 'hand'; g.players[0].hand.push(s);
  g.playCard(0, g.players[0].hand.indexOf(s), {});
  tlog(id, ': pincer 后 s 标志 partner =', s._pincerPartner ? s._pincerPartner.name : '无',
    'healSelf =', s._endOfTurnHealSelf);
  if (act === 'repair') {
    s.defense = Math.max(1, s.defense - 2);
    g.endTurn();
    tlog('  222nd: def =', s.defense, '/', s.totalDefense);
  } else {
    s.loc = 'front'; s.defense = Math.max(s.defense, 20);
    const bi = g.players[0].board.indexOf(s); if (bi >= 0) g.players[0].board.splice(bi, 1);
    if (!g.frontline.includes(s)) g.frontline.push(s);
    const raider = new Engine.CardInst(FILL[1], 1, g);
    raider.loc = 'front'; raider.summonedTurn = -1; raider.hasAttacked = false; raider.attacksLeft = 1; raider.buffAttack += 3;
    g.frontline.push(raider);
    const pd = s._pincerPartner ? s._pincerPartner.defense : -1;
    g.attack(1, raider.uid, s.uid);
    tlog('  KINGSON: s.def =', s.defense, 'partner.def =', s._pincerPartner ? s._pincerPartner.defense : '无', '(前', pd + ')');
  }
}

// 8. KV-85：last destroyed + cast（无 target）
{
  const g = mk();
  const v = new Engine.CardInst(FILL[2], 1, g); v.loc = 'board'; v.summonedTurn = 0; g.players[1].board.push(v);
  g.destroyCard(v, null);
  const s = new Engine.CardInst(byId('card_unit_kv_85'), 0, g); s.loc = 'hand'; g.players[0].hand.push(s);
  const handBefore = g.players[0].hand.map(c => c.name).join(',');
  g.playCard(0, g.players[0].hand.indexOf(s), {});
  tlog('KV85: 手牌 前=', handBefore, ' 后=', g.players[0].hand.map(c => c.name).join(','));
}

// 9. SM.79：有部署效果的友军
{
  const g = mk();
  const dep = db.cards.find(c => c.type !== 'order' && c.type !== 'gotcha' && c.type !== 'weather' && /deployment:/i.test(c.text || ''));
  tlog('SM79: 部署效果友军 =', dep && dep.id);
  if (dep) {
    const di = new Engine.CardInst(dep, 0, g); di.loc = 'board'; di.summonedTurn = 0; g.players[0].board.push(di);
    const s = new Engine.CardInst(byId('card_unit_sm_79'), 0, g); s.loc = 'hand'; g.players[0].hand.push(s);
    g.playCard(0, g.players[0].hand.indexOf(s), {});
    tlog('SM79: 执行后友军 def =', di.defense);
  }
}

// 10. THE AMERICAN GUARD / 32nd / LUBLIN
{
  const g = mk();
  const s = new Engine.CardInst(byId('card_unit_the_american_guard'), 0, g); s.loc = 'hand'; g.players[0].hand.push(s);
  const top0 = g.players[0].deck[0].uid;
  g.playCard(0, g.players[0].hand.indexOf(s), {});
  tlog('TAG: deck[0].uid', top0, '->', g.players[0].deck[0] && g.players[0].deck[0].uid);
}
{
  const g = mk();
  const twin = new Engine.CardInst(byId('card_unit_32nd_infantry_regiment'), 0, g);
  twin.loc = 'deck'; g.players[0].deck.unshift(twin);
  const s = new Engine.CardInst(byId('card_unit_32nd_infantry_regiment'), 0, g); s.loc = 'hand'; g.players[0].hand.push(s);
  g.playCard(0, g.players[0].hand.indexOf(s), {});
  tlog('32nd: 手牌含同名 =', g.players[0].hand.some(c => c.id === 'card_unit_32nd_infantry_regiment'));
}
{
  const g = mk();
  const s = new Engine.CardInst(byId('card_unit_lublin_r_xiii'), 0, g); s.loc = 'hand'; g.players[0].hand.push(s);
  const r = g.playCard(0, g.players[0].hand.indexOf(s), {});
  tlog('LUBLIN: playCard =', JSON.stringify(r));
}

console.log(logs.join('\n'));
