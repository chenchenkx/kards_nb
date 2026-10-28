/* AI 出牌合法性专项测试：分步决策语义下，
 * 断言 AI 打出的每一张牌的实际费用（handCost）都 ≤ 打出时的指挥点，
 * 且指挥点永远不为负。跑多个随机对局/回合。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

global.window = global; // 引擎以 UMD 挂 window
const Engine = require(path.join(ROOT, 'public/js/engine.js'));
const cards = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

// 加载 ai.js（IIFE 挂 window.KardsAI）
require(path.join(ROOT, 'public/js/ai.js'));
const AI = global.window.KardsAI;

let plays = 0, fails = 0;
const GAMES = 30;

for (let gi = 0; gi < GAMES; gi++) {
  const mkDeck = () => {
    const pool = db.cards.filter(c => c.type !== 'hq');
    const d = [];
    while (d.length < 39) d.push(pool[(Math.random() * pool.length) | 0].id);
    return d;
  };
  const g = new Engine.Game({
    db,
    seed: (Math.random() * 2147483647) | 0,
    decks: [mkDeck(), mkDeck()],
    hqs: [db.hqs.Germany, db.hqs.Soviet],
  });
  g.humanSides = [true, false];
  let turns = 0;
  while (!g.done && turns < 60) {
    turns++;
    // AI 回合（side 1）：分步语义逐步执行
    if (g.current === 1) {
      const skip = new Set();
      let guard = 120;
      while (guard-- > 0 && !g.done && g.current === 1) {
        const act = AI.nextAction(g, 1, skip);
        if (!act) break;
        let r = { ok: false };
        try {
          if (act.kind === 'play') {
            // 关键断言：打出前用与引擎同口径的费用校验
            const cost = g.handCost(1, act.handIndex);
            const p1 = g.players[1];
            if (cost == null || cost > p1.kredits) {
              fails++;
              console.log(`  ✗ 非法出牌：${p1.hand[act.handIndex].name} cost=${cost} kredits=${p1.kredits}`);
              skip.add('play:' + act.uid);
              continue;
            }
            r = g.playCard(1, act.handIndex, {});
            plays++;
          }
          else if (act.kind === 'move') r = g.move(1, act.uid, act.toFront);
          else if (act.kind === 'attack') r = g.attack(1, act.uid, act.target);
        } catch (e) { r = { ok: false, error: String(e) }; }
        if (!r.ok) skip.add(act.kind + ':' + act.uid);
      }
      if (g.current === 1) g.endTurn();
    }
    // 玩家侧（side 0）自动空过，只让游戏推进
    if (g.current === 0 && !g.done) g.endTurn();
    // 指挥点永不为负
    for (const s of [0, 1]) {
      if (g.players[s].kredits < 0) { fails++; console.log(`  ✗ 指挥点为负 P${s}: ${g.players[s].kredits}`); }
    }
  }
}
console.log(`\n${GAMES} 局模拟完成，AI 出牌 ${plays} 次，违规 ${fails} 次`);
process.exit(fails ? 1 : 0);
