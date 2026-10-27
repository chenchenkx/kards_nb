/* 单位卡事件驱动审计：同卡对照法
 * 对每张有文本的单位卡，用「原文卡」与「同卡清空文本」做**同一套动作**，
 * 逐事件比对世界状态 delta。任何事件出现差异 → 该卡文本确实生效（已实现）。
 * 全事件都无差异 → 真·未实现（或需要更特殊的事件）。
 *
 * 输出 .work/unit_events.md，并打印分类统计。
 */
const fs = require('fs'), path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);
const UNITS = db.cards.filter(c => ['infantry', 'tank', 'artillery', 'fighter', 'bomber'].includes(c.type) && (c.text || '').trim());
const FILL = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3);
const ORDERS = db.cards.filter(c => c.type === 'order' && (c.cost || 0) <= 3).slice(0, 6);

function mkGame(subjectDef, withAllyAttack) {
  const d = FILL.slice(0, 6).map(c => c.id);
  const deck = []; for (let i = 0; i < 39; i++) deck.push(d[i % d.length]);
  const g = new Engine.Game({ db, seed: 33, decks: [deck, deck.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  g.players[0].kredits = 30; g.players[0].slots = 12;
  g.players[1].kredits = 30; g.players[1].slots = 12;
  // 对手一个可被打的单位 + 一个会进攻的单位
  const foe = new Engine.CardInst(FILL[1], 1, g);
  foe.loc = 'board'; foe.slot = 0; foe.summonedTurn = 0; foe.defense = 20;
  g.players[1].board.push(foe);
  foe.keywords.delete('guard'); foe.keywords.delete('covert');
  const foeAtk = new Engine.CardInst(FILL[2], 1, g);
  foeAtk.loc = 'board'; foeAtk.slot = 1; foeAtk.summonedTurn = -1; foeAtk.hasAttacked = false; foeAtk.attacksLeft = 1;
  foeAtk.keywords.delete('guard'); foeAtk.keywords.delete('covert');
  g.players[1].board.push(foeAtk);
  // 自己一个普通友军（供"友军被攻击/部署"类触发）
  const ally = new Engine.CardInst(FILL[3], 0, g);
  ally.loc = 'board'; ally.slot = 0; ally.summonedTurn = 0;
  g.players[0].board.push(ally);
  if (withAllyAttack) {
    // 给对手一个在前线的单位，便于我方攻击
    foe.loc = 'front'; g.players[1].board.splice(g.players[1].board.indexOf(foe), 1); g.frontline.push(foe);
  }
  return { g, foe, foeAtk, ally };
}

/** 世界状态快照（结构化，按 owner+name 索引单位，避免 uid 干扰对照） */
function snap(g) {
  const units = {};
  for (const side of [0, 1]) {
    for (const u of g.unitsOf(side)) {
      const key = side + '|' + u.name + '|' + u.loc;
      units[key] = {
        def: u.defense, atk: u.buffAttack, dfn: u.buffDefense,
        kw: [...u.keywords].sort().join('+'), gone: false,
      };
    }
  }
  return {
    units,
    hq: [g.players[0].hqDef, g.players[1].hqDef, g.players[0].hqMaxDef, g.players[1].hqMaxDef],
    k: [g.players[0].kredits, g.players[1].kredits, g.players[0].slots, g.players[1].slots],
    hand: [g.players[0].hand.length, g.players[1].hand.length],
    deck: [g.players[0].deck.length, g.players[1].deck.length],
    disc: [g.players[0].discard.length, g.players[1].discard.length],
    front: [g.frontlineOwner, g.frontline.length],
  };
}

/** 两次快照的 delta（稳定字符串数组，不含 uid） */
function deltaOf(a, b) {
  const out = [];
  for (const key of new Set([...Object.keys(a.units), ...Object.keys(b.units)])) {
    const x = a.units[key], y = b.units[key];
    if (!x && y) { out.push(`+${key}`); continue; }
    if (x && !y) { out.push(`-${key}`); continue; }
    for (const f of ['def', 'atk', 'dfn', 'kw']) {
      if (x[f] !== y[f]) out.push(`${key}.${f}:${x[f]}->${y[f]}`);
    }
  }
  for (const f of ['hq', 'k', 'hand', 'deck', 'disc', 'front']) {
    for (let i = 0; i < a[f].length; i++) {
      if (a[f][i] !== b[f][i]) out.push(`${f}${i}:${a[f][i]}->${b[f][i]}`);
    }
  }
  return out.sort();
}

/** 事件电池：每个事件用独立对局，返回 delta 字符串 */
const EVENTS = {
  deploy(g, s) { s.loc = 'hand'; g.players[0].hand.push(s); g.playCard(0, g.players[0].hand.indexOf(s), {}); },
  attackUnit(g, s, env) {
    s.loc = 'front'; s.summonedTurn = -1; s.hasAttacked = false; s.attacksLeft = 1;
    const bi = g.players[0].board.indexOf(s); if (bi >= 0) g.players[0].board.splice(bi, 1);
    if (!g.frontline.includes(s)) g.frontline.push(s);
    g.frontlineOwner = 0; s.buffAttack += 3;
    g.attack(0, s.uid, env.foe.uid);
  },
  attackHQ(g, s) {
    s.loc = 'front'; s.summonedTurn = -1; s.hasAttacked = false; s.attacksLeft = 1;
    const bi = g.players[0].board.indexOf(s); if (bi >= 0) g.players[0].board.splice(bi, 1);
    if (!g.frontline.includes(s)) g.frontline.push(s);
    g.frontlineOwner = 0; s.buffAttack += 3;
    g.attack(0, s.uid, 0);
  },
  beAttacked(g, s, env) {
    env.foeAtk.loc = 'front'; env.foeAtk.buffAttack += 3;
    if (!g.frontline.includes(env.foeAtk)) g.frontline.push(env.foeAtk);
    g.frontlineOwner = 1;
    g.attack(1, env.foeAtk.uid, s.uid);
  },
  selfDamaged(g, s) { g.damageCard(s, 2, null); },
  killEnemy(g, s, env) { g.destroyCard(env.foe, s); },
  ownDeploy(g) {
    const c = new Engine.CardInst(FILL[4], 0, g);
    c.loc = 'hand'; g.players[0].hand.push(c);
    g.playCard(0, g.players[0].hand.indexOf(c), {});
  },
  playOrder(g) {
    const c = new Engine.CardInst(ORDERS[0], 0, g);
    c.loc = 'hand'; g.players[0].hand.push(c);
    const tgt = g.players[1].board[0];
    g.playCard(0, g.players[0].hand.indexOf(c), { target: tgt && tgt.uid });
  },
  moveFront(g, s) {
    s.summonedTurn = -1; s.hasAttacked = false;
    g.move(0, s.uid, true);
  },
  die(g, s) { g.destroyCard(s, null); },
  veteran(g, s) { g.execOps([{ op: 'veteran' }], s, {}); },
  healHq(g) { g.execOps([{ op: 'hqDef', n: 1 }], g.players[0].board[0], {}); },
  startOfTurn(g) { g.endTurn(); },
  endOfTurn(g) { g.endTurn(); g.endTurn(); },
  surviveCombat(g, s, env) {
    s.loc = 'front'; s.summonedTurn = -1; s.hasAttacked = false; s.attacksLeft = 1;
    const bi2 = g.players[0].board.indexOf(s); if (bi2 >= 0) g.players[0].board.splice(bi2, 1);
    if (!g.frontline.includes(s)) g.frontline.push(s);
    g.frontlineOwner = 0;
    env.foe.defense = 99;
    g.attack(0, s.uid, env.foe.uid);
  },
  retreat(g, s) {
    s.loc = 'front'; s.summonedTurn = -1; s.hasAttacked = false;
    const bi3 = g.players[0].board.indexOf(s); if (bi3 >= 0) g.players[0].board.splice(bi3, 1);
    if (!g.frontline.includes(s)) g.frontline.push(s);
    g.frontlineOwner = 0;
    g.move(0, s.uid, false);
  },
};

function runEvent(def, name) {
  const fn = EVENTS[name];
  // 两个平行世界：原文 vs 清空文本
  const res = [def, { ...def, text: '' }].map(d => {
    let env;
    try {
      env = mkGame(d, name === 'attackUnit' || name === 'surviveCombat');
    } catch (e) { return 'ERR'; }
    const g = env.g;
    const s = new Engine.CardInst(d, 0, g);
    s.loc = 'board'; s.slot = 1; s.summonedTurn = 0;
    g.players[0].board.push(s);
    const before = snap(g);
    let err = null;
    try { fn(g, s, env); } catch (e) { err = e; }
    return err ? 'ERR:' + err.message : JSON.stringify(deltaOf(before, snap(g)));
  });
  if (res[0].startsWith('ERR') || res[1].startsWith('ERR')) return false;
  // 只有"原文卡"多出来的变化才算实现（control 的通用变化两边都有）
  const a = JSON.parse(res[0]), b = JSON.parse(res[1]);
  const extra = a.filter(x => !b.includes(x));
  return extra.length > 0;
}

const implemented = [], missing = [];
for (const def of UNITS) {
  let hit = false;
  for (const name of Object.keys(EVENTS)) {
    if (runEvent(def, name)) { hit = true; break; }
  }
  (hit ? implemented : missing).push(def);
}

const total = UNITS.length;
let out = `# 单位卡事件驱动审计（${implemented.length}/${total} 有可观测效果）\n`;
out += `\n未实现 ${missing.length} 张：\n\n`;
for (const m of missing) out += `- **${m.name}** (${m.id}) — ${(m.text || '').replace(/\n/g, ' / ')}\n`;
fs.writeFileSync(path.join(__dirname, '..', '.work', 'unit_events.md'), out, 'utf8');
console.log(`带文本单位 ${total} | 有可观测效果 ${implemented.length} (${(implemented.length / total * 100).toFixed(1)}%) | 未实现 ${missing.length}`);
console.log('-> .work/unit_events.md');
