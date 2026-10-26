/* ============================================================
 * KARDS Web - Game Rules Engine
 * Faithful port of KARDS rules (frontline, HQ, orders, keywords).
 * Runs in browser and Node (UMD).
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KardsEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------- Rules constants ----------------
  const RULES = {
    MAX_HAND: 9,
    MAX_ROW: 5,          // support line slots (incl. HQ)
    MAX_KREDITS: 12,     // natural slot cap
    MAX_SLOTS: 24,       // absolute slot cap (card effects)
    DECK_SIZE: 39,
    STARTING_HAND: 4,
    HQ_DEFENSE: 20,
    FATIGUE_BASE: 1,
  };

  const NATION_CODE = { '1': 'Germany', '2': 'Britain', '3': 'Japan', '4': 'Soviet', '5': 'USA', '6': 'France', '7': 'Italy', '8': 'Poland', '9': 'Finland', 'a': 'Anzac' };
  const DEFAULT_HQ_CODE = { Germany: '3v', Britain: '0N', Japan: '6l', Soviet: '8v', USA: 'ce' };

  // ---------------- RNG (mulberry32, deterministic) ----------------
  function makeRng(seed) {
    let s = seed >>> 0;
    return {
      next() {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(n) { return Math.floor(this.next() * n); },
    pick(arr) { return arr[this.int(arr.length)]; },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = this.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }};
  }

  // ---------------- Card instance ----------------
  let _uid = 1;
  class CardInst {
    constructor(def, owner, game) {
      this.uid = _uid++;
      this.def = def;
      this.id = def.id;
      this.owner = owner;               // 0 | 1
      this.name = def.name;
      this.type = def.type;             // infantry|tank|artillery|fighter|bomber|order|gotcha|location
      this.nation = def.nation;
      this.cost = def.cost || 0;
      this.opCost = def.opCost || 0;
      this.attack = def.attack || 0;
      this.defense = def.defense || 0;
      this.range = def.range || 1;
      this.text = def.text || '';
      this.keywords = new Set(def.keywords || []);
      this.heavyArmor = def.heavyArmor || 0;
      this.slot = null;                 // 所在阵线的槽位（支援 0..3 / 前线 0..4）
      this.loc = 'deck';                // deck|hand|board|front|discard
      this.summonedTurn = 0;
      this.attacksLeft = 1;             // per turn attack count (Fury=2)
      this.hasAttacked = false;
      this.hasMoved = false;
      this.hasActed = false;            // moved or attacked this turn (smokescreen)
      this.buffAttack = 0;
      this.buffDefense = 0;
      this.gotchaActive = 0;
      this.chosenTarget = null;
      this.gotchaUsed = false;
      this._game = game;
    }
    get totalAttack() { return Math.max(0, this.attack + this.buffAttack); }
    get totalDefense() { return this.defense + this.buffDefense; }
    get isUnit() { return ['infantry', 'tank', 'artillery', 'fighter', 'bomber'].includes(this.type); }
    has(kw) { return this.keywords.has(kw); }
    canOperate() {
      if (this.summonedTurn === this._game.turn && !this.has('blitz')) return false;
      return true;
    }
    serialize() {
      return {
        uid: this.uid, id: this.id, owner: this.owner, loc: this.loc,
        attack: this.attack, defense: this.defense, buffAttack: this.buffAttack, buffDefense: this.buffDefense,
        totalAttack: this.totalAttack, totalDefense: this.totalDefense,
        keywords: [...this.keywords], summonedTurn: this.summonedTurn,
        attacksLeft: this.attacksLeft, hasAttacked: this.hasAttacked, hasMoved: this.hasMoved,
        gotchaActive: this.gotchaActive, name: this.name, type: this.type, nation: this.nation,
        cost: this.cost, opCost: this.opCost, range: this.range, text: this.text,
        heavyArmor: this.heavyArmor, hasActed: this.hasActed, slot: this.slot,
      };
    }
  }

  // ================= Text / effect interpreter =================
  // Parses English card text into executable clauses.
  // Each clause: { kind, cond, ops }  kind: order|deployment|destruction|static
  const UNITS = 'infantry|tank|artillery|fighter|bomber';

  function splitSentences(text) {
    if (!text) return [];
    // keep "Deployment:" / "Destruction:" prefixes attached to their sentence
    return text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function parseClauses(text) {
    const clauses = [];
    for (const sent of splitSentences(text)) {
      let kind = 'static', body = sent;
      const m = /^(Deployment|Destruction|Reveal|Ambush|Shock|Pincer|Forecast)\s*:\s*/i.exec(sent);
      if (m) {
        kind = m[1].toLowerCase() === 'deployment' ? 'deployment'
            : m[1].toLowerCase() === 'destruction' ? 'destruction' : 'static';
        body = sent.slice(m[0].length);
      }
      const clause = { kind, text: sent, cond: null, ops: parseOps(body) };
      if (clause.ops.length) clauses.push(clause);
      else {
        // try whole-sentence parse (e.g. "When X, Y." trigger patterns)
        const trig = parseTriggerSentence(sent);
        if (trig) clauses.push(trig);
      }
    }
    return clauses;
  }

  function parseOps(s) {
    const ops = [];
    const t = s.trim();

    // "Deal N damage to ..." (several target forms)
    let m = /\bdeal (\d+) damage to (?:an? |the |each |target )?([a-z \-+]*?)(?:\.|,|$)/i.exec(t);
    if (m) {
      const n = +m[1];
      let target = (m[2] || '').trim().toLowerCase();
      let tgt = 'unit';
      if (/all enem/.test(target)) tgt = 'allEnemies';
      else if (/all enemy (air|units)/.test(target)) tgt = /air/.test(target) ? 'allEnemyAir' : 'allEnemyUnits';
      else if (/enemy hq/.test(target)) tgt = 'enemyHQ';
      else if (/your hq/.test(target)) tgt = 'ownHQ';
      else if (/random enem/.test(target)) tgt = 'randomEnemy';
      else if (/any target|a unit|target unit|an enemy/.test(target)) tgt = 'unit';
      else if (/all friendly|all your/.test(target)) tgt = 'allFriendly';
      ops.push({ op: 'damage', n, target: tgt });
      const rest = t.slice(m.index + m[0].length);
      if (rest.trim()) ops.push(...parseOps(rest.trim().replace(/^(and|then)\s+/i, '')));
      return ops;
    }

    // "Deal damage to the enemy HQ equal to X"
    if (/deal damage to the enemy hq/i.test(t)) ops.push({ op: 'damage', n: 'atk', target: 'enemyHQ' });

    // "Destroy target X" / "Destroy a unit" / "Destroy an enemy unit"
    if (/\bdestroy\b/i.test(t)) {
      let tgt = 'unit';
      if (/destroy all enem/i.test(t)) tgt = 'allEnemyUnits';
      else if (/destroy (?:a|the|target)? ?(tank|air unit|infantry|artillery|fighter|bomber)/i.test(t)) tgt = 'typed';
      ops.push({ op: 'destroy', target: tgt });
      return ops;
    }

    // "Draw N card(s)"
    m = /\bdraw (\d+) cards?/i.exec(t);
    if (m) { ops.push({ op: 'draw', n: +m[1] }); return ops; }

    // "Gain N extra kredit slot(s)" / "Gain N kredits"
    m = /\bgain (\d+) extra kredit slots?/i.exec(t);
    if (m) { ops.push({ op: 'slots', n: +m[1] }); return ops; }
    m = /\bgain (\d+) kredits?/i.exec(t);
    if (m) { ops.push({ op: 'kredits', n: +m[1] }); return ops; }

    // "Your HQ gets +N defense" / "Your HQ gains +N defense"
    m = /your hq (?:gets|gains) \+?(\d+) defense/i.exec(t);
    if (m) { ops.push({ op: 'hqDef', n: +m[1] }); return ops; }
    m = /your hq (?:gets|gains) \+(\d+)\+(\d+)/i.test(t) && /your hq/i.test(t) ? null : null;
    if (/your hq/i.test(t) && /\+(\d+)\+?(\d+)?/.test(t)) {
      const mm = /\+(\d+)\+?(\d+)?/.exec(t);
      ops.push({ op: 'hqBuff', a: +mm[1], d: +(mm[2] || 0) });
      return ops;
    }

    // "Give [target] +X+Y" / "Gets +X+Y"
    m = /(?:give|gives|gets|get) (?:a |an |the |target |random )?(friendly |enemy |random friendly |random enemy )?(unit|infantry|tank|artillery|fighter|bomber|it|them)? ?\+(\d+)\+(\d+)/i.exec(t);
    if (m) {
      let tgt = 'unit';
      const who = ((m[1] || '') + (m[2] || '')).toLowerCase();
      if (/random friendly/.test(who)) tgt = 'randomFriendly';
      else if (/friendly/.test(who)) tgt = 'friendlyUnit';
      else if (/enemy/.test(who)) tgt = 'enemyUnit';
      ops.push({ op: 'buff', a: +m[3], d: +m[4], target: tgt, self: /^gets/i.test(t.trim()) });
      return ops;
    }

    // "Your units get +X+Y"
    m = /your units get \+(\d+)\+(\d+)/i.exec(t);
    if (m) { ops.push({ op: 'buff', a: +m[1], d: +m[2], target: 'allFriendlyUnits' }); return ops; }
    m = /(?:all )?(friendly|enemy) units get \+(\d+)\+(\d+)/i.exec(t);
    if (m) { ops.push({ op: 'buff', a: +m[2], d: +m[3], target: m[1].toLowerCase() === 'friendly' ? 'allFriendlyUnits' : 'allEnemyUnits' }); return ops; }

    // "Give [a unit] Blitz / Guard / Fury ..."
    m = /give (?:a |an |the |target |random )?(friendly |enemy )?(unit|infantry|tank|artillery|fighter|bomber)? ?((?:[a-z]+ ?)+)$/i.exec(t);
    if (m && /\b(blitz|guard|fury|smokescreen|ambush|shock)\b/i.test(t)) {
      const kws = ['blitz', 'guard', 'fury', 'smokescreen', 'ambush', 'shock'].filter(k => new RegExp('\\b' + k + '\\b', 'i').test(t));
      let tgt = 'unit';
      if (/random friendly/.test(t)) tgt = 'randomFriendly';
      else if (/friendly/.test(t)) tgt = 'friendlyUnit';
      ops.push({ op: 'keyword', kws, target: tgt });
      return ops;
    }

    // "Retreat [target] unit" / "Target enemy unit retreats"
    if (/\bretreat/i.test(t)) {
      let tgt = 'unit';
      if (/random enem/.test(t)) tgt = 'randomEnemy';
      else if (/enem/.test(t)) tgt = 'enemyUnit';
      else if (/friendly|your/.test(t)) tgt = 'friendlyUnit';
      ops.push({ op: 'retreat', target: tgt });
      return ops;
    }

    // "Pin [all] enemy units" / "Suppress"
    if (/\bpin\b/i.test(t) || /\bsuppress\b/i.test(t)) {
      const tgt = /all enem/.test(t) ? 'allEnemyUnits' : 'unit';
      ops.push({ op: 'pin', target: tgt });
      return ops;
    }

    // "Add X to your hand" (spawn by name)
    m = /add (?:a |an |one |two |three )?(random )?([A-Z0-9'\-\. ]+?) to your hand/i.exec(t);
    if (m) {
      if (/^copy$/i.test(m[2].trim())) { ops.push({ op: 'copyToHand' }); return ops; }
      ops.push({ op: 'addHand', name: m[2].trim(), random: !!m[1] });
      return ops;
    }

    // "Deploy a X" / "Add a X to [the|your] (support line|frontline|battlefield)"
    m = /(?:deploy|add) (?:a |an |one |two )?(random )?([A-Z0-9'\-\. ]+?) (?:to (?:the |your )?(support line|frontline|battlefield|hand))?/i.exec(t);
    if (m && m[2] && !/to your hand/.test(t)) {
      const loc = (m[3] || 'support').toLowerCase();
      ops.push({ op: 'spawn', name: m[2].trim(), random: !!m[1], loc: /front/.test(loc) ? 'front' : (/hand/.test(loc) ? 'hand' : 'board') });
      return ops;
    }

    // "Return [target] to your hand" / "to the top of your deck" / "to its owner's hand"
    if (/return .*(hand|deck)/i.test(t)) {
      const toDeck = /deck/i.test(t);
      let tgt = 'unit';
      if (/all enem/.test(t)) tgt = 'allEnemyUnits';
      else if (/enem/.test(t)) tgt = 'enemyUnit';
      ops.push({ op: 'return', target: tgt, toDeck });
      return ops;
    }

    // "Shuffle X into your deck"
    m = /shuffle (?:a |an |one )?([A-Z0-9'\-\. ]+?) into your deck/i.exec(t);
    if (m) { ops.push({ op: 'addDeck', name: m[1].trim() }); return ops; }

    // "Forecast."
    if (/^forecast/i.test(t)) { ops.push({ op: 'forecast' }); return ops; }

    // "Becomes Veteran"
    if (/becomes veteran/i.test(t)) { ops.push({ op: 'veteran' }); return ops; }

    // "Increase cost of all cards in enemy hand by N"
    m = /increase cost of all cards in enemy hand by (\d+)/i.exec(t);
    if (m) { ops.push({ op: 'enemyHandCost', n: +m[1] }); return ops; }

    // "Reduce the cost of all orders in your hand by N"
    m = /reduce (?:the )?cost of all orders in your hand by (\d+)/i.exec(t);
    if (m) { ops.push({ op: 'ownHandOrderCost', n: +m[1] }); return ops; }

    // "Choose one - X OR Y"
    m = /choose one\s*-\s*(.+?)\s+or\s+(.+?)\.?$/i.exec(t);
    if (m) {
      ops.push({ op: 'choose', options: [parseOps(m[1]), parseOps(m[2])] });
      return ops;
    }

    return ops;
  }

  // "When X, Y." / "After X, Y." / "At the end of turn, X."
  function parseTriggerSentence(sent) {
    const m = /^(when|after|at the end of (?:your |the )?turn|at the start of (?:your |the )?turn|if)\b,?\s*(.+?),?\s*(.+?)\.?$/i.exec(sent.trim());
    if (!m) return null;
    const when = m[1].toLowerCase();
    let event = null;
    if (/when the enemy (deploys|plays)/.test(m[2])) event = /deploys/.test(m[2]) ? 'enemyDeploy' : 'enemyOrder';
    else if (/when this unit becomes veteran/i.test(m[2])) event = 'becomesVeteran';
    else if (/when the enemy draws/i.test(m[2])) event = 'enemyDraw';
    else if (/at the end of turn/i.test(m[2]) || when.startsWith('at the end')) event = 'endOfTurn';
    else if (/at the start of/i.test(m[2]) || when.startsWith('at the start')) event = 'startOfTurn';
    else if (/after this unit attacks/i.test(m[2])) event = 'selfAttack';
    else if (/this unit (is destroyed|dies)/i.test(m[2])) event = 'selfDestroy';
    const ops = parseOps(m[3]);
    if (!ops.length) return null;
    return { kind: 'trigger', event, when: m[2], text: sent, cond: null, ops };
  }

  // ---------------- Conditions ----------------
  function evalCond(cond, game, card, ctx) {
    if (!cond) return true;
    switch (cond.c) {
      case 'leftmost': return ctx && ctx.fromLeftmost;
      case 'rightmost': return ctx && ctx.fromRightmost;
      case 'controlFrontline': return game.frontlineOwner === card.owner;
      case 'gaveOrderThisTurn': return game.players[card.owner].ordersPlayedThisTurn > 0;
      case 'isEnemyTurn': return game.current !== card.owner;
      case 'hqDamagedThisTurn': return game.players[1 - card.owner].hqDamagedThisTurn >= (cond.n || 1);
      case 'controlType': return game.unitsOf(card.owner).some(u => u.type === cond.type && u.uid !== card.uid);
      case 'controlNation': return game.unitsOf(card.owner).some(u => u.nation === cond.nation && u.uid !== card.uid);
      case 'topDeckType': {
        const deck = game.players[card.owner].deck;
        return deck.length && deck[0].type === cond.type;
      }
      default: return true;
    }
  }

  // ================= Game =================
  class Game {
    constructor(opts) {
      opts = opts || {};
      this.db = opts.db;                       // {byId, cards, hqs}
      this.rng = makeRng(opts.seed || 12345);
      this.turn = 1;
      this.current = 0;
      this.done = false;
      this.winner = -1;
      this.frontline = [];
      this.frontlineOwner = -1;                // -1 none, 0|1
      this.logLines = [];
      this.players = [0, 1].map(i => ({
        side: i,
        hq: opts.hqs ? (opts.hqs[i] || null) : null,
        hqDef: RULES.HQ_DEFENSE,
        hqMaxDef: RULES.HQ_DEFENSE,
        kredits: 0,
        slots: 0,
        fatigue: 0,
        deck: [], hand: [], board: [], discard: [],
        ordersPlayedThisTurn: 0,
        hqDamagedThisTurn: 0,
        slotsLost: 0,
      }));
      this.nextGotchaOrder = 1;
      this.pendingChoose = null;
      this.history = [];
      this.events = [];
      if (opts.decks) {
        for (const i of [0, 1]) {
          const list = opts.decks[i] || [];
          for (const id of list) {
            const def = this.db.byId[id];
            if (!def) continue;
            const c = new CardInst(def, i, this);
            c.loc = 'deck';
            this.players[i].deck.push(c);
          }
          this.rng.shuffle(this.players[i].deck);
        }
      }
      if (opts.start !== false) this.start();
    }

    log(line) { this.logLines.push(line); if (this.logLines.length > 400) this.logLines.shift(); }
    ev(e) { this.events.push(e); if (this.events.length > 500) this.events.shift(); }
    drainEvents() { const e = this.events; this.events = []; return e; }

    start() {
      for (const i of [0, 1]) {
        for (let k = 0; k < RULES.STARTING_HAND; k++) this.draw(i, 1, true);
      }
      this.beginTurn();
    }

    // ---------- queries ----------
    unitsOf(side) {
      const out = [];
      for (const c of this.players[side].board) if (c.isUnit) out.push(c);
      for (const c of this.frontline) if (c.owner === side && c.isUnit) out.push(c);
      return out;
    }
    allBoard() {
      return [...this.players[0].board, ...this.frontline, ...this.players[1].board];
    }
    canEnterFrontline(side) {
      return this.frontlineOwner === -1 || this.frontlineOwner === side;
    }
    frontlineCount(side) { return this.frontline.filter(c => c.owner === side).length; }

    /** 在阵线中认领一个槽位：优先玩家指定的落点，否则取最靠近中间的可用槽 */
    claimSlot(list, preferred, maxSlots) {
      const used = new Set();
      for (const c of list) if (c && c.slot != null) used.add(c.slot);
      if (typeof preferred === 'number' && preferred >= 0 && preferred < maxSlots && !used.has(preferred)) {
        return preferred;
      }
      const free = [];
      for (let i = 0; i < maxSlots; i++) if (!used.has(i)) free.push(i);
      if (!free.length) return null;
      const mid = (maxSlots - 1) / 2;
      free.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
      return free[0];
    }
    sortFrontline() {
      this.frontline.sort((a, b) => (a.slot == null ? 9 : a.slot) - (b.slot == null ? 9 : b.slot));
    }
    /** 前线是「自动居中」的密集排列：重排后把顺序位压实成 0..n-1 */
    packFrontline() {
      this.frontline.forEach((c, i) => { c.slot = i; });
    }
    sortBoard(list) {
      list.sort((a, b) => (a.slot == null ? 9 : a.slot) - (b.slot == null ? 9 : b.slot));
    }
    supportCount(side) { return this.players[side].board.length; }
    hqExposed(defender) {
      if (this.frontlineOwner !== -1 && this.frontlineOwner !== defender) return true;
      return this.frontline.filter(c => c.owner === defender).length === 0;
    }
    hqIsGuarded(attackerSide) {
      const foe = 1 - attackerSide;
      return this.players[foe].board.some(c => c.isUnit && c.has('guard') && !c.has('covert'));
    }
    isGuarded(target) {
      // 相邻槽位的守护单位提供保护
      const row = target.loc === 'front' ? this.frontline : this.players[target.owner].board;
      if (target.slot != null) {
        for (const n of row) {
          if (!n || n === target || !n.isUnit || !n.has('guard')) continue;
          if (n.slot != null && Math.abs(n.slot - target.slot) === 1) return true;
        }
        return false;
      }
      // 兜底：缺少槽位信息时按数组相邻判断
      const idx = row.indexOf(target);
      for (const j of [idx - 1, idx + 1]) {
        if (j < 0 || j >= row.length) continue;
        const n = row[j];
        if (n && n.isUnit && n.has('guard')) return true;
      }
      return false;
    }

    // ---------- turn flow ----------
    beginTurn() {
      const p = this.players[this.current];
      p.slots = Math.min(RULES.MAX_KREDITS, p.slots + 1);
      p.kredits = p.slots;
      p.ordersPlayedThisTurn = 0;
      p.hqDamagedThisTurn = 0;
      for (const u of this.unitsOf(this.current)) {
        u.attacksLeft = u.has('fury') ? 2 : 1;
        u.hasAttacked = false;
        u.hasMoved = false;
        u.hasActed = false;
      }
      this.log(`── 第 ${this.turn} 回合（P${this.current + 1}）${p.kredits}/${p.slots} 指挥点 ──`);
      this.ev({ e: 'turn', turn: this.turn, side: this.current, kredits: p.kredits, slots: p.slots });
      this.draw(this.current, 1);
    }

    endTurn() {
      if (this.done) return;
      const cur = this.current;
      // expiry of end-of-turn effects could go here
      this.current = 1 - cur;
      if (cur === 1) this.turn++;
      if (!this.done) this.beginTurn();
    }

    draw(side, n, silent) {
      const p = this.players[side];
      for (let i = 0; i < n; i++) {
        if (!p.deck.length) {
          p.fatigue += 1;
          this.log(`P${side + 1} 牌库已空，受到 ${p.fatigue} 点疲劳伤害`);
          this.damageHq(side, p.fatigue, null, true);
          if (this.done) return;
          continue;
        }
        const c = p.deck.shift();
        c.loc = 'hand';
        if (p.hand.length >= RULES.MAX_HAND) {
          c.loc = 'discard';
          p.discard.push(c);
          this.log(`P${side + 1} 手牌已满，${c.name} 被销毁`);
          continue;
        }
        p.hand.push(c);
        if (!silent) this.log(`P${side + 1} 抽到 ${c.name}`);
        if (!silent) this.ev({ e: 'draw', side, uid: c.uid, name: c.name });
      }
    }

    damageHq(side, amount, source, isFatigue) {
      if (amount <= 0) return;
      const p = this.players[side];
      p.hqDef -= amount;
      if (!isFatigue) p.hqDamagedThisTurn += amount;
      this.ev({ e: 'hqdamage', side, amount });
      this.log(`P${side + 1} 总部受到 ${amount} 点伤害，剩余 ${Math.max(0, p.hqDef)}`);
      if (p.hqDef <= 0) {
        p.hqDef = 0;
        this.done = true;
        this.winner = 1 - side;
        this.ev({ e: 'end', winner: this.winner });
        this.log(`═══ P${this.winner + 1} 获得胜利 ═══`);
      }
    }

    damageCard(c, amount, killer) {
      if (!c || amount <= 0) return;
      c.defense -= amount;
      this.ev({ e: 'damage', uid: c.uid, amount });
      this.log(`${c.name} 受到 ${amount} 点伤害，剩余 ${Math.max(0, c.defense)}`);
      if (c.defense <= 0) this.destroyCard(c, killer);
    }

    destroyCard(c, killer, inCombat) {
      if (c.loc === 'discard') return;
      const wasFront = c.loc === 'front';
      // destruction trigger effects
      const clauses = c._parsed || (c._parsed = parseClauses(c.text));
      for (const cl of clauses) {
        if (cl.kind !== 'destruction') continue;
        this.execOps(cl.ops, c, { killer });
      }
      if (wasFront) {
        this.frontline.splice(this.frontline.indexOf(c), 1);
        if (!this.frontline.length) this.frontlineOwner = -1;
      } else {
        const b = this.players[c.owner].board;
        b.splice(b.indexOf(c), 1);
      }
      c.loc = 'discard';
      c.slot = null;
      c.defense = c.defense; // keep damaged value
      this.players[c.owner].discard.push(c);
      this.ev({ e: 'death', uid: c.uid, name: c.name, owner: c.owner });
      this.log(`${c.name} 被摧毁`);
    }

    // ---------- deployment ----------
    hasRoomFor(c) {
      if (c.type === 'location') return this.supportCount(c.owner) < RULES.MAX_ROW;
      if (!c.isUnit) return true;
      if (this.canEnterFrontline(c.owner) && this.frontlineCount(c.owner) < RULES.MAX_ROW) return true;
      return this.supportCount(c.owner) < RULES.MAX_ROW;
    }

    playCard(side, handIndex, opts) {
      opts = opts || {};
      if (this.done || this.current !== side) return { ok: false, error: '还没到你的回合' };
      const p = this.players[side];
      const c = p.hand[handIndex];
      if (!c) return { ok: false, error: '找不到该卡牌' };
      if (c.cost > p.kredits) return { ok: false, error: '指挥点不足' };
      if (!this.hasRoomFor(c)) return { ok: false, error: '战场没有空位' };
      if (c.isUnit && opts.toFront === false && this.supportCount(c.owner) >= RULES.MAX_ROW) {
        if (!(this.canEnterFrontline(c.owner) && this.frontlineCount(c.owner) < RULES.MAX_ROW)) {
          return { ok: false, error: '支援阵线已满' };
        }
      }

      const fromLeftmost = handIndex === 0;
      const fromRightmost = handIndex === p.hand.length - 1;

      p.hand.splice(handIndex, 1);
      p.kredits -= c.cost;
      this.log(`P${side + 1} 使用 ${c.name}（-${c.cost} 指挥点）`);

      if (c.type === 'gotcha') {
        // activating a countermeasure: pay cost, stays in hand, hidden
        c.gotchaActive = this.nextGotchaOrder++;
        this.log(`P${side + 1} 激活了反制指令 ${c.name}`);
        return { ok: true, gotcha: true };
      }

      if (c.type === 'order') {
        p.ordersPlayedThisTurn++;
        c.loc = 'discard';
        p.discard.push(c);
        this.ev({ e: 'order', uid: c.uid, name: c.name, owner: side });
        const ctx = { fromLeftmost, fromRightmost, target: opts.target || null };
        this.execCardText(c, 'order', ctx);
        return { ok: true };
      }

      // unit / location deployment
      c.loc = 'board';
      c.summonedTurn = this.turn;
      c.attacksLeft = c.has('fury') ? 2 : 1;
      c.hasAttacked = !c.has('blitz');
      c.hasMoved = false;
      c.hasActed = false;
      c.chosenTarget = opts.target || null;

      // 默认自动选择阵线；玩家通过拖拽可指定（opts.toFront）
      const canFront = this.canEnterFrontline(c.owner) && this.frontlineCount(c.owner) < RULES.MAX_ROW;
      const toFront = c.isUnit && canFront && (opts.toFront === undefined ? true : !!opts.toFront);
      if (toFront) {
        c.loc = 'front';
        c.slot = (typeof opts.slot === 'number')
          ? Math.max(0, Math.min(this.frontline.length, opts.slot))
          : Math.ceil(this.frontline.length / 2);
        this.frontline.push(c);
        this.sortFrontline();
        this.packFrontline();
        if (this.frontlineOwner === -1) this.frontlineOwner = c.owner;
        this.log(`${c.name} 部署至前线（归属 P${this.frontlineOwner + 1}）`);
        this.ev({ e: 'deploy', uid: c.uid, name: c.name, front: true, owner: c.owner });
      } else {
        c.slot = this.claimSlot(p.board, opts.slot, RULES.MAX_ROW - 1);
        p.board.push(c);
        this.sortBoard(p.board);
        this.log(`${c.name} 部署至支援阵线`);
        this.ev({ e: 'deploy', uid: c.uid, name: c.name, front: false, owner: c.owner });
      }

      // deployment effects
      const ctx = { fromLeftmost, fromRightmost, target: opts.target || null };
      this.execCardText(c, 'deployment', ctx);
      this.execCardText(c, 'static', ctx);
      return { ok: true };
    }

    // ---------- movement ----------
    canMove(c, toFront) {
      if (!c.isUnit || c.owner !== this.current || this.done) return false;
      if (c.hasMoved) return false;
      if (!c.canOperate()) return false;
      if (c.hasAttacked && !(c.type === 'tank')) return false;
      if (toFront) {
        if (c.loc === 'front') return false;
        if (!this.canEnterFrontline(c.owner)) return false;
        if (this.frontlineCount(c.owner) >= RULES.MAX_ROW) return false;
      } else {
        if (c.loc !== 'front') return false;
        if (this.supportCount(c.owner) >= RULES.MAX_ROW) return false;
      }
      return true;
    }

    move(side, uid, toFront, slot) {
      if (this.done || this.current !== side) return { ok: false, error: '还没到你的回合' };
      const c = this.find(uid);
      if (!c) return { ok: false, error: '找不到该卡牌' };
      if (!this.canMove(c, toFront)) return { ok: false, error: '非法移动' };
      const p = this.players[side];
      if (p.kredits < c.opCost) return { ok: false, error: '指挥点不足' };
      p.kredits -= c.opCost;
      if (toFront) {
        p.board.splice(p.board.indexOf(c), 1);
        c.loc = 'front';
        c.slot = (typeof slot === 'number')
          ? Math.max(0, Math.min(this.frontline.length, slot))
          : Math.ceil(this.frontline.length / 2);
        this.frontline.push(c);
        this.sortFrontline();
        this.packFrontline();
        if (this.frontlineOwner === -1) this.frontlineOwner = c.owner;
        this.log(`${c.name} 移动至前线（-${c.opCost} 指挥点）`);
        this.ev({ e: 'move', uid: c.uid, to: 'front', owner: c.owner });
      } else {
        this.frontline.splice(this.frontline.indexOf(c), 1);
        if (!this.frontline.length) this.frontlineOwner = -1;
        c.loc = 'board';
        c.slot = this.claimSlot(p.board, slot, RULES.MAX_ROW - 1);
        p.board.push(c);
        this.sortBoard(p.board);
        this.log(`${c.name} 撤回支援阵线（-${c.opCost} 指挥点）`);
        this.ev({ e: 'move', uid: c.uid, to: 'support', owner: c.owner });
      }
      c.hasMoved = true;
      c.hasActed = true;
      return { ok: true };
    }

    // ---------- attack ----------
    attackTargets(attacker) {
      const out = [];
      const foe = 1 - attacker.owner;
      const enemyFront = this.frontline.filter(c => c.owner === foe);
      const pairOk = (t) => this.canAttackPair(attacker, t);
      if (enemyFront.length) {
        for (const t of enemyFront) if (pairOk(t)) out.push(t.uid);
        return out;
      }
      if (this.hqExposed(foe) || this.frontlineOwner === attacker.owner) {
        if (!this.hqIsGuarded(attacker.owner)) out.push(0); // 0 = enemy HQ
      }
      for (const t of this.players[foe].board) if (pairOk(t)) out.push(t.uid);
      return out;
    }

    canAttackPair(atk, def) {
      // smokescreen: cannot be attacked by units until it has acted
      if (def.has('smokescreen') && !def.hasActed) return false;
      // guard: adjacent units protected, except bombers & artillery
      if (def.has('guard') === false && this.isGuarded(def)) {
        if (!(atk.type === 'bomber' || atk.type === 'artillery')) return false;
      }
      // bomber cannot attack units in same row as an enemy fighter
      if (atk.type === 'bomber') {
        const row = def.loc === 'front' ? this.frontline : this.players[def.owner].board;
        const hasFighter = row.some(c => c.owner === def.owner && c.type === 'fighter');
        if (hasFighter) return false;
      }
      // range: support-line vs support-line needs range >= 2
      if (def.loc !== 'front' && atk.loc !== 'front' && atk.range < 2) return false;
      // ground units in support line cannot attack enemy support line without frontline
      // (handled by structural target list; frontline units can always attack)
      return true;
    }

    canAttack(c) {
      if (!c.isUnit || c.owner !== this.current || this.done) return false;
      if (c.attacksLeft <= 0) return false;
      if (!c.canOperate()) return false;
      if (c.hasMoved && c.type !== 'tank') return false;
      if (c.totalAttack <= 0) return false;
      return this.attackTargets(c).length > 0;
    }

    attack(side, uid, targetUid) {
      if (this.done || this.current !== side) return { ok: false, error: '还没到你的回合' };
      const atk = this.find(uid);
      if (!atk || !this.canAttack(atk)) return { ok: false, error: '非法攻击' };
      if (!this.attackTargets(atk).includes(targetUid)) return { ok: false, error: '非法目标' };
      const p = this.players[side];
      if (p.kredits < atk.opCost) return { ok: false, error: '指挥点不足' };
      p.kredits -= atk.opCost;
      atk.hasAttacked = true;
      atk.attacksLeft -= 1;
      atk.hasActed = true;

      if (targetUid === 0) {
        this.log(`${atk.name}（攻击 ${atk.totalAttack}）攻击敌方总部（-${atk.opCost} 指挥点）`);
        this.ev({ e: 'attack', from: atk.uid, to: 0, owner: atk.owner });
        this.damageHq(1 - side, atk.totalAttack, atk);
        this.ev({ e: 'hqdamage', side: 1 - side, amount: atk.totalAttack });
        return { ok: true };
      }
      const def = this.find(targetUid);
      if (!def || def.loc === 'discard') return { ok: true };
      this.ev({ e: 'attack', from: atk.uid, to: def.uid, owner: atk.owner });

      const ambush = def.has('ambush');
      const shock = atk.has('shock');

      this.log(`${atk.name}（攻击 ${atk.totalAttack}）攻击 ${def.name}（防御 ${def.totalDefense}）（-${atk.opCost} 指挥点）`);
      const dmg = (a, d) => Math.max(0, a.totalAttack - d.heavyArmor);
      if (ambush || shock) {
        // Ambush: defender strikes first. Shock: attacker strikes first.
        if (ambush) {
          const d1 = dmg(def, atk);
          if (d1 > 0) atk.defense -= d1;
          this.log(`${def.name}（伏击）先手造成 ${d1} 点伤害`);
          if (atk.defense <= 0) { this.destroyCard(atk, def, true); return { ok: true }; }
          const d2 = dmg(atk, def);
          if (d2 > 0) def.defense -= d2;
          if (def.defense <= 0) this.destroyCard(def, atk, true);
        } else {
          const d1 = dmg(atk, def);
          if (d1 > 0) def.defense -= d1;
          this.log(`${atk.name}（冲击）先手造成 ${d1} 点伤害`);
          if (def.defense <= 0) { this.destroyCard(def, atk, true); return { ok: true }; }
          // retaliation
          let canFightBack = true;
          if (atk.type === 'artillery') canFightBack = false;
          if (atk.type === 'bomber' && !(def.type === 'fighter' || def.type === 'artillery')) canFightBack = false;
          if (canFightBack) {
            const d2 = dmg(def, atk);
            if (d2 > 0) atk.defense -= d2;
            if (atk.defense <= 0) this.destroyCard(atk, def, true);
          }
        }
        return { ok: true };
      }
      const dToDef = dmg(atk, def);
      let dToAtk = 0;
      // retaliation rules
      let canFightBack = true;
      if (atk.type === 'artillery') canFightBack = false;
      if (atk.type === 'bomber' && !(def.type === 'fighter' || def.type === 'artillery')) canFightBack = false;
      if (canFightBack) dToAtk = Math.max(0, def.totalAttack - atk.heavyArmor);
      if (dToDef > 0) def.defense -= dToDef;
      if (dToAtk > 0) atk.defense -= dToAtk;
      this.log(`${def.name} 受到 ${dToDef} 点伤害，${atk.name} 受到 ${dToAtk} 点反击伤害`);
      const defDies = def.defense <= 0;
      const atkDies = atk.defense <= 0;
      if (defDies) this.destroyCard(def, atk, true);
      if (atkDies) this.destroyCard(atk, def, true);
      return { ok: true };
    }

    find(uid) {
      for (const c of this.allBoard()) if (c.uid === uid) return c;
      return null;
    }

    // ---------- card text execution ----------
    execCardText(c, kind, ctx) {
      const clauses = c._parsed || (c._parsed = parseClauses(c.text));
      for (const cl of clauses) {
        if (cl.kind !== kind) continue;
        if (!evalCond(cl.cond, this, c, ctx)) continue;
        this.execOps(cl.ops, c, ctx);
      }
      // also run trigger clauses that are immediate (self effects like "After this unit attacks")
    }

    execOps(ops, src, ctx) {
      for (const op of ops) this.execOp(op, src, ctx || {});
    }

    execOp(op, src, ctx) {
      const me = src.owner;
      const foe = 1 - me;
      const pickUnit = (target) => {
        switch (target) {
          case 'unit': {
            const foeUnits = this.unitsOf(foe).filter(u => u.uid !== src.uid);
            if (foeUnits.length) return foeUnits[0];
            const myUnits = this.unitsOf(me).filter(u => u.uid !== src.uid);
            return myUnits[0] || null;
          }
          case 'enemyUnit': {
            const t = this.find(ctx.target);
            if (t && t.owner === foe && t.uid !== src.uid) return t;
            const foeUnits = this.unitsOf(foe).filter(u => u.uid !== src.uid);
            return foeUnits[0] || null;
          }
          case 'friendlyUnit': {
            const t = this.find(ctx.target);
            if (t && t.owner === me && t.uid !== src.uid) return t;
            const myUnits = this.unitsOf(me).filter(u => u.uid !== src.uid);
            return myUnits[0] || null;
          }
          case 'randomEnemy': { const l = this.unitsOf(foe).filter(u => u.uid !== src.uid); return l.length ? this.rng.pick(l) : null; }
          case 'randomFriendly': { const l = this.unitsOf(me).filter(u => u.uid !== src.uid); return l.length ? this.rng.pick(l) : null; }
          default: return null;
        }
      };
      switch (op.op) {
        case 'damage': {
          const apply = (t, n) => { if (t) this.damageCard(t, n, src); };
          if (op.target === 'enemyHQ') { this.damageHq(foe, typeof op.n === 'number' ? op.n : src.totalAttack, src); break; }
          if (op.target === 'ownHQ') { this.players[me].hqDef = Math.min(this.players[me].hqMaxDef, this.players[me].hqDef + op.n); break; }
          if (op.target === 'allEnemies' || op.target === 'allEnemyUnits') { for (const u of [...this.unitsOf(foe)]) apply(u, op.n); break; }
          if (op.target === 'allEnemyAir') { for (const u of this.unitsOf(foe).filter(u => u.type === 'fighter' || u.type === 'bomber')) apply(u, op.n); break; }
          if (op.target === 'allFriendly' || op.target === 'allFriendlyUnits') { for (const u of [...this.unitsOf(me)]) apply(u, op.n); break; }
          if (op.target === 'randomEnemy') { const t = this.unitsOf(foe); if (t.length) apply(this.rng.pick(t), op.n); break; }
          const t = pickUnit(op.target);
          if (t) apply(t, op.n); else this.log(`（没有合法伤害目标）`);
          break;
        }
        case 'draw': this.draw(me, op.n); break;
        case 'slots': {
          const p = this.players[me];
          p.slots = Math.min(RULES.MAX_SLOTS, p.slots + op.n);
          p.kredits = Math.min(RULES.MAX_SLOTS, p.kredits + op.n);
          this.log(`指挥点上限 +${op.n}`);
          break;
        }
        case 'kredits': {
          const p = this.players[me];
          p.kredits = Math.min(RULES.MAX_SLOTS, p.kredits + op.n);
          this.log(`获得 ${op.n} 点指挥点`);
          break;
        }
        case 'hqDef': {
          const p = this.players[me];
          p.hqDef = Math.min(p.hqMaxDef, p.hqDef + op.n);
          this.log(`我方总部防御 +${op.n}`);
          break;
        }
        case 'buff': {
          const apply = (u) => { u.buffAttack += op.a; u.buffDefense += op.d; };
          if (op.target === 'allFriendlyUnits') { for (const u of [...this.unitsOf(me)]) apply(u); this.log(`我方所有单位 +${op.a}/+${op.d}`); }
          else if (op.target === 'allEnemyUnits') { for (const u of [...this.unitsOf(foe)]) apply(u); }
          else {
            let t = pickUnit(op.target);
            if (op.self && src.isUnit) t = src;
            if (t) { apply(t); this.log(`${t.name} 获得 +${op.a}/+${op.d}`); }
          }
          break;
        }
        case 'keyword': {
          let t = pickUnit(op.target);
          if (op.self && src.isUnit) t = src;
          if (t) { for (const k of op.kws) t.keywords.add(k); this.log(`${t.name} 获得关键词：${op.kws.join('/')}`); }
          break;
        }
        case 'retreat': {
          let t = pickUnit(op.target);
          if (!t) break;
          if (t.loc === 'front') {
            if (this.supportCount(t.owner) < RULES.MAX_ROW) {
              this.frontline.splice(this.frontline.indexOf(t), 1);
              if (!this.frontline.length) this.frontlineOwner = -1;
              t.loc = 'board';
              this.players[t.owner].board.push(t);
              this.log(`${t.name} 撤退`);
            } else this.log(`  ${t.name} cannot retreat (support full)`);
          }
          break;
        }
        case 'pin': {
          const list = op.target === 'allEnemyUnits' ? this.unitsOf(foe) : [pickUnit('enemyUnit')].filter(Boolean);
          for (const u of list) { u._pinned = true; }
          this.log(`压制了 ${list.length} 个单位`);
          break;
        }
        case 'destroy': {
          if (op.target === 'allEnemyUnits') { for (const u of [...this.unitsOf(foe)]) this.destroyCard(u, src); break; }
          const t = pickUnit('enemyUnit');
          if (t) { this.destroyCard(t, src); this.log(`${t.name} 被效果摧毁`); }
          break;
        }
        case 'return': {
          if (op.target === 'allEnemyUnits') { for (const u of [...this.unitsOf(foe)]) this.returnCard(u, op.toDeck); break; }
          const t = pickUnit('enemyUnit');
          if (t) this.returnCard(t, op.toDeck);
          break;
        }
        case 'spawn':
        case 'addHand':
        case 'addDeck': {
          const defs = this.findByName(op.name, me);
          let def = null;
          if (op.random && defs.length) def = this.rng.pick(defs);
          else if (defs.length) def = defs[0];
          if (!def) { this.log(`（未找到可生成的卡牌：${op.name}）`); break; }
          const c = new CardInst(def, me, this);
          if (op.op === 'addHand') {
            c.loc = 'hand';
            if (this.players[me].hand.length < RULES.MAX_HAND) this.players[me].hand.push(c);
            else this.players[me].discard.push(c);
            this.log(`${c.name} 加入手牌`);
          } else if (op.op === 'addDeck') {
            c.loc = 'deck';
            this.players[me].deck.push(c);
            this.rng.shuffle(this.players[me].deck);
            this.log(`${c.name} 洗入牌库`);
          } else {
            c.summonedTurn = this.turn;
            c.hasAttacked = !c.has('blitz');
            if (op.loc === 'front' && this.canEnterFrontline(me) && this.frontlineCount(me) < RULES.MAX_ROW) {
              c.loc = 'front';
              this.frontline.push(c);
              if (this.frontlineOwner === -1) this.frontlineOwner = me;
            } else if (op.loc === 'hand') {
              c.loc = 'hand';
              this.players[me].hand.push(c);
            } else {
              c.loc = 'board';
              this.players[me].board.push(c);
            }
            this.log(`${c.name} 被效果部署上场`);
          }
          break;
        }
        case 'copyToHand': {
          const p = this.players[me];
          if (p.hand.length < RULES.MAX_HAND) {
            const c = new CardInst(src.def, me, this);
            c.loc = 'hand';
            p.hand.push(c);
            this.log(`${src.name} 的复制加入手牌`);
          }
          break;
        }
        case 'veteran': {
          const vetId = src.id.replace(/_?vet.*$/, '') + '_vet';
          // try data veteran id patterns
          const cands = [src.id + '_vet', src.id.replace(/_vet$/, '') + '_vet'];
          for (const id of cands) {
            const def = this.db.byId[id];
            if (def && def.nation === src.nation) {
              const keep = { uid: src.uid, owner: src.owner, loc: src.loc };
              const nc = new CardInst(def, src.owner, this);
              nc.uid = keep.uid; nc.loc = keep.loc;
              nc.summonedTurn = src.summonedTurn;
              nc.hasAttacked = src.hasAttacked; nc.hasMoved = src.hasMoved; nc.hasActed = src.hasActed;
              if (nc.loc === 'front') { const i = this.frontline.indexOf(src); if (i >= 0) { nc.slot = src.slot; this.frontline[i] = nc; } }
              else { const b = this.players[src.owner].board; const i = b.indexOf(src); if (i >= 0) b[i] = nc; }
              this.log(`${src.name} 晋升为老兵（${nc.name}）`);
              break;
            }
          }
          break;
        }
        case 'choose': {
          // auto-pick first option for AI/simplicity; UI handles real choice
          if (op.options && op.options.length) this.execOps(op.options[0], src, ctx);
          break;
        }
        case 'forecast': {
          const deck = this.players[me].deck;
          if (deck.length) this.log(`预见：牌库顶为 ${deck[0].name}`);
          break;
        }
        case 'enemyHandCost': {
          for (const c of this.players[foe].hand) c._costMod = (c._costMod || 0) + op.n;
          this.log(`敌方手牌费用 +${op.n}`);
          break;
        }
        case 'ownHandOrderCost': {
          for (const c of this.players[me].hand) if (c.type === 'order') c._costMod = (c._costMod || 0) - op.n;
          this.log(`我方指令费用 -${op.n}`);
          break;
        }
        default: break;
      }
    }

    returnCard(c, toDeck) {
      if (c.loc === 'front') {
        this.frontline.splice(this.frontline.indexOf(c), 1);
        if (!this.frontline.length) this.frontlineOwner = -1;
      } else {
        const b = this.players[c.owner].board;
        b.splice(b.indexOf(c), 1);
      }
      if (toDeck) {
        c.loc = 'deck';
        this.players[c.owner].deck.push(c);
        this.log(`${c.name} 被洗回牌库`);
      } else {
        c.loc = 'hand';
        if (this.players[c.owner].hand.length < RULES.MAX_HAND) this.players[c.owner].hand.push(c);
        else this.players[c.owner].discard.push(c);
        this.log(`${c.name} 回到手牌`);
      }
    }

    findByName(name, side) {
      const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const target = norm(name);
      const out = [];
      for (const def of this.db.cards) {
        if (norm(def.name) === target) {
          if (def.nation === side || def.nation === 'Neutral' || this.db.nationOf[def.nation] === undefined) out.push(def);
        }
      }
      // fallback: any nation
      if (!out.length) {
        for (const def of this.db.cards) if (norm(def.name) === target) out.push(def);
      }
      return out;
    }

    // ---------- order target selection ----------
    playTargetsFor(c) {
      const clauses = c._parsed || (c._parsed = parseClauses(c.text));
      let side = null;
      for (const cl of clauses) {
        for (const op of cl.ops) {
          if (['damage', 'destroy', 'retreat', 'pin', 'return'].includes(op.op)) {
            if (op.target === 'unit' || op.target === 'enemyUnit') { side = 'enemy'; break; }
            if (op.target === 'friendlyUnit') { side = 'own'; break; }
          }
          if (op.op === 'buff' || op.op === 'keyword') {
            if (op.target === 'friendlyUnit') { side = 'own'; break; }
            if (op.target === 'enemyUnit') { side = 'enemy'; break; }
          }
        }
        if (side) break;
      }
      if (side === 'enemy') return this.unitsOf(1 - c.owner).map(u => u.uid);
      if (side === 'own') return this.unitsOf(c.owner).filter(u => u.uid !== c.uid).map(u => u.uid);
      return [];
    }

    // ---------- views ----------
    viewFor(side) {
      const cardView = (c, withTargets) => {
        const v = c.serialize();
        v.image = c.def.image;
        if (withTargets && c.type === 'order') v.targets = this.playTargetsFor(c);
        return v;
      };
      return {
        turn: this.turn,
        current: this.current,
        done: this.done,
        winner: this.winner,
        frontlineOwner: this.frontlineOwner,
        you: side,
        players: [0, 1].map(i => ({
          hq: this.players[i].hq,
          hqDef: this.players[i].hqDef,
          hqMaxDef: this.players[i].hqMaxDef,
          kredits: this.players[i].kredits,
          slots: this.players[i].slots,
          fatigue: this.players[i].fatigue,
          hand: this.players[i].hand.map(c => cardView(c, i === side)),
          handCount: this.players[i].hand.length,
          deckCount: this.players[i].deck.length,
          board: this.players[i].board.map(c => cardView(c, false)),
          discardCount: this.players[i].discard.length,
        })),
        frontline: this.frontline.map(c => cardView(c, false)),
        log: this.logLines.slice(-60),
      };
    }
  }

  // ================= Deck codes =================
  function parseDeckCode(code, table, db) {
    // returns {main, ally, cards:[ids], hq}
    if (!code || !code.startsWith('%%')) return null;
    const parts = code.slice(2).split('|');
    if (parts.length < 2) return null;
    const main = NATION_CODE[parts[0][0]];
    const ally = NATION_CODE[parts[0][1]];
    if (!main || !ally) return null;
    let body = parts[1];
    const tilde = body.indexOf('~');
    if (tilde >= 0) body = body.slice(0, tilde);
    let groups = body.split(';');
    let hqCode = null;
    if (parts.length >= 3 && parts[2].length >= 2) hqCode = parts[2].slice(0, 2);
    else if (DEFAULT_HQ_CODE[main]) {
      hqCode = DEFAULT_HQ_CODE[main];
      if (groups.length && groups[0].startsWith(hqCode)) groups[0] = groups[0].slice(hqCode.length);
    }
    const cards = [];
    for (let g = 0; g < Math.min(groups.length, 4); g++) {
      const copies = g + 1;
      const s = groups[g];
      for (let j = 0; j + 1 < s.length; j += 2) {
        const codeId = s.substr(j, 2);
        const cands = table[codeId];
        if (!cands) continue;
        const present = (Array.isArray(cands) ? cands : [cands]).filter(id => db.byId[id]);
        let id = present.find(id => {
          const f = db.byId[id].nation;
          return f === main || f === ally || f === 'Neutral';
        });
        if (!id) id = present[0];
        if (!id) continue;
        for (let n = 0; n < copies; n++) cards.push(id);
      }
    }
    return { main, ally, cards, hq: hqCode };
  }

  function buildDb(cardsJson, hqsJson) {
    const byId = {};
    const cards = cardsJson;
    for (const c of cards) byId[c.id] = c;
    const hqs = {};
    for (const h of hqsJson) hqs[h.nation] = h;
    const nationOf = {};
    return { byId, cards, hqs, nationOf };
  }

  // Auto-build a simple deck for a nation (39 cards, curve based).
  function autoDeck(nation, db, rng) {
    rng = rng || makeRng(Date.now() % 2147483647);
    const pool = db.cards.filter(c =>
      (c.nation === nation || c.nation === 'Neutral') &&
      c.type !== 'gotcha' && c.type !== 'location' && c.cost > 0 && c.cost <= 7);
    const units = pool.filter(c => ['infantry', 'tank', 'artillery', 'fighter', 'bomber'].includes(c.type));
    const orders = pool.filter(c => c.type === 'order');
    const maxCopies = { Common: 4, Uncommon: 3, Rare: 2, Unique: 1 };
    const counts = {};
    const add = (c) => {
      const max = maxCopies[c.rarity] || 2;
      if ((counts[c.id] || 0) >= max) return false;
      counts[c.id] = (counts[c.id] || 0) + 1;
      return true;
    };
    const deck = [];
    // curve: more low-cost cards
    const costWeights = { 1: 6, 2: 7, 3: 7, 4: 6, 5: 4, 6: 3, 7: 2 };
    const pickByCost = (list) => {
      const total = Object.values(costWeights).reduce((a, b) => a + b, 0);
      let r = rng.next() * total;
      let cost = 1;
      for (const k of Object.keys(costWeights)) { r -= costWeights[k]; if (r <= 0) { cost = +k; break; } }
      const cands = list.filter(c => c.cost === cost);
      if (!cands.length) return null;
      return rng.pick(cands);
    };
    // 28 units
    for (let i = 0; i < 28; i++) {
      for (let t = 0; t < 12; t++) {
        const c = pickByCost(units);
        if (c && add(c)) { deck.push(c.id); break; }
      }
    }
    // 11 orders
    for (let i = 0; i < 11; i++) {
      for (let t = 0; t < 12; t++) {
        const c = pickByCost(orders);
        if (c && add(c)) { deck.push(c.id); break; }
      }
    }
    return deck.slice(0, RULES.DECK_SIZE);
  }

  return {
    RULES, NATION_CODE, DEFAULT_HQ_CODE,
    Game, CardInst, makeRng, parseClauses, parseDeckCode, buildDb, autoDeck,
  };
});
