/* ============================================================
 * KARDS Web - AI opponent (heuristic, stepwise)
 *
 * 设计要点：
 * - AI 不再一次性把整回合打完。对外提供 nextAction()：每次只给出
 *   「当前局面下的下一个最优动作」，由调用方（main.js）执行、渲染、
 *   播放动画，停顿一段随机时间后再来要下一步。
 * - 每一步都从实时局面重新计算（指挥点、手牌、场面），杜绝基于
 *   过期快照出牌；费用判定与引擎 playCard 完全同口径（g.handCost）。
 * - takeTurn() 保留同步整回合执行，仅供工具/测试使用。
 * ============================================================ */
(function () {
  'use strict';

  const AI = {};

  // ---- 节奏：动作之间的停顿（毫秒，随机化，避免机械感）----
  AI.MIN_DELAY = 550;
  AI.MAX_DELAY = 1400;
  AI.delay = function () {
    return AI.MIN_DELAY + Math.floor(Math.random() * (AI.MAX_DELAY - AI.MIN_DELAY));
  };

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

  /**
   * 下一个该做的动作；每次都从当前局面重新计算。
   * skip（可选）：Set<string>，本回合已失败的动作签名，避免反复重试同一非法动作。
   * 返回 {kind:'play',handIndex,uid} | {kind:'move',uid,toFront} |
   *      {kind:'attack',uid,target} | null（无事可做 → 结束回合）
   */
  AI.nextAction = function (g, side, skip) {
    skip = skip || null;
    const p = g.players[side];

    // 1) 出牌：在当前指挥点内选最优的一张（先出牌后行动，与旧策略一致）
    let best = null, bestScore = -1e9;
    for (let i = 0; i < p.hand.length; i++) {
      const c = p.hand[i];
      const cost = (typeof g.handCost === 'function')
        ? g.handCost(side, i)
        : Math.max(0, (c.cost || 0) + (c._costMod || 0));
      if (cost == null || cost > p.kredits) continue;
      if (!g.hasRoomFor(c)) continue;
      if (skip && skip.has('play:' + c.uid)) continue;
      // 与 playCard 的前置拒绝条件保持一致，减少“选中却打不出”的空转
      if (c.isUnit && p._noDeployTurns > 0) continue;
      if ((c.type === 'order' || c.type === 'gotcha') && p._noOrders) continue;
      if (c.type === 'order' && g._orderLimit && p.ordersPlayedThisTurn >= g._orderLimit) continue;
      // 略偏向先花掉大卡，把小卡留作补刀费用
      const s = cardPriority(g, c, side) + cost * 0.1;
      if (s > bestScore) { bestScore = s; best = { kind: 'play', handIndex: i, uid: c.uid }; }
    }
    if (best) return best;

    // 2) 移动单位进前线（己方控制前线或前线为空、或单位攻击足够高时）
    for (const u of g.unitsOf(side)) {
      if (skip && skip.has('move:' + u.uid)) continue;
      if (!g.canMove(u, true)) continue;
      if (p.kredits < u.effOpCost) continue;
      const enemyFront = g.frontline.filter(x => x.owner !== side).length;
      if (g.frontlineOwner === side || enemyFront === 0 || u.totalAttack >= 4) {
        return { kind: 'move', uid: u.uid, toFront: true };
      }
    }

    // 3) 攻击：为每个可攻击单位选最优目标
    for (const u of g.unitsOf(side)) {
      if (skip && skip.has('attack:' + u.uid)) continue;
      if (!g.canAttack(u)) continue;
      const targets = g.attackTargets(u);
      if (!targets.length) continue;
      if (p.kredits < u.effOpCost) continue;
      let bestT = null, bs = -1e9;
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
        }
        if (score > bs) { bs = score; bestT = t; }
      }
      if (bestT !== null) return { kind: 'attack', uid: u.uid, target: bestT };
    }

    return null;
  };

  /**
   * 同步整回合执行（保留给工具/测试）：循环向 nextAction 要动作直到无事可做，
   * 与分步执行共用同一决策逻辑。
   */
  AI.takeTurn = function (g, side, onDone) {
    const queue = [];
    const skip = new Set();
    let guard = 200; // 绝对保险丝，防止任何意外死循环
    while (guard-- > 0) {
      const act = AI.nextAction(g, side, skip);
      if (!act) break;
      let r = { ok: false };
      try {
        if (act.kind === 'play') r = g.playCard(side, act.handIndex, {});
        else if (act.kind === 'move') r = g.move(side, act.uid, act.toFront);
        else if (act.kind === 'attack') r = g.attack(side, act.uid, act.target);
      } catch (e) { r = { ok: false, error: String(e) }; }
      if (!r.ok) {
        // 该动作被引擎拒绝：拉黑签名后继续尝试其他动作
        skip.add(act.kind + ':' + act.uid);
        continue;
      }
      queue.push({ type: act.kind, uid: act.uid, target: act.target });
    }
    g.endTurn();
    queue.push({ type: 'endTurn' });
    if (onDone) onDone(queue);
    return queue;
  };

  window.KardsAI = AI;
})();
