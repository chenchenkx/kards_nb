/* 第二批单卡行为验证：覆盖审计 42 张真缺口里尚未验证的高风险卡。
 * 目的：区分"引擎没实现（真缺口）"与"审计探针覆盖不到（假阴性）"。 */
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
  g.current = 0;
  g.players[0].kredits = 40; g.players[0].slots = 12;
  g.players[1].kredits = 40; g.players[1].slots = 12;
  return g;
}
function put(g, id, side) {
  const inst = new E.CardInst(byId(id), side || 0, g);
  inst.loc = 'board'; inst.slot = 1; inst.summonedTurn = -1;
  g.players[side || 0].board.push(inst);
  return inst;
}
function onBoard(g, id, side) {
  const u = new E.CardInst(byId(id), side || 0, g);
  u.loc = 'board'; u.slot = 1; u.summonedTurn = -1;
  g.players[side || 0].board.push(u);
  u._parsed = E.parseClauses(u.text);
  return u;
}
function front(g, id, side) {
  const u = new E.CardInst(byId(id), side || 0, g);
  u.loc = 'front'; u.summonedTurn = -1; u.hasAttacked = false; u.attacksLeft = 1;
  g.frontline.push(u); g.frontlineOwner = side || 0;
  u._parsed = E.parseClauses(u.text);
  return u;
}
function cast(g, id) {
  const inst = new E.CardInst(byId(id), 0, g);
  inst.loc = 'hand'; g.players[0].hand.push(inst);
  return g.playCard(0, g.players[0].hand.indexOf(inst), {});
}
const results = [];
function check(name, ok, extra) { results.push({ name, ok: !!ok, extra: extra || '' }); }

