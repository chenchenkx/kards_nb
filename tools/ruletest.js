/* Rule verification tests for the KARDS engine. */
const fs = require('fs');
const path = require('path');
const Engine = require('../public/js/engine.js');

const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

// helper: build a game with specific decks
function mkGame(deck0, deck1, hq0 = db.hqs.Germany, hq1 = db.hqs.Soviet) {
  return new Engine.Game({ db, seed: 7, decks: [deck0, deck1], hqs: [hq0, hq1] });
}
function byId(id) { return db.byId[id]; }
function idOf(name, nation) {
  const c = db.cards.find(c => c.name === name && (!nation || c.nation === nation));
  return c ? c.id : null;
}

console.log('=== setup tests ===');
// 1. starting hands: 4 cards each
{
  const g = mkGame(Engine.autoDeck('Germany', db, Engine.makeRng(1)), Engine.autoDeck('Soviet', db, Engine.makeRng(2)));
  check('starting hands 4 + first turn draw (5/4)', g.players[0].hand.length === 5 && g.players[1].hand.length === 4);
  check('turn 1 gives 1 kredit slot', g.players[0].slots === 1 && g.players[0].kredits === 1);
  check('HQ starts at 20 defense', g.players[0].hqDef === 20 && g.players[1].hqDef === 20);
  check('P1 starts', g.current === 0);
  check('frontline uncontrolled at start', g.frontlineOwner === -1);
}

// find test cards
const BLITZ_INF = db.cards.find(c => c.type === 'infantry' && c.keywords.includes('blitz') && c.cost <= 3 && c.attack >= 3);
const TANK = db.cards.find(c => c.type === 'tank' && c.cost <= 3 && c.attack >= 3);
const INF = db.cards.find(c => c.type === 'infantry' && !c.keywords.includes('blitz') && !c.keywords.includes('deployment') && c.cost <= 2 && c.attack >= 2 && !/draw/i.test(c.text || ''));
const ARTY = db.cards.find(c => c.type === 'artillery' && c.cost <= 4 && c.attack >= 2);
const BOMBER = db.cards.find(c => c.type === 'bomber' && c.cost <= 5 && c.attack >= 2);
const FIGHTER = db.cards.find(c => c.type === 'fighter' && c.cost <= 4 && c.attack >= 2);
const GUARD = db.cards.find(c => c.type === 'infantry' && c.keywords.includes('guard') && c.cost <= 2);
const SMOKE = db.cards.find(c => c.keywords.includes('smokescreen') && c.type === 'infantry' && c.cost <= 3);
const FURY = db.cards.find(c => c.keywords.includes('fury') && c.cost <= 4);

console.log('test cards:', {
  BLITZ_INF: BLITZ_INF && BLITZ_INF.name, TANK: TANK && TANK.name, INF: INF && INF.name,
  ARTY: ARTY && ARTY.name, BOMBER: BOMBER && BOMBER.name, FIGHTER: FIGHTER && FIGHTER.name,
  GUARD: GUARD && GUARD.name, SMOKE: SMOKE && SMOKE.name, FURY: FURY && FURY.name,
});

function deployTest(name, cardDef, fn) {
  // fresh game, deploy the card for P1, run assertions
  const deck = [cardDef.id];
  const g = mkGame(deck, [INF.id]);
  // force into hand
  const p = g.players[0];
  p.deck = []; p.hand = [];
  const c = new Engine.CardInst(cardDef, 0, g);
  c.loc = 'hand';
  p.hand.push(c);
  p.kredits = 12; p.slots = 12;
  const r = g.playCard(0, 0, {});
  if (!r.ok) { check(name + ' (deploy)', false); return null; }
  return { g, c: g.find(c.uid) };
}

console.log('=== blitz tests ===');
if (BLITZ_INF) {
  const { g, c } = deployTest('blitz', BLITZ_INF, null);
  check('blitz unit deploys to frontline', !!c && c.loc === 'front');
  check('blitz unit can attack on deploy turn', g.canAttack(c) === true || g.attackTargets(c).length > 0);
  // enemy unit in support for a target
  const e = new Engine.CardInst(INF, 1, g);
  e.loc = 'board';
  g.players[1].board.push(e);
  check('blitz unit attacks deploy turn (target exists)', g.attackTargets(c).length > 0);
}

console.log('=== summon sickness ===');
if (INF) {
  const { g, c } = deployTest('inf', INF, null);
  check('non-blitz unit cannot move on deploy turn', g.canMove(c, false) === false);
  check('non-blitz unit cannot attack on deploy turn', g.canAttack(c) === false);
  // next turn
  g.endTurn(); g.endTurn();
  check('non-blitz unit can move next turn', g.canMove(c, false) === true);
}

