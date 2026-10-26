/* ============================================================
 * KARDS Web - AI opponent (heuristic)
 * ============================================================ */
(function () {
  'use strict';

  const AI = {};

  // Evaluate how good a card is to play now (higher = play sooner)
  function cardPriority(g, c, side) {
    let score = 0;
    const p = g.players[side];
    // prefer using kredits fully
    score += Math.min(c.cost, p.kredits) * 1.2;
    if (c.type === 'order') {
      if (c.text) {
        if (/deal \d+ damage/i.test(c.text)) score += 6;
        if (/draw \d+ card/i.test(c.text)) score += 5;
        if (/destroy/i.test(c.text)) score += 6;
        if (/your hq.*\+?\d* ?defense/i.test(c.text)) score += 3;
        if (/kredit slot/i.test(c.text)) score += 7;
      }
      return score;
    }
    // units: value = stats + keywords
    score += (c.totalAttack || c.attack) * 1.1 + (c.defense) * 0.9;
    if (c.has && c.has('guard')) score += 3;
    if (c.has && c.has('blitz')) score += 3;
    if (c.has && c.has('fury')) score += 3;
    if (c.type === 'tank') score += 2;
    return score;
  }

  AI.takeTurn = function (g, side, onDone) {
    const p = g.players[side];
    const queue = [];

    // 1) play cards (best value first, keep 1-2 kredits for ops if early)
    const reserve = g.turn <= 2 ? 0 : 0;
    let hand = p.hand.map((c, i) => ({ c, i }));
    hand.sort((a, b) => cardPriority(g, b.c, side) - cardPriority(g, a.c, side));
    for (const { c, i } of hand) {
      const idx = p.hand.indexOf(c);
      if (idx < 0) continue;
      const eff = Math.max(0, (c.cost || 0) + (c._costMod || 0));
      if (eff > p.kredits) continue;
      if (!g.hasRoomFor(c)) continue;
      // don't dump everything if we want to operate units this turn
      if (p.kredits - eff < 0) continue;
      const r = g.playCard(side, idx, {});
      if (r.ok) queue.push({ type: 'play' });
    }

    // 2) move units to frontline (prefer when we control or it's empty)
    const myUnits = g.unitsOf(side);
    for (const u of myUnits) {
      if (g.canMove(u, true) && p.kredits >= u.opCost) {
        // contest frontline if enemy has frontline units or we control it
        const enemyFront = g.frontline.filter(c => c.owner !== side).length;
        if (g.frontlineOwner === side || enemyFront === 0 || u.totalAttack >= 4) {
          g.move(side, u.uid, true);
          queue.push({ type: 'move', uid: u.uid, toFront: true });
        }
      }
    }

    // 3) attack with all able units
    for (const u of g.unitsOf(side)) {
      if (!g.canAttack(u)) continue;
      const targets = g.attackTargets(u);
      if (!targets.length) continue;
      if (p.kredits < u.opCost) continue;
      let best = null, bestScore = -1e9;
      for (const t of targets) {
        let score;
        if (t === 0) {
          const foeHq = g.players[1 - side].hqDef;
          const lethal = u.totalAttack >= foeHq;
          score = lethal ? 10000 : 9 + u.totalAttack * 0.4;
        } else {
          const d = g.find(t);
          if (!d) continue;
          const kill = u.totalAttack >= d.totalDefense;
          const dies = Math.max(0, d.totalAttack - u.heavyArmor) >= u.totalDefense;
          const noRetal = u.type === 'artillery' || u.type === 'bomber';
          score = (kill ? 60 : 8) - (dies ? (noRetal ? 0 : 45) : 0);
          score += d.totalAttack * 1.2 + d.totalDefense * 0.8;
          if (d.has('guard')) score += 6;
          // don't attack into smokescreen-hidden (can't anyway)
        }
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (best !== null) {
        g.attack(side, u.uid, best);
        queue.push({ type: 'attack', uid: u.uid, target: best });
      }
    }

    // 4) end turn
    g.endTurn();
    queue.push({ type: 'endTurn' });

    if (onDone) onDone(queue);
    return queue;
  };

  window.KardsAI = AI;
})();