// 1. JU 88 G6：击杀敌人→复制被摧毁单位入手
{
  const g = mk(); const j = front(g, 'card_unit_ju_88_g6'); j.buffAttack = 12;
  const enemy = new E.CardInst(FILL[2], 1, g); enemy.loc = 'front'; enemy.defense = 1; g.frontline.push(enemy);
  g.attack(0, j.uid, enemy.uid);
  check('JU 88 G6 击杀后复制被摧毁单位入手', g.players[0].hand.some(c => c.id === FILL[2].id), `hand=${g.players[0].hand.map(c=>c.id).join(',')}`);
}
// 2. JAGDPANZER IV：击杀→敌方手牌转 PRODUCTION（限制：子类型未建模，仅验证不崩溃）
{
  const g = mk(); const j = front(g, 'card_unit_jagdpanzer_iv'); j.buffAttack = 12;
  const enemy = new E.CardInst(FILL[2], 1, g); enemy.loc = 'front'; enemy.defense = 1; g.frontline.push(enemy);
  let ok = true; try { g.attack(0, j.uid, enemy.uid); } catch (e) { ok = false; }
  check('JAGDPANZER IV 击杀不崩溃（PRODUCTION子类型限制）', ok, 'PRODUCTION 为 order 子类型，引擎未建模');
}
// 3. 162nd：步兵受战斗伤害上限 2
{
  const g = mk(); const u = onBoard(g, 'card_unit_162nd_regiment'); g.execCardText(u, 'static', {});
  const ally = new E.CardInst(FILL[0], 0, g); ally.loc = 'front'; ally.defense = 5; g.frontline.push(ally);
  const foe = new E.CardInst(FILL[2], 1, g); foe.loc = 'front'; foe.buffAttack = 6; foe.summonedTurn = -1; foe.attacksLeft = 1; g.frontline.push(foe);
  g.current = 1;
  g.attack(1, foe.uid, ally.uid);
  check('162nd 步兵受战斗伤害上限2', ally.defense === 3, `def=${ally.defense}`);
}
// 4. 12th GUARDS：部署 4+ 攻坦克→自身晋升老兵
{
  const g = mk(); const u = onBoard(g, 'card_unit_12th_guards_mechanised');
  const tank = db.cards.find(c => c.type === 'tank' && (c.attack || 0) >= 4 && db.byId[c.id + '_vet']);
  const tk = new E.CardInst(tank, 0, g); tk.loc = 'hand'; g.players[0].hand.push(tk);
  g.playCard(0, g.players[0].hand.indexOf(tk), {});
  check('12th 部署4+坦克→老兵', g.unitsOf(0).some(x => x.id === 'card_unit_12th_guards_mechanised_vet'), g.unitsOf(0).map(x=>x.id).join(','));
}
// 5. 266th GUARD：部署单位→该单位晋升老兵
{
  const g = mk(); const u = onBoard(g, 'card_unit_266th_guards_rifles_vet');
  const tank = db.cards.find(c => c.type === 'tank' && db.byId[c.id + '_vet']);
  const tk = new E.CardInst(tank, 0, g); tk.loc = 'hand'; g.players[0].hand.push(tk);
  g.playCard(0, g.players[0].hand.indexOf(tk), {});
  check('266th 部署单位→该单位老兵', g.unitsOf(0).some(x => x.id === tank.id + '_vet'), g.unitsOf(0).map(x=>x.id).join(','));
}
// 6. PZL P.7：敌方进前线→自身撤退
{
  const g = mk(); const p = front(g, 'card_unit_pzl_7');
  g.fireTrigger('enemyMoveFront', { uid: 0, owner: 1, type: 'infantry', nation: 'german' }, () => true);
  check('PZL P.7 敌方进前线则撤退', p.loc === 'board', `loc=${p.loc}`);
}
// 7. FIAT C.R.32：总部回血→修复全体友军
{
  const g = mk(); const f = onBoard(g, 'card_unit_fiat_cr_32'); f.defense = 2;
  g.fireTrigger('ownHqHealed', { side: 0, amount: 1 }, () => true);
  check('FIAT 总部回血则修复友军', f.defense === f.totalDefense, `def=${f.defense}/${f.totalDefense}`);
}
// 8. 37mm M1 AA GUN：攻击后重置防守方攻击
{
  const g = mk(); const m = front(g, 'card_unit_37mm_m1_aa_gun'); m.buffAttack = 4;
  g.execCardText(m, 'trigger', {});
  const foe = new E.CardInst(FILL[2], 1, g); foe.loc = 'front'; foe.defense = 30; foe.attacksLeft = 1; foe.summonedTurn = -1; g.frontline.push(foe);
  g.attack(0, m.uid, foe.uid);
  check('37mm 攻击后重置防守方攻击', foe.attacksLeft === 0, `atkL=${foe.attacksLeft}`);
}
// 9. KINGFISHER：攻击总部触发预见（不报错）
{
  const g = mk(); const k = front(g, 'card_unit_kingfisher_us'); k.buffAttack = 2;
  g.execCardText(k, 'trigger', {});
  let ok = true; try { g.attack(0, k.uid, 0); } catch (e) { ok = false; }
  check('KINGFISHER 攻击总部触发预见', ok);
}
// 10. 2nd PARA C：钳形造成伤害即摧毁（标志）
{
  const g = mk(); const u = onBoard(g, 'card_unit_2nd_para_c');
  const partner = put(g, FILL[0].id);
  g.execCardText(u, 'pincer', { partner });
  check('2nd PARA C 钳形造成伤害即摧毁标志', u._destroyOnDamage === true);
}
// 11. KING'S OWN SCOTTISH：钳形伤害转移伙伴
{
  const g = mk(); const u = onBoard(g, 'card_unit_kings_own_scottish');
  const partner = put(g, FILL[0].id);
  g.execCardText(u, 'pincer', { partner });
  check("KING'S OWN 钳形伤害转移伙伴", u._pincerPartner === partner);
}
// 12. T-28：钳形亡计置牌库顶
{
  const g = mk(); const u = onBoard(g, 'card_unit_t_28_pincer');
  const partner = put(g, FILL[0].id);
  g.execCardText(u, 'pincer', { partner });
  g.destroyCard(u, null, false);
  check('T-28 钳形亡计置牌库顶', g.players[0].deck.length && g.players[0].deck[0].id === u.id, `top=${g.players[0].deck[0] && g.players[0].deck[0].id}`);
}
// 13. TUPOLEV SB-2：钳形敌方攻击+2税
{
  const g = mk(); const u = onBoard(g, 'card_unit_tupolev_sb_2');
  const partner = put(g, FILL[0].id);
  g.execCardText(u, 'pincer', { partner });
  check('TUPOLEV 钳形敌方攻击+2税', u._enemyTax === 2, `_enemyTax=${u._enemyTax}`);
}
// 14. 222nd GUARD RIFLES：钳形回合末自愈
{
  const g = mk(); const u = onBoard(g, 'card_unit_222th_guard_rifles'); u.defense = 1;
  const partner = put(g, FILL[0].id);
  g.execCardText(u, 'pincer', { partner });
  g.endTurn();
  check('222nd 钳形回合末自愈', u.defense === u.totalDefense, `def=${u.defense}/${u.totalDefense}`);
}
// 15. 18e RÉGIMENT：仅部署一张则回合末行动费0
{
  const g = mk(); g.current = 0;
  const u = new E.CardInst(byId('card_unit_18e_regiment'), 0, g); u.loc = 'hand'; g.players[0].hand.push(u);
  g.playCard(0, g.players[0].hand.indexOf(u), {});
  g.endTurn();
  check('18e 仅部署一张则回合末行动费0', u.effOpCost === 0, `op=${u.effOpCost}`);
}
// 16. CEDAR DIVISION：手牌空则回合始抽2
{
  const g = mk(); g.current = 0; g.players[0].hand.length = 0;
  const c = onBoard(g, 'card_unit_cedar_division_vet');
  const h0 = g.players[0].hand.length;
  g.fireTrigger('startOfTurn', { side: 0 }, () => true);
  check('CEDAR 手牌空则回合始抽2', g.players[0].hand.length >= h0 + 2, `+${g.players[0].hand.length - h0}`);
}
// 17. AVRO ANSON：用喷火攻击抽牌
{
  const g = mk(); const a = onBoard(g, 'card_unit_avro_anson1');
  const spit = db.cards.find(c => /spitfire/i.test(c.name));
  const s = new E.CardInst(spit, 0, g); s.loc = 'front'; s.buffAttack = 3; s.summonedTurn = -1; s.attacksLeft = 1; g.frontline.push(s);
  const h0 = g.players[0].hand.length;
  g.attack(0, s.uid, 0);
  check('AVRO ANSON 用喷火攻击抽牌', g.players[0].hand.length > h0, `+${g.players[0].hand.length - h0}`);
}
// 18. 5e CUIRASSIERS：首张部署→18e 入手
{
  const g = mk(); g.current = 0; g.players[0]._unitDeployCount = 0;
  cast(g, 'card_unit_5e_cuirassier');
  check('5e 首张部署→18e入手', g.players[0].hand.some(c => c.id === 'card_unit_18e_regiment'));
}
// 19. H75-C1：部署赋予友军机动
{
  const g = mk(); g.current = 0;
  const ally = put(g, FILL[0].id);
  cast(g, 'card_unit_french_p_36');
  check('H75-C1 部署赋予友军机动', ally.keywords.has('mobilize'), [...ally.keywords].join(','));
}
// 20. 125th LA SPEZIA：有空军则部署抽牌
{
  const g = mk(); g.current = 0;
  const air = db.cards.find(c => c.type === 'fighter' || c.type === 'bomber');
  const a = new E.CardInst(air, 0, g); a.loc = 'board'; g.players[0].board.push(a);
  const h0 = g.players[0].hand.length;
  cast(g, 'card_unit_125th_la_spezia');
  check('125th 有空军则部署抽牌', g.players[0].hand.length > h0, `+${g.players[0].hand.length - h0}`);
}
// 21. COASTWATCHERS：天气卡降费（静态标志）
{
  const g = mk(); const u = onBoard(g, 'card_unit_coastwatchers'); g.execCardText(u, 'static', {});
  check('COASTWATCHERS 天气降费标志', g.players[0]._weatherCostDiscount === 1, `_weatherCostDiscount=${g.players[0]._weatherCostDiscount}`);
}
// 22. FW 200 CONDOR：部署不可攻HQ
{
  const g = mk(); g.current = 0;
  const u = new E.CardInst(byId('card_unit_fw_200_condor'), 0, g); u.loc = 'hand'; g.players[0].hand.push(u);
  g.playCard(0, g.players[0].hand.indexOf(u), {});
  check('FW 200 CONDOR 不可攻HQ标志', u._noHQ === true);
}
// 23. LUBLIN R-XIII：部署揭示（不报错，Intel 标志）
{
  const g = mk(); g.current = 0;
  let ok = true; try { cast(g, 'card_unit_lublin_r_xiii'); } catch (e) { ok = false; }
  check('LUBLIN 部署揭示不报错', ok);
}
// 24. 73rd INFANTRY：部署触发近期亡计（不报错）
{
  const g = mk();
  const d = put(g, FILL[2].id, 1); g.destroyCard(d, null, false);
  let ok = true; try { cast(g, 'card_unit_73rd_infantry_regiment'); } catch (e) { ok = false; }
  check('73rd 部署触发近期亡计不报错', ok);
}
// 25. ILYUSHIN IL-10：亡计把最后被毁地面单位放上场
{
  const g = mk(); const d = put(g, FILL[2].id, 1); g.destroyCard(d, null, false);
  const u = onBoard(g, 'card_unit_ilyushin_10');
  g.destroyCard(u, null, false);
  check('ILYUSHIN 亡计放最后被毁地面单位', g.unitsOf(0).some(x => x.id === FILL[2].id), g.unitsOf(0).map(x=>x.id).join(','));
}
// 26. KV-85：部署把手牌转为最后被毁单位
{
  const g = mk(); const d = put(g, FILL[2].id, 1); g.destroyCard(d, null, false);
  const hc = new E.CardInst(FILL[0], 0, g); hc.loc = 'hand'; g.players[0].hand.push(hc);
  let ok = true; try { cast(g, 'card_unit_kv_85'); } catch (e) { ok = false; }
  const converted = g.players[0].hand.some(c => c.id === FILL[2].id) || g.unitsOf(0).some(c => c.id === FILL[2].id);
  check('KV-85 部署转手牌为最后被毁单位', ok && converted, `ok=${ok} conv=${converted}`);
}
// 27. SM.79：部署触发友军非指定部署（不报错）
{
  const g = mk();
  let ok = true; try { cast(g, 'card_unit_sm_79'); } catch (e) { ok = false; }
  check('SM.79 部署触发友军部署不报错', ok);
}
// 28. KURMARK：部署选手牌反制并在回合末激活（不报错+标志）
{
  const g = mk(); g.current = 0;
  const cm = db.cards.find(c => (c.keywords || []).some(k => /countermeasure/i.test(k)) || /countermeasure/i.test(c.text || ''));
  if (cm) { const c = new E.CardInst(cm, 0, g); c.loc = 'hand'; g.players[0].hand.push(c); }
  let ok = true; try { cast(g, 'card_unit_kurmark_aufklarungs'); } catch (e) { ok = false; }
  check('KURMARK 部署选反制不报错', ok);
}