console.log('=== tank move+attack ===');
if (TANK) {
  const { g, c } = deployTest('tank', TANK, null);
  g.endTurn(); g.endTurn();
  var tankInst = g.find(c.uid);
  if (tankInst && g.canMove(tankInst, true)) g.move(0, tankInst.uid, true);
  const stillThere = g.frontline.includes(tankInst);
  if (stillThere) {
    // put enemy unit in frontline for target
    const e = new Engine.CardInst(INF, 1, g);
    e.loc = 'front';
    g.frontline.push(e);
    check('tank can attack after moving same turn', g.canAttack(tankInst) === true);
    const before = g.players[0].kredits;
    g.attack(0, tankInst.uid, e.uid);
    check('tank attack works after move', g.players[0].kredits <= before - tankInst.opCost);
  } else check('tank can attack after moving same turn', false);
}

console.log('=== retaliation rules ===');
if (ARTY && INF) {
  const { g, c: art } = deployTest('arty', ARTY, null);
  const e = new Engine.CardInst(INF, 1, g); e.loc = 'front'; g.frontline.push(e);
  const defBefore = art.defense;
  g.attack(0, art.uid, e.uid);
  check('artillery takes no retaliation', art.defense === defBefore);
}
if (BOMBER && INF) {
  const { g, c: bom } = deployTest('bomber', BOMBER, null);
  const e = new Engine.CardInst(INF, 1, g); e.loc = 'board'; g.players[1].board.push(e);
  const before = bom.defense;
  g.attack(0, bom.uid, e.uid);
  check('bomber takes no retaliation vs infantry', bom.defense === before);
}

console.log('=== guard ===');
if (GUARD && INF) {
  const g = mkGame([INF.id], [GUARD.id, INF.id]);
  // P1 infantry in frontline wants to attack P2 support unit adjacent to guard
  const p1 = g.players[0], p2 = g.players[1];
  p1.deck = []; p1.hand = [];
  const atk = new Engine.CardInst(INF, 0, g); atk.loc = 'front'; atk.slot = 2; g.frontline.push(atk);
  atk.hasAttacked = false; atk.summonedTurn = -1;
  const guard = new Engine.CardInst(GUARD, 1, g); guard.loc = 'board'; guard.slot = 0; p2.board.push(guard);
  const target = new Engine.CardInst(INF, 1, g); target.loc = 'board'; target.slot = 1; p2.board.push(target);
  const targets = g.attackTargets(atk);
  check('guard blocks attack on adjacent unit', !targets.includes(target.uid));
  check('guard unit itself can be attacked', targets.includes(guard.uid));
  // HQ guarded
  check('HQ is guarded by guard unit', g.hqIsGuarded(0) === true);
}

console.log('=== smokescreen ===');
if (SMOKE && INF) {
  const g = mkGame([INF.id], [SMOKE.id]);
  const p1 = g.players[0], p2 = g.players[1];
  p1.deck = []; p1.hand = [];
  const atk = new Engine.CardInst(INF, 0, g); atk.loc = 'front'; g.frontline.push(atk);
  atk.summonedTurn = -1;
  const smoke = new Engine.CardInst(SMOKE, 1, g); smoke.loc = 'front'; g.frontline.push(smoke);
  smoke.summonedTurn = -1; smoke.hasActed = false;
  check('smokescreen unit cannot be attacked before acting', !g.attackTargets(atk).includes(smoke.uid));
  smoke.hasActed = true;
  check('smokescreen unit can be attacked after acting', g.attackTargets(atk).includes(smoke.uid));
}

console.log('=== frontline control ===');
{
  const g = mkGame([INF.id], [INF.id]);
  const p1 = g.players[0];
  p1.deck = []; p1.hand = [];
  const u1 = new Engine.CardInst(INF, 0, g); u1.loc = 'hand'; p1.hand.push(u1);
  p1.kredits = 12;
  g.playCard(0, 0, {});
  check('first unit to frontline takes control', g.frontlineOwner === 0);
  // P2 cannot enter frontline
  const p2 = g.players[1];
  p2.deck = []; p2.hand = [];
  const u2 = new Engine.CardInst(INF, 1, g); u2.loc = 'hand'; p2.hand.push(u2);
  g.endTurn();
  p2.kredits = 12;
  g.playCard(1, 0, {});
  check('opponent cannot deploy into controlled frontline', g.frontline.filter(c => c.owner === 1).length === 0);
  check('opponent unit goes to support line', p2.board.length === 1);
  // P1 frontline empty after retreat -> uncontrolled
  const u = g.frontline.find(c => c.owner === 0);
  if (u) {
    g.endTurn();
    g.move(0, u.uid, false);
    check('frontline uncontrols when emptied', g.frontlineOwner === -1);
  }
}

