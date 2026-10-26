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
    get totalAttack() {
      if (this._useDefenseAsAttack) return this.totalDefense;
      return Math.max(0, this.attack + this.buffAttack);
    }
    get totalDefense() { return this.defense + this.buffDefense; }
    /** 实际行动费用：支持临时设定（_opCostSet）与增减（_opCostMod） */
    get effOpCost() {
      if (this._opCostSet != null) return Math.max(0, this._opCostSet);
      return Math.max(0, (this.opCost || 0) + (this._opCostMod || 0));
    }
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
        cost: this.cost, opCost: this.effOpCost, range: this.range, text: this.text,
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

  /**
   * 把 "your british units"、"a unit with guard"、"all other friendly units" 这类
   * 目标短语解析成 { target, filters }。filters 供 execOp 进一步筛选：
   * type / nation / keyword / ground / air / other / frontline / damaged / minAttack / maxCost。
   */
  function describeTarget(who, sentence) {
    // target 只由目标短语本身决定；修饰条件（in the frontline / with Guard 等）
    // 从整句提取，避免被句子里其它成分（如 "your air units"）带偏。
    const w = (who || '').toLowerCase();
    const s = ((who || '') + ' ' + (sentence || '')).toLowerCase();
    const f = {};
    let target = 'unit';
    const pluralUnits = /(?:your|friendly|enemy|all )?[a-z' \-]*(?:units|tanks|fighters|bombers|artillery)\b/.test(w)
      && !/\bunit\b/.test(w);
    if (/all (?:other )?(?:friendly|your)/.test(w) || pluralUnits || /(?:your|all) units\b/.test(w)) target = 'allFriendlyUnits';
    else if (/all enem/.test(w)) target = 'allEnemyUnits';
    else if (/all units|every unit/.test(w)) target = 'allUnits';
    else if (/random friendly/.test(w)) target = 'randomFriendly';
    else if (/another friendly|another target/.test(w)) { target = 'friendlyUnit'; f.other = true; }
    else if (/friendly|your/.test(w)) target = 'friendlyUnit';
    else if (/enemy/.test(w)) target = 'enemyUnit';

    if (/\bin the frontline\b/.test(s)) f.frontline = true;
    if (/\bground\b/.test(s)) f.ground = true;
    if (/\bair\b/.test(s)) f.air = true;
    if (/\bguard\b/.test(s)) f.kw = 'guard';
    if (/\bcovert\b/.test(s)) f.kw = f.kw || 'covert';
    if (/\bcommando\b/.test(s)) f.kw = f.kw || 'commando';
    if (/\balpine\b/.test(s)) f.kw = f.kw || 'alpine';
    if (/\bexile\b/.test(s)) f.kw = f.kw || 'exile';
    if (/\blight infantry\b/.test(s)) f.nameTag = 'light infantry';
    if (/\bnavy\b/.test(s)) f.navy = true;
    const nationMap = { British: 'Britain', German: 'Germany', Soviet: 'Soviet', Japanese: 'Japan',
      US: 'USA', French: 'France', Polish: 'Poland', Finnish: 'Finland', Italian: 'Italy', Anzac: 'Anzac' };
    for (const n of Object.keys(nationMap)) {
      if (new RegExp('\\b' + n + '\\b', 'i').test(s)) { f.nation = nationMap[n]; break; }
    }
    for (const ty of ['infantry', 'tank', 'artillery', 'fighter', 'bomber']) {
      if (new RegExp('\\b' + ty + 's?\\b').test(s)) { f.type = ty; break; }
    }
    const ma = /\b(\d+) or more attack\b/.exec(s);
    if (ma) f.minAttack = +ma[1];
    const mc = /\bcost (\d+) or less\b/.exec(s);
    if (mc) f.maxCost = +mc[1];
    if (/\b0 operation cost\b/.test(s)) f.maxOpCost = 0;
    if (/damaged/.test(s)) f.damaged = true;
    return { target, filters: Object.keys(f).length ? f : null };
  }

  function parseOps(s) {
    const ops = [];
    const t = String(s || '').replace(/[\u2019\u2018]/g, "'").trim();

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

    // "Your HQ gets/gains +N defense" / "Give your HQ +N defense" —— 均为永久提升
    m = /(?:your hq (?:gets|gains)|give your hq|your hq has) \+?(\d+) defense/i.exec(t);
    if (m) { ops.push({ op: 'hqDef', n: +m[1] }); return ops; }
    // 明确句式才算 HQ 加成："Your HQ gets +A+D" / "Give your HQ +A+D"
    // （旧兜底只要文本含 "your hq" 和一个 "+N" 就整句当 HQ 加成，
    //   会把 "Gets +1+2 if your HQ has defense over 20" 这类条件自我加成误判）
    m = /(?:your hq (?:gets|gains)|give your hq) \+(\d+)\+(\d+)/i.exec(t);
    if (m) { ops.push({ op: 'hqBuff', a: +m[1], d: +m[2] }); return ops; }

    // "Give [target] +X+Y" / "Gets +X+Y" / "Your units get +X+Y" / "Give your British units +2 defense"
    // 目标短语交给 describeTarget 一次性解析（含 with Guard / in the frontline / 国家名等修饰）。
    m = /(?:give|gives|gets|get|gaining|receive|receives|has|have) (?:a |an |the |target |random |all |another )?(friendly |enemy |random friendly |random enemy |your )?([a-z0-9 \-']{0,38}?) ?([+-]?\d+)[+\-]([+-]?\d+)/i.exec(t);
    if (m) {
      const who = ((m[1] || '') + ' ' + (m[2] || '')).toLowerCase();
      const f = describeTarget(who, t);
      ops.push({ op: 'buff', a: +m[3], d: +m[4], target: f.target, filters: f.filters,
                 temp: /until (?:the )?end of turn|this turn|until your next turn/i.test(t),
                 self: /^gets|^has/i.test(t.trim()) });
      return ops;
    }

    // "Your units get +X+Y"（被通用 buff 模式覆盖，含 all/other/类型过滤）

    // "Give [a unit] Blitz / Guard / Fury ..."
    // "Give [target] Blitz / Guard / Fury ..."
    //
    // 关键词必须写进正则本身，不能用「先抓一堆小写词、再回头测关键词」的两段式写法。
    // 旧写法 `((?:[a-z]+ ?)+)$` 是嵌套量词（量词里套量词），在 "Give a random friendly
    // unit on the battlefield and in hand +2+1." 这类文本上会指数级回溯 —— 单条正则
    // 就能把 CPU 打满、整局游戏永久卡死（THE DOUBLE SUNRISE / SORTIE / BOLSTER THE
    // RANKS / OVERWHELMING FORCE 四张卡必中）。
    // 改成关键词白名单后：匹配是线性的，且语义更准 —— 不会再把
    // "Give ... on the battlefield and in hand" 误当成关键词指令。
    m = /give (?:a |an |the |target |random |another )?(friendly |enemy )?[a-z \-']{0,30}?(blitz|guard|fury|smokescreen|ambush|shock|mobilize|alpine|pincer|covert|scrying)\b/i.exec(t);
    if (m) {
      const kws = ['blitz', 'guard', 'fury', 'smokescreen', 'ambush', 'shock', 'mobilize', 'alpine', 'pincer', 'covert', 'scrying']
        .filter(k => new RegExp('\\b' + k + '\\b', 'i').test(t));
      let tgt = 'unit';
      if (/random friendly/.test(t)) tgt = 'randomFriendly';
      else if (/friendly/.test(t)) tgt = 'friendlyUnit';
      ops.push({ op: 'keyword', kws, target: tgt, temp: /this turn/i.test(t) });
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

    // ================= 扩展模式（效果覆盖率 90% 计划，见 AI-PROMPT.md 第四节） =================

    // --- 条件自我加成："+1+1 if you control a tank or infantry" ---
    m = /\b(?:gets?|gains?) \+?(\d+) (attack|defense)(?: and (blitz|guard|fury|smokescreen|ambush|shock))? if (?:you|the enemy) (?:control|controls)/i.exec(t);
    if (m) {
      // 官方是条件加成；本引擎无持续重算，简化为进场一次性生效
      ops.push({ op: 'buff', a: m[2] === 'attack' ? +m[1] : 0, d: m[2] === 'defense' ? +m[1] : 0,
                 target: 'self', approx: 'condition ignored' });
      if (m[3]) ops.push({ op: 'keyword', kws: [m[3]], target: 'self' });
      return ops;
    }
    m = /\b(?:gets?|gains?) (blitz|guard|fury|smokescreen|ambush|shock) if\b/i.exec(t);
    if (m) { ops.push({ op: 'keyword', kws: [m[1]], target: 'self' }); return ops; }
    m = /\b(?:gets?|gains?) \+?(\d+) attack and (blitz|guard|fury|ambush|shock)\b/i.exec(t);
    if (m) {
      ops.push({ op: 'buff', a: +m[1], d: 0, target: 'self' });
      ops.push({ op: 'keyword', kws: [m[2]], target: 'self' });
      return ops;
    }
    m = /(\d+)\+(\d+) if (?:you|the enemy) (?:control|controls)/i.exec(t);
    if (m) {
      // 官方是条件加成；本引擎无持续重算，简化为进场一次性生效
      ops.push({ op: 'buff', a: +m[1], d: +m[2], target: 'self', approx: 'condition ignored' });
      return ops;
    }

    // "Give a random friendly unit on the battlefield and in hand +2+1."（官方原文，避免宽松正则）
    m = /\bgive a random friendly unit(?: on the battlefield and in hand)? \+(\d+)\+(\d+)/i.exec(t);
    if (m) { ops.push({ op: 'buff', a: +m[1], d: +m[2], target: 'randomFriendly' }); return ops; }

    // --- 单数值 buff：+N attack / +N defense（含负值） ---
    m = /(?:give|gives|gets|get|gaining|receive|receives|has|have) (?:a |an |the |target |random |all |another )?(friendly |enemy |random friendly |random enemy |your )?([a-z \-']{0,28}?) ?\+?([+-]?\d+) (attack|defense)/i.exec(t);
    if (m && !/\bfor each\b/i.test(t)) {
      const who = ((m[1] || '') + ' ' + (m[2] || '')).toLowerCase();
      const f = describeTarget(who, t);
      const a = m[4] === 'attack' ? +m[3] : 0;
      const d = m[4] === 'defense' ? +m[3] : 0;
      ops.push({ op: 'buff', a, d, target: f.target, filters: f.filters,
                 temp: /until (?:the )?end of turn|this turn|until your next turn/i.test(t),
                 self: /^gets|^has/i.test(t.trim()) });
      return ops;
    }

    // --- "for each ..." 按数量加成 ---
    m = /(?:gets?|gains?|gaining|receives?|has|have) \+?(\d+) (attack|defense) for each ([a-z0-9 \-']{1,50})/i.exec(t);
    if (m) {
      ops.push({ op: 'buffPer', a: m[2] === 'attack' ? +m[1] : 0, d: m[2] === 'defense' ? +m[1] : 0,
                 count: describeCount(m[3]), self: true, target: 'self' });
      return ops;
    }
    m = /(?:your|friendly|all) units? get \+?(\d+) (attack|defense) for each ([a-z0-9 \-']{1,50})/i.exec(t);
    if (m) {
      ops.push({ op: 'buffPer', a: m[2] === 'attack' ? +m[1] : 0, d: m[2] === 'defense' ? +m[1] : 0,
                 count: describeCount(m[3]), target: 'allFriendlyUnits' });
      return ops;
    }

    // --- 抽牌变体 ---
    m = /\bdraw (?:a|an|one|two|three|\d+) random ([a-z \-']{1,40}?) from your deck/i.exec(t);
    if (m) {
      const n = /two/i.test(m[0]) ? 2 : /three/i.test(m[0]) ? 3 : 1;
      ops.push({ op: 'drawFilter', n, kw: m[1].trim() });
      return ops;
    }
    m = /\bdraw (?:the )?(?:top|highest cost) (?:non-[a-z]+ |[a-z]+ ){0,2}card of your deck/i.exec(t)
      || /\bdraw the (?:highest cost|top) (?:non-[a-z]+ )?card in your deck/i.exec(t);
    if (m) { ops.push({ op: 'drawFilter', n: 1, kw: '' }); return ops; }
    m = /\bdraw a card for each ([a-z0-9 \-']{1,50})/i.exec(t)
      || /\bdraw cards? equal to (?:the number of )?([a-z0-9 \-']{1,50})/i.exec(t);
    if (m) { ops.push({ op: 'drawPer', count: describeCount(m[1]) }); return ops; }
    m = /\bboth players draw until they have (\d+) cards?/i.exec(t)
      || /\bplayers? shuffle (?:their|the) hand into (?:their|the) deck, then draw/i.exec(t);
    if (m) { ops.push({ op: 'drawTo', n: m[1] ? +m[1] : 4, both: true, reshuffle: !m[1] }); return ops; }
    m = /\bdraw cards? until you have as many cards? in your hand as the enemy/i.exec(t);
    if (m) { ops.push({ op: 'drawTo', n: 0, toEnemy: true }); return ops; }
    // --- 伤害：数值由场面计算 ---
    m = /\bdeal damage to (?:a |an |the |target |each |all )?([a-z \-']{1,34}?) equal to (?:the total attack of |the number of )?(all units|your air units|friendly air units|other friendly air units|cards? in the enemy hand|known cards? in the enemy hand|kredits? spent(?: operating)?(?: this turn)?|(?:your|the) (?:german )?tanks? in the frontline|1 plus the number of bombers you control|1 plus the number of unit types you control|polish units destroyed this battle|damage to your hq this turn|number of units you control)/i.exec(t);
    if (m) {
      const who = m[1];
      const f = describeTarget(who, t);
      const calcMap = {
        'all units': 'ownUnitCount', 'your air units': 'airAttackSum',
        'friendly air units': 'airAttackSum', 'other friendly air units': 'airAttackSum',
        'cards in the enemy hand': 'enemyHandSize', 'known cards in the enemy hand': 'enemyHandSize',
        'known cards in the enemy hand ': 'enemyHandSize',
        'kredits spent operating this turn': 'kreditsSpent', 'kredits spent operating': 'kreditsSpent',
        'kredits spent': 'kreditsSpent',
        'the german tanks in the frontline': 'germanTankCost',
        'your german tanks in the frontline': 'germanTankCost',
        'tanks in the frontline': 'germanTankCost',
        '1 plus the number of bombers you control': 'bombersPlus1',
        '1 plus the number of unit types you control': 'typesPlus1',
        'polish units destroyed this battle': 'polandDestroyed',
        'damage to your hq this turn': 'hqDamageThisTurn',
        'number of units you control': 'ownUnitCount',
      };
      let calc = calcMap[m[2].replace(/\s+/g, ' ').trim()] || calcMap[m[2].toLowerCase().replace(/\s+/g, ' ').trim()];
      if (!calc) {
        const k = m[2].toLowerCase();
        if (/air/.test(k)) calc = 'airAttackSum';
        else if (/enemy hand/.test(k)) calc = 'enemyHandSize';
        else if (/kredits? spent/.test(k)) calc = 'kreditsSpent';
        else if (/bombers/.test(k)) calc = 'bombersPlus1';
        else if (/unit types/.test(k)) calc = 'typesPlus1';
        else if (/units destroyed/.test(k)) calc = 'polandDestroyed';
        else if (/hq this turn/.test(k)) calc = 'hqDamageThisTurn';
        else if (/tanks/.test(k)) calc = 'germanTankCost';
        else calc = 'ownUnitCount';
      }
      ops.push({ op: 'damage', n: calc, target: f.target === 'unit' ? 'unit' : f.target, filters: f.filters, calc });
      return ops;
    }
    m = /\bdeal (\d+) damage to (?:a |an |the |target |each )?([a-z \-']{1,30}?) for each unit with (\d+) or more attack you control/i.exec(t);
    if (m) {
      const f = describeTarget(m[2], t);
      ops.push({ op: 'damage', n: +m[1], target: f.target === 'unit' ? 'unit' : f.target, filters: f.filters, calc: 'perBigUnit', per: +m[3] });
      return ops;
    }
    m = /\bdeal (\d+) damage to (?:a |an |the |target )?([a-z \-']{1,30}?) and (\d+) damage to adjacent/i.exec(t);
    if (m) {
      const f = describeTarget(m[2], t);
      ops.push({ op: 'damage', n: +m[1], target: f.target === 'unit' ? 'unit' : f.target, filters: f.filters });
      ops.push({ op: 'damage', n: +m[3], target: 'allEnemyUnits', adjacent: true });
      return ops;
    }
    m = /\ball units? deal (\d+) combat damage/i.exec(t);
    if (m) { ops.push({ op: 'buff', a: 0, d: 0, target: 'allUnits', tempDamage: +m[1] }); return ops; }

    // --- 移除 / 送回 / 洗回 ---
    m = /\bremove (?:an? |the |target )?(?:enemy )?unit(?: with attack (\d+) or less)?(?: with cost (\d+) or less)? from the battlefield/i.exec(t);
    if (m) {
      const filters = {};
      if (m[1]) filters.maxAttack = +m[1];
      if (m[2]) filters.maxCost = +m[2];
      ops.push({ op: 'return', target: /enemy/.test(t) ? 'enemyUnit' : 'unit', toDeck: /deck|owner's deck/i.test(t), filters });
      return ops;
    }
    m = /\b(?:put|send) (?:a |an |target |your enemy )?(?:random )?units? on top of (?:its |their |owner's |your enemy'?s )?deck/i.exec(t)
      || /\bsend (?:a |an |the |target |all )?(?:enemy |friendly )?(?:ground |air )?units? to hand/i.exec(t);
    if (m) {
      ops.push({ op: 'return', target: /enemy/.test(t) ? 'enemyUnit' : 'unit', toDeck: /deck/i.test(t) });
      return ops;
    }
    m = /\b(?:is|are) shuffled into (?:your|their) deck\b/i.exec(t);
    if (m) { ops.push({ op: 'return', target: 'enemyUnit', toDeck: true }); return ops; }

    // --- 完全修复 ---
    if (/\bfully repair\b/i.test(t)) { ops.push({ op: 'heal', target: 'allFriendlyUnits', full: true }); return ops; }

    // --- 设定数值 ---
    m = /\bset (?:the )?(attack|defense) of (?:a |an |the |target |each |all )?([a-z \-']{1,30}?) to (\d+)/i.exec(t)
      || /\bthe (attack|defense) of (?:each |all |target )?([a-z \-']{1,30}?) is set to (\d+)/i.exec(t);
    if (m) {
      const f = describeTarget(m[2], t);
      ops.push({ op: 'setStat', stat: m[1], n: +m[3], target: f.target === 'unit' ? 'unit' : f.target, filters: f.filters });
      return ops;
    }
    m = /\b(?:change|set) (?:the )?attack (?:of|on) (?:a |the |target )?([a-z \-']{1,30}?) to (?:be )?equal to its defense/i.exec(t)
      || /\bset its attack equal to its defense/i.exec(t);
    if (m) {
      const f = m[1] ? describeTarget(m[1], t) : { target: 'self', filters: null };
      ops.push({ op: 'setStat', stat: 'attack', to: 'defense', target: f.target, filters: f.filters, self: !m[1] });
      return ops;
    }
    m = /\bset (?:the attack, defense and operation cost|the attack, defense and operation cost) of all units to (\d+)/i.exec(t);
    if (m) { ops.push({ op: 'setStat', stat: 'all', n: +m[1], target: 'allUnits' }); return ops; }
    m = /\bset (?:your|the) hq'?s? defense to (\d+)/i.exec(t) || /\bset the defense of each hq to (\d+)/i.exec(t);
    if (m) { ops.push({ op: 'setHqDef', n: +m[1], both: /each hq/i.test(t) }); return ops; }
    m = /\byour hq gains? defense equal to (?:the number of )?([a-z0-9 \-']{1,44})/i.exec(t);
    if (m) { ops.push({ op: 'setHqDef', n: 0, calc: describeCount(m[1]) }); return ops; }

    // --- 进入前线 ---
    if (/\bmoves? into the frontline\b/i.test(t)) { ops.push({ op: 'moveToFront' }); return ops; }

    // --- 随机分摊伤害 ---
    m = /\bdistribute (\d+) (damage|defense) randomly/i.exec(t);
    if (m) { ops.push({ op: m[2] === 'damage' ? 'distribute' : 'distributeDef', n: +m[1] }); return ops; }
    m = /\bdistribute damage randomly to enemies equal to (?:the number of )?(?:its attack|the units on the battlefield)/i.exec(t);
    if (m) { ops.push({ op: 'distribute', n: 'attackOrBoard' }); return ops; }

    // --- 三选一随机精英 ---
    m = /\bchoose 1 of 3 random elite ([a-z ]{1,20}?) units? to add to your hand/i.exec(t);
    if (m) {
      const eliteNation = { british: 'Britain', german: 'Germany', soviet: 'Soviet', japanese: 'Japan', 'us': 'USA' }[m[1].trim().toLowerCase()] || 'Neutral';
      ops.push({ op: 'addRandomElite', nation: eliteNation });
      return ops;
    }

    // --- 夺取控制权 ---
    m = /\btake control of an enemy unit(?: with cost (\d+) or less)?/i.exec(t);
    if (m) { ops.push({ op: 'steal', maxCost: m[1] ? +m[1] : 99, temp: /until end of turn/i.test(t) }); return ops; }

    // --- 弃牌 ---
    m = /(?:the enemy|your enemy) discards? (?:a|one|two) random card/i.exec(t);
    if (m) { ops.push({ op: 'discard', n: /two/i.test(m[0]) ? 2 : 1, random: true, maxCost: maxCostIn(t) }); return ops; }
    m = /\b(?:choose and discard a card|discard a card)\b/i.exec(t) || /\bdiscard the lower cost card\b/i.exec(t);
    if (m) { ops.push({ op: 'discard', n: 1, own: true }); return ops; }
    m = /\bdiscard it at the end of your (?:next )?turn\b/i.exec(t);
    if (m) { ops.push({ op: 'draw', n: 1 }); ops.push({ op: 'discard', n: 1, own: true, delayed: true }); return ops; }

    // --- 对拼：Fight target enemy unit ---
    if (/\bfight (?:target|a|an) enemy unit\b/i.test(t)) { ops.push({ op: 'fight' }); return ops; }

    // --- 复制 / 克隆 ---
    m = /\bduplicate (?:a|this|the) friendly unit/i.exec(t) || /\bduplicate it\b/i.exec(t) || /\bduplicate a friendly (?:unit|.*?unit) (?:in the frontline )?with a cost of (\d+) or less/i.exec(t);
    if (m) { ops.push({ op: 'clone', maxCost: m[1] ? +m[1] : 99 }); return ops; }
    m = /\bput (?:a |two |three |\d+ )?cop(?:y|ies) on top of owner's deck/i.exec(t)
      || /\bput a copy of target unit on top of owner's deck/i.exec(t);
    if (m) { ops.push({ op: 'clone', toDeck: true }); return ops; }

    // --- 变形（Convert X into Y） ---
    m = /\bconvert (?:a friendly unit|this unit|target unit|a card in hand|two cards in your deck|it)(?: with [a-z0-9 ]{1,26}?)? into (?:a |an |your |target )?([A-Z0-9'\-\. ]{2,44})/i.exec(t);
    if (m) { ops.push({ op: 'convert', to: m[1].trim() }); return ops; }

    // --- 手牌费用修正 ---
    m = /\breduce (?:its|the) cost by (\d+)/i.exec(t) || /\breduce its cost by (\d+)/i.exec(t);
    if (m) { ops.push({ op: 'handCostMod', n: -(+m[1]) }); return ops; }
    m = /\bset its cost to 0\b/i.exec(t) || /\bset cost to 0\b/i.exec(t);
    if (m) { ops.push({ op: 'handCostMod', n: -99 }); return ops; }
    m = /\bincrease the cost of all cards in your hand by (\d+)/i.exec(t);
    if (m) { ops.push({ op: 'ownHandCostMod', n: +m[1] }); return ops; }
    m = /\bcards? in enemy hand cost (\d+) more\b/i.exec(t);
    if (m) { ops.push({ op: 'enemyHandCost', n: +m[1] }); return ops; }
    m = /\bincrease the cost of a known card in the enemy hand by (\d+)/i.exec(t);
    if (m) { ops.push({ op: 'enemyHandCost', n: +m[1] }); return ops; }

    // --- 指挥点/槽位 ---
    m = /\blose (?:a|one) kredit slot\b/i.exec(t) || /\blose a kredit\b/i.exec(t);
    if (m) { ops.push({ op: 'slots', n: -1 }); return ops; }
    m = /\bnext turn, you gain (\d+) additional kredits\b/i.exec(t) || /\bgain (\d+) additional kredits\b/i.exec(t);
    if (m) { ops.push({ op: 'kredits', n: +m[1] }); return ops; }
    m = /\bgain (\d+) additional? kredit\b/i.exec(t);
    if (m) { ops.push({ op: 'kredits', n: +m[1] }); return ops; }

    // --- 免疫 / 天气 / 情报 ---
    if (/\bimmune to damage\b/i.test(t)) { ops.push({ op: 'immune', temp: true }); return ops; }
    if (/\b(?:it will be sunny|a storm is coming|rain is on its way)\b/i.test(t)) {
      ops.push({ op: 'weather', kind: /sunny/i.test(t) ? 'sun' : /storm/i.test(t) ? 'storm' : 'rain' });
      return ops;
    }
    if (/\breveal (?:target|a) covert unit\b/i.test(t)) { ops.push({ op: 'reveal' }); return ops; }

    // --- 填满支援线 ---
    m = /\bfill your support line with ([A-Z0-9'\-\. ]{2,44})/i.exec(t);
    if (m) { ops.push({ op: 'fillSupport', name: m[1].trim() }); return ops; }

    // --- 复制敌方牌库 ---
    m = /\bcopy (?:three|two|(\d+)) random ([a-z ]{1,20}?) in the enemy deck and shuffle them into yours/i.exec(t);
    if (m) { ops.push({ op: 'copyEnemyDeck', type: (m[2] || '').trim(), n: m[1] ? +m[1] : 3 }); return ops; }

    // --- 敌方手牌送回牌库顶 ---
    if (/\bputs? a random card in hand on top of their deck\b/i.test(t)) { ops.push({ op: 'enemyHandToDeck' }); return ops; }

    m = /\bdraw (?:a|one) card\b/i.exec(t);
    if (m && !/\bdiscard/i.test(t)) { ops.push({ op: 'draw', n: 1 }); return ops; }
    m = /\bdraw two cards?\b/i.exec(t);
    if (m) { ops.push({ op: 'draw', n: 2 }); return ops; }

    // --- Develop（从牌库直接打出一 Dialing 卡） ---
    m = /\bdevelop (?:a |an |two )?(?:[a-z]+ |[a-z]+ or [a-z]+ )?([A-Z][A-Z0-9'\-\. ]{1,40})/.exec(t)
      || /\bdevelop (?:a |an |two )?(british|german|soviet|japanese|us|french|polish|finnish|italian)? ?(special force |countermeasure |order |bomber |navy |unit |card )/.exec(t);
    if (m) {
      const nationMap2 = { british: 'Britain', german: 'Germany', soviet: 'Soviet', japanese: 'Japan', 'us': 'USA' };
      ops.push({ op: 'develop', name: (m[1] || '').trim(), nation: nationMap2[(m[2] || '').toLowerCase()] || null,
                 kind: (m[2] || '').trim() || null });
      return ops;
    }

    // --- 行动费用修正（单位） ---
    m = /\breduce the operation cost (?:on |of )?(?:a |an |the |target )?(?:friendly )?unit by (\d+)/i.exec(t)
      || /\bgive (?:another |a )?friendly unit -(\d+) operation cost/i.exec(t)
      || /\breduce the operation cost by (\d+)/i.exec(t);
    if (m) { ops.push({ op: 'unitOpCostMod', n: -(+m[1]) }); return ops; }
    m = /\breduce the operation cost of (?:a |the |target )?unit to 0/i.exec(t)
      || /\breduce the operation cost of target unit to 0/i.exec(t);
    if (m) { ops.push({ op: 'unitOpCostMod', to: 0 }); return ops; }
    m = /\bhas 0 operation cost this turn\b/i.exec(t);
    if (m) { ops.push({ op: 'unitOpCostMod', to: 0, self: true, temp: true }); return ops; }
    m = /\b(?:set|has) (?:the )?operation cost of (?:all |your )?units? to (\d+)/i.exec(t)
      || /\ball units have an operation cost of (\d+)/i.exec(t);
    if (m) { ops.push({ op: 'setAllOpCost', n: +m[1] }); return ops; }

    // --- 行动限制 ---
    if (/\benemy (?:does not|cannot) draw\b/i.test(t) || /\benemy does not gain a kredit slot or draw a card\b/i.test(t)) {
      ops.push({ op: 'noDraw', n: 3 }); return ops;
    }
    if (/\benemy ground units cannot attack\b/i.test(t)) { ops.push({ op: 'noAttack', target: 'allEnemyUnits' }); return ops; }
    if (/\bthe enemy cannot give orders\b/i.test(t)) { ops.push({ op: 'noOrders' }); return ops; }
    if (/\bcannot attack the enemy hq\b/i.test(t)) { ops.push({ op: 'noHQAttack' }); return ops; }
    if (/\battacking ground units deal damage equal to their defense\b/i.test(t)) { ops.push({ op: 'attackWithDefense' }); return ops; }
    m = /\bthe enemy gets (\d+) fewer kredits next turn\b/i.exec(t);
    if (m) { ops.push({ op: 'enemyKreditsMod', n: -(+m[1]) }); return ops; }
    m = /\benemy units get: "receives (\d+) damage at the start of owner's turn"/i.exec(t);
    if (m) { ops.push({ op: 'dotDamage', n: +m[1] }); return ops; }

    // --- 牌库操作 ---
    m = /\bremove the top (\d+) cards? of your deck\b/i.exec(t);
    if (m) { ops.push({ op: 'mill', n: +m[1] }); return ops; }
    m = /\bswap the attack and operation cost of target unit\b/i.exec(t);
    if (m) { ops.push({ op: 'swapAtkOpCost' }); return ops; }
    m = /\bconvert (\d+) of the top (\d+) cards of your deck into ([A-Z0-9'\-\. ]{2,44})/i.exec(t);
    if (m) { ops.push({ op: 'convertDeck', n: +m[1], within: +m[2], to: m[3].trim() }); return ops; }
    m = /\bdraw (\d+) units? from your deck\b/i.exec(t);
    if (m) { ops.push({ op: 'drawFilter', n: +m[1], kw: 'units' }); return ops; }
    m = /\bdraw (?:a|an|one|two) ([a-z \-']{1,30}?) from your deck\b/i.exec(t);
    if (m) { ops.push({ op: 'drawFilter', n: /two/i.test(m[0]) ? 2 : 1, kw: m[1].trim() }); return ops; }
    m = /\bdraw (?:a|an) ([A-Z][A-Z0-9'\-\. ]{2,40})$/i.exec(t);
    if (m) { ops.push({ op: 'addHand', name: m[1].trim() }); return ops; }
    m = /\badd (?:a |an )?([A-Z0-9'\-\. ]{2,40}?) and (?:a |an )?([A-Z0-9'\-\. ]{2,40}?) to your hand/i.exec(t);
    if (m) {
      ops.push({ op: 'addHand', name: m[1].trim() });
      ops.push({ op: 'addHand', name: m[2].trim() });
      return ops;
    }
    m = /\bfill your hand and support line with ([A-Z0-9'\-\. ]{2,44})/i.exec(t);
    if (m) { ops.push({ op: 'fillSupport', name: m[1].trim(), hand: true }); return ops; }
    m = /\bduplicate (?:a|this|the) (?:friendly )?unit/i.exec(t);
    if (m) { ops.push({ op: 'clone', maxCost: 99 }); return ops; }
    m = /\bduplicate a random unit in your hand\b/i.exec(t);
    if (m) { ops.push({ op: 'cloneHand' }); return ops; }
    m = /\bchoose a unit in hand with a cost of (\d+) or less\. put it into play\b/i.exec(t);
    if (m) { ops.push({ op: 'deployFromHand', maxCost: +m[1] }); return ops; }
    m = /\bboth players draw a card\b/i.exec(t);
    if (m) { ops.push({ op: 'drawBoth' }); return ops; }
    m = /\bthe player with the most units? in hand draws? (\d+) cards?\b/i.exec(t);
    if (m) { ops.push({ op: 'mostHandDraws', n: +m[1] }); return ops; }
    m = /\beach player removes their (\d+) most expensive cards?\b/i.exec(t);
    if (m) { ops.push({ op: 'removeExpensive', n: +m[1] }); return ops; }
    m = /\bdouble the attack and defense of your units\b/i.exec(t);
    if (m) { ops.push({ op: 'doubleStats' }); return ops; }
    m = /\bdeal (\d+)-(\d+) damage to (?:a |an |any )?target\b/i.exec(t);
    if (m) { ops.push({ op: 'damageRand', min: +m[1], max: +m[2] }); return ops; }
    m = /\bremove an enemy unit that has (\d+) or less attack\b/i.exec(t);
    if (m) { ops.push({ op: 'destroy', target: 'enemyUnit', filters: { maxAttack: +m[1] } }); return ops; }
    m = /\bremove an enemy unit until (?:this|that) unit leaves the battlefield\b/i.exec(t);
    if (m) { ops.push({ op: 'return', target: 'enemyUnit', toDeck: false }); return ops; }
    m = /\bput (?:a |target )?unit on top of (?:its |their |owner's )?deck\b/i.exec(t);
    if (m) { ops.push({ op: 'return', target: 'unit', toDeck: true }); return ops; }

    // --- 兜底：句子任何位置出现已知动词都尽量提取（仅在前面的模式全部落空时执行） ---
    const fb = parseFallbackOps(t);
    if (fb.length) return fb;

    return ops;
  }

  /** "for each ..." 短语 → 可执行的计数描述符（execOp 时按场面计算） */
  function describeCount(phrase) {
    const s = (phrase || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (/kredits? spent/.test(s)) return { type: 'kreditsSpent' };
    if (/enemy units? on the battlefield|enemy units?/.test(s)) return { type: 'enemyUnits' };
    if (/unit types?/.test(s)) return { type: 'unitTypes' };
    if (/other unit in (?:their|the) front|other unit in (?:their|the) frontline/.test(s)) return { type: 'frontlineOthers' };
    if (/two or more combat keywords/.test(s)) return { type: 'keywordUnits', min: 2 };
    if (/friendly unit with 0 operation cost|unit with 0 operation cost/.test(s)) return { type: 'zeroOpCost' };
    if (/bombers?/.test(s)) return { type: 'ownUnits', filters: { type: 'bomber' } };
    if (/cards? on the battlefield|units? on the battlefield/.test(s)) return { type: 'boardUnits' };
    if (/damage to your hq this turn/.test(s)) return { type: 'hqDamageThisTurn' };
    // 国家 / 类型 / 关键词计数（自己场上）
    const nationMap = { british: 'Britain', german: 'Germany', soviet: 'Soviet', japanese: 'Japan', 'us': 'USA', french: 'France', polish: 'Poland', finnish: 'Finland', italian: 'Italy', anzac: 'Anzac' };
    for (const k of Object.keys(nationMap)) {
      if (new RegExp('\\b' + k + '\\b').test(s)) {
        return { type: 'deckOrUnits', nation: nationMap[k], not: /non-/.test(s) };
      }
    }
    if (/non-[a-z]+ unit/.test(s)) {
      const m2 = /non-([a-z]+)/.exec(s);
      const inv = { french: 'France', german: 'Germany', british: 'Britain', soviet: 'Soviet', japanese: 'Japan', 'us': 'USA' };
      if (inv[m2[1]]) return { type: 'ownUnits', filters: { notNation: inv[m2[1]] } };
    }
    for (const ty of ['infantry', 'tank', 'artillery', 'fighter', 'bomber']) {
      if (new RegExp('\\b' + ty + 's?\\b').test(s)) return { type: 'ownUnits', filters: { type: ty } };
    }
    return { type: 'ownUnits', filters: null };
  }

  /** "cost 5 or less" 之类短语 → 数值（无则 99） */
  function maxCostIn(t) {
    const m = /\bcost (\d+) or less\b/i.exec(t || '');
    return m ? +m[1] : 99;
  }

  /**
   * 兜底解析：句子中任何位置出现已知动词都尽量提取。
   * 只用线性正则（禁止嵌套量词），按出现位置排序、去重叠后产出多个 op。
   */
  function parseFallbackOps(t) {
    const spans = [];
    const grab = (rx, make) => {
      const re = new RegExp(rx.source, rx.flags.indexOf('g') >= 0 ? rx.flags : rx.flags + 'g');
      let m;
      while ((m = re.exec(t)) !== null) {
        spans.push({ s: m.index, e: m.index + m[0].length, op: make(m) });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    };
    grab(/\bdraw (?:a|an|one|two|three|\d+) (?:extra |random )?cards?/gi, () => ({ op: 'draw', n: 1 }));
    grab(/\bdraw (\d+) cards?/gi, m => ({ op: 'draw', n: +m[1] }));
    grab(/\bgain (?:an|one) extra kredit slot/gi, () => ({ op: 'slots', n: 1 }));
    grab(/\bgain (\d+)(?: additional| extra)? kredits?/gi, m => ({ op: 'kredits', n: +m[1] }));
    grab(/\bdeal (\d+) damage/gi, m => ({ op: 'damage', n: +m[1], target: 'unit' }));
    grab(/\bfully repair/gi, () => ({ op: 'heal', target: 'allFriendlyUnits', full: true }));
    grab(/\btake control of an enemy unit/gi, () => ({ op: 'steal', maxCost: 99 }));
    grab(/\bthe enemy discards? (?:a|one) random card/gi, () => ({ op: 'discard', n: 1, random: true, maxCost: maxCostIn(t) }));
    grab(/\breveal (?:target|a) covert unit/gi, () => ({ op: 'reveal' }));
    grab(/\bmoves? into the frontline/gi, () => ({ op: 'moveToFront' }));
    // 排序去重叠
    spans.sort((a, b) => a.s - b.s);
    const ops = [];
    let lastEnd = -1;
    for (const sp of spans) {
      if (sp.s >= lastEnd && sp.op) { ops.push(sp.op); lastEnd = sp.e; }
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

  /** HQ 卡的初始防御：优先官方 location 的 defense，非法值回落 RULES.HQ_DEFENSE */
  function hqDefOf(hqCard) {
    const d = hqCard && typeof hqCard.defense === 'number' ? hqCard.defense : 0;
    return d > 0 ? d : RULES.HQ_DEFENSE;
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
      this.players = [0, 1].map(i => {
        // HQ 防御取所选 location 卡的真实 defense（官方存在 10/12/14/16/20/30 等多档），缺省回落 20
        const hqCard = opts.hqs ? (opts.hqs[i] || null) : null;
        const base = hqDefOf(hqCard);
        return {
        side: i,
        hq: hqCard,
        hqDef: base,
        hqMaxDef: base,
        hqArmor: 0,                       // 临时防御加成（hqBuff），回合结束清空
        kredits: 0,
        slots: 0,
        fatigue: 0,
        deck: [], hand: [], board: [], discard: [],
        ordersPlayedThisTurn: 0,
        hqDamagedThisTurn: 0,
        slotsLost: 0,
        kreditsSpent: 0,
        };
      });
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

    /** 「for each ...」计数描述符 → 数量（buffPer / drawPer / setHqDef 用） */
    countOf(desc, src) {
      if (!desc) return 0;
      const me = src ? src.owner : this.current;
      const foe = 1 - me;
      switch (desc.type) {
        case 'kreditsSpent': return this.players[me].kreditsSpent || 0;
        case 'enemyUnits': return this.unitsOf(foe).length;
        case 'unitTypes': return new Set(this.unitsOf(me).map(u => u.type)).size;
        case 'frontlineOthers': return this.frontline.filter(u => u.isUnit && (!src || u.uid !== src.uid)).length;
        case 'keywordUnits': {
          const min = desc.min || 2;
          return this.unitsOf(me).filter(u => (u.keywords ? u.keywords.size : 0) >= min).length;
        }
        case 'zeroOpCost': return this.unitsOf(me).filter(u => u.effOpCost === 0).length;
        case 'bombers': case 'ownUnits': {
          let list = this.unitsOf(me);
          const f = desc.filters;
          if (f) {
            if (f.type) list = list.filter(u => u.type === f.type);
            if (f.notNation) list = list.filter(u => u.nation !== f.notNation);
            if (f.nation) list = list.filter(u => u.nation === f.nation);
          }
          return list.length;
        }
        case 'boardUnits': return this.allBoard().filter(c => c.isUnit).length;
        case 'hqDamageThisTurn': return this.players[me].hqDamagedThisTurn || 0;
        case 'deckOrUnits': {
          const list = this.players[me].deck.filter(c => desc.not ? c.nation !== desc.nation : c.nation === desc.nation);
          return list.length;
        }
        default: return 0;
      }
    }

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
      // 官方 UpdateGuarded 语义：只有支援线（location 5/6）有掩护，
      // 相邻槽位（locationNumber±1）有 Guard 才保护，且排除未明牌的 Covert；
      // 前线不加掩护（前线本来就挡在前面）。
      if (target.loc !== 'board') return false;
      const row = this.players[target.owner].board;
      const guardOk = (n) => n && n !== target && n.isUnit && n.has('guard') && !n.has('covert');
      if (target.slot != null) {
        return row.some(n => guardOk(n) && n.slot != null && Math.abs(n.slot - target.slot) === 1);
      }
      // 兜底：缺少槽位信息时按数组相邻判断
      const idx = row.indexOf(target);
      for (const j of [idx - 1, idx + 1]) {
        if (j < 0 || j >= row.length) continue;
        if (guardOk(row[j])) return true;
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
      p.kreditsSpent = 0;
      if (p._kreditsNextMod) {
        p.slots = Math.max(0, Math.min(RULES.MAX_KREDITS, p.slots + p._kreditsNextMod));
        p.kredits = p.slots;
        p._kreditsNextMod = 0;
      }
      if (p._noDrawTurns > 0) p._noDrawTurns--;
      for (const u of this.unitsOf(this.current)) {
        if (u._dot) this.damageCard(u, u._dot, null);
      }
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
      this.expireTempBuffs(cur);
      this.current = 1 - cur;
      if (cur === 1) this.turn++;
      if (!this.done) this.beginTurn();
    }

    /**
     * 回合结束清理临时加成（对齐官方 GameEngine.Turn.cs 的 ExpireTempBuffs）：
     * - HQ 临时护甲清零
     * - 单位上标记为 temp 的攻击/防御加成回退
     */
    expireTempBuffs(side) {
      const p = this.players[side];
      if (!p) return;
      if (p.hqArmor) {
        this.log(`我方总部临时防御失效（-${p.hqArmor}）`);
        p.hqArmor = 0;
      }
      for (const u of this.unitsOf(side)) {
        u._noAttack = false;
        u._immune = false;
        u._useDefenseAsAttack = false;
        if (u._tempOpCostSet) { u._opCostSet = null; u._tempOpCostSet = false; }
        if (u._tempAtk || u._tempDef) {
          u.buffAttack -= (u._tempAtk || 0);
          u.buffDefense -= (u._tempDef || 0);
          u._tempAtk = 0;
          u._tempDef = 0;
          this.log(`${u.name} 的临时加成失效`);
        }
      }
    }

    draw(side, n, silent) {
      const p = this.players[side];
      if (p._noDrawTurns > 0) {
        this.log(`P${side + 1} 被封锁抽牌（剩余 ${p._noDrawTurns} 回合）`);
        return;
      }
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
      // 临时护甲先吸收（hqBuff）
      if (!isFatigue && p.hqArmor > 0) {
        const absorbed = Math.min(p.hqArmor, amount);
        p.hqArmor -= absorbed;
        amount -= absorbed;
        if (absorbed > 0) this.log(`总部护甲吸收 ${absorbed} 点伤害（剩余护甲 ${p.hqArmor}）`);
        if (amount <= 0) return;
      }
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
      if (c._immune) { this.log(`${c.name} 免疫伤害`); return; }
      c.defense -= amount;
      this.ev({ e: 'damage', uid: c.uid, amount });
      this.log(`${c.name} 受到 ${amount} 点伤害，剩余 ${Math.max(0, c.defense)}`);
      if (c.defense <= 0) this.destroyCard(c, killer);
    }

    destroyCard(c, killer, inCombat) {
      if (c.loc === 'discard') return;
      this._destroyedByNation = this._destroyedByNation || {};
      this._destroyedByNation[c.nation] = (this._destroyedByNation[c.nation] || 0) + 1;
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

      if ((c.type === 'order' || c.type === 'gotcha') && p._noOrders) {
        return { ok: false, error: '本回合无法使用指令' };
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
      if (p.kredits < c.effOpCost) return { ok: false, error: '指挥点不足' };
      p.kredits -= c.effOpCost;
      p.kreditsSpent = (p.kreditsSpent || 0) + c.effOpCost;
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
        this.log(`${c.name} 移动至前线（-${c.effOpCost} 指挥点）`);
        this.ev({ e: 'move', uid: c.uid, to: 'front', owner: c.owner });
      } else {
        this.frontline.splice(this.frontline.indexOf(c), 1);
        if (!this.frontline.length) this.frontlineOwner = -1;
        c.loc = 'board';
        c.slot = this.claimSlot(p.board, slot, RULES.MAX_ROW - 1);
        p.board.push(c);
        this.sortBoard(p.board);
        this.log(`${c.name} 撤回支援阵线（-${c.effOpCost} 指挥点）`);
        this.ev({ e: 'move', uid: c.uid, to: 'support', owner: c.owner });
      }
      c.hasMoved = true;
      c.hasActed = true;
      return { ok: true };
    }

    // ---------- attack ----------
    attackTargets(attacker) {
      const out = this._attackTargetsBase(attacker);
      if (attacker && attacker._noHQ) {
        const i = out.indexOf(0);
        if (i >= 0) out.splice(i, 1);
      }
      return out;
    }
    _attackTargetsBase(attacker) {
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
      if (c._noAttack) return false;
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
      if (p.kredits < atk.effOpCost) return { ok: false, error: '指挥点不足' };
      p.kredits -= atk.effOpCost;
      p.kreditsSpent = (p.kreditsSpent || 0) + atk.effOpCost;
      atk.hasAttacked = true;
      atk.attacksLeft -= 1;
      atk.hasActed = true;

      if (targetUid === 0) {
        this.log(`${atk.name}（攻击 ${atk.totalAttack}）攻击敌方总部（-${atk.effOpCost} 指挥点）`);
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

      this.log(`${atk.name}（攻击 ${atk.totalAttack}）攻击 ${def.name}（防御 ${def.totalDefense}）（-${atk.effOpCost} 指挥点）`);
      const atkSilenced = !!atk._pinned || !!atk._suppressed;
      const defSilenced = !!def._pinned || !!def._suppressed;
      const dmg = (a, d, silenced) => {
        if (silenced) return 0;
        let x = Math.max(0, a.totalAttack - d.heavyArmor);
        if (a._immune) x = 0;
        return x;
      };
      if (ambush || shock) {
        // Ambush: defender strikes first. Shock: attacker strikes first.
        if (ambush) {
          const d1 = dmg(def, atk, defSilenced);
          if (d1 > 0) atk.defense -= d1;
          this.log(`${def.name}（伏击）先手造成 ${d1} 点伤害`);
          if (atk.defense <= 0) { this.destroyCard(atk, def, true); return { ok: true }; }
          const d2 = dmg(atk, def, atkSilenced);
          if (d2 > 0) def.defense -= d2;
          if (def.defense <= 0) this.destroyCard(def, atk, true);
        } else {
          const d1 = dmg(atk, def, atkSilenced);
          if (d1 > 0) def.defense -= d1;
          this.log(`${atk.name}（冲击）先手造成 ${d1} 点伤害`);
          if (def.defense <= 0) { this.destroyCard(def, atk, true); return { ok: true }; }
          // retaliation
          let canFightBack = true;
          if (atk.type === 'artillery') canFightBack = false;
          if (atk.type === 'bomber' && !(def.type === 'fighter' || def.type === 'artillery')) canFightBack = false;
          if (canFightBack) {
            const d2 = dmg(def, atk, defSilenced);
            if (d2 > 0) atk.defense -= d2;
            if (atk.defense <= 0) this.destroyCard(atk, def, true);
          }
        }
        return { ok: true };
      }
      const dToDef = dmg(atk, def, atkSilenced);
      let dToAtk = 0;
      // retaliation rules
      let canFightBack = true;
      if (atk.type === 'artillery') canFightBack = false;
      if (atk.type === 'bomber' && !(def.type === 'fighter' || def.type === 'artillery')) canFightBack = false;
      if (canFightBack) dToAtk = dmg(def, atk, defSilenced);
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
          const calcN = () => {
            switch (op.calc) {
              case 'airAttackSum': return this.unitsOf(me).filter(u => u.type === 'fighter' || u.type === 'bomber').reduce((a, u) => a + u.totalAttack, 0);
              case 'enemyHandSize': return this.players[foe].hand.length;
              case 'kreditsSpent': return this.players[me].kreditsSpent || 0;
              case 'ownUnitCount': return this.unitsOf(me).length;
              case 'bombersPlus1': return this.unitsOf(me).filter(u => u.type === 'bomber').length + 1;
              case 'typesPlus1': return new Set(this.unitsOf(me).map(u => u.type)).size + 1;
              case 'the total cost of your german tanks in the frontline': case 'germanTankCost':
              case 'total cost of your german tanks in the frontline': return this.frontline.filter(u => u.owner === me && u.type === 'tank').reduce((a, u) => a + (u.cost || 0), 0);
              case 'hqDamageThisTurn': return this.players[me].hqDamagedThisTurn || 0;
              case 'polandDestroyed': return (this._destroyedByNation && this._destroyedByNation.Poland) || 0;
              case 'perBigUnit': return (op.n || 0) * this.unitsOf(me).filter(u => u.totalAttack >= (op.per || 4)).length;
              default: return typeof op.n === 'number' ? op.n : 0;
            }
          };
          const n = op.calc ? calcN() : op.n;
          const f = op.filters || {};
          const matchFilter = (u) => {
            if (f.type && u.type !== f.type) return false;
            if (f.ground && !['infantry', 'tank', 'artillery'].includes(u.type)) return false;
            if (f.air && !(u.type === 'fighter' || u.type === 'bomber')) return false;
            if (f.maxAttack != null && u.totalAttack > f.maxAttack) return false;
            if (f.maxCost != null && u.cost > f.maxCost) return false;
            return true;
          };
          const pickFiltered = () => {
            const t = pickUnit(op.target === 'typedUnit' ? 'unit' : op.target);
            if (t && !matchFilter(t)) {
              const sideFor = (op.target === 'enemyUnit' || /enemy/.test(op.target)) ? foe : me;
              const alt = this.unitsOf(sideFor).filter(u => u.uid !== src.uid && matchFilter(u))[0];
              return alt || t;
            }
            return t;
          };
          if (op.target === 'enemyHQ') { this.damageHq(foe, typeof n === 'number' ? n : src.totalAttack, src); break; }
          if (op.target === 'ownHQ') { this.players[me].hqDef = Math.min(this.players[me].hqMaxDef, this.players[me].hqDef + n); break; }
          if (op.target === 'allEnemies' || op.target === 'allEnemyUnits') { for (const u of [...this.unitsOf(foe)]) if (matchFilter(u)) apply(u, n); break; }
          if (op.target === 'allEnemyAir') { for (const u of this.unitsOf(foe).filter(u => u.type === 'fighter' || u.type === 'bomber')) apply(u, n); break; }
          if (op.target === 'allFriendly' || op.target === 'allFriendlyUnits') { for (const u of [...this.unitsOf(me)]) if (matchFilter(u)) apply(u, n); break; }
          if (op.target === 'allUnits') { for (const u of [...this.unitsOf(0), ...this.unitsOf(1)]) if (matchFilter(u)) apply(u, n); break; }
          if (op.target === 'randomEnemy') { const t = this.unitsOf(foe).filter(matchFilter); if (t.length) apply(this.rng.pick(t), n); break; }
          const t = pickFiltered();
          if (t) apply(t, n); else this.log(`（没有合法伤害目标）`);
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
          // 永久提升：上限与当前防御同时 +N（官方 ChangeDefense(location, N, permanent)）
          const p = this.players[me];
          p.hqMaxDef += op.n;
          p.hqDef += op.n;
          this.log(`我方总部防御 +${op.n}`);
          break;
        }
        case 'hqBuff': {
          // 临时/条件加成：只挡伤害，回合结束清空（HQ 没有攻击力，op.a 忽略）
          const p = this.players[me];
          const d = op.d || op.a || 0;
          if (d) {
            p.hqArmor = (p.hqArmor || 0) + d;
            this.log(`我方总部获得 ${d} 点临时防御`);
          }
          break;
        }
        case 'buff': {
          const f = op.filters || {};
          const matchFilter = (u) => {
            if (f.type && u.type !== f.type) return false;
            if (f.nation && u.nation !== f.nation) return false;
            if (f.notNation && u.nation === f.notNation) return false;
            if (f.kw && !u.has(f.kw) && !/light infantry/i.test(u.name)) return false;
            if (f.ground && !['infantry', 'tank', 'artillery'].includes(u.type)) return false;
            if (f.air && !(u.type === 'fighter' || u.type === 'bomber')) return false;
            if (f.frontline && u.loc !== 'front') return false;
            if (f.damaged && u.defense >= u.totalDefense) return false;
            if (f.minAttack != null && u.totalAttack < f.minAttack) return false;
            if (f.maxOpCost != null && u.effOpCost > f.maxOpCost) return false;
            if (f.maxCost != null && u.cost > f.maxCost) return false;
            if (f.maxAttack != null && u.totalAttack > f.maxAttack) return false;
            return true;
          };
          const apply = (u) => {
            u.buffAttack += op.a;
            u.buffDefense += op.d;
            if (op.temp) { u._tempAtk = (u._tempAtk || 0) + op.a; u._tempDef = (u._tempDef || 0) + op.d; }
          };
          if (op.target === 'allFriendlyUnits') {
            const list = this.unitsOf(me).filter(u => matchFilter(u) && !(f.other && u.uid === src.uid));
            for (const u of list) apply(u);
            this.log(`我方 ${list.length} 个单位 +${op.a}/+${op.d}`);
          } else if (op.target === 'allEnemyUnits') {
            const list = this.unitsOf(foe).filter(u => matchFilter(u));
            for (const u of list) apply(u);
            this.log(`敌方 ${list.length} 个单位 +${op.a}/+${op.d}`);
          } else if (op.target === 'allUnits') {
            const list = [...this.unitsOf(0), ...this.unitsOf(1)].filter(u => matchFilter(u));
            for (const u of list) apply(u);
            this.log(`所有单位 +${op.a}/+${op.d}`);
          } else {
            let t = pickUnit(op.target);
            if (op.self && src.isUnit) t = src;
            if (t && !matchFilter(t)) {
              const sideFor = (op.target === 'enemyUnit') ? foe : me;
              const alt = this.unitsOf(sideFor).filter(u => u.uid !== src.uid && matchFilter(u))[0];
              t = alt || t;
            }
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
        // ================= 扩展效果执行（覆盖率 90% 计划） =================
        case 'buffPer': {
          // 按「for each X」计数后施加加成（进场一次性近似官方的持续重算）
          const cnt = this.countOf(op.count, src) || 0;
          const a = (op.a || 0) * cnt, d = (op.d || 0) * cnt;
          const f = op.filters || {};
          const apply = (u) => {
            u.buffAttack += a;
            u.buffDefense += d;
            if (op.temp) { u._tempAtk = (u._tempAtk || 0) + a; u._tempDef = (u._tempDef || 0) + d; }
          };
          if (op.target === 'allFriendlyUnits' || op.target === 'allUnits') {
            for (const u of this.unitsOf(me)) apply(u);
            this.log(`按计数 ×${cnt}，我方单位 +${a}/+${d}`);
          } else {
            let t = pickUnit(op.target);
            if (op.self && src.isUnit) t = src;
            if (t) { apply(t); this.log(`${t.name} 按计数 ×${cnt} 获得 +${a}/+${d}`); }
          }
          break;
        }
        case 'drawFilter': {
          // 从牌库抽符合条件的牌（Draw a random Commando unit from your deck 等）
          const p = this.players[me];
          const kw = String(op.kw || '').toLowerCase();
          const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const kwNorm = norm(kw);
          const pred = (c) => {
            if (!kw) return true;
            if (/order/.test(kw) && c.type === 'order') return true;
            if (/countermeasure/.test(kw) && c.type === 'gotcha') return true;
            if (/unit/.test(kw) && !/order|countermeasure/.test(kw) && ['infantry','tank','artillery','fighter','bomber'].includes(c.type)) return true;
            for (const ty of ['infantry', 'tank', 'artillery', 'fighter', 'bomber']) {
              if (kw.includes(ty) && c.type === ty) return true;
            }
            const cm = /\b(\d)-cost\b|\bcost (\d+)\b/.exec(kw);
            if (cm && c.cost === +(cm[1] || cm[2])) return true;
            if (kwNorm && norm(c.name).includes(kwNorm)) return true;
            if (c.keywords && c.keywords.some(k => norm(k).includes(kwNorm))) return true;
            if (norm(c.text).includes(kwNorm)) return true;
            return false;
          };
          let drawn = 0;
          const queue = p.deck.filter(pred);
          for (let i = 0; i < (op.n || 1) && queue.length; i++) {
            const idx = p.deck.indexOf(queue[i % queue.length]);
            if (idx < 0) continue;
            const c = p.deck.splice(idx, 1)[0];
            c.loc = 'hand';
            if (p.hand.length < RULES.MAX_HAND) { p.hand.push(c); drawn++; this.log(`P${me + 1} 从牌库抽到 ${c.name}`); }
            else { p.discard.push(c); }
          }
          if (!drawn) this.log(`（牌库中没有符合条件的牌：${kw || '任意'}）`);
          break;
        }
        case 'drawPer': {
          const cnt = this.countOf(op.count, src) || 0;
          if (cnt > 0) this.draw(me, Math.min(cnt, 6));
          else this.log(`（没有满足计数的对象）`);
          break;
        }
        case 'drawTo': {
          if (op.reshuffle) {
            for (const i of [0, 1]) {
              const p = this.players[i];
              while (p.hand.length) { const c = p.hand.pop(); c.loc = 'deck'; p.deck.push(c); }
              this.rng.shuffle(p.deck);
            }
          }
          const drawUpTo = (side, target) => {
            const p = this.players[side];
            let guard = 0;
            while (p.hand.length < target && p.deck.length && guard++ < 20) this.draw(side, 1, true);
          };
          if (op.toEnemy) {
            const target = this.players[foe].hand.length;
            drawUpTo(me, target);
            this.log(`抽牌补齐至与对手相同（${target} 张）`);
          } else if (op.both) {
            drawUpTo(0, op.n || 8);
            drawUpTo(1, op.n || 8);
            this.log(`双方抽牌至 ${op.n || 8} 张`);
          } else {
            drawUpTo(me, op.n || 8);
          }
          break;
        }
        case 'drawBoth': {
          this.draw(0, 1, true);
          this.draw(1, 1, true);
          this.log('双方各抽一张牌');
          break;
        }
        case 'heal': {
          let healed = 0;
          for (const u of this.unitsOf(me)) {
            const missing = u.totalDefense - u.defense;
            if (missing > 0) { u.defense = u.totalDefense; healed++; }
          }
          this.log(`完全修复了 ${healed} 个我方单位`);
          break;
        }
        case 'setStat': {
          const applyTo = (u) => {
            if (op.to === 'defense') u.buffAttack += (u.totalDefense - u.totalAttack);
            else if (op.stat === 'all') { u.attack = op.n; u.defense = op.n; u._opCostSet = op.n; }
            else if (op.stat === 'attack') {
              const delta = op.n - u.totalAttack;
              u.buffAttack += delta;
              if (op.temp) { u._tempAtk = (u._tempAtk || 0) + delta; }
            } else if (op.stat === 'defense') {
              const delta = op.n - u.totalDefense;
              u.buffDefense += delta;
            }
          };
          const list = op.target === 'allEnemyUnits' ? this.unitsOf(foe)
            : op.target === 'allFriendlyUnits' ? this.unitsOf(me)
            : op.target === 'allUnits' ? [...this.unitsOf(0), ...this.unitsOf(1)]
            : [pickUnit(op.target) || (op.self && src.isUnit ? src : null)].filter(Boolean);
          for (const u of list) applyTo(u);
          this.log(`设定了 ${list.length} 个单位的数值`);
          break;
        }
        case 'setHqDef': {
          const n = op.calc ? (this.countOf(op.calc, src) || 0) : op.n;
          const apply = (side) => {
            const p = this.players[side];
            p.hqMaxDef = Math.max(1, n);
            p.hqDef = Math.max(1, Math.min(p.hqMaxDef, n));
          };
          apply(me);
          if (op.both) apply(foe);
          this.log(`总部防御设为 ${n}`);
          break;
        }
        case 'moveToFront': {
          const t = pickUnit('friendlyUnit') || (src.isUnit ? src : null);
          if (t && t.loc === 'board' && this.canEnterFrontline(t.owner) && this.frontlineCount(t.owner) < RULES.MAX_ROW) {
            t.loc = 'front';
            t.slot = this.claimSlot(this.frontline, null, RULES.MAX_ROW + 1);
            this.frontline.push(t);
            this.packFrontline();
            if (this.frontlineOwner === -1) this.frontlineOwner = t.owner;
            this.log(`${t.name} 进入前线`);
          } else this.log(`（无法进入前线）`);
          break;
        }
        case 'distribute': {
          let n = op.n === 'attackOrBoard' ? (src.isUnit ? src.totalAttack : this.allBoard().length) : op.n;
          const enemies = this.unitsOf(foe);
          let dealt = 0;
          while (dealt < n && enemies.some(u => u.defense > 0)) {
            const alive = enemies.filter(u => u.defense > 0);
            if (!alive.length) break;
            const t = this.rng.pick(alive);
            this.damageCard(t, 1, src);
            dealt++;
          }
          this.log(`随机分摊了 ${dealt} 点伤害`);
          break;
        }
        case 'distributeDef': {
          const friends = this.unitsOf(me);
          for (let i = 0; i < (op.n || 0) && friends.length; i++) {
            const t = this.rng.pick(friends);
            t.buffDefense += 1;
          }
          this.log(`随机分发了 ${op.n} 点防御`);
          break;
        }
        case 'addRandomElite': {
          const pool = this.db.cards.filter(c => c.nation === op.nation && c.rarity === 'Unique' && c.type !== 'location');
          if (!pool.length) { this.log(`（没有 ${op.nation} 精英卡）`); break; }
          const picks = [];
          const poolCopy = pool.slice();
          for (let i = 0; i < 3 && poolCopy.length; i++) picks.push(poolCopy.splice(Math.floor(this.rng.next() * poolCopy.length), 1)[0]);
          const chosen = picks[0];
          const c = new CardInst(chosen, me, this);
          c.loc = 'hand';
          this.players[me].hand.push(c);
          this.log(`${c.name}（三选一）加入手牌`);
          break;
        }
        case 'steal': {
          const cands = this.unitsOf(foe).filter(u => (op.maxCost == null || u.cost <= op.maxCost));
          const t = cands[0];
          if (!t) { this.log(`（没有可夺取的敌方单位）`); break; }
          if (t.loc === 'front') {
            this.frontline.splice(this.frontline.indexOf(t), 1);
            if (!this.frontline.length) this.frontlineOwner = -1;
          } else {
            const b = this.players[foe].board;
            b.splice(b.indexOf(t), 1);
          }
          t.owner = me;
          t.loc = 'board';
          t.slot = this.claimSlot(this.players[me].board, null, RULES.MAX_ROW - 1);
          this.players[me].board.push(t);
          this.log(`夺取了 ${t.name}`);
          break;
        }
        case 'discard': {
          if (op.own) {
            const p = this.players[me];
            if (p.hand.length) {
              const c = p.hand.splice(Math.floor(this.rng.next() * p.hand.length), 1)[0];
              c.loc = 'discard';
              p.discard.push(c);
              this.log(`弃掉 ${c.name}`);
            }
          } else {
            const p = this.players[foe];
            const cands = p.hand.filter(c => !op.maxCost || op.maxCost >= 99 || (c.cost || 0) <= op.maxCost);
            if (cands.length) {
              const c = cands[Math.floor(this.rng.next() * cands.length)];
              p.hand.splice(p.hand.indexOf(c), 1);
              c.loc = 'discard';
              p.discard.push(c);
              this.log(`敌方弃掉 ${c.name}`);
            }
          }
          break;
        }
        case 'fight': {
          const t = pickUnit('enemyUnit');
          if (!t || !src.isUnit) { this.log(`（没有可攻击的目标）`); break; }
          const atkSilenced = !!src._pinned || !!src._suppressed;
          const dOut = Math.max(0, src.totalAttack - t.heavyArmor);
          const dBack = Math.max(0, t.totalAttack - src.heavyArmor);
          if (dOut > 0) t.defense -= dOut;
          if (dBack > 0) src.defense -= dBack;
          this.log(`${src.name} 与 ${t.name} 交战（${dOut}/${dBack} 伤害）`);
          if (t.defense <= 0) this.destroyCard(t, src, true);
          if (src.defense <= 0) this.destroyCard(src, t, true);
          break;
        }
        case 'clone': {
          const cands = this.unitsOf(me).filter(u => u.uid !== src.uid && (!op.maxCost || op.maxCost >= 99 || u.cost <= op.maxCost));
          const t = op.self ? src : (cands[0] || null);
          if (!t) { this.log(`（没有可复制的单位）`); break; }
          const c = new CardInst(t.def, t.owner, this);
          c.loc = op.toDeck ? 'deck' : t.loc;
          if (op.toDeck) {
            this.players[t.owner].deck.push(c);
            this.log(`${c.name} 的复制放入牌库顶`);
          } else if (t.loc === 'front') {
            c.summonedTurn = this.turn;
            c.loc = 'front';
            c.slot = this.claimSlot(this.frontline, null, RULES.MAX_ROW + 1);
            this.frontline.push(c);
            this.packFrontline();
            this.log(`${c.name} 被复制到前线`);
          } else {
            this.players[t.owner].board.push(c);
            this.log(`${c.name} 被复制到支援阵线`);
          }
          break;
        }
        case 'cloneHand': {
          const p = this.players[me];
          const units = p.hand.filter(c => ['infantry','tank','artillery','fighter','bomber'].includes(c.type));
          if (units.length) {
            const c = units[Math.floor(this.rng.next() * units.length)];
            const copy = new CardInst(c.def, me, this);
            copy.loc = 'hand';
            p.hand.push(copy);
            this.log(`复制了手牌中的 ${copy.name}`);
          }
          break;
        }
        case 'convert': {
          const targets = op.target === 'allEnemyUnits' || op.target === 'allUnits'
            ? (op.target === 'allEnemyUnits' ? this.unitsOf(foe) : [...this.unitsOf(0), ...this.unitsOf(1)])
            : [pickUnit(op.target === 'friendlyUnit' ? 'friendlyUnit' : 'enemyUnit')].filter(Boolean);
          const def = this.findByName(op.to, me)[0] || this.findByName(op.to)[0];
          if (!def) { this.log(`（未找到变形目标：${op.to}）`); break; }
          for (const t of targets) {
            const nc = new CardInst(def, t.owner, this);
            nc.uid = t.uid; nc.loc = t.loc; nc.slot = t.slot;
            nc.summonedTurn = t.summonedTurn; nc.hasAttacked = t.hasAttacked; nc.hasMoved = t.hasMoved;
            if (t.loc === 'front') { const i = this.frontline.indexOf(t); if (i >= 0) this.frontline[i] = nc; }
            else { const b = this.players[t.owner].board; const i = b.indexOf(t); if (i >= 0) b[i] = nc; }
            this.log(`${t.name} 变形为 ${nc.name}`);
          }
          break;
        }
        case 'convertDeck': {
          const p = this.players[me];
          const def = this.findByName(op.to, me)[0];
          if (!def) { this.log(`（未找到变形目标：${op.to}）`); break; }
          let converted = 0;
          for (let i = 0; i < Math.min(op.within || 8, p.deck.length) && converted < (op.n || 1); i++) {
            p.deck[i] = new CardInst(def, me, this);
            p.deck[i].loc = 'deck';
            converted++;
          }
          this.log(`牌库顶 ${converted} 张卡变为 ${def.name}`);
          break;
        }
        case 'handCostMod': {
          const p = this.players[me];
          const c = p.hand[p.hand.length - 1] || p.hand[0];
          if (c) { c._costMod = (c._costMod || 0) + op.n; this.log(`${c.name} 费用 ${op.n >= 0 ? '+' : ''}${op.n}`); }
          break;
        }
        case 'ownHandCostMod': {
          for (const c of this.players[me].hand) c._costMod = (c._costMod || 0) + op.n;
          this.log(`我方手牌费用 ${op.n >= 0 ? '+' : ''}${op.n}`);
          break;
        }
        case 'develop': {
          // 官方 Develop：从牌库直接打出一 Dialing 卡。简化为「符合条件的牌直接进入手牌并标记本回合可免费打出」
          const p = this.players[me];
          const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const kw = norm(op.name || '');
          let idx = p.deck.findIndex(c => kw && norm(c.name) === kw);
          if (idx < 0) idx = p.deck.findIndex(c => kw && norm(c.name).includes(kw));
          if (idx < 0 && op.nation) idx = p.deck.findIndex(c => c.nation === op.nation);
          if (idx < 0 && op.kind) {
            const kind = op.kind.toLowerCase();
            idx = p.deck.findIndex(c => (kind === 'countermeasure' && c.type === 'gotcha')
              || (kind === 'order' && c.type === 'order')
              || (kind === 'bomber' && c.type === 'bomber')
              || (kind === 'unit' && ['infantry','tank','artillery','fighter','bomber'].includes(c.type))
              || (kind === 'card'));
          }
          if (idx < 0) idx = 0;
          if (p.deck.length) {
            const c = p.deck.splice(idx, 1)[0];
            c.loc = 'hand';
            c._costMod = -(c.cost || 0);   // Develop 免费打出
            if (p.hand.length < RULES.MAX_HAND) p.hand.push(c);
            else p.discard.push(c);
            this.log(`Develop：${c.name} 加入手牌（免费）`);
          }
          break;
        }
        case 'unitOpCostMod': {
          const applyTo = (u) => {
            if (op.to != null) { u._opCostSet = op.to; if (op.temp) u._tempOpCostSet = true; }
            else u._opCostMod = (u._opCostMod || 0) + op.n;
          };
          if (op.self && src.isUnit) applyTo(src);
          else {
            const t = pickUnit('friendlyUnit') || (src.isUnit ? src : null);
            if (t) applyTo(t);
          }
          this.log('单位行动费用已修正');
          break;
        }
        case 'setAllOpCost': {
          for (const u of [...this.unitsOf(0), ...this.unitsOf(1)]) u._opCostSet = op.n;
          this.log(`所有单位行动费用设为 ${op.n}`);
          break;
        }
        case 'noDraw': {
          this.players[foe]._noDrawTurns = (this.players[foe]._noDrawTurns || 0) + (op.n || 3);
          this.log(`敌方 ${op.n || 3} 回合无法抽牌`);
          break;
        }
        case 'noAttack': {
          for (const u of this.unitsOf(foe)) u._noAttack = true;
          this.log(`敌方单位本回合无法攻击`);
          break;
        }
        case 'noOrders': {
          this.players[foe]._noOrders = true;
          this.log(`敌方下回合无法使用指令`);
          break;
        }
        case 'noHQAttack': {
          if (src.isUnit) { src._noHQ = true; this.log(`${src.name} 本回合无法攻击敌方总部`); }
          break;
        }
        case 'attackWithDefense': {
          for (const u of this.unitsOf(me)) {
            if (['infantry', 'tank', 'artillery'].includes(u.type)) u._useDefenseAsAttack = true;
          }
          this.log(`我方地面单位本回合以防御力攻击`);
          break;
        }
        case 'enemyKreditsMod': {
          this.players[foe]._kreditsNextMod = (this.players[foe]._kreditsNextMod || 0) + op.n;
          this.log(`敌方下回合指挥点 ${op.n}`);
          break;
        }
        case 'dotDamage': {
          for (const u of this.unitsOf(foe)) u._dot = op.n;
          this.log(`敌方单位将在其回合开始时受到 ${op.n} 点伤害`);
          break;
        }
        case 'mill': {
          const p = this.players[me];
          const n = Math.min(op.n || 1, p.deck.length);
          for (let i = 0; i < n; i++) {
            const c = p.deck.shift();
            c.loc = 'discard';
            p.discard.push(c);
          }
          this.log(`移除了牌库顶 ${n} 张卡`);
          break;
        }
        case 'swapAtkOpCost': {
          const t = pickUnit('unit') || (src.isUnit ? src : null);
          if (t) {
            const old = t.attack;
            t.attack = t.opCost || 0;
            t._opCostSet = old;
            this.log(`${t.name} 攻击与行动费用互换`);
          }
          break;
        }
        case 'fillSupport': {
          const p = this.players[me];
          const def = this.findByName(op.name, me)[0] || this.findByName(op.name)[0];
          if (!def) { this.log(`（未找到：${op.name}）`); break; }
          if (op.hand) {
            while (p.hand.length < RULES.MAX_HAND) {
              const c = new CardInst(def, me, this);
              c.loc = 'hand';
              p.hand.push(c);
            }
          }
          let spawned = 0;
          while (this.supportCount(me) < RULES.MAX_ROW - 1 && spawned < 4) {
            const c = new CardInst(def, me, this);
            c.loc = 'board';
            c.summonedTurn = this.turn;
            p.board.push(c);
            spawned++;
          }
          this.log(`填入了 ${spawned} 个 ${def.name}`);
          break;
        }
        case 'copyEnemyDeck': {
          const ed = this.players[foe].deck.filter(c => !op.type || op.type === 'order' ? c.type === 'order' : true);
          const p = this.players[me];
          for (let i = 0; i < (op.n || 3) && ed.length; i++) {
            const src2 = ed[Math.floor(this.rng.next() * ed.length)];
            const c = new CardInst(src2.def, me, this);
            c.loc = 'deck';
            p.deck.push(c);
          }
          this.rng.shuffle(p.deck);
          this.log(`复制了敌方牌库中的 ${op.n || 3} 张牌`);
          break;
        }
        case 'enemyHandToDeck': {
          const p = this.players[foe];
          if (p.hand.length) {
            const c = p.hand.splice(Math.floor(this.rng.next() * p.hand.length), 1)[0];
            c.loc = 'deck';
            p.deck.unshift(c);
            this.log(`敌方一张手牌被放回牌库顶`);
          }
          break;
        }
        case 'immune': {
          for (const u of this.unitsOf(me)) u._immune = true;
          this.log(`我方单位本回合免疫伤害`);
          break;
        }
        case 'weather': {
          const names = { sun: '晴天', storm: '风暴', rain: '降雨' };
          this.log(`天气：${names[op.kind] || '变化'}（本模拟不含天气联动）`);
          break;
        }
        case 'reveal': {
          const t = pickUnit('enemyUnit');
          if (t) { t._revealed = true; this.log(`揭示 ${t.name}（情报）`); }
          break;
        }
        case 'deployFromHand': {
          const p = this.players[me];
          const idx = p.hand.findIndex(c => ['infantry','tank','artillery','fighter','bomber'].includes(c.type) && (c.cost || 0) <= (op.maxCost || 99));
          if (idx >= 0) {
            const c = p.hand.splice(idx, 1)[0];
            c.loc = 'board';
            c.summonedTurn = this.turn;
            c.slot = this.claimSlot(p.board, null, RULES.MAX_ROW - 1);
            p.board.push(c);
            this.log(`${c.name} 从手牌直接部署`);
          } else this.log(`（手牌中没有符合条件的单位）`);
          break;
        }
        case 'mostHandDraws': {
          const h0 = this.players[0].hand.length, h1 = this.players[1].hand.length;
          if (h0 !== h1) this.draw(h0 > h1 ? 0 : 1, op.n || 2);
          else this.draw(me, op.n || 2);
          break;
        }
        case 'removeExpensive': {
          for (const i of [0, 1]) {
            const p = this.players[i];
            const sorted = p.hand.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0));
            for (let k = 0; k < Math.min(op.n || 2, sorted.length); k++) {
              const c = sorted[k];
              p.hand.splice(p.hand.indexOf(c), 1);
              c.loc = 'discard';
              p.discard.push(c);
            }
          }
          this.log(`双方各移除了最昂贵的 ${op.n || 2} 张手牌`);
          break;
        }
        case 'doubleStats': {
          for (const u of this.unitsOf(me)) {
            u.buffAttack += u.totalAttack;
            u.buffDefense += u.totalDefense;
          }
          this.log(`我方单位攻防翻倍`);
          break;
        }
        case 'damageRand': {
          const t = this.unitsOf(foe);
          if (t.length) {
            const n = op.min + Math.floor(this.rng.next() * (op.max - op.min + 1));
            this.damageCard(this.rng.pick(t), n, src);
            this.log(`造成 ${n} 点随机伤害`);
          }
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
          hqArmor: this.players[i].hqArmor || 0,
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

  /**
   * @param cardsJson 全部可打出的卡（单位/指令/反制）
   * @param hqsJson   全部 location 卡（官方 178 张，含 campaign 变体），即可选总部
   */
  function buildDb(cardsJson, hqsJson) {
    const byId = {};
    const cards = cardsJson;
    for (const c of cards) byId[c.id] = c;
    const list = hqsJson || [];
    const hqById = {};
    for (const h of list) hqById[h.id] = h;

    // 每个国家的默认总部：优先 isDefault，其次第一张可选的
    const hqs = {};
    for (const h of list) if (h.isDefault && h.playable && !hqs[h.nation]) hqs[h.nation] = h;
    for (const h of list) if (h.playable && !hqs[h.nation]) hqs[h.nation] = h;

    // 副国（France/Italy/Poland/Finland/Anzac）在官方没有 location 数据，
    // 运行时给一个 20 防的兜底总部，避免空引用（不进 data/hqs.json，不污染 1906 计数）
    const FALLBACK_NATIONS = ['Germany', 'USA', 'Soviet', 'Japan', 'Britain',
      'France', 'Italy', 'Poland', 'Finland', 'Anzac', 'Neutral'];
    for (const n of FALLBACK_NATIONS) {
      if (hqs[n]) continue;
      hqs[n] = {
        id: 'hq_fallback_' + n.toLowerCase(), name: 'FIELD HQ', type: 'hq', nation: n,
        rarity: 'HQ', set: 'HQ', cost: 0, defense: RULES.HQ_DEFENSE,
        text: '', keywords: [], image: 'Bunker_Blank.jpg', playable: false, synthetic: true,
      };
    }

    // 某国家全部可选总部（默认 HQ 在最前，其次按防御降序）
    const hqsOf = (nation) => list
      .filter(h => h.nation === nation && h.playable)
      .sort((a, b) => (b.isDefault - a.isDefault) || (b.defense - a.defense) || a.name.localeCompare(b.name));

    const nationOf = {};
    return { byId, cards, hqs, hqsOf, hqById, hqList: list, nationOf };
  }

  // ================= 构筑规则（对齐官方） =================
  // 稀有度上限：标准 4 / 限定 3 / 特殊 2 / 精英 1
  const RARITY_LIMITS = { Common: 4, Uncommon: 3, Rare: 2, Unique: 1 };
  // 官方五大主国（各自有 HQ/location 数据）
  const MAJOR_NATIONS = ['Germany', 'USA', 'Soviet', 'Japan', 'Britain'];
  // 副国（ally）：无 HQ，只能作为副阵营加入
  const ALLY_NATIONS = ['France', 'Italy', 'Poland', 'Finland', 'Anzac'];
  const ALLY_CARD_LIMIT = 12;          // 副国卡最多 12 张
  const ALLY_MAX_COST = 99;

  function rarityLimit(def) {
    return RARITY_LIMITS[(def && def.rarity) || 'Common'] || 2;
  }
  function isEliteCard(def) {
    return !!def && (def.rarity === 'Unique' || def.rarity === 'Elite');
  }

  /**
   * 校验卡组是否合法（主国 + 副国 + 中立）：
   * - 恰好 DECK_SIZE 张
   * - 单卡张数 ≤ 稀有度上限
   * - 只能带 主国 / 副国 / 中立 的卡
   * - 副国卡 ≤ 12 张，且不得是精英/特殊精英
   */
  function validateDeck(ids, main, ally, db) {
    const errors = [];
    const warnings = [];
    const counts = {};
    let allyCards = 0;
    const list = ids || [];
    for (const id of list) {
      const d = db.byId[id];
      if (!d) { warnings.push(`卡牌 ${id} 不在卡库中，将被忽略`); continue; }
      counts[id] = (counts[id] || 0) + 1;
      const limit = rarityLimit(d);
      if (counts[id] > limit) errors.push(`${d.name} 超过 ${limit} 张上限`);
      const isMain = d.nation === main;
      const isAlly = !!ally && d.nation === ally;
      const isNeutral = d.nation === 'Neutral';
      if (!isMain && !isAlly && !isNeutral) {
        errors.push(`${d.name} 属于 ${d.nation}，不在 ${main}${ally ? ' / ' + ally : ''} / 中立 之内`);
      }
      if (isAlly && !isNeutral) {
        allyCards++;
        if (isEliteCard(d)) errors.push(`副国不能携带精英卡：${d.name}`);
      }
    }
    if (list.length !== RULES.DECK_SIZE) {
      errors.push(`卡组需要 ${RULES.DECK_SIZE} 张，当前 ${list.length} 张`);
    }
    if (ally && allyCards > ALLY_CARD_LIMIT) {
      errors.push(`副国卡 ${allyCards} 张，超过 ${ALLY_CARD_LIMIT} 张上限`);
    }
    return {
      ok: errors.length === 0, errors, warnings,
      total: list.length, allyCards, unique: Object.keys(counts).length, counts,
    };
  }

  // Auto-build a simple deck for a nation (39 cards, curve based).
  function autoDeck(nation, db, rng, opts) {
    rng = rng || makeRng(Date.now() % 2147483647);
    opts = opts || {};
    const ally = opts.ally && ALLY_NATIONS.includes(opts.ally) ? opts.ally : null;
    const playable = (c) => c.cost > 0 && c.cost <= 7 &&
      (c.nation === nation || c.nation === 'Neutral' || (ally && c.nation === ally)) &&
      (!ally || c.nation !== ally || !isEliteCard(c));   // 副国不带精英
    const pool = db.cards.filter(playable);
    const units = pool.filter(c => ['infantry', 'tank', 'artillery', 'fighter', 'bomber'].includes(c.type));
    const orders = pool.filter(c => c.type === 'order');
    const gotchas = pool.filter(c => c.type === 'gotcha');
    const maxCopies = RARITY_LIMITS;
    let allyUsed = 0;
    const counts = {};
    const add = (c) => {
      if (!c) return false;
      const max = maxCopies[c.rarity] || 2;
      if ((counts[c.id] || 0) >= max) return false;
      // 副国卡上限 12 张
      if (ally && c.nation === ally && allyUsed >= ALLY_CARD_LIMIT) return false;
      counts[c.id] = (counts[c.id] || 0) + 1;
      if (ally && c.nation === ally) allyUsed++;
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
    // 9 orders + 2 countermeasures（官方卡组是带反制指令的）
    for (let i = 0; i < 9; i++) {
      for (let t = 0; t < 12; t++) {
        const c = pickByCost(orders);
        if (c && add(c)) { deck.push(c.id); break; }
      }
    }
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 12; t++) {
        const c = pickByCost(gotchas);
        if (c && add(c)) { deck.push(c.id); break; }
      }
    }
    return deck.slice(0, RULES.DECK_SIZE);
  }

  return {
    RULES, NATION_CODE, DEFAULT_HQ_CODE,
    Game, CardInst, makeRng, parseClauses, parseDeckCode, buildDb, autoDeck,
    validateDeck, rarityLimit, isEliteCard, RARITY_LIMITS, MAJOR_NATIONS, ALLY_NATIONS, ALLY_CARD_LIMIT,
  };
});
