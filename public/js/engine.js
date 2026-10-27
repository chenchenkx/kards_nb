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
      this.maxDef = def.defense || 0;    // 原始印刷生命（受损卡面焦黑比例用）
      this.range = def.range || 1;
      this.text = def.text || '';
      this.keywords = new Set((def.keywords || []).map(k => String(k).toLowerCase()));
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
      // 手牌状态与伤害转移（文本级静态监听，不走 op 解析）
      this._handWatch = parseHandWatch(this.text);
      this._redirectName = parseRedirect(this.text);
    }
    get totalAttack() {
      if (this._useDefenseAsAttack) return this.totalDefense;
      return Math.max(0, this.attack + this.buffAttack);
    }
    get totalDefense() { return this.defense + this.buffDefense; }
    /** 实际出牌费用：支持手牌费用增减（_costMod）、Develop 免费等 */
    get effCost() { return Math.max(0, (this.cost || 0) + (this._costMod || 0)); }
    /** 实际行动费用：支持临时设定（_opCostSet）与增减（_opCostMod） */
    get effOpCost() {
      if (this._opCostSet != null) return Math.max(0, this._opCostSet);
      const g = this._game;
      const aura = (g && g.teamAuraFor) ? g.teamAuraFor(this, 'operate') : 0;
      return Math.max(0, (this.opCost || 0) + (this._opCostMod || 0) + aura);
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
        totalAttack: this.totalAttack, totalDefense: this.totalDefense, maxDef: this.maxDef,
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
    let prevCond = null;      // 上一句已识别的条件，供 "if not." 反指
    for (const sent of splitSentences(text)) {
      let kind = 'static', body = sent;
      const m = /^(Deployment|Destruction|Reveal|Ambush|Shock|Pincer|Forecast)\s*:\s*/i.exec(sent);
      if (m) {
        const k = m[1].toLowerCase();
        // Pincer 单独成为一类：只有本回合打出第 2 张及以上的卡才生效
        kind = k === 'deployment' ? 'deployment' : k === 'destruction' ? 'destruction'
             : k === 'pincer' ? 'pincer' : 'static';
        body = sent.slice(m[0].length);
      }
      const clause = { kind, text: sent, cond: null, ops: parseOps(body) };
      if (clause.ops.length) clauses.push(clause);
      else {
        // try whole-sentence parse (e.g. "When X, Y." trigger patterns)
        // 前缀（Deployment:/Pincer: 等）已剥离时用 body 解析，移植回 kind
        const trig = parseTriggerSentence(kind !== 'static' || body !== sent ? body : sent);
        if (trig) {
          const arr = Array.isArray(trig) ? trig : [trig];
          if (kind !== 'static') for (const t2 of arr) t2.kind = kind;
          clauses.push(...arr);
          continue;
        }
      }
      // "if not."（如 SPITFIRE "Gets Fury if not."）→ 反指上一句条件
      if (/\bif not\b\s*\.?\s*$/i.test(sent)) {
        const target = clause.ops.length ? clause : clauses[clauses.length - 1];
        if (target) for (const o of target.ops) {
          if (o.cond && o.cond.c === 'none') {
            o.cond = prevCond ? { ...prevCond, neg: !prevCond.neg } : null;
          }
        }
      }
      for (const o of clause.ops) if (o.cond && o.cond.c !== 'none') prevCond = o.cond;
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

  /**
   * 条件尾巴解析器：把 "if/when" 后面的条件文本解析成 evalCond 可用的 cond。
   * 识别不了的条件返回 null —— 保持旧行为（效果照常生效），绝不静默改变语义。
   * 支持取反：开头的 "not" → { neg: true }。
   */
  function parseCondTail(s) {
    let t = String(s || '').replace(/[.!?]+$/, '').trim();
    if (!t) return null;
    const neg = /^not\b/i.test(t);
    t = t.replace(/^not\b\s*/i, '').trim();
    if (!t) return { c: 'none', neg };      // "if not." —— 指代上一句的条件（parseClauses 里回填）
    const KW = '(blitz|guard|fury|smokescreen|ambush|shock|covert|mobilize|alpine|pincer)';
    const TYPE = '(air|ground|infantry|tanks?|artillery|fighters?|bombers?)';
    let m = new RegExp('(?:the )?enemy controls? an? ' + KW + '(?: unit)?', 'i').exec(t);
    if (m) return { c: 'hasKw', side: 'enemy', kw: m[1].toLowerCase(), neg };
    m = new RegExp('(?:the )?enemy controls? an? ' + TYPE + '(?: units?)?', 'i').exec(t);
    if (m) return { c: 'hasType', side: 'enemy', type: m[1].toLowerCase().replace(/s$/, ''), neg };
    m = new RegExp('you controls? an? ' + KW + '(?: unit)?', 'i').exec(t);
    if (m) return { c: 'hasKw', side: 'own', kw: m[1].toLowerCase(), neg };
    m = new RegExp('you controls? an? ' + TYPE + '(?: units?)?', 'i').exec(t);
    if (m) return { c: 'hasType', side: 'own', type: m[1].toLowerCase().replace(/s$/, ''), neg };
    return null;
  }

  /**
   * parseOps 包装层：
   * 1) 全局剥离 "if <条件>" —— 条件可识别时挂到本句所有 op 上（execOp 统一求值，
   *    条件不满足则整个 op 跳过并写日志）；不可识别则保持旧行为（不附加）。
   * 2) 含 "when <已知事件>" 的句子返回空，让 parseClauses 走 parseTriggerSentence，
   *    不再按静态效果在部署时无条件执行。
   */
  /** "对 X 造成伤害" 的目标类型归一（伤害修正用） */
  function dmgTargetOf(s) {
    const t = String(s || '').toLowerCase();
    if (/\bhqs?\b|headquarter/.test(t)) return 'hq';
    if (/\bair\b|fighter|bomber/.test(t)) return 'air';
    if (/\bground\b/.test(t)) return 'ground';
    if (/tank/.test(t)) return 'tank';
    if (/infantry/.test(t)) return 'infantry';
    if (/artillery/.test(t)) return 'artillery';
    if (/units?|enem/.test(t)) return 'all';
    return null;
  }

  /** "If in your hand, this unit costs N less/more each time <事件>" → 手牌监听 */
  function parseHandWatch(text) {
    const m = /if in your hand,?\s*(?:this unit|reduce)\s*(?:costs?|cost)\s*(\d+)?\s*(less|more)?\s*each time (.+?)\.?$/i.exec(String(text || ''));
    if (!m) return null;
    const n = m[1] ? +m[1] : 1;
    const delta = m[2] && /more/i.test(m[2]) ? n : -n;
    const tail = m[3].toLowerCase();
    let event = null;
    if (/you (?:give|play) an? order|you play an? order/.test(tail)) event = 'order';
    else if (/your countermeasure triggers/.test(tail)) event = 'gotcha';
    else if (/you lose a unit/.test(tail)) event = 'ownUnitLost';
    else if (/your hq takes (?:friendly )?damage/.test(tail)) event = 'ownHqDamaged';
    else if (/the enemy draws/.test(tail)) event = 'enemyDraw';
    else if (/enemy countermeasure triggers/.test(tail)) event = 'enemyGotcha';
    if (!event) return null;
    return { event, delta };
  }

  /** "对 X 的伤害转移给本单位" */
  function parseRedirect(text) {
    const m = /damage to (.+?) is dealt to this unit instead/i.exec(String(text || ''));
    return m ? m[1].trim() : null;
  }

  /** 已知触发事件词汇表：命中才把 "when" 句让路给触发解析器（防回归） */
  const TRIGGER_EVENT_RE = new RegExp([
    'destroys? (?:a |an |another |the )?(?:enemy )?unit',
    'attacks? and destroys? .*unit',
    'this unit is dealt damage',
    'moves? into the frontline',
    'you deploy (?:or add |another )?(?:an? )?[a-z]+ unit',
    'you deploy another unit',
    'you play an? [a-z]+ card',
    'your hq takes damage',
    'your hq gains? (?:defense|defence)',
    '(?:targeted|chosen) unit deals? damage',
    'attack is \\d+\\+',
    'the enemy (?:deploys|plays)',
    'this unit becomes veteran',
    'a unit becomes veteran',
    'an? enemy unit is pinned',
    'a (?:ground |air )?unit retreats',
    'an? (?:enemy )?unit is destroyed',
    'undestroyed unit leaves the battlefield',
    'survives? combat',
    'the enemy draws',
    'end of turn', 'start of turn',
    'this unit attacks',
    'this unit (?:is destroyed|dies)',
  ].join('|'), 'i');

  function parseOps(s) {
    let t0 = String(s || '').replace(/[\u2019\u2018]/g, "'").trim();

    // ---- 二选一必须最先处理 ----
    // 否则 "Choose one - add X to your hand OR add Y to your hand" 会被
    // 后半段的 "add … to your hand" 模式截走，只剩一半效果。
    const chm = /^choose\s*(?:one|1)\s*(?:[-\u2013:]\s*)?(.+)$/i.exec(t0);
    if (chm) {
      const body = chm[1].trim();
      // 官方用大写 OR 分隔；个别卡写小写 or
      let parts = body.split(/\s+OR\s+/);
      if (parts.length !== 2) parts = body.split(/\s+or\s+/i);
      if (parts.length === 2) {
        const clean = (txt) => String(txt).trim().replace(/[.。]$/, '');
        const a = clean(parts[0]), b = clean(parts[1]);
        let oa = parseOps(a), ob = parseOps(b);
        // 官方写法常省略重复成分："shuffle A OR B into your deck" / "Deal 5 damage to all ground units OR air units"
        if (!oa.length || !ob.length) {
          const verb = /^(shuffle|add|deal|give|draw|destroy|remove|gain|set|repair|discard|put|return)\b\s*/i.exec(a);
          const tailRx = /((?:to|into|from)\s+(?:your|the|owner's)?\s*(?:hand|deck|play|battlefield)[a-z ]*)$/i;
          const tA = tailRx.exec(a), tB = tailRx.exec(b);
          if (!ob.length && verb && !new RegExp('^' + verb[1], 'i').test(b)) {
            const b2 = verb[1] + ' ' + b;
            const o2 = parseOps(b2);
            if (o2.length) { ob = o2; parts[1] = b2; }
          }
          if (!ob.length && tA) {
            const b2 = b + ' ' + tA[1];
            const o2 = parseOps(b2);
            if (o2.length) { ob = o2; parts[1] = b2; }
          }
          if (!oa.length && tB) {
            const a2 = a + ' ' + tB[1];
            const o2 = parseOps(a2);
            if (o2.length) { oa = o2; parts[0] = a2; }
          }
          if (!oa.length && verb) {
            const a2 = verb[1] + ' ' + a;
            const o2 = parseOps(a2);
            if (o2.length) { oa = o2; parts[0] = a2; }
          }
        }
        if (oa.length && ob.length) {
          return [{ op: 'choose', options: [
            { text: clean(parts[0]), ops: oa },
            { text: clean(parts[1]), ops: ob },
          ] }];
        }
      }
    }

    let cond = null;
    if (/\bif\b/i.test(t0)) {
      const parts = t0.split(/\bif\b/i);
      const c = parseCondTail(parts.slice(1).join(' if '));
      if (c) { cond = c; t0 = parts[0].trim(); }
    }
    let ops;
    if (cond === null && /\bwhen\b/i.test(t0) && TRIGGER_EVENT_RE.test(t0)) {
      ops = [];                              // 让路给触发句解析
    } else {
      ops = parseOpsRaw(t0, String(s || ''));
    }
    if (cond) for (const o of ops) if (!o.cond) o.cond = cond;
    return ops;
  }

  /** 光环主语短语 → 筛选条件（"other tanks" / "ground units with 4 or more attack"） */
  function auraFilter(subj) {
    const t = String(subj || '').toLowerCase();
    const f = {};
    if (/\bother\b/.test(t)) f.other = true;
    if (/\bground\b/.test(t)) f.ground = true;
    if (/\bair\b/.test(t)) f.air = true;
    if (/infantry/.test(t)) f.type = 'infantry';
    else if (/tank/.test(t)) f.type = 'tank';
    else if (/artillery/.test(t)) f.type = 'artillery';
    else if (/fighter/.test(t)) f.type = 'fighter';
    else if (/bomber/.test(t)) f.type = 'bomber';
    const nat = /(german|soviet|american|british|japanese|french|italian|polish|finnish)/.exec(t);
    if (nat) f.nation = NAT_MAP[nat[1]];
    const minAtk = /(\d+) or more attack/.exec(t);
    if (minAtk) f.minAttack = +minAtk[1];
    return f;
  }

  /** "equal to ..." 表达式 → 引擎可算的 calc 键 */
  function calcFromText(s) {
    const t = String(s || '').toLowerCase();
    if (/unspent kredit/.test(t)) return { key: 'kredits' };
    if (/cards? in (?:the )?enemy hand/.test(t)) return { key: 'enemyHandSize' };
    if (/highest attack/.test(t)) return { key: 'highestOwnAttack' };
    if (/german tanks in the frontline/.test(t)) return { key: 'germanTankCost' };
    if (/its attack|this unit's attack/.test(t)) return { key: 'atk' };
    if (/kredits spent/.test(t)) return { key: 'kreditsSpent' };
    if (/cards? in your hand/.test(t)) return { key: 'ownHandSize' };
    if (/number of (?:your |friendly )?units|friendly units you (?:control|have)/.test(t)) return { key: 'ownUnitCount' };
    if (/damage (?:taken|dealt) to your hq/.test(t)) return { key: 'hqDamageThisTurn' };
    const n = /(\d+)/.exec(t);
    return { n: n ? +n[1] : 0 };
  }

  function parseOpsRaw(s, orig) {
    const ops = [];
    const t = String(s || '').replace(/[\u2019\u2018]/g, "'").trim();
    const origT = String(orig || s || t).replace(/[\u2019\u2018]/g, "'");

    // "Deal N damage to ..." (several target forms)
    let m = /\bdeal (\d+) damage to (?:an? |the |each |target )?([a-z \-+]*?)(?:\.|,|$)/i.exec(t);
    if (m) {
      const n = +m[1];
      let target = (m[2] || '').trim().toLowerCase();
      let tgt = 'unit';
      if (/each enem|all enem/.test(target)) tgt = 'allEnemies';
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

    // ================= 反向语序与动态数值（批量补齐） =================
    // "The enemy HQ takes N damage" / "Your HQ takes N damage"
    m = /(?:the )?enemy hq takes (\d+) damage/i.exec(t);
    if (m) return [{ op: 'damage', n: +m[1], target: 'enemyHQ' }];
    m = /your hq takes (\d+) damage/i.exec(t);
    if (m) return [{ op: 'damage', n: +m[1], target: 'ownHQDamage' }];
    m = /(?:target|an? enemy|the|a) (?:unit|ground unit|infantry|tank|artillery|air unit) takes (\d+) damage/i.exec(t);
    if (m) return [{ op: 'damage', n: +m[1], target: 'unit' }];

    // "Deal damage to X equal to <表达式>"（动态伤害）
    m = /deal damage to (?:an? |the |target |each )?(enemy hq|hq|unit|enemy unit|all enemy units) equal to ([^.,;]+)/i.exec(t);
    if (m) {
      const who = m[1].toLowerCase();
      const tgt = (who === 'enemy hq' || who === 'hq') ? 'enemyHQ'
                : who === 'all enemy units' ? 'allEnemyUnits' : 'unit';
      const c = calcFromText(m[2]);
      return [{ op: 'damage', n: c.n || 0, calc: c.key, target: tgt }];
    }

    // 摧毁溢出伤害转移到敌方总部
    if (/deal excess damage to the enemy hq/i.test(t)) return [{ op: 'excessToHq' }];
    // 攻击伤害同时打到敌方总部（PANTHER D）
    if (/the damage it deals is also dealt to the enemy hq/i.test(t)) return [{ op: 'splashHq' }];
    // 受到伤害时总部回等量防御（461st / 845th RIFLES）
    if (/your hq gets equal amount of defense/i.test(t)) return [{ op: 'hqGainFromDamage' }];
    // 总部受到的伤害转给本单位（ROYAL ULSTER RIFLES）
    if (/deal that amount of damage to this unit instead/i.test(t)) return [{ op: 'redirectToSelf' }];
    // 总部回血加成（111th INDIAN BRIGADE）
    m = /it gains (\d+) extra defense/i.exec(t);
    if (m) return [{ op: 'hqHealBonus', n: +m[1] }];
    // 阵亡后回到牌库顶（T-28）
    if (/put it on top of (?:owner's |its owner's )?deck/i.test(t)) return [{ op: 'toDeckTop' }];
    // 抽一张弃一张（34th INFANTRY REGIMENT）
    if (/draw and discard the top card/i.test(t)) return [{ op: 'cycleTop' }];
    // 攻击力翻倍（RED BULL）
    if (/double the attack of this unit/i.test(t)) return [{ op: 'doubleAttack' }];
    // 随机友方空中单位获得免疫（P-61 BLACK WIDOW）
    if (/give a random friendly air unit immune/i.test(t)) return [{ op: 'grantImmune', target: 'randomFriendlyAir' }];
    // 重置防守方攻击（37mm M1 AA GUN）
    if (/reset the attack of the defending unit/i.test(t)) return [{ op: 'resetDefender' }];
    // 敌方手牌整体涨价（LANCASTER B.III）
    m = /cards in enemy hand cost \+(\d+)/i.exec(t);
    if (m) return [{ op: 'handTaxAll', n: +m[1] }];
    // 敌方弃牌（随机 / 指定兵种）
    if (/the enemy (?:must )?discards? (?:a |one )?(?:random )?card/i.test(t)) {
      return [{ op: 'discard', n: 1, random: true }];
    }
    m = /the enemy (?:must )?discards? (?:a |one )?(?:random )?(bomber|fighter|infantry|tank|artillery|order)/i.exec(t);
    if (m) return [{ op: 'discard', n: 1, random: true, typed: m[1].toLowerCase() }];

    // ---- 老兵化（"Becomes Veteran when ..." 的效果段）----
    if (/^becomes? veteran\b/i.test(t)) return [{ op: 'veteran' }];
    // ---- 每次攻击后行动费 +N（BF 110 C / PANZER IV-J / KATZMANN）----
    m = /increase (?:the )?operation cost by (\d+)(?: until end of turn)? (?:after|each time)/i.exec(t);
    if (m) return [{ op: 'opCostOnAttack', n: +m[1] }];
    // ---- 移动后仍可攻击 ----
    if (/can move and attack during the same turn/i.test(t)) return [{ op: 'moveAndAttack' }];
    // ---- 击杀后可再次行动（WINDHUND DIVISION）----
    if (/can operate again after it attacks and destroys a unit/i.test(t)) return [{ op: 'operateOnKill' }];
    // ---- 攻击后离场，下回合开始归来（SALAMANDER）----
    if (/remove from the battlefield after it attacks/i.test(t)) return [{ op: 'bunkerAfterAttack' }];
    // ---- 队伍级光环：关键词 / 行动费 / 部署费 ----
    m = /^(all )?(your|enemy) (other )?(.{0,44}?) (?:units? |cards? )?(?:in hand and deck )?(?:have|has|gain|gains|gets?) (blitz|guard|fury|smokescreen|ambush|shock)\b/i.exec(t);
    if (m) {
      return [{ op: 'teamAura', kind: 'keyword', kw: m[5].toLowerCase(), side: m[2].toLowerCase() === 'enemy' ? 'enemy' : 'own', f: auraFilter(m[3] + ' ' + m[4]) }];
    }
    m = /^(all )?(your|enemy) (other )?(.{0,44}?) (?:units? )?(?:in hand and deck )?(?:operate|operation cost) (?:for )?(?:free|(\+?)(\d+) (less|more))/i.exec(t);
    if (m) {
      const free = /free/i.test(m[0]);
      const n = free ? -99 : (m[7] ? +m[7] : 0);
      const delta = free ? -50 : (/less/i.test(m[8]) ? -n : n);
      return [{ op: 'teamAura', kind: 'operate', delta, side: m[2].toLowerCase() === 'enemy' ? 'enemy' : 'own', f: auraFilter(m[3] + ' ' + m[4]) }];
    }
    m = /^(all )?(your|enemy) (other )?(.{0,44}?) (?:units? |cards? )?(?:in hand and deck )?costs? (\+?)(\d+) (less|more)?(?: to deploy)?/i.exec(t);
    if (m) {
      const n = +m[6];
      const delta = /less/i.test(m[7] || '') ? -n : n;
      return [{ op: 'teamAura', kind: 'deploy', delta, side: m[2].toLowerCase() === 'enemy' ? 'enemy' : 'own', f: auraFilter(m[3] + ' ' + m[4]) }];
    }
    // ---- 被本单位攻击的单位失去关键词（T19 HOWITZER）----
    m = /units? attacked by [a-z0-9 .'\-]+ lose (guard|blitz|fury|smokescreen|ambush|shock)/i.exec(t);
    if (m) return [{ op: 'stripKwOnAttack', kw: m[1].toLowerCase() }];
    // ---- 伤害等于自身攻击打到敌方总部（TSURUGA 的 Destruction）----
    if (/deal damage equal to (?:its|this unit's) attack to the enemy hq/i.test(t)) return [{ op: 'damage', n: 0, calc: 'atk', target: 'enemyHQ' }];
    // ---- 从牌库抽指定名字的卡（24th CAVALRY / 32nd INFANTRY）----
    m = /draw an? ([A-Z0-9][A-Z0-9 .'\-]+?) from your deck/i.exec(origT);
    if (m) return [{ op: 'addHand', name: m[1].trim(), fromDeck: true }];
    // ---- 抽多兵种（GATHERING STORM）----
    m = /draw an? random ([a-z, ]+?) from your deck/i.exec(t);
    if (m && /,|\band\b/.test(m[1])) {
      const types = m[1].split(/,|\band\b/).map(s => s.trim()).filter(s => /^(infantry|tank|artillery|fighter|bomber)$/.test(s));
      if (types.length) return [{ op: 'drawTypedMulti', types }];
    }
    // ---- 条件关键词（"Has Blitz if it has 3 or more attack"）----
    m = /^(?:it )?(?:has|gets?|gains?) (blitz|guard|fury|smokescreen|ambush|shock) if it has (\d+) or more attack/i.exec(t);
    if (m) return [{ op: 'keyword', kws: [m[1].toLowerCase()], target: 'self', self: true, cond: { c: 'attackAtLeast', n: +m[2] } }];
    // ---- 总部减伤 / 下限 / 烟幕 ----
    m = /your hq takes (\d+) less damage for each of your units with (\d+) or more attack/i.exec(t);
    if (m) return [{ op: 'hqDmgReduce', n: +m[1], per: +m[2] }];
    m = /your hq cannot lose more than (\d+) defense each turn/i.exec(t);
    if (m) return [{ op: 'hqLossCap', n: +m[1] }];
    m = /your hq has (blitz|guard|fury|smokescreen|ambush|shock)/i.exec(t);
    if (m) return [{ op: 'hqKeyword', kws: [m[1].toLowerCase()] }];
    // ---- 全局出牌限制 ----
    if (/players can only give one order each turn/i.test(t)) return [{ op: 'orderLimit', n: 1 }];
    if (/the first card played by the enemy each turn costs double/i.test(t)) return [{ op: 'enemyFirstCardDouble' }];
    // "Deal damage to the enemy HQ equal to X"
    if (/deal damage to the enemy hq/i.test(t)) ops.push({ op: 'damage', n: 'atk', target: 'enemyHQ' });

    // "Destroy target X" / "Destroy a unit" / "Destroy an enemy unit"
    if (/\bdestroy\b/i.test(t)) {
      let tgt = /destroy that unit|destroy it\b/i.test(t) ? 'enemyUnit' : 'unit';
      if (/destroy this unit\b/i.test(t)) tgt = 'selfUnit';
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
    if (m) {
      ops.push({ op: 'hqDef', n: +m[1] });
      // 余句继续解析（DINGO："... and you draw a card"）
      const restQ = t.slice(m.index + m[0].length).trim();
      if (restQ) ops.push(...parseOps(restQ.replace(/^(?:and|then|,)\s*/i, '').replace(/^\./, '').trim()));
      return ops;
    }
    // 明确句式才算 HQ 加成："Your HQ gets +A+D" / "Give your HQ +A+D"
    // （旧兜底只要文本含 "your hq" 和一个 "+N" 就整句当 HQ 加成，
    //   会把 "Gets +1+2 if your HQ has defense over 20" 这类条件自我加成误判）
    m = /(?:your hq (?:gets|gains)|give your hq) \+(\d+)\+(\d+)/i.exec(t);
    if (m) { ops.push({ op: 'hqBuff', a: +m[1], d: +m[2] }); return ops; }

    // ================= 通用战斗/状态机制（覆盖高频未实现句式） =================
    // "Deals double damage against tanks" / "Deals +3 damage to air units / HQs"
    m = /\bdeals? double damage (?:against|to) ([a-z ]{3,18})/i.exec(t);
    if (m) { ops.push({ op: 'dmgMod', mult: 2, vs: dmgTargetOf(m[1]) }); return ops; }
    m = /\bdeals? \+?(\d+) (?:extra )?damage (?:to|against) ([a-z ]{3,20}?)(?:\.|,|$)/i.exec(t);
    if (m) {
      const vs = dmgTargetOf(m[2]);
      if (vs) { ops.push({ op: 'dmgMod', add: +m[1], vs }); return ops; }
    }
    // "Cannot / Can't be targeted by enemy orders"
    if (/can(?:no|')?t be targeted by enemy (orders|commands)/i.test(t)) {
      ops.push({ op: 'orderImmune' });
      return ops;
    }
    // "Cannot be pinned [or suppressed]"
    if (/can(?:no|')?t be (?:pinned|suppressed)(?: or (?:pinned|suppressed))?/i.test(t)) {
      ops.push({ op: 'pinImmune' });
      return ops;
    }
    // "Takes N less combat damage from ground units"
    m = /takes? (\d+) less combat damage from (ground|air) units/i.exec(t);
    if (m) { ops.push({ op: 'dmgTakenMod', minus: +m[1], vs: m[2].toLowerCase() }); return ops; }
    // "Cannot be attacked by ground units while in the support line"
    if (/can(?:no|')?t be attacked by ground units/i.test(t)) {
      ops.push({ op: 'groundProof' });
      return ops;
    }
    // "Gain two extra kredit slots" / "Gain an extra kredit slot"
    m = /gain (an? |two |three |\d+ )?(?:extra )?kredit slots?/i.exec(t);
    if (m) {
      const w = (m[1] || '').trim().toLowerCase();
      const n = w === 'two' ? 2 : w === 'three' ? 3 : /\d+/.test(w) ? +w : 1;
      ops.push({ op: 'slots', n });
      return ops;
    }
    // "Lose N kredits at the start of your next turn"
    m = /lose (\d+) kredits? at the start of your next turn/i.exec(t);
    if (m) { ops.push({ op: 'kreditsNextTurn', n: -Math.abs(+m[1]) }); return ops; }
    // "Cards in your hand cost N kredits"（统一设定手牌费用）
    m = /cards in your hand cost (\d+) kredits/i.exec(t);
    if (m) { ops.push({ op: 'handCostSet', n: +m[1] }); return ops; }
    // "Deploys for 0 kredits if a friendly unit was destroyed this turn"（出牌前判定）
    if (/deploys? for 0 kredits if a friendly unit was destroyed this turn/i.test(t)) {
      ops.push({ op: 'freeIfLost', marker: true });
      return ops;
    }

    // "-1 operation cost"（回合触发的简写）与 "reduce operation cost by N"
    m = /^\s*-(\d+) operation cost\b/i.exec(t) || /\b-(\d+) operation cost\b/i.exec(t);
    if (m) { ops.push({ op: 'opCostMod', n: -Math.abs(+m[1]) }); return ops; }
    // "Units attacked by this howitzer lose Guard"
    m = /attacked by (?:this|it)[a-z ]*?lose (guard|fury|smokescreen|blitz|ambush)/i.exec(t);
    if (m) { ops.push({ op: 'stripKwOnAttack', kw: m[1].toLowerCase() }); return ops; }
    // "Any unit that attacks this unit takes N damage"
    m = /(?:any )?unit that attacks this unit takes (\d+) damage/i.exec(t);
    if (m) { ops.push({ op: 'thorns', n: +m[1] }); return ops; }
    // "It costs the enemy N kredits to target or attack this unit"
    m = /costs? the enemy \+?(\d+) kredits to (?:target or attack|attack or target|target)/i.exec(t);
    if (m) { ops.push({ op: 'enemyTax', n: +m[1] }); return ops; }
    // "Reduce attack of this unit by N each time it attacks"
    m = /reduce (?:the )?attack of this unit by (\d+) each time/i.exec(t);
    if (m) { ops.push({ op: 'selfDrainOnAttack', n: +m[1] }); return ops; }

    // ================= Develop 变体 / Convert / HQ 限制 / 条件增伤 =================
    // "Develop CONVOY HX 175, THE DESERT RATS or FORTIFICATION."（多选一，随机入手）
    m = /^develop (.+?)\.?$/i.exec(t);
    if (m && !/^develop an? (?:british|us|german|soviet|japanese|italian|french|polish|finnish|navy|special)/i.test(t)) {
      const names = m[1].split(/\s*,\s*|\s+or\s+/i).map(s => s.trim()).filter(s => s && s.length > 2);
      if (names.length) { ops.push({ op: 'addHandAny', names }); return ops; }
    }
    // "At the end of turn, Convert into MOSQUITO F Mk II."
    m = /convert into (.+?)\.?$/i.exec(t);
    if (m) { ops.push({ op: 'convert', name: m[1].trim() }); return ops; }
    // "While in the frontline, your HQ cannot be reduced below 1 defense."
    m = /while in the frontline, your hq cannot be reduced below (\d+)/i.exec(t);
    if (m) { ops.push({ op: 'hqFloor', n: +m[1] }); return ops; }
    // "HQs cannot gain defense."
    if (/hqs? cannot gain defense/i.test(t)) { ops.push({ op: 'hqNoHeal' }); return ops; }
    // "Deals double damage if <条件>"
    m = /deals? double damage if (.+?)\.?$/i.exec(t);
    if (m) {
      const tail = m[1];
      let cond = null;
      if (/frontline is empty/i.test(tail)) cond = { c: 'frontlineEmpty' };
      else if (/kredit slots?/i.test(tail)) {
        const num = /\d+/.exec(tail);
        if (num) cond = { c: 'slotsAtMost', n: +num[0] };
      }
      ops.push({ op: 'dmgMod', mult: 2, vs: 'all', cond });
      return ops;
    }

    // ================= 限制类（不能弃牌/治疗/攻击/部署条件） =================
    if (/your cards cannot be discarded/i.test(t)) { ops.push({ op: 'noDiscard' }); return ops; }
    if (/^units cannot be repaired/i.test(t)) { ops.push({ op: 'noHealUnits' }); return ops; }
    m = /units with (\d+) or more attack cannot attack/i.exec(t);
    if (m) { ops.push({ op: 'blockHighAttack', n: +m[1] }); return ops; }
    m = /cannot be deployed if you have deployed a unit this turn/i.exec(t);
    if (m) { ops.push({ op: 'deployGate', kind: 'noUnitPlayed' }); return ops; }
    m = /cannot be deployed unless you have (\d+) or more kredit slots/i.exec(t);
    if (m) { ops.push({ op: 'deployGate', kind: 'slots', n: +m[1] }); return ops; }
    // "Draw two random 1-cost units from your deck"
    m = /draw (a|an|one|two|three|\d+) random (\d+)?-?cost ([a-z]+)s? from your deck/i.exec(t);
    if (m) {
      const w = m[1].toLowerCase();
      const n = w === 'two' ? 2 : w === 'three' ? 3 : /\d+/.test(w) ? +w : 1;
      ops.push({ op: 'drawFilter', type: m[3].toLowerCase().replace(/s$/, ''), cost: m[2] ? +m[2] : null, n });
      return ops;
    }

    // 手牌费用修正类（最左 / 首张指令 / 敌方手牌税）
    m = /the first order you play each turn costs? (\d+) less/i.exec(t);
    if (m) { ops.push({ op: 'firstOrderDiscount', n: -Math.abs(+m[1]) }); return ops; }
    m = /your left-?most card costs? (\d+) less/i.exec(t);
    if (m) { ops.push({ op: 'leftmostCost', n: -Math.abs(+m[1]) }); return ops; }
    m = /orders? in enemy hand costs? (\d+) more/i.exec(t);
    if (m) { ops.push({ op: 'enemyHandTax', type: 'order', n: +m[1] }); return ops; }
    m = /enemy countermeasures cost (\d+) more/i.exec(t);
    if (m) { ops.push({ op: 'enemyHandTax', type: 'gotcha', n: +m[1] }); return ops; }

    // 裸加成句式（Pincer: +2 attack. / +1+1）——无动词，只有数值
    m = /^\+(\d+) (attack|defense)\.?$/i.exec(t.trim());
    if (m) {
      ops.push({ op: 'buff', a: m[2] === 'attack' ? +m[1] : 0, d: m[2] === 'defense' ? +m[1] : 0, target: 'self', self: true });
      return ops;
    }
    m = /^\+(\d+)\+(\d+)\.?$/i.exec(t.trim());
    if (m) {
      ops.push({ op: 'buff', a: +m[1], d: +m[2], target: 'self', self: true });
      return ops;
    }
    // 相邻费用光环："Units to the left/right of this unit operate for N less/more"
    m = /units to the (left|right) of this unit operate for (\d+) (less|more)/i.exec(t);
    if (m) {
      ops.push({ op: 'auraOpCost', dir: m[1].toLowerCase(), n: m[3].toLowerCase() === 'less' ? -Math.abs(+m[2]) : +m[2] });
      return ops;
    }

    // "Your orders deal N damage" → 全局指令增伤
    m = /your orders deal \+?(\d+) damage/i.exec(t);
    if (m) { ops.push({ op: 'orderDmgMod', n: +m[1] }); return ops; }
    // "Damage dealt by this unit adds equal defense to your HQ"
    if (/damage dealt by this unit adds? (?:an )?equal (?:amount of )?defense to your hq/i.test(t)) {
      ops.push({ op: 'hqDrain' });
      return ops;
    }
    // "Units dealt combat damage by this unit are destroyed"
    if (/units? dealt combat damage by this unit (?:are|is) destroyed/i.test(t)) {
      ops.push({ op: 'destroyOnDamage' });
      return ops;
    }
    // "Reduce operation cost by N [if ...]" → 自身行动费减免
    m = /reduce (?:its |this unit's )?operation cost by (\d+)/i.exec(t);
    if (m) { ops.push({ op: 'opCostMod', n: -Math.abs(+m[1]) }); return ops; }
    // "Has Guard when it doesn't have Mobilize" → 条件关键词（否定条件）
    m = /has (blitz|guard|fury|smokescreen|ambush|shock|mobilize) (?:while|when) it (?:doesn't|does not) have (\w+)/i.exec(t);
    if (m) { ops.push({ op: 'keyword', kws: [m[1].toLowerCase()], target: 'self', self: true, cond: { c: 'hasKw', side: 'own', kw: m[2].toLowerCase(), neg: true, selfCheck: true } }); return ops; }

    // ================= 条件/触发式关键字授予（试玩报告 v9 缺口修复） =================    // 条件已由 parseOps 包装层剥离并挂到 op.cond；execOp 统一求值，不满足则跳过。
    // "Gets +2 defense and Guard [if ...]"（1097. VOLKSGRENADIER）
    // "Gets +1+1 and Guard ..."（456th RIFLE REGIMENT 等触发效果）
    m = /\b(?:gets?|gains?) \+?(\d+) (attack|defense)(?: and|,) ?(blitz|guard|fury|smokescreen|ambush|shock|alpine|pincer)\b/i.exec(t);
    if (m) {
      ops.push({ op: 'buff', a: m[2] === 'attack' ? +m[1] : 0, d: m[2] === 'defense' ? +m[1] : 0, target: 'self', self: true });
      ops.push({ op: 'keyword', kws: [m[3].toLowerCase()], target: 'self', self: true });
      return ops;
    }
    // "Gets +2+2 and Guard ..." / "Gets +2+2 [if ...]"（SPITFIRE Mk IIa）
    m = /\b(?:gets?|gains?) \+?(\d+)\+(\d+)(?: and|,) ?(blitz|guard|fury|smokescreen|ambush|shock)\b/i.exec(t);
    if (m) {
      ops.push({ op: 'buff', a: +m[1], d: +m[2], target: 'self', self: true });
      ops.push({ op: 'keyword', kws: [m[3].toLowerCase()], target: 'self', self: true });
      return ops;
    }
    // "Gets N attack and Guard"
    m = /\b(?:gets?|gains?) \+?(\d+) attack and (blitz|guard|fury|ambush|shock)\b/i.exec(t);
    if (m) {
      ops.push({ op: 'buff', a: +m[1], d: 0, target: 'self', self: true });
      ops.push({ op: 'keyword', kws: [m[2].toLowerCase()], target: 'self', self: true });
      return ops;
    }
    // "Has Blitz and Guard if ..." / "Gets X and Y"（条件由全局 if 剥离自动挂上）
    m = /\b(?:gets?|gains?|has|have) (blitz|guard|fury|smokescreen|ambush|shock) and (blitz|guard|fury|smokescreen|ambush|shock)\b/i.exec(t);
    if (m) {
      ops.push({ op: 'keyword', kws: [m[1].toLowerCase()], target: 'self', self: true });
      ops.push({ op: 'keyword', kws: [m[2].toLowerCase()], target: 'self', self: true });
      return ops;
    }
    // "it gets Fury until end of turn"（HUDSON Mk III 触发效果）
    m = /^(?:it |this unit )?(?:gets?|gains?) (blitz|guard|fury|smokescreen|ambush|shock) until/i.exec(t);
    if (m) {
      ops.push({ op: 'keyword', kws: [m[1].toLowerCase()], target: 'self', self: true, temp: true });
      return ops;
    }
    // "Gets Fury"（条件句剥离后剩余；无条件时等于部署即获得。SPITFIRE "Gets Fury if not."）
    m = /^(?:gets?|gains?) (blitz|guard|fury|smokescreen|ambush|shock)\b\.?$/i.exec(t);
    if (m) {
      ops.push({ op: 'keyword', kws: [m[1].toLowerCase()], target: 'self', self: true });
      return ops;
    }
    // "Your HQ gains Smokescreen until your next turn."（DEPTH CHARGES）
    m = /^(?:your |the )?hq gains? (blitz|guard|fury|smokescreen|ambush|shock) until your next turn/i.exec(t);
    if (m) {
      ops.push({ op: 'hqKeyword', kws: [m[1].toLowerCase()] });
      return ops;
    }

    // "Give [target] +X+Y" / "Gets +X+Y" / "Your units get +X+Y" / "Give your British units +2 defense"
    // 目标短语交给 describeTarget 一次性解析（含 with Guard / in the frontline / 国家名等修饰）。
    m = /(?:give|gives|gets|get|gains|gain|gaining|receive|receives|has|have) (?:a |an |the |target |random |all |another )?(friendly |enemy |random friendly |random enemy |your )?([a-z0-9 \-']{0,38}?) ?([+-]?\d+)[+\-]([+-]?\d+)/i.exec(t);
    if (m) {
      const who = ((m[1] || '') + ' ' + (m[2] || '')).toLowerCase();
      const f = describeTarget(who, t);
      ops.push({ op: 'buff', a: +m[3], d: +m[4], target: f.target, filters: f.filters,
                 temp: /until (?:the )?end of turn|this turn|until your next turn/i.test(origT),
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
      ops.push({ op: 'keyword', kws, target: tgt, temp: /this turn/i.test(origT) });
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
      // "Add a X and a Y to your hand" → 两张都加入
      const parts = m[2].split(/\s+and\s+(?:an?\s+)?/i).map(s => s.trim()).filter(Boolean);
      if (parts.length > 1) {
        for (const nm of parts) ops.push({ op: 'addHand', name: nm, random: !!m[1] });
        return ops;
      }
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

    // ================= 扩展模式（效果覆盖率 90% 计划，见 AI-PROMPT.md 第四节） =================

    // --- 条件自我加成（兼容兜底：仅当条件无法识别、if 尾巴未被剥离时才会走到） ---
    m = /\b(?:gets?|gains?) \+?(\d+) (attack|defense)(?: and (blitz|guard|fury|smokescreen|ambush|shock))? if (?:you|the enemy) (?:control|controls)/i.exec(t);
    if (m) {
      // 官方是条件加成；本引擎无持续重算，简化为进场一次性生效
      ops.push({ op: 'buff', a: m[2] === 'attack' ? +m[1] : 0, d: m[2] === 'defense' ? +m[1] : 0,
                 target: 'self', approx: 'condition ignored' });
      if (m[3]) ops.push({ op: 'keyword', kws: [m[3].toLowerCase()], target: 'self', self: true });
      return ops;
    }
    m = /\b(?:gets?|gains?) (blitz|guard|fury|smokescreen|ambush|shock) if\b/i.exec(t);
    if (m) { ops.push({ op: 'keyword', kws: [m[1].toLowerCase()], target: 'self', self: true }); return ops; }
    m = /\b(?:gets?|gains?) \+?(\d+) attack and (blitz|guard|fury|ambush|shock)\b/i.exec(t);
    if (m) {
      ops.push({ op: 'buff', a: +m[1], d: 0, target: 'self' });
      ops.push({ op: 'keyword', kws: [m[2].toLowerCase()], target: 'self', self: true });
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
    m = /(?:give|gives|gets|get|gains|gain|gaining|receive|receives|has|have) (?:a |an |the |target |random |all |another )?(friendly |enemy |random friendly |random enemy |your )?([a-z \-']{0,28}?) ?\+?([+-]?\d+) (attack|defense)/i.exec(t);
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
    if (m) {
      // "gains defense equal to X" 是**增加**而非设为（8e MAROCAINS：等于部署单位行动费）
      if (/its operation cost/i.test(m[1])) ops.push({ op: 'hqDef', calc: { type: 'deployedOpCost' } });
      else ops.push({ op: 'hqDef', n: 0, calc: describeCount(m[1]) });
      return ops;
    }

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
  // ---- 触发事件前缀表（先长后短，命中即停）：返回 { event, cond, len } ----
  const NAT_MAP = { german: 'Germany', soviet: 'Soviet', american: 'USA', us: 'USA', british: 'Britain',
                    japanese: 'Japan', french: 'France', polish: 'Poland', finnish: 'Finland',
                    italian: 'Italy', anzac: 'Anzac' };
  const TRIGGER_EVENTS = [
    { re: /this unit attacks? and destroys? (?:a |an |another |the )?(?:enemy )?(ground )?unit\b/i, ev: 'selfKill' },
    { re: /this unit destroys? (?:a |an |another |the )?(?:enemy )?(ground )?unit\b/i, ev: 'selfKill' },
    { re: /you attack and destroy a ground unit\b/i, ev: 'selfKill' },
    { re: /this unit attacks? (?:the )?enemy(?:'s)? hq\b/i, ev: 'selfAttackHQ' },
    { re: /this unit damages? (?:a |an |the )?(?:enemy )?hq\b/i, ev: 'selfDamageHq' },
    { re: /this unit attacks? (?:an? |the )?pinned unit\b/i, ev: 'selfAttack', cond: { c: 'targetPinned' } },
    { re: /this unit attacks?\b/i, ev: 'selfAttack' },
    { re: /this unit is dealt damage\b|^this unit takes damage\b/i, ev: 'selfDamaged' },
    { re: /this unit (?:is destroyed|dies)\b/i, ev: 'selfDestroy' },
    { re: /this unit moves? into the frontline\b/i, ev: 'selfMoveFront' },
    { re: /a friendly (?:german|soviet|british|american|japanese|french|italian|polish|finnish) unit moves? into the frontline\b/i,
      ev: 'allyMoveFront',
      cond: m => {
        const nat = /(german|soviet|british|american|japanese|french|italian|polish|finnish)/.exec(m[0].toLowerCase());
        return { c: 'eventNation', nation: NAT_MAP[nat[1]] || nat[1] };
      } },
    { re: /this unit becomes veteran\b/i, ev: 'becomesVeteran' },
    // --- 新增事件（v33 批量补齐）：任意单位/敌方单位维度 ---
    { re: /an? enemy unit is pinned\b/i, ev: 'unitPinned' },
    { re: /a (?:ground |air |friendly )?unit retreats?\b/i, ev: 'unitRetreated' },
    { re: /a unit becomes veteran\b/i, ev: 'becomesVeteran' },
    { re: /you deploy another unit with (\d+) or more attack\b/i, ev: 'ownDeploy', cond: m => ({ c: 'eventAttackLeast', n: +m[1] }) },
    { re: /you deploy another unit\b/i, ev: 'ownDeploy' },
    { re: /you deploy (?:or add )?(?:an? )?(non-)?(german|soviet|british|american|japanese|french|italian|polish|finnish) unit\b/i,
      ev: 'ownDeploy',
      cond: m => {
        const nat = /(german|soviet|british|american|japanese|french|italian|polish|finnish)/.exec(m[0].toLowerCase());
        return { c: 'eventNation', nation: NAT_MAP[nat[1]] || nat[1], neg: !!m[1] };
      } },
    { re: /you deploy (?:or add )?(?:an? )?(infantry|tank|artillery|fighter|bomber) unit\b/i, ev: 'ownDeploy', cond: m => ({ c: 'eventType', type: m[1].toLowerCase() }) },
    { re: /(?:this unit|it) survives? combat\b/i, ev: 'selfSurvive' },
    { re: /a friendly unit with heavy armor survives? combat\b/i, ev: 'allySurvive', cond: m => ({ c: 'eventHeavyArmor' }) },
    { re: /a friendly unit survives? combat\b/i, ev: 'allySurvive' },
    { re: /a friendly (german|soviet|british|american|japanese|french|italian|polish|finnish) (air|ground) unit is destroyed\b/i,
      ev: 'unitDestroyed',
      cond: m => ({ c: 'eventAnd', and: [
        { c: 'eventOwnerFriendly' }, { c: 'eventNation', nation: NAT_MAP[m[1].toLowerCase()] || m[1] }, { c: 'eventType', type: m[2].toLowerCase() },
      ] }) },
    { re: /you deploy another unit with operation cost (\d+) or more\b/i, ev: 'ownDeploy', cond: m => ({ c: 'eventOpCostLeast', n: +m[1] }) },
    { re: /an? (?:enemy )?unit is destroyed\b/i, ev: 'unitDestroyed' },
    { re: /an? undestroyed unit leaves the battlefield\b/i, ev: 'unitDestroyed' },
    { re: /you play an? ([a-z]+) card\b/i, ev: 'ownCardPlayed', cond: m => ({ c: 'nationPlayed', nation: NAT_MAP[(m[1] || '').toLowerCase()] || m[1] }) },
    { re: /you deploy or add a guard unit\b/i, ev: 'ownGuardDeploy' },
    { re: /you give an? order\b/i, ev: 'ownOrder' },
    { re: /your hq takes damage\b/i, ev: 'ownHqDamaged' },
    { re: /your hq gains? (?:defense|defence)\b/i, ev: 'ownHqHealed' },
    { re: /(?:the )?enemy hq takes damage\b/i, ev: 'enemyHqDamaged' },
    { re: /the enemy deploys?\b/i, ev: 'enemyDeploy' },
    { re: /the enemy (?:plays?|gives? an? order)\b/i, ev: 'enemyOrder' },
    { re: /the enemy draws?\b/i, ev: 'enemyDraw' },
    { re: /the enemy discards?\b/i, ev: 'enemyDiscard' },
    { re: /(?:targeted|chosen) unit deals? damage\b/i, ev: 'chosenTargetDamaged' },
    { re: /attack is (\d+)\+/i, ev: 'selfAttack10', cond: m => ({ c: 'attackAtLeast', n: +m[1] }) },
  ];

  /** 触发事件段的主语归一化：卡名/it → "this unit"，其余（you/the enemy…）保持原样 */
  function normalizeTriggerSubject(body) {
    if (/^(this unit|you|your|the |enemy|players|targeted|chosen|attack|a |an )\b/i.test(body)) {
      return body.replace(/^it\b/i, 'this unit');
    }
    if (/^it\b/i.test(body)) return body.replace(/^it\b/i, 'this unit');
    const m = /^(.{1,32}?)\s+(?=(?:attacks?|destroys?|is |dies|moves?|becomes|damages?|takes?|discards?|draws?|deploys?|plays?|gains?|gets?|kills?)\b)/i.exec(body);
    if (m) return 'this unit ' + body.slice(m[1].length).trim();
    return body;
  }

  function matchTriggerEvent(text) {
    for (const p of TRIGGER_EVENTS) {
      const m = p.re.exec(text);
      if (!m) continue;
      // 主语可能是卡名（"Hudson destroys a unit"）或代词（"it moves into…"），
      // 只接受句首 40 字符内的命中，避免把效果句里的词误当事件
      if (m.index > 40) continue;
      return {
        event: p.ev,
        cond: p.cond ? (typeof p.cond === 'function' ? p.cond(m) : p.cond) : null,
        len: m.index + m[0].length,
      };
    }
    return null;
  }

  function buildTrigger(event, cond, effectText, raw) {
    const eff = String(effectText || '').replace(/^[,:;]\s*/, '').trim();
    if (!eff) return null;
    let ops = parseOps(eff);
    if (!ops.length) ops = parseOps(eff.replace(/^[a-z0-9 .'\-]+?\s+(?=gets?|gains?|deals?|destroys?|draws?)/i, ''));
    if (!ops.length) {
      // 触发效果只有裸关键词（如 "Guard"）
      const km = /^(blitz|guard|fury|smokescreen|ambush|shock|mobilize)\b\.?$/i.exec(eff);
      if (km) ops = [{ op: 'keyword', kws: [km[1].toLowerCase()], target: 'self', self: true }];
    }
    if (!ops.length) return null;
    // "When this unit is destroyed, put it on top of owner's deck" —— 等价于阵亡回牌库顶的静态标记
    if (event === 'selfDestroy' && ops.length === 1 && ops[0].op === 'toDeckTop') {
      return { kind: 'static', text: raw, cond: null, ops: [{ op: 'toDeckTop' }] };
    }
    // "Once per turn, ..." —— 每回合仅触发一次
    const once = /^once per turn\b/i.test(String(raw || ''));
    // 触发效果里没写明目标时，增益类默认作用于自身；伤害/摧毁类保持通用目标解析
    const isDeployEv = /^(ownDeploy|ownGuardDeploy)$/.test(event);
    const isEventEv = /^(unitPinned|unitRetreated|unitDestroyed|allyMoveFront)$/.test(event);
    for (const o of ops) {
      if (!['buff', 'keyword', 'buffPer', 'opCostMod'].includes(o.op)) continue;
      if (isDeployEv && /^(give it|it gets|gets)\b/i.test(eff)) { o.target = 'deployed'; o.self = false; continue; }
      if (isEventEv && /^(give it|it gets|gets)\b/i.test(eff)) { o.target = 'event'; o.self = false; continue; }
      if (!o.target || o.target === 'unit') { o.target = 'self'; o.self = true; }
    }
    return { kind: 'trigger', event, when: raw, text: raw, cond: cond || null, ops, once };
  }

  function parseTriggerSentence(sent) {
    const raw0 = String(sent || '').trim().replace(/[.!?]+$/, '');
    if (!raw0) return null;
    // "Once per turn, ..." 前缀最先剥离（否则会被复合句拆分误切），并回填 once 标记
    const onceM = /^once per turn[,]?\s*/i.exec(raw0);
    const raw = onceM ? raw0.slice(onceM[0].length).trim() : raw0;
    if (!raw) return null;
    const wrapOnce = (t) => {
      if (t && onceM) (Array.isArray(t) ? t : [t]).forEach(x => { x.once = true; });
      return t;
    };

    // 复合句拆分："Gets +1+1 when you play a Japanese card, and Guard when attack is 10+."
    const compSplit = /,\s*(?:and\s+)?(?=[^,.]{0,40}\bwhen\b)/i;
    if (compSplit.test(raw)) {
      const idx = raw.search(compSplit);
      const first = raw.slice(0, idx).trim();
      const rest = raw.slice(idx).replace(/^,\s*(?:and\s+)?/i, '').trim();
      const a = parseTriggerSentence(first);
      const b = parseTriggerSentence(rest);
      if (a && b) return wrapOnce([a, b].flat());
      if (a) return wrapOnce(a);
      if (b) return wrapOnce(b);
    }

    // ① "At the start/end of your turn ..." —— 效果紧跟其后（有无逗号均可）
    let m = /^(?:at|on) the (start|end) of (?:your|the|each) turn\b[,:]?\s*(.*)$/i.exec(raw);
    if (m) return wrapOnce(buildTrigger(m[1].toLowerCase() === 'start' ? 'startOfTurn' : 'endOfTurn', null, m[2], raw));

    // ② "When/Whenever/After <事件>[,] <效果>"
    m = /^(?:when|whenever|after)\b\s+(.+)$/i.exec(raw);
    if (m) {
      const body = normalizeTriggerSubject(m[1]);
      const hit = matchTriggerEvent(body);
      if (!hit) return null;
      return wrapOnce(buildTrigger(hit.event, hit.cond, body.slice(hit.len), raw));
    }

    // ③ "<效果> when/after <事件>" —— 效果在前（HUDSON / STUKA 87G 等）
    const wm = /\b(when|after|whenever)\s+(.+)$/i.exec(raw);
    if (wm && wm.index > 0) {
      const effectText = raw.slice(0, wm.index).trim();
      const evText = normalizeTriggerSubject(wm[2]);
      const hit = matchTriggerEvent(evText);
      if (hit) return wrapOnce(buildTrigger(hit.event, hit.cond, effectText, raw));
      // 特例："... after giving an order"（你给出指令时）
      if (/^(?:giving|you give)\s+an?\s+order\b/i.test(evText)) {
        return wrapOnce(buildTrigger('ownOrder', null, effectText, raw));
      }
      return null;
    }
    return null;
  }

  // ---------------- Conditions ----------------
  function evalCond(cond, game, card, ctx) {
    if (!cond) return true;
    if (cond.neg && cond.c !== 'none') {
      return !evalCond({ ...cond, neg: false }, game, card, ctx);
    }
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
      // --- 条件/触发式关键字子系统新增 ---
      case 'hasKw': {
        if (cond.selfCheck) return !!(card && card.has && card.has(cond.kw));
        const side = cond.side === 'enemy' ? 1 - card.owner : card.owner;
        return game.unitsOf(side).some(u => u.uid !== card.uid && u.has(cond.kw));
      }
      case 'hasType': {
        const side = cond.side === 'enemy' ? 1 - card.owner : card.owner;
        const isAir = cond.type === 'air';
        const isGround = cond.type === 'ground';
        return game.unitsOf(side).some(u => {
          if (u.uid === card.uid) return false;
          if (isAir) return u.type === 'fighter' || u.type === 'bomber';
          if (isGround) return u.type === 'infantry' || u.type === 'tank' || u.type === 'artillery';
          return u.type === cond.type;
        });
      }
      case 'targetPinned': {
        const t = ctx && ctx.target != null ? game.find(ctx.target) : null;
        return !!(t && (t._pinned || t._stunned));
      }
      case 'nationPlayed': return true;   // 事件触发时已由 nation 过滤
      case 'attackAtLeast': return card && card.totalAttack >= (cond.n || 0);
      case 'frontlineEmpty': return game.frontline.length === 0;
      case 'slotsAtMost': return game.players[card.owner].slots <= (cond.n || 0);
      // --- 事件载荷条件（v33）：过滤触发事件里的那张卡 ---
      case 'eventNation': return !!(ctx && ctx.nation === cond.nation);
      case 'eventType': {
        if (!ctx) return false;
        const t = ctx.type;
        if (cond.type === 'air') return t === 'fighter' || t === 'bomber';
        if (cond.type === 'ground') return t === 'infantry' || t === 'tank' || t === 'artillery';
        return t === cond.type;
      }
      case 'eventKw': return !!(ctx && ctx.card && ctx.card.has && ctx.card.has(cond.kw));
      case 'eventAttackLeast': return !!(ctx && (ctx.attack || 0) >= (cond.n || 0));
      case 'eventOpCostLeast': return !!(ctx && ctx.card && ((ctx.card.opCost || 0)) >= (cond.n || 0));
      case 'eventHeavyArmor': return !!(ctx && ctx.card && (ctx.card.heavyArmor || 0) > 0);
      case 'eventOwnerFriendly': return !!(ctx && card && ctx.owner != null && ctx.owner === card.owner);
      case 'eventOwnerEnemy': return !!(ctx && card && ctx.owner != null && ctx.owner !== card.owner);
      case 'eventAnd': return !!(cond.and && cond.and.every(c2 => evalCond(c2, game, card, ctx)));
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
      // 官方：先攻 4 张、后攻 5 张；先攻首回合不额外抽牌（后续回合各抽 1）
      this.draw(0, 4, true);
      this.draw(1, 5, true);
      this._skipOpeningDraw = true;
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
    /** 能否移动进入前线：中立或己方控制都可以（移动本身就是夺取手段） */
    canEnterFrontline(side) {
      return this.frontlineOwner === -1 || this.frontlineOwner === side;
    }
    /**
     * 能否**直接部署**到前线：只有在已经控制前线时才允许。
     * 中立前线（开局 / 双方都撤空）必须先把单位部署到支援阵线，再花行动费推进。
     */
    canDeployToFront(side) {
      return this.frontlineOwner === side;
    }
    frontlineCount(side) { return this.frontline.filter(c => c.owner === side).length; }

    /** 「for each ...」计数描述符 → 数量（buffPer / drawPer / setHqDef 用） */
    countOf(desc, src, ctx) {
      if (!desc) return 0;
      const me = src ? src.owner : this.current;
      const foe = 1 - me;
      switch (desc.type) {
        case 'deployedOpCost': return (ctx && ctx.card) ? (ctx.card.opCost || 0) : 0;
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
      p.playedThisTurn = 0;
      p._lostUnitThisTurn = false;
      p._unitDeployedThisTurn = false;
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
      this.purgeTempKeywords();
      for (const u of [...this.unitsOf(0), ...this.unitsOf(1)]) {
        if (u._tempImmune != null && u._tempImmune < this.turn * 2 + this.current) {
          u._immune = false; u._tempImmune = null;
        }
      }
      // "At the start of your turn…" 触发
      p.hqStartDef = p.hqDef;
      this.fireTrigger('startOfTurn', { side: this.current }, u => u.owner === this.current);
      this.log(`── 第 ${this.turn} 回合（P${this.current + 1}）${p.kredits}/${p.slots} 指挥点 ──`);
      this.ev({ e: 'turn', turn: this.turn, side: this.current, kredits: p.kredits, slots: p.slots });
      if (this._skipOpeningDraw) this._skipOpeningDraw = false;
      else this.draw(this.current, 1);
    }

    /**
     * 半回合边界清理临时关键字：
     * - 单位上的 "until end of turn" 关键词（_tempKws 记录授予时的半回合号）
     * - 总部临时关键词（_hqTempKws，DEPTH CHARGES 的"直到你的下个回合"）
     * 同时检查 "attack is N+" 型触发（JADE DIVISION）。
     */
    purgeTempKeywords() {
      const tk = this.turn * 2 + this.current;
      for (const u of [...this.unitsOf(0), ...this.unitsOf(1)]) {
        if (u._tempKws) {
          for (const k of Object.keys(u._tempKws)) {
            if (u._tempKws[k] < tk) {
              u.keywords.delete(k);
              delete u._tempKws[k];
              this.log(`${u.name} 的临时关键词 ${k} 失效`);
            }
          }
        }
        // JADE DIVISION："and Guard when attack is 10+."（攻击达阈值后补授守护）
        if (u.isUnit && !u._atk10Done) {
          const cls = u._parsed || (u._parsed = parseClauses(u.text));
          for (const cl of cls) {
            if (cl.kind !== 'trigger' || cl.event !== 'selfAttack10') continue;
            if (!evalCond(cl.cond, this, u, {})) continue;
            this.log(`触发：${u.name}`);
            this.execOps(cl.ops, u, { trigger: true });
            u._atk10Done = true;
            break;
          }
        }
      }
      for (const pl of this.players) {
        if (pl._hqTempKws && pl._hqTempKws.length) {
          pl._hqTempKws = pl._hqTempKws.filter(e => {
            if (e.until < tk) { this.log(`总部临时关键词 ${e.kw} 失效`); return false; }
            return true;
          });
        }
      }
    }

    endTurn() {
      if (this.done) return;
      if (this.pendingChoose) return;
      const cur = this.current;
      // "At the end of your turn…" 触发（先结算再切换行动方）
      this.fireTrigger('endOfTurn', { side: cur }, u => u.owner === cur);
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
      // "每当你对手抽牌…" 手牌监听
      this.bumpHandWatches('enemyDraw', 1 - side);
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
        // "Draw a card when the enemy draws a RESISTANCE order"（1er BCP / 27e DIA）
        this.fireTrigger('enemyDraw', { side, nation: c.nation, card: c, type: c.type }, u => u.owner !== side);
      }
    }

    damageHq(side, amount, source, isFatigue) {
      if (amount <= 0) return;
      // "When your HQ is damaged, deal that amount of damage to this unit instead"
      if (!isFatigue) {
        const redirect = this.unitsOf(side).find(u => u._hqDamageRedirect);
        if (redirect) {
          this.log(`${redirect.name} 替总部承受 ${amount} 点伤害`);
          this.damageCard(redirect, amount, source);
          const pp0 = this.players[side];
          pp0.hqDamagedThisTurn += amount;
          this.bumpHandWatches('ownHqDamaged', side);
          return;
        }
      }
      const p = this.players[side];
      // 临时护甲先吸收（hqBuff）
      if (!isFatigue && p.hqArmor > 0) {
        const absorbed = Math.min(p.hqArmor, amount);
        p.hqArmor -= absorbed;
        amount -= absorbed;
        if (absorbed > 0) this.log(`总部护甲吸收 ${absorbed} 点伤害（剩余护甲 ${p.hqArmor}）`);
        if (amount <= 0) return;
      }
      // 总部减伤（M6：每个 4+ 攻击的我方单位减 1）
      if (!isFatigue && p._hqDmgReduce) {
        const red = Math.min(amount, p._hqDmgReduce);
        if (red > 0) { amount -= red; this.log(`总部伤害减免 ${red} 点`); if (amount <= 0) return; }
      }
      // 单回合损失上限（SEAGULL）
      if (!isFatigue && p._hqLossCap) {
        const lost = p.hqStartDef != null ? Math.max(0, p.hqStartDef - p.hqDef) : 0;
        const room = Math.max(0, p._hqLossCap - lost);
        if (amount > room) { this.log(`总部每回合最多损失 ${p._hqLossCap} 点`); amount = room; }
        if (amount <= 0) return;
      }
      p.hqDef -= amount;
      // "While in the frontline, your HQ cannot be reduced below N defense"
      const floorUnit = this.unitsOf(side).find(u => u._hqFloor && u.loc === 'front');
      if (floorUnit && p.hqDef < floorUnit._hqFloor) {
        p.hqDef = floorUnit._hqFloor;
        this.log(`${floorUnit.name} 保护：总部防御不会低于 ${floorUnit._hqFloor}`);
      }
      if (!isFatigue) p.hqDamagedThisTurn += amount;
      this.ev({ e: 'hqdamage', side, amount });
      this.log(`P${side + 1} 总部受到 ${amount} 点伤害，剩余 ${Math.max(0, p.hqDef)}`);
      this.bumpHandWatches('ownHqDamaged', side);
      // 己方总部受击触发（456th RIFLE REGIMENT：+1+1 和守护）
      if (!isFatigue && !this.done) {
        this.fireTrigger('ownHqDamaged', { side, amount }, u => u.owner === side);
        // "When the enemy HQ takes damage" —— 对 1-side 的单位而言，敌方总部就是 side
        this.fireTrigger('enemyHqDamaged', { side, amount }, u => u.owner === 1 - side);
        if (source && source.isUnit) {
          this.fireTrigger('selfDamageHq', { uid: source.uid }, u => u.uid === source.uid);
        }
      }
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
      // 伤害转移：友方有单位声明"对本卡的伤害转移给它"
      if (!c._redirected) {
        const guard = this.unitsOf(c.owner).find(u => u !== c && u._redirectName
          && c.name.toLowerCase().includes(u._redirectName.toLowerCase()));
        if (guard) {
          this.log(`${c.name} 受到的 ${amount} 点伤害转移给 ${guard.name}`);
          guard._redirected = true;
          this.damageCard(guard, amount, killer);
          guard._redirected = false;
          return;
        }
      }
      c.defense -= amount;
      this.ev({ e: 'damage', uid: c.uid, amount });
      this.log(`${c.name} 受到 ${amount} 点伤害，剩余 ${Math.max(0, c.defense)}`);
      // "When this unit is dealt damage…"
      this.fireTrigger('selfDamaged', { uid: c.uid, amount }, u => u.uid === c.uid);
      // 被指定目标造成伤害触发（15th RECCE：被指定单位造成伤害时 +1+1 和守护）
      if (killer && killer.isUnit) {
        this.fireTrigger('chosenTargetDamaged', { killerUid: killer.uid, targetUid: c.uid },
          u => u.chosenTarget != null && u.chosenTarget === killer.uid);
      }
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
      // 击杀触发（HUDSON Mk III：击杀单位 → 获得狂怒直到回合结束）
      if (killer && killer.isUnit && killer.loc !== 'discard') {
        this.fireTrigger('selfKill', { killerUid: killer.uid, destroyedUid: c.uid }, u => u.uid === killer.uid);
      }
      // "When an enemy unit is destroyed" / "when an undestroyed unit leaves the battlefield"
      this.fireTrigger('unitDestroyed', { uid: c.uid, owner: c.owner, type: c.type, nation: c.nation, attack: c.totalAttack, card: c }, () => true);
      // "When this unit is destroyed, ..."（T-28）
      this.fireTrigger('selfDestroy', { uid: c.uid, owner: c.owner, card: c }, u => u.uid === c.uid);
      if (wasFront) {
        this.frontline.splice(this.frontline.indexOf(c), 1);
        if (!this.frontline.length) this.frontlineOwner = -1;
      } else {
        const b = this.players[c.owner].board;
        b.splice(b.indexOf(c), 1);
      }
      if (c._toDeckTop) {
        const dk = this.players[c.owner].deck;
        const inst = new CardInst(c.def, c.owner, this);
        dk.unshift(inst);
        c.loc = 'discard';
        c.slot = null;
        this.players[c.owner].discard.push(c);
        this.ev({ e: 'death', uid: c.uid, name: c.name, owner: c.owner });
        this.log(`${c.name} 被摧毁，回到牌库顶`);
        this.applyAuras();
        this.players[c.owner]._lostUnitThisTurn = true;
        this.bumpHandWatches('ownUnitLost', c.owner);
        return;
      }
      c.loc = 'discard';
      c.slot = null;
      c.defense = c.defense; // keep damaged value
      this.players[c.owner].discard.push(c);
      this.ev({ e: 'death', uid: c.uid, name: c.name, owner: c.owner });
      this.log(`${c.name} 被摧毁`);
      this.applyAuras();
      this.players[c.owner]._lostUnitThisTurn = true;
      this.bumpHandWatches('ownUnitLost', c.owner);
    }

    // ---------- deployment ----------
    hasRoomFor(c) {
      if (c.type === 'location') return this.supportCount(c.owner) < RULES.MAX_ROW;
      if (!c.isUnit) return true;
      if (this.canDeployToFront(c.owner) && this.frontlineCount(c.owner) < RULES.MAX_ROW) return true;
      return this.supportCount(c.owner) < RULES.MAX_ROW;
    }

    playCard(side, handIndex, opts) {
      opts = opts || {};
      if (this.pendingChoose) return { ok: false, error: '请先完成二选一' };

      if (this.done || this.current !== side) return { ok: false, error: '还没到你的回合' };
      const p = this.players[side];
      const c = p.hand[handIndex];
      if (!c) return { ok: false, error: '找不到该卡牌' };
      // 动态费用：手牌费用增减 + 最左手牌折扣 + 首张指令折扣 + 敌方手牌税
      const extraCost = (c._costMod || 0)
        + (handIndex === 0 ? (p._leftmostCost || 0) : 0)
        + (c.type === 'order' && !(p.ordersPlayedThisTurn > 0) ? (p._firstOrderDiscount || 0) : 0)
        + (c.type === 'order' ? (p._handTaxOrder || 0) : 0)
        + ((c.type === 'gotcha') ? (p._handTaxGotcha || 0) : 0)
        + (p._handTaxAll || 0)
        + this.teamAuraFor(c, 'deploy')
        + ((this._enemyFirstCardDouble && p.playedThisTurn === 0 && p._enemyFirstDoubleOwner) ? c.cost : 0)
        + ((/deploys? for 0 kredits if a friendly unit was destroyed this turn/i.test(c.text || '') && p._lostUnitThisTurn) ? -(c.cost || 0) : 0);
      const costNow = Math.max(0, c.cost + extraCost);
      if (costNow > p.kredits) return { ok: false, error: '指挥点不足' };
      if (!this.hasRoomFor(c)) return { ok: false, error: '战场没有空位' };
      // 部署条件（文本直判："若本回合已部署过单位则不能部署 / 需要 N 个指挥点槽"）
      if (/cannot be deployed if you have deployed a unit this turn/i.test(c.text || '') && p._unitDeployedThisTurn) {
        return { ok: false, error: '本回合已部署过单位，无法部署该卡' };
      }
      const slotNeed = /cannot be deployed unless you have (\d+) or more kredit slots/i.exec(c.text || '');
      if (slotNeed && p.slots < +slotNeed[1]) {
        return { ok: false, error: `需要 ${slotNeed[1]} 个指挥点槽` };
      }
      if (c.isUnit && opts.toFront === false && this.supportCount(c.owner) >= RULES.MAX_ROW) {
        if (!(this.canDeployToFront(c.owner) && this.frontlineCount(c.owner) < RULES.MAX_ROW)) {
          return { ok: false, error: '支援阵线已满' };
        }
      }

      const fromLeftmost = handIndex === 0;
      const fromRightmost = handIndex === p.hand.length - 1;

      p.hand.splice(handIndex, 1);
      p.kredits -= costNow;
      p.kreditsSpent = (p.kreditsSpent || 0) + costNow;
      this.log(`P${side + 1} 使用 ${c.name}（-${costNow} 指挥点）`);

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
        if (this._orderLimit && p.ordersPlayedThisTurn >= this._orderLimit) {
          return { ok: false, error: `本回合最多给出 ${this._orderLimit} 张指令` };
        }
        p.ordersPlayedThisTurn++;
        c.loc = 'discard';
        p.discard.push(c);
        this.ev({ e: 'order', uid: c.uid, name: c.name, owner: side,
                  id: c.id, image: c.def.image, nation: c.nation });
        const ctx = { fromLeftmost, fromRightmost, target: opts.target || null };
        this.execOrderText(c, ctx);
        this.bumpHandWatches('order', side);
        this.fireTrigger('ownCardPlayed', { owner: side, nation: c.nation }, u => u.owner === side);
        this.fireTrigger('ownOrder', { owner: side }, u => u.owner === side);
        this.fireTrigger('enemyOrder', { owner: side }, u => u.owner !== side);
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
      // 只有已控制前线时才允许直接部署到前线（否则一律先进支援阵线）
      const canFront = this.canDeployToFront(c.owner) && this.frontlineCount(c.owner) < RULES.MAX_ROW;
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

      if (c.isUnit) p._unitDeployedThisTurn = true;
      // deployment effects
      const ctx = { fromLeftmost, fromRightmost, target: opts.target || null };
      this.execCardText(c, 'deployment', ctx);
      this.execCardText(c, 'static', ctx);
      // Pincer：本回合第 2 张及以上的卡才触发
      p.playedThisTurn = (p.playedThisTurn || 0) + 1;
      if (p.playedThisTurn >= 2) this.execCardText(c, 'pincer', ctx);
      this.applyAuras();
      // 触发器：己方出牌 / 部署守护单位 / 直落前线 / 敌方视角的部署事件
      this.fireTrigger('ownCardPlayed', { owner: side, nation: c.nation }, u => u.owner === side && u.uid !== c.uid);
      this.fireTrigger('enemyDeploy', { owner: side, uid: c.uid }, u => u.owner !== side);
      if (c.isUnit) {
        // "When you deploy (another |a <nation/type>) unit ..."（8e MAROCAINS / FELDHERRNHALLE / HOTCHKISS H35）
        this.fireTrigger('ownDeploy', { owner: side, uid: c.uid, type: c.type, nation: c.nation, attack: c.totalAttack, card: c },
          u => u.owner === side && u.uid !== c.uid);
        if (c.has('guard')) {
          this.fireTrigger('ownGuardDeploy', { owner: side, uid: c.uid, card: c }, u => u.owner === side && u.uid !== c.uid);
        }
      }
      if (toFront) {
        this.fireTrigger('selfMoveFront', { uid: c.uid }, u => u.uid === c.uid);
        this.fireTrigger('allyMoveFront', { uid: c.uid, owner: c.owner, type: c.type, nation: c.nation, attack: c.totalAttack, card: c },
          u => u.owner === c.owner && u.uid !== c.uid);
      }
      return { ok: true };
    }

    // ---------- movement ----------
    canMove(c, toFront) {
      if (!c.isUnit || c.owner !== this.current || this.done) return false;
      if (c.hasMoved) return false;
      if (!c.canOperate()) return false;
      if (c.hasAttacked && !(c.type === 'tank') && !c._moveAndAttack) return false;
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
      if (this.pendingChoose) return { ok: false, error: '请先完成二选一' };

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
      this.applyAuras();
      // 移入前线触发（25. PANZERGRENADIER：移入前线时获得守护）
      if (toFront) {
        this.fireTrigger('selfMoveFront', { uid: c.uid }, u => u.uid === c.uid);
        this.fireTrigger('allyMoveFront', { uid: c.uid, owner: c.owner, type: c.type, nation: c.nation, attack: c.totalAttack, card: c },
          u => u.owner === c.owner && u.uid !== c.uid);
      } else {
        // 撤退触发（TYPHOON Mk IB：地面单位撤退时抽牌）
        this.fireTrigger('unitRetreated', { uid: c.uid, owner: c.owner, type: c.type, card: c }, () => true);
      }
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
      // 空中单位（战斗机/轰炸机）与射程 ≥2 的火炮可以越过敌方前线直接打支援阵线
      const canBypassFront = attacker.type === 'fighter' || attacker.type === 'bomber' || (attacker.range || 1) >= 2;
      if (enemyFront.length) {
        for (const t of enemyFront) if (pairOk(t)) out.push(t.uid);
        if (!canBypassFront) return out;      // 地面近战必须先清前线
      }
      if (this.hqExposed(foe) || this.frontlineOwner === attacker.owner) {
        // 敌方总部带临时烟幕（DEPTH CHARGES 等）时不可被单位攻击
        if (!this.hqIsGuarded(attacker.owner) && !this.hqHas(foe, 'smokescreen')) out.push(0); // 0 = enemy HQ
      }
      for (const t of this.players[foe].board) if (pairOk(t)) out.push(t.uid);
      return out;
    }

    canAttackPair(atk, def) {
      // 后排"不能被地面单位攻击"（C6N SAIUN / F1M2 PETE）
      if (def._groundProof && def.loc !== 'front' && ['infantry', 'tank', 'artillery'].includes(atk.type)) return false;
      // smokescreen: cannot be attacked by units until it has acted
      if (def.has('smokescreen') && !def.hasActed) return false;
      // guard: adjacent units protected, except bombers & artillery
      if (def.has('guard') === false && this.isGuarded(def)) {
        if (!(atk.type === 'bomber' || atk.type === 'artillery')) return false;
      }
      // 轰炸机拦截：若目标阵线有敌方战斗机，则只能攻击该战斗机（打战斗机本身是允许的）
      if (atk.type === 'bomber') {
        const row = def.loc === 'front' ? this.frontline : this.players[def.owner].board;
        const hasFighter = row.some(c => c.owner === def.owner && c.type === 'fighter');
        if (hasFighter && def.type !== 'fighter') return false;
      }
      // range: support-line vs support-line needs range >= 2
      if (def.loc !== 'front' && atk.loc !== 'front' && atk.range < 2) return false;
      // ground units in support line cannot attack enemy support line without frontline
      // (handled by structural target list; frontline units can always attack)
      return true;
    }

    /**
     * 反击判定（官方规则）：
     * - 防守方是轰炸机 / 炮兵 → 不造成反击
     * - 攻击方是炮兵 → 不吃反击
     * - 攻击方是轰炸机且目标不是战斗机 → 不吃反击（轰炸机只在与战斗机战斗时受反击）
     */
    canCounter(atk, def) {
      if (!atk || !def) return false;
      if (def.type === 'bomber' || def.type === 'artillery') return false;
      if (atk.type === 'artillery') return false;
      if (atk.type === 'bomber' && def.type !== 'fighter') return false;
      return true;
    }

    canAttack(c) {
      if (this._blockHighAttack && c.totalAttack >= this._blockHighAttack) return false;
      if (!c.isUnit || c.owner !== this.current || this.done) return false;
      if (c._noAttack) return false;
      if (c.attacksLeft <= 0) return false;
      if (!c.canOperate()) return false;
      if (c.hasMoved && c.type !== 'tank' && !c._moveAndAttack) return false;
      if (c.totalAttack <= 0) return false;
      return this.attackTargets(c).length > 0;
    }

    attack(side, uid, targetUid) {
      if (this.pendingChoose) return { ok: false, error: '请先完成二选一' };

      if (this.done || this.current !== side) return { ok: false, error: '还没到你的回合' };
      const atk = this.find(uid);
      if (!atk || !this.canAttack(atk)) return { ok: false, error: '非法攻击' };
      if (!this.attackTargets(atk).includes(targetUid)) return { ok: false, error: '非法目标' };
      const p = this.players[side];
      // "It costs the enemy N kredits to … attack this unit"：攻击带税目标需额外支付
      const earlyDef = targetUid === 0 ? null : this.find(targetUid);
      const tax = earlyDef && earlyDef._enemyTax ? earlyDef._enemyTax : 0;
      if (p.kredits < atk.effOpCost + tax) return { ok: false, error: '指挥点不足' };
      p.kredits -= (atk.effOpCost + tax);
      p.kreditsSpent = (p.kreditsSpent || 0) + atk.effOpCost + tax;
      atk.hasAttacked = true;
      atk.attacksLeft -= 1;
      atk.hasActed = true;

      if (targetUid === 0) {
        // 对 HQ 的伤害修正（如 "Deals +3 damage to HQs"、"Deals double damage to HQs"）
        let hqDmg = atk.totalAttack;
        if (atk._dmgMods) {
          for (const m of atk._dmgMods) {
            if (m.vs === 'hq') hqDmg = m.mult > 1 ? hqDmg * m.mult : hqDmg + m.add;
          }
        }
        this.log(`${atk.name}（攻击 ${atk.totalAttack}）攻击敌方总部（-${atk.effOpCost} 指挥点）`);
        this.ev({ e: 'attack', from: atk.uid, to: 0, owner: atk.owner });
        this.damageHq(1 - side, hqDmg, atk);
        this.ev({ e: 'hqdamage', side: 1 - side, amount: hqDmg });
        this.fireTrigger('selfAttack', { uid: atk.uid }, u => u.uid === atk.uid);
        this.fireTrigger('selfAttackHQ', { uid: atk.uid }, u => u.uid === atk.uid);
        return { ok: true };
      }
      const def = this.find(targetUid);
      if (!def || def.loc === 'discard') return { ok: true };
      this.ev({ e: 'attack', from: atk.uid, to: def.uid, owner: atk.owner });
      // "Units attacked by this unit lose Guard" 等
      if (atk._stripKwOnAttack && def.keywords.has(atk._stripKwOnAttack)) {
        def.keywords.delete(atk._stripKwOnAttack);
        this.log(`${def.name} 失去关键词 ${atk._stripKwOnAttack}`);
      }
      // "When this unit attacks…" 触发（宣告攻击时结算，覆盖伏击/冲击等分支）
      this.fireTrigger('selfAttack', { uid: atk.uid, target: def.uid }, u => u.uid === atk.uid);

      // 伏击：每回合仅首次被攻击时生效；对无法反击的搭配（炮兵/轰炸机）无效
      const ambush = def.has('ambush') && def._ambushTurn !== this.turn && this.canCounter(atk, def);
      const shock = atk.has('shock');

      this.log(`${atk.name}（攻击 ${atk.totalAttack}）攻击 ${def.name}（防御 ${def.totalDefense}）（-${atk.effOpCost} 指挥点）`);
      const atkSilenced = !!atk._pinned || !!atk._suppressed;
      const defSilenced = !!def._pinned || !!def._suppressed;
      const dmg = (a, d, silenced) => {
        if (silenced) return 0;
        let x = Math.max(0, a.totalAttack - d.heavyArmor);
        // 伤害修正（"对坦克双倍伤害" / "对空中单位 +2 伤害" 等）
        if (a._dmgMods) {
          for (const m of a._dmgMods) {
            if (m.cond && !evalCond(m.cond, a._game, a, {})) continue;
            const okVs = m.vs === 'all' || m.vs === d.type
              || (m.vs === 'air' && (d.type === 'fighter' || d.type === 'bomber'))
              || (m.vs === 'ground' && ['infantry', 'tank', 'artillery'].includes(d.type));
            if (!okVs) continue;
            x = m.mult > 1 ? x * m.mult : x + m.add;
          }
        }
        // 受击方减免（"受到地面单位伤害 -1"）
        if (d._dmgTakenMod) {
          const mt = d._dmgTakenMod;
          const okSrc = mt.vs === 'air' ? (a.type === 'fighter' || a.type === 'bomber')
            : ['infantry', 'tank', 'artillery'].includes(a.type);
          if (okSrc) x = Math.max(0, x - mt.minus);
        }
        if (a._immune) x = 0;
        return Math.max(0, x);
      };
      if (ambush || shock) {
        // Ambush: defender strikes first. Shock: attacker strikes first.
        if (ambush) {
          def._ambushTurn = this.turn;   // 本回合已用掉伏击
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
          atk.keywords.delete('shock');   // 冲击用后移除
          if (def.defense <= 0) { this.destroyCard(def, atk, true); return { ok: true }; }
          // 冲击：被攻击单位不会造成任何反击伤害
        }
        return { ok: true };
      }
      const defBefore = def.defense;
      const dToDef = dmg(atk, def, atkSilenced);
      let dToAtk = 0;
      // 反击判定（见 canCounter）：防守方为轰炸机/炮兵不反击；炮兵攻击不吃反击；轰炸机仅对战斗机吃反击
      if (this.canCounter(atk, def)) dToAtk = dmg(def, atk, defSilenced);
      if (dToDef > 0) def.defense -= dToDef;
      if (dToAtk > 0) atk.defense -= dToAtk;
      this.log(`${def.name} 受到 ${dToDef} 点伤害，${atk.name} 受到 ${dToAtk} 点反击伤害`);
      const defDies = def.defense <= 0;
      const atkDies = atk.defense <= 0;
      if (defDies) this.destroyCard(def, atk, true);
      if (atkDies) this.destroyCard(atk, def, true);
      // "Becomes Veteran when it survives combat"（HURRICANE Mk II-C TROP）/ "When a friendly unit survives combat"
      if (!atkDies) {
        this.fireTrigger('selfSurvive', { uid: atk.uid }, u => u.uid === atk.uid);
        this.fireTrigger('allySurvive', { uid: atk.uid, owner: atk.owner, type: atk.type, nation: atk.nation, attack: atk.totalAttack, card: atk },
          u => u.owner === atk.owner && u.uid !== atk.uid);
      }
      if (!defDies) {
        this.fireTrigger('allySurvive', { uid: def.uid, owner: def.owner, type: def.type, nation: def.nation, attack: def.totalAttack, card: def },
          u => u.owner === def.owner && u.uid !== def.uid);
      }
      // 攻击伤害同时打到敌方总部（PANTHER D）
      if (!atkDies && dToDef > 0 && atk._splashHq) {
        this.log(`${atk.name} 的攻击伤害同时打到敌方总部（${dToDef}）`);
        this.damageHq(1 - atk.owner, dToDef, atk);
      }
      // 摧毁目标的溢出伤害打到敌方总部（756th REGIMENT / SHTURMOVIK）
      if (defDies && atk._excessToHq) {
        const excess = Math.max(0, dToDef - defBefore);
        if (excess > 0) {
          this.log(`${atk.name} 溢出 ${excess} 点伤害打到敌方总部`);
          this.damageHq(1 - atk.owner, excess, atk);
        }
      }
      // 每次攻击后行动费 +N（BF 110 C / PANZER IV-J）
      if (atk._opCostOnAttack) {
        atk._opCostMod = (atk._opCostMod || 0) + atk._opCostOnAttack;
        this.log(`${atk.name} 行动费上升至 ${atk.effOpCost}`);
      }
      // 击杀后可再次行动（WINDHUND DIVISION）
      if (defDies && atk._operateOnKill) {
        atk.attacksLeft = Math.max(atk.attacksLeft, 1);
        atk.hasAttacked = false;
        this.log(`${atk.name} 摧毁目标，可再次行动`);
      }
      // 重置防守方攻击（37mm M1 AA GUN）
      if (atk._resetDefender && !defDies) {
        def.attacksLeft = 0;
        def.hasAttacked = true;
        this.log(`${def.name} 的攻击次数被重置`);
      }
      // 受伤方：总部回等量防御（461st / 845th RIFLES）
      if (dToDef > 0 && def._hqGainFromDamage) {
        const pp2 = this.players[def.owner];
        pp2.hqDef = Math.min(pp2.hqMaxDef, pp2.hqDef + dToDef);
        this.log(`${def.name} 受伤，其总部回复 ${dToDef} 点防御`);
      }
      // "Damage dealt by this unit adds equal defense to your HQ"
      if (!atkDies && dToDef > 0 && atk._hqDrain) {
        const pp = this.players[atk.owner];
        pp.hqDef = Math.min(pp.hqMaxDef, pp.hqDef + dToDef);
        this.log(`${atk.name} 造成伤害，总部恢复 ${dToDef} 点防御`);
      }
      // "Units dealt combat damage by this unit are destroyed"
      if (!defDies && dToDef > 0 && atk._destroyOnDamage) {
        this.log(`${atk.name} 的战斗伤害直接摧毁 ${def.name}`);
        this.destroyCard(def, atk, true);
      }
      // "Any unit that attacks this unit takes N damage"（反伤）
      if (dToAtk >= 0 && def._thorns && !atkDies) {
        atk.defense -= def._thorns;
        this.log(`${atk.name} 攻击 ${def.name} 受到 ${def._thorns} 点反伤`);
        if (atk.defense <= 0) this.destroyCard(atk, def, true);
      }
      // "Reduce attack of this unit by N each time it attacks"
      if (atk._selfDrainOnAttack) {
        atk.buffAttack -= atk._selfDrainOnAttack;
        this.log(`${atk.name} 攻击力 -${atk._selfDrainOnAttack}`);
      }
      return { ok: true };
    }

    find(uid) {
      for (const c of this.allBoard()) if (c.uid === uid) return c;
      return null;
    }

    /**
     * 中央触发器派发：扫描双方场上单位的 trigger 子句（kind:'trigger'），
     * 命中事件与条件则执行其 ops。filter 用于限定作用单位（如"只有击杀者自己"）。
     */
    fireTrigger(event, ctx, filter) {
      for (const u of [...this.unitsOf(0), ...this.unitsOf(1)]) {
        if (filter && !filter(u)) continue;
        const cls = u._parsed || (u._parsed = parseClauses(u.text));
        for (const cl of cls) {
          if (cl.kind !== 'trigger' || cl.event !== event) continue;
          if (!evalCond(cl.cond, this, u, ctx || {})) continue;
          if (cl.once) {
            // 每回合一次的触发（158. NACHSCHUB / 2. MARINE DIVISION 等）
            const key = '_onceTrig';
            if (u[key] === this.turn) continue;
            u[key] = this.turn;
          }
          this.log(`触发：${u.name}`);
          this.execOps(cl.ops, u, { ...(ctx || {}), trigger: true });
        }
      }
    }

    /** 手牌监听："每当你 X，此牌费用 -N"（在事件点扫手牌调整 _costMod） */
    bumpHandWatches(event, side) {
      const hand = this.players[side] && this.players[side].hand;
      if (!hand) return;
      for (const c of hand) {
        if (!c._handWatch || c._handWatch.event !== event) continue;
        c._costMod = (c._costMod || 0) + c._handWatch.delta;
        this.log(`${c.name} 手牌费用 ${c._handWatch.delta > 0 ? '+' : ''}${c._handWatch.delta}（当前 ${c.effCost}）`);
      }
    }

    /** 场上是否有"总部不能获得防御"的单位（KAGOSHIMA REGIMENT） */
    hqHealBlocked() {
      for (const u of [...this.unitsOf(0), ...this.unitsOf(1)]) if (u._hqNoHeal) return true;
      return false;
    }

    /**
     * 相邻费用光环重算（"左侧/右侧单位行动费 -N"）：
     * 先撤掉上次贡献，再按当前位置重算，避免重复叠加。
     */
    /** 队伍级光环查询：返回 card 在 kind（operate/deploy）上的费用增减 */
    teamAuraFor(card, kind) {
      if (!card || !card.isUnit) return 0;
      let d = 0;
      for (const u of [...this.unitsOf(0), ...this.unitsOf(1)]) {
        for (const a of (u._teamAuras || [])) {
          if (a.kind !== kind) continue;
          const appliesTo = a.side === 'enemy' ? (card.owner !== u.owner) : (card.owner === u.owner);
          if (!appliesTo) continue;
          if (a.f.other && u.uid === card.uid) continue;
          if (a.f.type && card.type !== a.f.type) continue;
          if (a.f.ground && !['infantry', 'tank', 'artillery'].includes(card.type)) continue;
          if (a.f.air && !['fighter', 'bomber'].includes(card.type)) continue;
          if (a.f.nation && card.nation !== a.f.nation) continue;
          if (a.f.minAttack != null && card.totalAttack < a.f.minAttack) continue;
          d += a.delta || 0;
        }
      }
      return d;
    }

    applyAuras() {
      const all = [...this.unitsOf(0), ...this.unitsOf(1)];
      for (const u of all) {
        if (u._auraTaken) { u._opCostMod = (u._opCostMod || 0) - u._auraTaken; u._auraTaken = 0; }
      }
      for (const src of all) {
        if (!src._auraOpCostDir) continue;
        const row = src.loc === 'front' ? this.frontline : this.players[src.owner].board;
        for (const u of row) {
          if (u === src || u.owner !== src.owner) continue;
          if (src._auraOpCostDir === 'left' && !(u.slot < src.slot)) continue;
          if (src._auraOpCostDir === 'right' && !(u.slot > src.slot)) continue;
          u._opCostMod = (u._opCostMod || 0) + src._auraOpCostVal;
          u._auraTaken = (u._auraTaken || 0) + src._auraOpCostVal;
        }
      }
    }

    /** 总部是否持有某关键词（含临时授予，如 DEPTH CHARGES 的 HQ 烟幕） */    hqHas(side, kw) {
      const p = this.players[side];
      if (!p) return false;
      if (p._hqTempKws && p._hqTempKws.some(e => e.kw === kw)) return true;
      return !!(p.hq && p.hq.keywords && p.hq.keywords.has && p.hq.keywords.has(kw));
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

    /**
     * 指令牌效果执行。
     *
     * parseClauses 只产出 static / deployment / destruction / trigger 四种 kind
     * （解析层不知道卡牌类型），所以指令牌不能按 kind==='order' 取子句 ——
     * 之前 playCard 调用 execCardText(c,'order') 永远匹配不到任何子句，
     * 结果所有指令牌都在扣费后静默失效。这里改为：
     *   - 执行 static 子句（指令文本本身就是效果）
     *   - 立即执行 trigger 子句（"When you play this…" 类对指令而言就是立即结算；
     *     需要外部事件的触发对已进弃牌堆的指令没有意义，跳过）
     */
    execOrderText(c, ctx) {
      const clauses = c._parsed || (c._parsed = parseClauses(c.text));
      for (const cl of clauses) {
        if (cl.kind === 'destruction' || cl.kind === 'deployment') continue;
        if (cl.kind === 'trigger' && cl.event && cl.event !== 'selfAttack' && cl.event !== 'selfDestroy') continue;
        if (!evalCond(cl.cond, this, c, ctx)) continue;
        this.execOps(cl.ops, c, ctx);
      }
    }

    execOps(ops, src, ctx) {
      // 已有待选择效果未结算：把剩余操作排队，等玩家选完再继续
      if (this.pendingChoose) {
        (this._chooseQueue = this._chooseQueue || []).push({ ops, src, ctx, i: 0 });
        return;
      }
      for (let i = 0; i < ops.length; i++) {
        this.execOp(ops[i], src, ctx || {});
        if (this.pendingChoose) {
          (this._chooseQueue = this._chooseQueue || []).push({ ops, src, ctx, i: i + 1 });
          return;
        }
      }
    }

    /** 玩家二选一结算：执行所选分支，并把排队中的剩余操作继续跑完 */
    resolveChoose(side, index) {
      const pc = this.pendingChoose;
      if (!pc) return { ok: false, error: '没有待选择的效果' };
      if (pc.side !== side) return { ok: false, error: '不是你的选择' };
      this.pendingChoose = null;
      const pick = pc.options[index];
      if (!pick) return { ok: false, error: '无效的选项' };
      this.log(`P${side + 1} 选择：${pick.text}`);
      this.ev({ e: 'choose', side, text: pick.text, index });
      const src = (this.find(pc.srcUid) || pc.src);
      this.execOps(pick.ops, src, pc.ctx || {});
      this.drainChooseQueue();
      return { ok: true, text: pick.text };
    }

    /** 把排队中的后续操作继续执行（可能再次触发新的选择） */
    drainChooseQueue() {
      const q = this._chooseQueue;
      if (!q) return;
      while (q.length) {
        if (this.pendingChoose) return;
        const fr = q.shift();
        for (let i = fr.i; i < fr.ops.length; i++) {
          this.execOp(fr.ops[i], fr.src, fr.ctx || {});
          if (this.pendingChoose) { fr.i = i + 1; q.unshift(fr); return; }
        }
      }
      this._chooseQueue = null;
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
          // 触发事件载荷目标："give it +1+3"（刚部署的单位）/ "Suppress it"（刚被压制的单位）
          case 'deployed': return (ctx && ctx.card && ctx.card.isUnit) ? ctx.card : null;
          case 'event': {
            if (ctx && ctx.card && ctx.card.isUnit) return ctx.card;
            if (ctx && ctx.uid != null) { const t = this.find(ctx.uid); if (t && t.isUnit) return t; }
            return null;
          }
          default: return null;
        }
      };
      switch (op.op) {
        // ---- 队伍级光环（关键词 / 行动费 / 部署费）----
        case 'teamAura': {
          src._teamAuras = src._teamAuras || [];
          src._teamAuras.push({ kind: op.kind, delta: op.delta || 0, kw: op.kw, side: op.side, f: op.f || {} });
          if (op.kind === 'keyword' && op.kw) {
            // 近似：部署时点给当前场上符合条件的目标授予关键词
            for (const u of this.unitsOf(me)) {
              if (u.uid === src.uid) continue;
              if (op.f.type && u.type !== op.f.type) continue;
              if (op.f.ground && !['infantry', 'tank', 'artillery'].includes(u.type)) continue;
              if (op.f.air && !['fighter', 'bomber'].includes(u.type)) continue;
              if (op.f.nation && u.nation !== op.f.nation) continue;
              if (op.f.minAttack != null && u.totalAttack < op.f.minAttack) continue;
              u.keywords.add(op.kw);
            }
            this.log(`${src.name}：我方符合条件的单位获得 ${op.kw}`);
          } else {
            this.log(`${src.name}：${op.kind === 'operate' ? '行动费' : '部署费'}光环 ${op.delta > 0 ? '+' : ''}${op.delta}`);
          }
          this.applyAuras();
          break;
        }
        case 'stripKwOnAttack': {
          src._stripKwOnAttack = op.kw;
          this.log(`${src.name}：被其攻击的单位失去 ${op.kw}`);
          break;
        }
        case 'drawTypedMulti': {
          const p = this.players[me];
          for (const tp of op.types) {
            const i = p.deck.findIndex(c => c.type === tp);
            if (i < 0) continue;
            const c = p.deck.splice(i, 1)[0];
            c.loc = 'hand';
            p.hand.push(c);
            this.log(`抽到 ${c.name}（${tp}）`);
          }
          break;
        }
        case 'hqDmgReduce': {
          const cnt = this.unitsOf(me).filter(u => u.totalAttack >= op.per).length;
          this.players[me]._hqDmgReduce = (op.n || 1) * cnt;
          this.log(`总部伤害减免 ${this.players[me]._hqDmgReduce}（${op.per}+ 攻击单位 ${cnt} 个）`);
          break;
        }
        case 'hqLossCap': {
          this.players[me]._hqLossCap = op.n;
          this.log(`总部每回合最多损失 ${op.n} 点防御`);
          break;
        }
        case 'opCostOnAttack': {
          src._opCostOnAttack = (src._opCostOnAttack || 0) + op.n;
          this.log(`${src.name}：每次攻击后行动费 +${op.n}`);
          break;
        }
        case 'moveAndAttack': {
          src._moveAndAttack = true;
          this.log(`${src.name}：可先移动再攻击`);
          break;
        }
        case 'operateOnKill': {
          src._operateOnKill = true;
          this.log(`${src.name}：击杀后可再次行动`);
          break;
        }
        case 'bunkerAfterAttack': {
          src._bunkerAfterAttack = true;
          this.log(`${src.name}：攻击后离场，下回合归来`);
          break;
        }
        case 'orderLimit': {
          this._orderLimit = op.n;
          this.log(`每回合最多给出 ${op.n} 张指令`);
          break;
        }
        case 'enemyFirstCardDouble': {
          this._enemyFirstCardDouble = true;
          this.players[foe]._enemyFirstDoubleOwner = true;
          this.log('敌方每回合第一张卡费用翻倍');
          break;
        }
        // ================= 批量补齐的机制 op =================
        case 'ownHQDamage': {
          this.damageHq(me, op.n, src);
          break;
        }
        case 'excessToHq': {
          src._excessToHq = true;
          this.log(`${src.name}：摧毁目标后溢出伤害打到敌方总部`);
          break;
        }
        case 'splashHq': {
          src._splashHq = true;
          this.log(`${src.name}：攻击伤害同时打到敌方总部`);
          break;
        }
        case 'hqGainFromDamage': {
          src._hqGainFromDamage = true;
          this.log(`${src.name}：受伤时总部回复等量防御`);
          break;
        }
        case 'redirectToSelf': {
          src._hqDamageRedirect = true;
          this.log(`${src.name}：总部受到的伤害转由本单位承担`);
          break;
        }
        case 'hqHealBonus': {
          const pp = this.players[me];
          pp._hqHealBonus = (pp._hqHealBonus || 0) + op.n;
          this.log(`总部恢复防御时额外 +${op.n}`);
          break;
        }
        case 'toDeckTop': {
          src._toDeckTop = true;
          this.log(`${src.name}：阵亡后回到牌库顶`);
          break;
        }
        case 'cycleTop': {
          const p = this.players[me];
          if (p.deck.length) {
            const c = p.deck.shift();
            const keep = this.rng.next() < 0.5;
            if (keep) { p.hand.push(c); c.loc = 'hand'; this.log(`抽到 ${c.name}，保留`); }
            else { c.loc = 'discard'; p.discard.push(c); this.log(`抽到 ${c.name}，弃掉`); }
          }
          break;
        }
        case 'doubleAttack': {
          src.buffAttack += src.totalAttack;
          this.log(`${src.name} 攻击力翻倍至 ${src.totalAttack}`);
          break;
        }
        case 'grantImmune': {
          const pool = this.unitsOf(me).filter(u => u.type === 'fighter' || u.type === 'bomber');
          if (!pool.length) { this.log('没有可保护的空中单位'); break; }
          const u = this.rng.pick(pool);
          u._immune = true;
          u._tempImmune = this.turn * 2 + this.current;
          this.log(`${u.name} 本回合免疫伤害`);
          break;
        }
        case 'resetDefender': {
          src._resetDefender = true;
          this.log(`${src.name}：攻击时重置防守方攻击次数`);
          break;
        }
        case 'handTaxAll': {
          this.players[foe]._handTaxAll = (this.players[foe]._handTaxAll || 0) + op.n;
          this.log(`敌方手牌费用 +${op.n}`);
          break;
        }
        case 'damage': {
          const apply = (t, n) => {
            if (!t) return;
            // "Your orders deal +N damage"：指令伤害全局加成
            let dmg = n;
            if (src && src.type === 'order') dmg += (this.players[me]._orderDmgMod || 0);
            this.damageCard(t, dmg, src);
          };
          const calcN = () => {
            switch (op.calc) {
              case 'airAttackSum': return this.unitsOf(me).filter(u => u.type === 'fighter' || u.type === 'bomber').reduce((a, u) => a + u.totalAttack, 0);
              case 'enemyHandSize': return this.players[foe].hand.length;
              case 'kreditsSpent': return this.players[me].kreditsSpent || 0;
              case 'ownUnitCount': return this.unitsOf(me).length;
              case 'kredits': return this.players[me].kredits || 0;
              case 'ownHandSize': return this.players[me].hand.length;
              case 'highestOwnAttack': return this.unitsOf(me).reduce((a, u) => Math.max(a, u.totalAttack), 0);
              case 'atk': return src.totalAttack || 0;
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
        case 'hqDrain': {
          src._hqDrain = true;
          this.log(`${src.name} 造成伤害时为本方总部恢复等量防御`);
          break;
        }
        case 'destroyOnDamage': {
          src._destroyOnDamage = true;
          this.log(`${src.name} 的战斗伤害将直接摧毁目标`);
          break;
        }
        case 'orderDmgMod': {
          const p = this.players[me];
          p._orderDmgMod = (p._orderDmgMod || 0) + op.n;
          this.log(`我方指令伤害 +${op.n}`);
          break;
        }
        case 'opCostMod': {
          // 触发事件目标："give it ... -1 operation cost"（36. KRADSCHÜTZEN）
          const t = (op.target === 'deployed' && ctx && ctx.card && ctx.card.isUnit) ? ctx.card
            : (op.target === 'event' && ctx) ? (ctx.card && ctx.card.isUnit ? ctx.card : (ctx.uid != null ? this.find(ctx.uid) : null))
            : src;
          if (!t || !t.isUnit) break;
          t._opCostMod = (t._opCostMod || 0) + op.n;
          this.log(`${t.name} 行动费 ${op.n > 0 ? '+' : ''}${op.n}（当前 ${t.effOpCost}）`);
          break;
        }
        case 'dmgMod': {
          // 伤害修正（对 HQ / 空中 / 坦克等额外或翻倍伤害），在攻击结算时读取
          src._dmgMods = src._dmgMods || [];
          src._dmgMods.push({ add: op.add || 0, mult: op.mult || 1, vs: op.vs || 'all' });
          this.log(`${src.name} 伤害修正：${op.mult ? '×' + op.mult : '+' + op.add}（对 ${op.vs}）`);
          break;
        }
        case 'orderImmune': {
          src._orderImmune = true;
          src.keywords.add('orderimmune');
          this.log(`${src.name} 不能被敌方指令指定`);
          break;
        }
        case 'pinImmune': {
          src._pinImmune = true;
          this.log(`${src.name} 不能被压制`);
          break;
        }
        case 'stripKwOnAttack': {
          src._stripKwOnAttack = op.kw;
          this.log(`${src.name} 攻击的目标会失去 ${op.kw}`);
          break;
        }
        case 'thorns': {
          src._thorns = op.n;
          this.log(`${src.name} 受到攻击时反伤 ${op.n}`);
          break;
        }
        case 'enemyTax': {
          src._enemyTax = op.n;
          this.log(`敌方攻击/指定 ${src.name} 需额外 ${op.n} 指挥点`);
          break;
        }
        case 'selfDrainOnAttack': {
          src._selfDrainOnAttack = op.n;
          this.log(`${src.name} 每次攻击后攻击力 -${op.n}`);
          break;
        }
        case 'auraOpCost': {
          src._auraOpCostDir = op.dir;
          src._auraOpCostVal = op.n;
          this.log(`${src.name}：${op.dir === 'left' ? '左侧' : '右侧'}单位行动费 ${op.n}`);
          this.applyAuras();
          break;
        }
        case 'addHandAny': {
          // 从候选名里随机取一张加入手牌（Develop 多选一的近似实现）
          const pool = [];
          for (const nm of op.names) {
            const defs = this.findByName(nm, me);
            if (defs.length) pool.push(defs[0]);
          }
          if (!pool.length) { this.log(`（未找到可生成的卡牌：${op.names.join(' / ')}）`); break; }
          const def = this.rng.pick(pool);
          const nc = new CardInst(def, me, this);
          nc.loc = 'hand';
          if (this.players[me].hand.length < RULES.MAX_HAND) this.players[me].hand.push(nc);
          else this.players[me].discard.push(nc);
          this.log(`Develop：${nc.name} 加入手牌`);
          break;
        }
        case 'convert': {
          // ① 自身变形：At the end of turn, Convert into X（op.name）
          // ② 目标单位变形：Convert target unit into X（op.to）
          const targetName = op.name || op.to;
          if (!op.name) {
            const targets = op.target === 'allEnemyUnits' || op.target === 'allUnits'
              ? (op.target === 'allEnemyUnits' ? this.unitsOf(foe) : [...this.unitsOf(0), ...this.unitsOf(1)])
              : [pickUnit(op.target === 'friendlyUnit' ? 'friendlyUnit' : 'enemyUnit')].filter(Boolean);
            const tdef = this.findByName(targetName, me)[0] || this.findByName(targetName)[0];
            if (!tdef) { this.log(`（未找到变形目标：${targetName}）`); break; }
            for (const t of targets) {
              const nc = new CardInst(tdef, t.owner, this);
              nc.uid = t.uid; nc.loc = t.loc; nc.slot = t.slot;
              nc.summonedTurn = t.summonedTurn; nc.hasAttacked = t.hasAttacked; nc.hasMoved = t.hasMoved;
              if (t.loc === 'front') { const i = this.frontline.indexOf(t); if (i >= 0) this.frontline[i] = nc; }
              else { const b = this.players[t.owner].board; const i = b.indexOf(t); if (i >= 0) b[i] = nc; }
              this.log(`${t.name} 变形为 ${nc.name}`);
            }
            break;
          }
          const defs = this.findByName(op.name, me);
          if (!defs.length) { this.log(`（变形目标不存在：${op.name}）`); break; }
          const nd = new CardInst(defs[0], src.owner, this);
          nd.uid = src.uid; nd.loc = src.loc; nd.slot = src.slot;
          nd.summonedTurn = src.summonedTurn;
          nd.defense = nd.defense;
          if (src.loc === 'front') {
            const i = this.frontline.indexOf(src);
            if (i >= 0) this.frontline[i] = nd;
          } else if (src.loc === 'board') {
            const b = this.players[src.owner].board;
            const i = b.indexOf(src);
            if (i >= 0) b[i] = nd;
          }
          this.log(`${src.name} 变形成 ${nd.name}`);
          this.ev({ e: 'veteran', uid: nd.uid, name: nd.name, owner: nd.owner });
          this.fireTrigger('becomesVeteran', { uid: nd.uid, owner: nd.owner, type: nd.type, nation: nd.nation, card: nd }, () => true);
          break;
        }
        case 'kreditsNextTurn': {
          const p = this.players[me];
          p._kreditsNextMod = (p._kreditsNextMod || 0) + op.n;
          this.log(`下回合指挥点 ${op.n}`);
          break;
        }
        case 'handCostSet': {
          for (const c of this.players[me].hand) c._costMod = op.n - (c.cost || 0);
          this.log(`我方手牌费用统一设为 ${op.n}`);
          break;
        }
        case 'freeIfLost': {
          src._freeIfLost = true;
          this.log(`${src.name}：本回合有友军阵亡时可 0 费部署`);
          break;
        }
        case 'noDiscard': { this.players[me]._noDiscard = true; this.log('我方卡牌不会被弃置'); break; }
        case 'noHealUnits': { this._noHealUnits = true; this.log('单位无法被治疗'); break; }
        case 'blockHighAttack': { this._blockHighAttack = op.n; this.log(`攻击力 ≥${op.n} 的单位无法攻击`); break; }
        case 'deployGate': {
          src._deployGate = { kind: op.kind, n: op.n };
          this.log(`${src.name} 有部署条件限制`);
          break;
        }
        case 'hqFloor': {
          src._hqFloor = op.n;
          this.log(`${src.name}：在前线时总部最低保留 ${op.n} 防御`);
          break;
        }
        case 'hqNoHeal': {
          src._hqNoHeal = true;
          this.log(`${src.name}：总部无法恢复防御`);
          break;
        }
        case 'firstOrderDiscount': {
          const p = this.players[me];
          p._firstOrderDiscount = (p._firstOrderDiscount || 0) + op.n;
          this.log(`本回合首张指令费用 ${op.n}`);
          break;
        }
        case 'leftmostCost': {
          const p = this.players[me];
          p._leftmostCost = (p._leftmostCost || 0) + op.n;
          this.log(`最左放手牌费用 ${op.n}`);
          break;
        }
        case 'enemyHandTax': {
          const fp = this.players[foe];
          if (op.type === 'order') {
            fp._handTaxOrder = (fp._handTaxOrder || 0) + op.n;
            this.log(`敌方手牌指令费用 +${op.n}`);
          } else {
            fp._handTaxGotcha = (fp._handTaxGotcha || 0) + op.n;
            this.log(`敌方反制指令费用 +${op.n}`);
          }
          break;
        }
        case 'dmgTakenMod': {
          src._dmgTakenMod = { minus: op.minus || 0, vs: op.vs || 'ground' };
          this.log(`${src.name} 受到${op.vs === 'air' ? '空中' : '地面'}单位伤害 -${op.minus}`);
          break;
        }
        case 'groundProof': {
          src._groundProof = true;
          this.log(`${src.name} 在支援阵线不会被地面单位攻击`);
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
          if (this.hqHealBlocked()) { this.log('总部无法获得防御（效果被阻止）'); break; }
          const p = this.players[me];
          const n = op.calc ? (this.countOf(op.calc, src, ctx) || 0) : op.n;
          if (!n) break;
          const bonus = p._hqHealBonus || 0;
          p.hqMaxDef += n;
          p.hqDef += n + bonus;
          this.log(`我方总部防御 +${n}${bonus ? `（加成 +${bonus}）` : ''}`);
          this.fireTrigger('ownHqHealed', { side: me, amount: n }, u => u.owner === me);
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
          if (op.cond && !evalCond(op.cond, this, src, ctx)) {
            this.log(`${src.name} 条件未满足，加成不生效`);
            break;
          }
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
          if (op.cond && !evalCond(op.cond, this, src, ctx)) {
            this.log(`${src.name} 条件未满足，未获得关键词`);
            break;
          }
          let t = pickUnit(op.target);
          if (op.self && src.isUnit) t = src;
          if (t) {
          for (const k of op.kws) {
            const kw = String(k).toLowerCase();
            const prevCap = t.has('fury') ? 2 : 1;    // 授予前的攻击容量
            t.keywords.add(kw);
            // 临时关键字："until end of turn" —— 半回合结束后撤销
            if (op.temp) {
              t._tempKws = t._tempKws || {};
              t._tempKws[kw] = this.turn * 2 + this.current;
            }
            // 拿到 Fury 后按"容量 2 - 已攻击次数"重算剩余攻击（部署时=2，攻击一次后=1）
            if (kw === 'fury' && t.isUnit) {
              const usedBefore = Math.max(0, prevCap - t.attacksLeft);
              t.attacksLeft = Math.max(0, 2 - usedBefore);
            }
          }
            this.log(`${t.name} 获得关键词：${op.kws.join('/')}${op.temp ? '（本回合）' : ''}`);
          }
          break;
        }
        case 'hqKeyword': {
          // 总部临时关键词（DEPTH CHARGES：HQ 获得烟幕直到你的下个回合）
          const p2 = this.players[me];
          p2._hqTempKws = p2._hqTempKws || [];
          const until = this.turn * 2 + this.current + 2;   // 己方下个半回合
          for (const k of op.kws) {
            p2._hqTempKws.push({ kw: String(k).toLowerCase(), until });
            this.log(`P${me + 1} 总部获得关键词：${k}（直到你的下个回合）`);
          }
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
              this.fireTrigger('unitRetreated', { uid: t.uid, owner: t.owner, type: t.type, card: t }, () => true);
            } else this.log(`  ${t.name} cannot retreat (support full)`);
          }
          break;
        }
        case 'pin': {
          const list = (op.target === 'allEnemyUnits' ? this.unitsOf(foe) : op.target === 'event'
            ? [ctx && ctx.card && ctx.card.isUnit ? ctx.card : (ctx && ctx.uid != null ? this.find(ctx.uid) : null)].filter(Boolean)
            : [pickUnit('enemyUnit')].filter(Boolean))
            .filter(u => !u._pinImmune);
          // 已钉住的单位不再触发 unitPinned（防 CROMWELL"压制→触发→再压制"死循环）
          for (const u of list) {
            const was = u._pinned;
            u._pinned = true;
            if (!was) this.fireTrigger('unitPinned', { uid: u.uid, owner: u.owner, type: u.type, card: u }, () => true);
          }
          this.log(`压制了 ${list.length} 个单位`);
          break;
        }
        case 'destroy': {
          if (op.target === 'allEnemyUnits') { for (const u of [...this.unitsOf(foe)]) this.destroyCard(u, src); break; }
          if (op.target === 'selfUnit') { this.destroyCard(src, src); this.log(`${src.name} 被自身效果摧毁`); break; }
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
              this.ev({ e: 'veteran', uid: src.uid, name: nc.name, owner: src.owner });
              // "When this/a unit becomes Veteran, ..."（22nd GUARDS / 64. PANZERGRENADIER / GREEN HOWARDS）
              this.fireTrigger('becomesVeteran', { uid: nc.uid, owner: nc.owner, type: nc.type, nation: nc.nation, card: nc }, () => true);
              break;
            }
          }
          break;
        }
        case 'choose': {
          const opts = op.options || [];
          if (!opts.length) break;
          // 人类玩家：挂起等 UI 二选一；AI / 自对弈：自动取第一项
          if (this.humanSides && this.humanSides[me]) {
            this.pendingChoose = {
              side: me,
              srcUid: src.uid,
              src,                     // 指令牌打出后已进弃牌堆，find() 找不到，直接留引用
              ctx: ctx || {},
              options: opts.map(o => ({ text: o.text || '', ops: o.ops })),
            };
            this.log(`等待 P${me + 1} 二选一：${opts.map(o => o.text).join(' / ')}`);
            this.ev({ e: 'choosePending', side: me, options: opts.map(o => o.text) });
            break;
          }
          this.execOps(opts[0].ops, src, ctx);
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
            if (c.keywords && [...c.keywords].some(k => norm(k).includes(kwNorm))) return true;
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
            let cands = p.hand.filter(c => !op.maxCost || op.maxCost >= 99 || (c.cost || 0) <= op.maxCost);
            if (op.typed) {
              const f = cands.filter(c => c.type === op.typed);
              if (f.length) cands = f;
            }
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
      if (side === 'enemy') {
        // "不能被敌方指令指定" 的单位不进入候选
        return this.unitsOf(1 - c.owner).filter(u => !u._orderImmune).map(u => u.uid);
      }
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
          // 只给本座位下发真实手牌；对手只手牌数量（防止抓包读到敌方手牌）
          hand: i === side ? this.players[i].hand.map(c => cardView(c, true)) : [],
          handCount: this.players[i].hand.length,
          deckCount: this.players[i].deck.length,
          board: this.players[i].board.map(c => cardView(c, false)),
          discardCount: this.players[i].discard.length,
        })),
        frontline: this.frontline.map(c => cardView(c, false)),
        // 二选一：只把选项文本发给正在选择的那一方（对手只看到"对方在选择"）
        pendingChoose: this.pendingChoose
          ? (this.pendingChoose.side === side
              ? { side, options: this.pendingChoose.options.map(o => o.text) }
              : { side: this.pendingChoose.side, options: [] })
          : null,
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
    // 是否有官方卡图：无图的卡不进构筑卡池 / 收藏（效果生成的衍生单位仍可按 id 找到，
    // 显示时走 .no-img 名字牌兜底）
    const hasArt = (c) => !!(c && c.image && !/Blank/i.test(c.image));
    for (const c of cards) { byId[c.id] = c; c.hasArt = hasArt(c); }
    const deckPool = cards.filter(c => c.hasArt);
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
    return { byId, cards, deckPool, hasArt, hqs, hqsOf, hqById, hqList: list, nationOf };
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
      if (d.hasArt === false) errors.push(`${d.name} 没有官方卡图，不在可用卡池中`);
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
    const pool = (db.deckPool || db.cards).filter(playable);
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
    // 补位：卡池较小的国家（如过滤无图卡后）凑不满 39 张时，
    // 按费用/随机从整个可用池补齐，仍受稀有度与副国上限约束
    let guard = 0;
    while (deck.length < RULES.DECK_SIZE && guard++ < 400) {
      const c = rng.pick(pool);
      if (c && add(c)) deck.push(c.id);
    }
    return deck.slice(0, RULES.DECK_SIZE);
  }

  return {
    RULES, NATION_CODE, DEFAULT_HQ_CODE,
    Game, CardInst, makeRng, parseClauses, parseDeckCode, buildDb, autoDeck,
    validateDeck, rarityLimit, isEliteCard, RARITY_LIMITS, MAJOR_NATIONS, ALLY_NATIONS, ALLY_CARD_LIMIT,
  };
});
