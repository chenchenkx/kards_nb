/* Self-play test: run games with the engine and print results. */
const fs = require('fs');
const path = require('path');
const Engine = require('../public/js/engine.js');

const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

function runGame(seed, verbose) {
  const rng = Engine.makeRng(seed);
  const decks = [Engine.autoDeck('Germany', db, rng), Engine.autoDeck('Soviet', db, rng)];
  const g = new Engine.Game({
    db, seed,
    decks,
    hqs: [db.hqs['Germany'], db.hqs['Soviet']],
  });
  let steps = 0;
  const aiSide = () => g.current;
  while (!g.done && steps < 3000) {
    steps++;
    const side = g.current;
    const p = g.players[side];
    // --- naive AI ---
    // play cards（每回合上限 30 张，避免 0 费 token 被无限生成的 combo 把朴素 AI 卡死）
    let played = true, plays = 0;
    while (played && plays < 30) {
      played = false;
      for (let i = 0; i < p.hand.length; i++) {
        const c = p.hand[i];
        const effCost = Math.max(0, (c.cost || 0) + (c._costMod || 0));
        if (effCost <= p.kredits && g.hasRoomFor(c)) {
          const r = g.playCard(side, i, {});
          if (r.ok) { played = true; plays++; break; }
        }
      }
    }
    // move units to frontline
    for (const u of [...g.unitsOf(side)]) {
      if (g.canMove(u, true) && p.kredits >= u.opCost) g.move(side, u.uid, true);
    }
    // attack
    for (const u of [...g.unitsOf(side)]) {
      if (!g.canAttack(u)) continue;
      const targets = g.attackTargets(u);
      if (!targets.length) continue;
      if (p.kredits < u.opCost) continue;
      // prefer lethal HQ, then good trades
      let best = targets[0], bestScore = -1e9;
      for (const t of targets) {
        let score;
        if (t === 0) {
          const lethal = u.totalAttack >= g.players[1 - side].hqDef;
          score = lethal ? 1000 : 12;
        } else {
          const d = g.find(t);
          const kill = u.totalAttack >= d.totalDefense;
          const dies = d.totalAttack - u.heavyArmor >= u.totalDefense;
          score = (kill ? 50 : 10) - (dies ? 40 : 0) + (d.totalAttack + d.totalDefense) * 0.1;
        }
        if (score > bestScore) { bestScore = score; best = t; }
      }
      g.attack(side, u.uid, best);
    }
    g.endTurn();
  }
  const result = { seed, steps, done: g.done, winner: g.winner, turn: g.turn,
    hq: [g.players[0].hqDef, g.players[1].hqDef] };
  if (verbose) console.log(g.log.join('\n'));
  return result;
}

const n = parseInt(process.argv[2] || '10', 10);
let p0 = 0, p1 = 0, unfinished = 0;
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const r = runGame(1000 + i * 7);
  if (!r.done) unfinished++;
  else if (r.winner === 0) p0++;
  else if (r.winner === 1) p1++;
  if (i < 3 || !r.done) console.log(JSON.stringify(r));
}
console.log(`\n${n} games: P1(Germany) ${p0} - ${p1} P2(Soviet), unfinished ${unfinished}, avg turns ${(n ? '' : '')}${Date.now() - t0}ms`);