// 29. 182. LANDWEHR：行动(攻击)后返还等量指挥点（首次行动即返）
{
  const g = mk(); g.current = 0;
  const u = onBoard(g, 'card_unit_182_landwehr_vet');
  const atk = front(g, FILL[2].id); atk.buffAttack = 1;
  const foe = new E.CardInst(FILL[0], 1, g); foe.loc = 'front'; foe.defense = 30; foe.summonedTurn = -1; foe.attacksLeft = 1; g.frontline.push(foe);
  const k0 = g.players[0].kredits = 10;   // 用真实数值，避免返费被 MAX_SLOTS(24) 封顶干扰断言
  g.attack(0, atk.uid, foe.uid);
  const opSpent = atk.effOpCost;
  check('182 LANDWEHR 行动返费（首次即返）', g.players[0].kredits === k0, `k ${k0}->${g.players[0].kredits} op=${opSpent}`);
}
// 30. THE 123s：部署单位→自身变形为该单位并保留转化能力
{
  const g = mk(); g.current = 0; g.players[0]._unitDeployCount = 0;
  const s = new E.CardInst(byId('card_unit_the_123s'), 0, g); s.loc = 'hand'; g.players[0].hand.push(s);
  g.playCard(0, g.players[0].hand.indexOf(s), {});
  const other = FILL[1];
  const o = new E.CardInst(other, 0, g); o.loc = 'hand'; g.players[0].hand.push(o);
  g.playCard(0, g.players[0].hand.indexOf(o), {});
  const converted = g.unitsOf(0).some(x => x.uid === s.uid && x.id === other.id);
  const keptTrig = g.unitsOf(0).find(x => x.uid === s.uid);
  check('THE 123s 部署单位→变形并保留能力', converted && keptTrig && (keptTrig._parsed || []).some(cl => cl.kind === 'trigger' && cl.event === 'ownDeploy'),
    g.unitsOf(0).map(x => x.id).join(','));
}
// 31. KOKURAS SWORD：敌方回合亡计→随机日军地面单位上场
{
  const g = mk(); g.current = 1;   // 敌方回合
  const u = onBoard(g, 'card_unit_kokuras_sword');
  g.destroyCard(u, null, false);
  const jp = g.unitsOf(0).find(x => x.nation === 'Japan' && ['infantry', 'tank', 'artillery'].includes(x.type));
  check('KOKURAS 敌方回合亡计加日军地面单位', !!jp, jp ? jp.id : g.unitsOf(0).map(x => x.id).join(','));
}

const pass = results.filter(r => r.ok).length;
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`);
console.log(`\n${pass}/${results.length} passed`);