console.log('=== operation cost ===');
{
  const g = mkGame([INF.id], [INF.id]);
  const p = g.players[0];
  p.deck = []; p.hand = [];
  const u = new Engine.CardInst(INF, 0, g); u.loc = 'board'; p.board.push(u);
  u.summonedTurn = -1; u.hasAttacked = false;
  p.kredits = u.opCost;
  const ok = g.move(0, u.uid, true);
  check('move costs operation kredits', ok.ok && p.kredits === 0);
}

console.log('=== fury double attack ===');
if (FURY && INF) {
  const g = mkGame([FURY.id], [INF.id]);
  const p = g.players[0];
  p.deck = []; p.hand = [];
  const f = new Engine.CardInst(FURY, 0, g); f.loc = 'front'; g.frontline.push(f);
  f.summonedTurn = -1; f.attacksLeft = 2; f.defense = 99; f.attack = 3;
  const e1 = new Engine.CardInst(INF, 1, g); e1.loc = 'front'; g.frontline.push(e1);
  const e2 = new Engine.CardInst(INF, 1, g); e2.loc = 'front'; g.frontline.push(e2);
  e1.defense = 20; e2.defense = 20; e1.attack = 0; e2.attack = 0;
  p.kredits = 12;
  const r1 = g.attack(0, f.uid, e1.uid);
  const canAgain = g.canAttack(f);
  check('fury unit can attack twice', r1.ok && canAgain && f.attacksLeft === 1);
  const r2 = g.attack(0, f.uid, e2.uid);
  check('fury second attack works', r2.ok && f.attacksLeft === 0);
  check('fury unit exhausted after two attacks', g.canAttack(f) === false);
}

console.log('=== fatigue ===');
{
  const g = mkGame([], []);
  const p = g.players[0];
  p.deck = [];
  p.fatigue = 0; p.hqDef = 20;
  g.draw(0, 1);
  check('empty deck causes fatigue damage', p.hqDef === 19 && p.fatigue === 1);
  g.draw(0, 1);
  check('fatigue increases', p.hqDef === 17 && p.fatigue === 2);
}

console.log('=== victory ===');
{
  const g = mkGame([INF.id], [INF.id]);
  g.damageHq(1, 25, null);
  check('HQ at 0 ends game with winner', g.done && g.winner === 0 && g.players[1].hqDef === 0);
}

// ---------------------------------------------------------------------------
// 效果文本解析器：不得出现灾难性回溯导致的无限循环。
//
// 曾经的 bug：parseOps 里 "Give ... <keyword>" 分支用了嵌套量词
// `((?:[a-z]+ ?)+)$`（量词套量词），在长小写词尾上会指数级回溯。
// 单条正则就能把 CPU 打满、整局对局永久卡死。
// 四张卡必中：THE DOUBLE SUNRISE / SORTIE / BOLSTER THE RANKS / OVERWHELMING FORCE。
//
// 这里用「子进程 + 超时」做硬保证：一旦有人把正则改回危险写法，
// 测试会超时失败而不是把 CI 一起挂死。
// ---------------------------------------------------------------------------
console.log('=== effect parser: no catastrophic backtracking ===');
{
  const { spawnSync } = require('child_process');
  const os = require('os');
  const fsx = require('fs');
  const probe = path.join(os.tmpdir(), 'kards_effect_parse_probe.js');
  const effectCards = cards.filter(c => c.type === 'order' || (c.keywords || []).includes('deployment'));
  fsx.writeFileSync(probe, `
    const Engine = require(${JSON.stringify(path.join(__dirname, '..', 'public', 'js', 'engine.js'))});
    const cards = require(${JSON.stringify(path.join(__dirname, '..', 'data', 'cards.json'))});
    const list = cards.filter(c => c.type === 'order' || (c.keywords || []).includes('deployment'));
    for (const c of list) Engine.parseClauses(c.text || '');
    console.log('OK');
  `);
  const r = spawnSync(process.execPath, [probe], { timeout: 30000, encoding: 'utf8' });
  fsx.unlinkSync(probe);
  check(`all ${effectCards.length} effect cards parse without hanging`,
    r.status === 0 && /OK/.test(r.stdout || ''));

  // 单独点名那四张历史事故卡，失败时能直接看出是哪张
  const known = ['THE DOUBLE SUNRISE', 'SORTIE', 'BOLSTER THE RANKS', 'OVERWHELMING FORCE'];
  for (const nm of known) {
    const c = cards.find(x => x.name === nm);
    let parsed = null;
    try { parsed = Engine.parseClauses(c ? c.text : ''); } catch (e) { parsed = e; }
    check(`"${nm}" parses without hanging`, Array.isArray(parsed));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
