/* 逐种子自对弈插桩：定位卡死（playCard 空转 / 攻击空转 / 单步超时） */
const fs = require('fs');
const path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

function runGame(seed) {
  const rng = Engine.makeRng(seed);
  const decks = [Engine.autoDeck('Germany', db, rng), Engine.autoDeck('Soviet', db, rng)];
  const g = new Engine.Game({ db, seed, decks, hqs: [db.hqs['Germany'], db.hqs['Soviet']] });
  let steps = 0;
  const t0 = Date.now();
  while (!g.done && steps < 3000) {
    steps++;
    if (Date.now() - t0 > 4000) {
      console.log(`TIMEOUT seed=${seed} steps=${steps} turn=${g.turn} side=${g.current}`);
      return { seed, timeout: true, steps, turn: g.turn };
    }
    const side = g.current;
    const p = g.players[side];
    // play cards (with spin guard)
    let played = true, guard = 0;
    while (played && guard++ < 300) {
      played = false;
      for (let i = 0; i < p.hand.length; i++) {
        const c = p.hand[i];
        const effCost = Math.max(0, (c.cost || 0) + (c._costMod || 0));
        if (effCost <= p.kredits && g.hasRoomFor(c)) {
          const r = g.playCard(side, i, {});
          if (r.ok) { played = true; break; }
        }
      }
    }
    if (guard >= 300) {
      console.log(`PLAY-SPIN seed=${seed} steps=${steps} turn=${g.turn} side=${side} hand=${p.hand.map(c => c.name).join(' | ')}`);
      return { seed, spin: 'play', steps };
    }
    for (const u of [...g.unitsOf(side)]) {
      if (g.canMove(u, true) && p.kredits >= u.opCost) g.move(side, u.uid, true);
    }
    for (const u of [...g.unitsOf(side)]) {
      if (!g.canAttack(u)) continue;
      const targets = g.attackTargets(u);
      if (!targets.length) continue;
      if (p.kredits < u.opCost) continue;
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
  return { seed, steps, done: g.done, winner: g.winner, turn: g.turn };
}

const start = parseInt(process.argv[2] || '1000', 10);
const n = parseInt(process.argv[3] || '10', 10);
for (let i = 0; i < n; i++) {
  const seed = start + i * 7;
  const t = Date.now();
  const r = runGame(seed);
  console.log(`seed=${seed} ${Date.now() - t}ms ${JSON.stringify(r)}`);
}
