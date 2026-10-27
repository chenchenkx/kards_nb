/* 单卡行为验证：直接构造场景断言效果，用于区分"引擎没实现"与"审计探针覆盖不到" */
const fs = require('fs'), path = require('path');
const E = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = E.buildDb(cards, hqs);
const FILL = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3);
const byId = id => db.byId[id] || cards.find(c => c.id === id);

function mk() {
  const d = FILL.slice(0, 5).map(c => c.id);
  const deck = []; for (let i = 0; i < 39; i++) deck.push(d[i % d.length]);
  const g = new E.Game({ db, seed: 11, decks: [deck, deck.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  g.players[0].kredits = 25; g.players[0].slots = 12;
  g.players[1].kredits = 25; g.players[1].slots = 12;
  return g;
}
function put(g, id, side) {
  const inst = new E.CardInst(byId(id), side || 0, g);
  inst.loc = 'board'; inst.slot = 1; inst.summonedTurn = 0;
  g.players[side || 0].board.push(inst);
  return inst;
}
function cast(g, id, opts) {
  const inst = new E.CardInst(byId(id), 0, g);
  inst.loc = 'hand'; g.players[0].hand.push(inst);
  return g.playCard(0, g.players[0].hand.indexOf(inst), opts || {});
}
const results = [];
function check(name, ok, extra) { results.push({ name, ok: !!ok, extra }); }

// 1. 461st RIFLES：受伤 2 → 总部 +2 防
{
  const g = mk(); const u = put(g, 'card_unit_461st_rifles');
  const h0 = g.players[0].hqDef; g.damageCard(u, 2, null);
  check('461st RIFLES 受伤→总部+等量防御', g.players[0].hqDef === h0 + 2, `${h0}->${g.players[0].hqDef}`);
}
// 2. CANNONE DA 47：回合结束，敌方单位更多 → 自伤 1
{
  const g = mk(); const u = put(g, 'card_unit_cannone_da_47');
  for (let i = 0; i < 2; i++) put(g, FILL[i].id, 1);
  const d0 = u.defense; g.endTurn(); g.endTurn();
  check('CANNONE DA 47 结束回合自伤', u.defense < d0, `${d0}->${u.defense}`);
}
// 3. 24th UŁAN：本回合无人阵亡 → 自伤 1
{
  const g = mk(); const u = put(g, 'card_unit_24th_uhlan');
  const d0 = u.defense; g.endTurn(); g.endTurn();
  check('24th UŁAN 无人阵亡则自伤', u.defense < d0, `${d0}->${u.defense}`);
}
// 4. TYPE 89：总部获得防御 → 改为受到等量伤害
{
  const g = mk(); const u = put(g, 'card_unit_type_89');
  u._parsed = E.parseClauses(u.text); g.execCardText(u, 'static', {});
  const h0 = g.players[0].hqDef;
  g.execOp({ op: 'hqDef', n: 3 }, u, {});
  check('TYPE 89 总部回血转为受伤', g.players[0].hqDef <= h0, `${h0}->${g.players[0].hqDef}`);
}
// 5. 144th：亡计按已失去槽位伤害敌方总部
{
  const g = mk(); g.players[0].slots = 8;                       // 失去 4 个槽
  const u = put(g, 'card_unit_144th_infantry_regiment');
  const e0 = g.players[1].hqDef; g.destroyCard(u, null);
  check('144th 亡计按失去槽位打脸', g.players[1].hqDef < e0, `${e0}->${g.players[1].hqDef}`);
}
// 6. 99th KHOLM：下回合少 1 指挥点
{
  const g = mk(); cast(g, 'card_unit_99th_kholm');
  g.endTurn();               // 到对手
  const before = g.players[0].kredits;
  g.endTurn();               // 回到自己
  check('99th KHOLM 下回合 -1 指挥点', g.players[0].kredits <= before, `${before}->${g.players[0].kredits}`);
}
// 7. 175th MOTORIZED：亡计让我方苏联坦克手牌/牌库 -1 费
{
  const g = mk(); const u = put(g, 'card_unit_175th_motorized');
  const tank = db.cards.find(c => c.nation === 'Soviet' && c.type === 'tank');
  const t = new E.CardInst(tank, 0, g); t.loc = 'hand'; g.players[0].hand.push(t);
  const c0 = t.effCost;
  g.destroyCard(u, null);
  check('175th MOTORIZED 苏联坦克降价', t.effCost < c0, `${c0}->${t.effCost}`);
}
// 8. THE AMERICAN GUARD：牌库顶变成手牌里的卡
{
  const g = mk();
  const handCard = new E.CardInst(byId('card_unit_4th_alabama'), 0, g);
  handCard.loc = 'hand'; g.players[0].hand.push(handCard);
  const top0 = g.players[0].deck[0].uid;
  cast(g, 'card_unit_the_american_guard');
  check('THE AMERICAN GUARD 牌库顶变形', g.players[0].deck[0].uid !== top0, `${top0}->${g.players[0].deck[0].uid}`);
}
// 9. 32nd INFANTRY：从牌库抽同名卡
{
  const g = mk();
  const copy = new E.CardInst(byId('card_unit_32nd_infantry_regiment'), 0, g);
  copy.loc = 'deck'; g.players[0].deck.unshift(copy);
  cast(g, 'card_unit_32nd_infantry_regiment');
  check('32nd INFANTRY 从牌库抽同名', g.players[0].hand.some(c => c.id === 'card_unit_32nd_infantry_regiment'), '');
}
// 10. 77th GUARDS：部署单位获得随机关键词
{
  const g = mk(); put(g, 'card_unit_77th_guards');
  const n = new E.CardInst(FILL[1], 0, g); n.loc = 'hand'; g.players[0].hand.push(n);
  const kw0 = [...n.keywords].join(',');
  g.playCard(0, g.players[0].hand.indexOf(n), {});
  check('77th GUARDS 给出随机关键词', [...n.keywords].join(',') !== kw0, `${kw0}->${[...n.keywords].join(',')}`);
}
// 11. 269th RIFLES：部署 4+ 攻击坦克 → 老兵化
{
  const g = mk(); const u = put(g, 'card_unit_269th_rifles');
  const tankDef = db.cards.find(c => c.type === 'tank' && (c.attack || 0) >= 4 && c.id + '_vet' === '' ) || db.cards.find(c => c.type === 'tank' && (c.attack || 0) >= 4);
  const tk = new E.CardInst(tankDef, 0, g); tk.loc = 'hand'; g.players[0].hand.push(tk);
  g.playCard(0, g.players[0].hand.indexOf(tk), {});
  const vetOnBoard = g.players[0].board.some(x => x.id === 'card_unit_269th_rifles_vet');
  check('269th RIFLES 4+攻坦克部署→老兵', vetOnBoard, g.players[0].board.map(x => x.id).join(','));
}
// 12. 57th RIFLES：部署 T-34 → 与随机敌人交战
{
  const g = mk(); const u = put(g, 'card_unit_57th_rifles');
  const foe = put(g, FILL[2].id, 1);
  const t34 = db.cards.find(c => /T-34/i.test(c.name) && c.type === 'tank');
  if (t34) {
    const tk = new E.CardInst(t34, 0, g); tk.loc = 'hand'; g.players[0].hand.push(tk);
    const foeHp0 = foe.defense;
    g.playCard(0, g.players[0].hand.indexOf(tk), {});
    check('57th RIFLES 部署 T-34 触发交战', foe.defense < foeHp0 || g.players[0].board.some(x => x.defense < x.totalDefense), `foe ${foeHp0}->${foe.defense}`);
  } else check('57th RIFLES（无 T-34 数据，跳过）', true);
}
// 13. KATYUSHA：攻击额外 0-1 伤害（多次采样应至少出现一次 +1）
{
  let extra = false;
  for (let i = 0; i < 12; i++) {
    const g = mk(); const k = put(g, 'card_unit_katyusha');
    k.loc = 'front'; k.buffAttack += 3; k.summonedTurn = -1; k.hasAttacked = false; k.attacksLeft = 1;
    const bi = g.players[0].board.indexOf(k); if (bi >= 0) g.players[0].board.splice(bi, 1);
    g.frontline.push(k); g.frontlineOwner = 0;
    const foe = put(g, FILL[2].id, 1); foe.defense = 20;
    g.attack(0, k.uid, foe.uid);
    if (k._extraDmgMax) extra = true;
  }
  check('KATYUSHA 攻击额外伤害', extra, '');
}

const pass = results.filter(r => r.ok).length;
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`);
console.log(`\n${pass}/${results.length} passed`);
