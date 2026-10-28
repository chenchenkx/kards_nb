/* 单位卡"接线"审计 v2：按卡自身声明的子句逐条验证是否真的生效
 *
 * 方法：同一张卡「原文」vs「清空文本（同 id、同数值）」，各跑同一动作，比对世界状态 delta。
 * 只有原文卡多出来的变化才算"已接线"——排除通用规则（部署本身、费用扣除）的噪声，
 * 又能抓出"解析了但执行没接上"。
 *
 * 覆盖：deployment（打出）、trigger（派发对应事件）、destruction（阵亡）、pincer（先打一张再打它）
 *      static（部署后二阶探针：打一拳 / 再部署一个）
 * 输出：.work/unit_wiring.md
 */
const fs = require('fs'), path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);
const UNITS = db.cards.filter(c => ['infantry', 'tank', 'artillery', 'fighter', 'bomber'].includes(c.type) && (c.text || '').trim());
const FILL = db.deckPool.filter(c => c.type === 'infantry' && !c.text && (c.cost || 0) <= 3);

/** 陪练环境：己方/敌方各 1 支援线单位（解除守护/隐蔽）
 *  opts: air（敌方空军）/ front（敌方前线单位）/ allyTank（己方坦克）/ manyAllies（己方 4 单位）
 *        foeBlitz（敌方带闪击）/ hqLow（己方总部残血）/ hqHigh（己方总部远高于敌方） */
function mkGame(opts = {}) {
  const d = FILL.slice(0, 6).map(c => c.id);
  const deck = []; for (let i = 0; i < 39; i++) deck.push(d[i % d.length]);
  // 混入其它国籍单位与指令（供"检索某国单位/指令"类效果命中）
  if (opts.deckMix) {
    const extra = db.cards.filter(c => c.type === 'order' && (c.cost || 0) <= 3).slice(0, 3)
      .concat(db.cards.filter(c => c.nation === 'Japan' && c.type === 'infantry' && (c.cost || 0) <= 1).slice(0, 2))
      .concat(db.cards.filter(c => c.nation === 'Soviet' && (c.cost || 0) <= 1).slice(0, 2))
      .concat(db.cards.filter(c => c.type === 'fighter' && (c.cost || 0) <= 3).slice(0, 2));
    for (const e of extra) deck.splice(Math.floor(deck.length * 0.5), 0, e.id);
  }
  const g = new Engine.Game({ db, seed: 41, decks: [deck, deck.slice()], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  g.players[0].kredits = 30; g.players[0].slots = 12;
  g.players[1].kredits = 30; g.players[1].slots = 12;
  const foe = new Engine.CardInst(FILL[1], 1, g);
  foe.loc = 'board'; foe.slot = 0; foe.summonedTurn = 0; foe.defense = 20;
  foe.keywords.delete('guard'); foe.keywords.delete('covert');
  if (opts.foeBlitz) foe.keywords.add('blitz');
  g.players[1].board.push(foe);
  let foeAir = null;
  if (opts.air) {
    foeAir = new Engine.CardInst(db.cards.find(c => c.type === 'fighter' && (c.cost || 0) <= 3) || FILL[4], 1, g);
    foeAir.loc = 'board'; foeAir.slot = 2; foeAir.summonedTurn = 0;
    g.players[1].board.push(foeAir);
  }
  let foeFront = null;
  if (opts.front) {
    foeFront = new Engine.CardInst(FILL[5], 1, g);
    foeFront.loc = 'front'; foeFront.summonedTurn = 0;
    g.frontline.push(foeFront); g.frontlineOwner = 1;
  }
  const ally = new Engine.CardInst(FILL[3], 0, g);
  ally.loc = 'board'; ally.slot = 0; ally.summonedTurn = 0;
  ally.keywords.delete('guard');
  g.players[0].board.push(ally);
  if (opts.allyFront) {
    const f = new Engine.CardInst(FILL[2], 0, g);
    f.loc = 'front'; f.summonedTurn = 0;
    g.frontline.push(f); if (g.frontlineOwner === -1) g.frontlineOwner = 0;
  }
  if (opts.allyTank) {
    const tankDef = db.cards.find(c => c.type === 'tank' && !(c.text || '').trim() && (c.cost || 0) <= 3) || FILL[2];
    const t = new Engine.CardInst(tankDef, 0, g);
    t.loc = 'board'; t.slot = 2; t.summonedTurn = 0;
    g.players[0].board.push(t);
  }
  if (opts.manyAllies) {
    for (let i = 0; i < 3; i++) {
      const a = new Engine.CardInst(FILL[i % FILL.length], 0, g);
      a.loc = 'board'; a.summonedTurn = 0;
      g.players[0].board.push(a);
    }
  }
  if (opts.hqLow) g.players[0].hqDef = 6;
  if (opts.hqHigh) g.players[0].hqDef = 30;
  return { g, foe, foeAir, foeFront, ally };
}

/** 世界状态快照：同名单位聚合成排序数组，避免"多生一个同名单位"被键合并吃掉 */
function snap(g) {
  const units = {};
  for (const side of [0, 1]) {
    for (const u of g.unitsOf(side)) {
      const k = side + '|' + u.id + '|' + u.loc;   // 用 id：veteran/convert 后 name 可能不变
      (units[k] = units[k] || []).push([u.defense, u.buffAttack, u.buffDefense, [...u.keywords].sort().join('+'),
        [u._pinOnDamage, u._hqDamageRedirect, u._destructionTwice, u._noRetreat, u._pinImmune, u._dmgAddsDefense,
         u._handWatch ? 1 : 0, u._redirectName || '', (u._dmgMods || []).length, (u._teamAuras || []).length,
         u._opCostMod || 0, u._costMod || 0, u._hqFloor || 0, u._hqLossCap || 0,
         u._noAttack ? 1 : 0, u._pinImmune ? 1 : 0, u._ignoreArmor ? 1 : 0,
         u._dmgTakenTo == null ? '' : u._dmgTakenTo, u._dmgTakenMult || 1, u._splashAdjacent || 0,
         u._dmgTakenTo == null ? '' : u._dmgTakenTo, u._dmgTakenMult || 1, u._splashAdjacent || 0,
         u._destroyTanksOnDamage ? 1 : 0, u._pinOnDamageAdj ? 1 : 0, u._pinAirOnCombat ? 1 : 0,
         u._excessToHq ? 1 : 0, u._splashHq ? 1 : 0, u._salvage ? 1 : 0, u.heavyArmor || 0,
         u._noHQ ? 1 : 0, u._enemyTax || 0, u.attacksLeft == null ? '' : u.attacksLeft,
         u._revealed ? 1 : 0].join('/'),
        u._pinned ? 'P' : '', u._suppressed ? 'S' : '', u.effOpCost, u.loc].join(','));
    }
  }
  for (const k of Object.keys(units)) units[k] = units[k].sort().join(';');
  return {
    units,
    hq: [g.players[0].hqDef, g.players[1].hqDef, g.players[0].hqMaxDef, g.players[1].hqMaxDef].join(','),
    k: [g.players[0].kredits, g.players[1].kredits, g.players[0].slots, g.players[1].slots].join(','),
    hand: g.players[0].hand.length, deck: g.players[0].deck.length,
    deck1: g.players[1].deck.length,
    handCost: g.players[0].hand.map(c => (c.effCost || 0)).join(','),
    handNames: g.players[0].hand.map(c => c.name).sort().join(','),
    hand1Names: g.players[1].hand.map(c => c.name).sort().join(','),
    handGotcha: g.players[0].hand.map(c => c.gotchaActive || 0).join(','),
    disc: g.players[0].discard.length, disc1: g.players[1].discard.length,
    front: g.frontlineOwner + '/' + g.frontline.length,
    deckTop0: g.players[0].deck[0] ? g.players[0].deck[0].name : '',
    flags: [g.players[0]._hqHealBonus || 0, g.players[0]._hqDmgReduce || 0, g.players[0]._deployTwice ? 1 : 0,
      g.players[0]._enemyDeployOpCost || 0, g.players[0]._notFromDeckDiscount || 0,
      g.players[1]._deployGate || 0,
      JSON.stringify(g.players[0]._teamDmgCap || null), g.players[0]._blastDmgBonus || 0,
      g.players[0]._planDrawBonus || 0, g.players[0]._productionBonus || 0,
      g.players[0]._weatherCostDiscount || 0, g.players[0]._orderDmgMod || 0].join(','),
  };
}

/** 把单位放到前线（供精准场景使用） */
function toFront(u, g) {
  u.loc = 'front'; u.summonedTurn = -1; u.hasAttacked = false; u.attacksLeft = 1;
  const bi = g.players[0].board.indexOf(u); if (bi >= 0) g.players[0].board.splice(bi, 1);
  if (!g.frontline.includes(u)) g.frontline.push(u);
  g.frontlineOwner = 0;
}

/** 卡是否本身就是老兵版本（veteran 查找时排除） */
function _isVet(c) { return /_vet\d*$/i.test(c.id); }


function delta(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.units), ...Object.keys(b.units)])) {
    if (a.units[k] !== b.units[k]) out.push(`u:${k}:${a.units[k]}->${b.units[k]}`);
  }
  for (const f of ['hq', 'k', 'hand', 'deck', 'deck1', 'disc', 'disc1', 'front', 'handCost', 'handNames', 'hand1Names', 'handGotcha', 'deckTop0', 'flags']) {
    if (a[f] !== b[f]) out.push(`${f}:${a[f]}->${b[f]}`);
  }
  return out.sort();
}

/** 用一套 cfg 跑「原文 vs 清空文本」，返回原文是否多出变化 */
function runPair(def, cl, cfg) {
  const runOne = (d) => {
    const env = cfg.env || {};
    const { g, foe, foeAir, foeFront } = mkGame({ deckMix: true, air: cfg.target === 'air' || env.air, front: cfg.front, allyTank: env.allyTank, allyFront: env.allyFront, manyAllies: env.manyAllies, foeBlitz: env.foeBlitz, hqLow: env.hqLow, hqHigh: env.hqHigh });
    const s = new Engine.CardInst(d, 0, g);
    let before;
    try {
      if (cl.kind === 'deployment') {
        if (cfg.precise) {
          // 前置条件场景（按卡文本构造）
          if (/control an air unit/i.test(cl.text) || /if you control an air/i.test(def.text)) {
            const air = db.cards.find(c => c.type === 'fighter' || c.type === 'bomber');
            if (air) { const ai = new Engine.CardInst(air, 0, g); ai.loc = 'board'; ai.summonedTurn = 0; g.players[0].board.push(ai); }
          }
          if (/friendly unit|give a friendly/i.test(cl.text)) {
            // mkGame 默认 ally 可能自带 mobilize 且排在前面：清掉关键词，并把干净友军放最前
            for (const u of g.players[0].board) u.keywords.delete('mobilize');
            const frDef = FILL.find(c => !(c.keywords || []).includes('mobilize')) || FILL[0];
            const fr = new Engine.CardInst(frDef, 0, g); fr.loc = 'board'; fr.summonedTurn = 0;
            g.players[0].board.unshift(fr);
          }
          if (/non-targeted deployment/i.test(def.text)) {
            // 清掉默认友军，rng 只能挑到带部署效果的单位（纯抽牌部署卡 → draw delta）
            g.players[0].board.length = 0;
            const dep = db.cards.find(c => c.type !== 'order' && c.type !== 'gotcha' && c.type !== 'weather'
              && /deployment:\s*draw a card\.?\s*$/i.test(c.text || ''))
              || db.cards.find(c => c.type !== 'order' && c.type !== 'gotcha' && c.type !== 'weather' && /deployment:/i.test(c.text || ''));
            if (dep) { const di = new Engine.CardInst(dep, 0, g); di.loc = 'board'; di.summonedTurn = 0; g.players[0].board.push(di); }
          }
          if (/destruction effects/i.test(def.text)) {
            // 73rd：注入"上回合开始以来"的己方阵亡记录；用无条件亡计卡（洗牌库→deck delta）
            const dz = db.cards.find(c => c.type !== 'order' && c.type !== 'gotcha' && /destruction:/i.test(c.text || '') && !/\bif\b/i.test(c.text || ''))
              || db.cards.find(c => c.type !== 'order' && c.type !== 'gotcha' && /destruction:/i.test(c.text || ''));
            if (dz) {
              g._destroyedSince = g._destroyedSince || { 0: [], 1: [] };
              g._destroyedSince[0].push({ def: dz, owner: 0, nation: dz.nation, type: dz.type, turn: g.turn - 1 });
            }
          }
          if (/countermeasure/i.test(def.text)) {
            const cm = db.cards.find(c => c.type === 'gotcha');
            if (cm) { const ci = new Engine.CardInst(cm, 0, g); ci.loc = 'hand'; g.players[0].hand.push(ci); }
          }
          if (/weather/i.test(def.text)) {
            const w = db.cards.find(c => c.type === 'weather');
            if (w) { const wi = new Engine.CardInst(w, 0, g); wi.loc = 'hand'; g.players[0].hand.push(wi); }
          }
          // LUBLIN：Reveal target Covert unit——敌方 covert 单位上场
          if (/covert/i.test(def.text)) {
            const cv = db.cards.find(c => c.type !== 'order' && c.type !== 'gotcha' && ((c.keywords || []).includes('covert') || /covert/i.test(c.text || '')));
            if (cv) { const ci = new Engine.CardInst(cv, 1, g); ci.loc = 'board'; ci.summonedTurn = 0; g.players[1].board.push(ci); }
          }
          // 32nd INFANTRY：同名卡塞牌库顶（"Draw a X from your deck"）
          if (/from your deck/i.test(def.text)) {
            const twin = new Engine.CardInst(def, 0, g);
            twin.loc = 'deck'; g.players[0].deck.unshift(twin);
          }
          // KV-85：先造 last destroyed 记录
          if (/last destroyed/i.test(def.text)) {
            const v = new Engine.CardInst(FILL[2], 1, g);
            v.loc = 'board'; v.summonedTurn = 0; g.players[1].board.push(v);
            g.destroyCard(v, null);
          }
        }
        s.loc = 'hand'; g.players[0].hand.push(s);
        before = snap(g);
        let tgt = foe;
        if (cfg.precise) {
          // 精准场景：不传 target（"无指定"语义，避免误导按目标挑选的效果）
          const r = g.playCard(0, g.players[0].hand.indexOf(s), {});
          if (!r || !r.ok) return 'ERR:playCard';
        } else {
          if (cfg.target === 'front') tgt = foeFront || foe;
          else if (cfg.target === 'air') tgt = foeAir || foe;
          else if (cfg.target === 'ground') tgt = foe;
          else if (cfg.target === 'ally') tgt = g.players[0].board[0] || foe;
          const r = g.playCard(0, g.players[0].hand.indexOf(s), {
            target: tgt && tgt.uid, fromRightmost: cfg.fromRightmost, fromLeftmost: cfg.fromLeftmost,
          });
          if (!r || !r.ok) return 'ERR:playCard';
        }
        if (cfg.precise) {
          // 后续动作：跨回合效果（下回合扣费 / 回合末激活反制）
          if (/lose 1 kredit at the start/i.test(def.text)) { g.endTurn(); g.endTurn(); }
          else if (/activate it at the end/i.test(def.text)) { g.endTurn(); }
        }
      } else if (cl.kind === 'destruction') {
        s.loc = 'front'; s.slot = 1; s.summonedTurn = 0;
        g.frontline.push(s); g.frontlineOwner = 0;
        if (cfg.precise) {
          // 144th：失去的槽位数决定伤害
          if (/slots/i.test(cl.text)) g.players[0].slots = Math.max(1, g.players[0].slots - 4);
          // ILYUSHIN/KOKURAS：先造一个阵亡记录
          if (/last destroyed/i.test(cl.text) || /japanese/i.test(cl.text)) {
            const v = new Engine.CardInst(FILL[2], 1, g);
            v.loc = 'board'; v.summonedTurn = 0; g.players[1].board.push(v);
            g.destroyCard(v, null);
          }
          // KOKURAS："If it's the enemy turn"——切到敌方回合
          if (/enemy turn/i.test(cl.text)) g.current = 1;
          // 175th：苏联坦克入手牌（降价才可见）
          if (/tanks in hand and deck/i.test(cl.text)) {
            const tk = db.cards.find(c => c.nation === 'Soviet' && c.type === 'tank') || FILL[1];
            const ti = new Engine.CardInst(tk, 0, g); ti.loc = 'hand'; g.players[0].hand.push(ti);
          }
        }
        before = snap(g);
        g.destroyCard(s, null);
      } else if (cl.kind === 'trigger') {
        s.loc = 'board'; s.slot = 1; s.summonedTurn = 0; g.players[0].board.push(s);
        s.summonedTurn = -1; s.hasAttacked = false; s.attacksLeft = 1;
        // enemyMoveFront：s 先上前线（before 含前线位置，撤退回 board 才有 delta）
        // ownHqHealed：s 先受伤（before 含伤势，修复才有 delta）
        if (cfg.precise && cl.event === 'enemyMoveFront') toFront(s, g);
        if (cfg.precise && cl.event === 'ownHqHealed') s.defense = Math.max(1, s.defense - 2);
        before = snap(g);
        // 用**真实动作**驱动事件，而不是硬派发（否则"部署另一个单位"类事件拿不到正确载荷）
        const ev = cl.event;
        if (cfg.direct) {
          const payload = { uid: s.uid, owner: 0, type: s.type, nation: s.nation, attack: s.totalAttack, card: s, amount: 2, side: 0 };
          g.fireTrigger(ev, payload, u => u.uid === s.uid);
        } else if (cfg.precise) {
          // ===== 精准场景：为每个事件构造真实前置状态 =====
          const toFrontline = () => {
            s.loc = 'front'; s.summonedTurn = -1; s.hasAttacked = false; s.attacksLeft = 1;
            const bi = g.players[0].board.indexOf(s); if (bi >= 0) g.players[0].board.splice(bi, 1);
            if (!g.frontline.includes(s)) g.frontline.push(s);
            g.frontlineOwner = 0;
          };
          if (ev === 'selfKill' || ev === 'selfDamageUnit') {
            // 必杀场景：s 前线高攻，敌方 1 血单位
            toFrontline(); s.buffAttack += 12;
            const victim = new Engine.CardInst(FILL[2], 1, g);
            victim.loc = 'front'; victim.defense = 1; victim.summonedTurn = -1;
            g.frontline.push(victim);
            g.attack(0, s.uid, victim.uid);
          } else if (ev === 'enemyMoveFront') {
            // 真实对局中 PZL 占线时敌方无法进前线（规则互斥），用直派事件验证接线
            g.fireTrigger('enemyMoveFront', { uid: 0, owner: 1, type: 'infantry', nation: 'Soviet' }, u => u.owner !== 1);
          } else if (ev === 'ownDeploy' || ev === 'ownGuardDeploy') {
            let nd = null;
            if (/t-34/i.test(cl.text)) nd = db.cards.find(c => /T-34/i.test(c.name) && c.type === 'tank');
            else if (/veteran|4 or more attack/i.test(cl.text)) {
              // 排除"部署时自行变老兵"的坦克（会掩盖 delta）；其余带文本坦克可用（其条件在本场景不满足）
              nd = db.cards.find(c => c.type === 'tank' && (c.attack || 0) >= 4 && !_isVet(c)
                && !/veteran when you deploy|when you deploy[^.]{0,40}veteran/i.test(c.text || '')
                && (db.byId[c.id + '_vet'] || db.byId[c.id.replace(/_vet$/, '') + '_vet']));
            } else if (/higher attack/i.test(cl.text)) {
              // LIGHT DETACHMENT 15：部署攻击力更高的单位
              nd = db.cards.find(c => !_isVet(c) && c.type !== 'order' && c.type !== 'gotcha' && (c.attack || 0) > (def.attack || 0) + 2);
            } else if (/random combat keyword|random keyword/i.test(cl.text)) {
              // 77th：选无关键词目标（自带关键词会掩盖授予效果）
              nd = FILL.find(c => !(c.keywords || []).length) || FILL[1];
            }
            if (!nd) nd = FILL[1];
            const inst = new Engine.CardInst(nd, 0, g);
            inst.loc = 'hand'; g.players[0].hand.push(inst);
            g.playCard(0, g.players[0].hand.indexOf(inst), {});
          } else if (ev === 'endOfTurn') {
            // 敌方单位更多（CANNONE："unless you control more units" 需不满足）+ 本回合真实部署一张
            for (let i = 0; i < 2; i++) {
              const fe = new Engine.CardInst(FILL[i], 1, g); fe.loc = 'board'; fe.summonedTurn = 0; g.players[1].board.push(fe);
            }
            const nd = new Engine.CardInst(FILL[1], 0, g);
            nd.loc = 'hand'; g.players[0].hand.push(nd);
            g.playCard(0, g.players[0].hand.indexOf(nd), {});
            g.endTurn();
          } else if (ev === 'startOfTurn') {
            // 清空手牌（"hand is empty"类条件），真实开始回合
            g.players[0].hand.length = 0;
            g.fireTrigger('startOfTurn', { side: 0 }, u => u.owner === 0);
          } else if (ev === 'ownOperate') {
            // 真实攻击（攻击会 fire ownOperate 并扣行动费）
            toFrontline(); s.buffAttack += 3;
            const foeU = g.unitsOf(1).find(u => u.defense > 0) || null;
            if (foeU) { foeU.defense = Math.max(foeU.defense, 20); g.attack(0, s.uid, foeU.uid); }
          } else if (ev === 'ownHqDamaged' || ev === 'enemyHqDamaged') {
            // "Becomes Veteran when the enemy HQ has taken N or more damage"——真实打 HQ 5 点
            const side2 = /own hq/i.test(cl.text) ? 0 : 1;
            g.damageHq(side2, 5, null);
          } else if (ev === 'ownHqHealed') {
            // 受伤已在 before 快照前完成，此处给 HQ 加防触发修复
            g.execOp({ op: 'hqDef', n: 2 }, s, {});
          } else if (ev === 'selfAttack' || ev === 'selfAttackHQ') {
            // 敌方高防不死（重置攻击类效果才可见），真实攻击
            toFrontline(); s.buffAttack += 2;
            if (ev === 'selfAttackHQ') g.attack(0, s.uid, 0);
            else {
              const tanky = new Engine.CardInst(FILL[2], 1, g);
              tanky.loc = 'front'; tanky.defense = 30; tanky.summonedTurn = -1; tanky.attacksLeft = 1;
              g.frontline.push(tanky);
              g.attack(0, s.uid, tanky.uid);
            }
          } else if (ev === 'ownAttackWith') {
            // 用文本指定的单位攻击（如 Spitfire）——名称模糊匹配
            const nm = /attack with an? ([A-Z][A-Za-z0-9'\- ]{2,}?)(?: unit)?,/.exec(cl.text);
            const key = nm ? nm[1].trim().toUpperCase() : '';
            const spec = key ? db.cards.find(c => !_isVet(c) && c.name.toUpperCase().startsWith(key)) : null;
            const atkDef = spec || FILL[1];
            const a = new Engine.CardInst(atkDef, 0, g);
            a.loc = 'front'; a.summonedTurn = -1; a.hasAttacked = false; a.attacksLeft = 1; a.buffAttack += 3;
            g.frontline.push(a); g.frontlineOwner = 0;
            const foeU = g.unitsOf(1).find(u => u.defense > 0) || null;
            if (foeU) g.attack(0, a.uid, foeU.uid);
          } else {
            const payload = { uid: s.uid, owner: 0, type: s.type, nation: s.nation, attack: s.totalAttack, card: s, amount: 2, side: 0 };
            g.fireTrigger(ev, payload, u => u.uid === s.uid);
          }
        } else if (ev === 'ownDeploy' || ev === 'ownGuardDeploy') {
          const nd = new Engine.CardInst(FILL[1], 0, g);
          nd.loc = 'hand'; g.players[0].hand.push(nd);
          if (ev === 'ownDeploy' && cfg.triggerKw) nd.keywords.add(cfg.triggerKw);
          g.playCard(0, g.players[0].hand.indexOf(nd), {});
        } else if (ev === 'selfAttack' || ev === 'selfAttackHQ' || ev === 'selfKill' || ev === 'selfDamageUnit') {
          s.loc = 'front'; s.buffAttack += 2;
          const bi = g.players[0].board.indexOf(s); if (bi >= 0) g.players[0].board.splice(bi, 1);
          if (!g.frontline.includes(s)) g.frontline.push(s);
          g.frontlineOwner = 0;
          if (ev === 'selfAttackHQ') g.attack(0, s.uid, 0);
          else {
            const foeU = g.unitsOf(1).find(u => u.defense > 0 && u.uid !== s.uid) || null;
            if (foeU) { if (cfg.pinTarget) foeU._pinned = true; g.attack(0, s.uid, foeU.uid); }
          }
        } else if (ev === 'allyKill' || ev === 'unitDestroyed') {
          const victim = new Engine.CardInst(FILL[2], 1, g);
          victim.loc = 'board'; victim.summonedTurn = 0; g.players[1].board.push(victim);
          g.destroyCard(victim, s);
        } else if (ev === 'selfAttacked') {
          // 敌方单位攻击我方这张卡
          s.loc = 'front'; s.defense = Math.max(s.defense, 12);
          const bi = g.players[0].board.indexOf(s); if (bi >= 0) g.players[0].board.splice(bi, 1);
          if (!g.frontline.includes(s)) g.frontline.push(s);
          g.frontlineOwner = 0;
          const raider = new Engine.CardInst(FILL[1], 1, g);
          raider.loc = 'front'; raider.summonedTurn = -1; raider.buffAttack += 1;
          g.frontline.push(raider);
          g.attack(1, raider.uid, s.uid);
        } else if (ev === 'ownAttackWith') {
          s.loc = 'front'; s.buffAttack += 2;
          const bi2 = g.players[0].board.indexOf(s); if (bi2 >= 0) g.players[0].board.splice(bi2, 1);
          if (!g.frontline.includes(s)) g.frontline.push(s);
          g.frontlineOwner = 0;
          const foeU = g.unitsOf(1).find(u => u.defense > 0) || null;
          if (foeU) g.attack(0, s.uid, foeU.uid);
        } else if (ev === 'selfDamaged') {
          g.damageCard(s, 2, null);
        } else if (ev === 'ownHqHealed') {
          g.execOp({ op: 'hqDef', n: 2 }, s, {});
        } else if (ev === 'enemyHqHealed') {
          g.execOp({ op: 'hqDef', n: 2 }, g.unitsOf(1)[0] || s, {});
        } else if (ev === 'enemyMoveFront') {
          const mv = new Engine.CardInst(FILL[2], 1, g);
          mv.loc = 'board'; mv.summonedTurn = -1; mv.hasAttacked = false;
          g.players[1].board.push(mv);
          g.move(1, mv.uid, true);
        } else if (ev === 'ownDraw') {
          g.draw(0, 1, true);
        } else if (ev === 'ownOrder' || ev === 'ownCardPlayed') {
          const od = db.cards.find(c => c.type === 'order' && (c.cost || 0) <= 2);
          if (od) { const oc = new Engine.CardInst(od, 0, g); oc.loc = 'hand'; g.players[0].hand.push(oc); g.playCard(0, g.players[0].hand.indexOf(oc), {}); }
        } else {
          const payload = { uid: s.uid, owner: 0, type: s.type, nation: s.nation, attack: s.totalAttack, card: s, amount: 2, side: 0 };
          g.fireTrigger(ev, payload, u => u.uid === s.uid);
        }
      } else if (cl.kind === 'pincer') {
        const pincerFiller = db.cards.find(x => x.has && x.has('pincer') && x.id !== def.id)
          || db.cards.find(x => (x.keywords || []).includes('pincer')) || FILL[2];
        const c1 = new Engine.CardInst(pincerFiller, 0, g);
        c1.loc = 'hand'; g.players[0].hand.push(c1);
        g.playCard(0, g.players[0].hand.indexOf(c1), {});
        s.loc = 'hand'; g.players[0].hand.push(s);
        if (cfg.precise && /fully repair/i.test(cl.text)) {
          // 222nd：先部署再受伤，before 快照含伤势，回合末修复才产生可见 delta
          g.playCard(0, g.players[0].hand.indexOf(s), {});
          s.defense = Math.max(1, s.defense - 2);
          before = snap(g);
        } else {
          before = snap(g);
          g.playCard(0, g.players[0].hand.indexOf(s), {});
        }
        if (cfg.precise) {
          // 钳形效果多为"标记 + 后续动作才可见"
          if (/dealt combat damage by this unit are destroyed/i.test(cl.text)) {
            // 2nd PARA C：高防目标不死但被 destroyOnDamage 摧毁
            toFront(s, g); s.buffAttack += 1;
            const victim = new Engine.CardInst(FILL[2], 1, g);
            victim.loc = 'front'; victim.defense = 30; victim.summonedTurn = -1; victim.attacksLeft = 1;
            g.frontline.push(victim);
            g.attack(0, s.uid, victim.uid);
          } else if (/damage dealt to this unit is dealt to/i.test(cl.text)) {
            // KING'S OWN SCOTTISH：s 前线高防挨打 → 伤害转给伙伴（攻击方是敌方，需轮到敌方）
            toFront(s, g); s.defense = Math.max(s.defense, 20);
            const raider = new Engine.CardInst(FILL[1], 1, g);
            raider.loc = 'front'; raider.summonedTurn = -1; raider.hasAttacked = false; raider.attacksLeft = 1; raider.buffAttack += 3;
            g.frontline.push(raider);
            g.current = 1;
            g.attack(1, raider.uid, s.uid);
            g.current = 0;
          } else if (/fully repair/i.test(cl.text)) {
            // 222nd GUARD RIFLES：受伤 → 回合末自愈
            g.endTurn(); // 受伤已在 before 快照前完成
          } else if (/put it on top of owner's deck|destroyed, put it on top/i.test(cl.text)) {
            // T-28：摧毁 → 置牌库顶
            g.destroyCard(s, null);
          }
          // TUPOLEV 等纯标志类：部署即写入快照字段（_enemyTax 已入 snap），无需后续动作
        }
      } else {
        s.loc = 'hand'; g.players[0].hand.push(s);
        before = snap(g);
        const r = g.playCard(0, g.players[0].hand.indexOf(s), {});
        if (!r || !r.ok) return 'ERR:playCard';
        // 二阶探针：打一拳（伤害修正类）、再部署一个（部署授予类）
        try {
          s.loc = 'front'; s.summonedTurn = -1; s.hasAttacked = false; s.attacksLeft = 1;
          const bi = g.players[0].board.indexOf(s); if (bi >= 0) g.players[0].board.splice(bi, 1);
          if (!g.frontline.includes(s)) g.frontline.push(s);
          g.frontlineOwner = 0; s.buffAttack += 2;
          const foeUnit = [...g.unitsOf(1)].find(u => u.type !== 'fighter');
          if (foeUnit) g.attack(0, s.uid, foeUnit.uid);
        } catch (e) { /* ignore */ }
        try {
          const extra = new Engine.CardInst(FILL[4], 0, g);
          extra.loc = 'hand'; g.players[0].hand.push(extra);
          g.playCard(0, g.players[0].hand.indexOf(extra), {});
        } catch (e) { /* ignore */ }
      }
    } catch (e) { return 'ERR:' + e.message; }
    if (g.pendingChoose) { try { g.resolveChoose(0, 0); } catch (e) { /* ignore */ } }
    return JSON.stringify(delta(before, snap(g)));
  };
  const control = { ...def, text: '' };
  const a = runOne(def), b = runOne(control);
  if (String(a).startsWith('ERR') || String(b).startsWith('ERR')) return { ok: false, err: String(a).startsWith('ERR') ? a : b };
  const ea = JSON.parse(a), eb = JSON.parse(b);
  return { ok: ea.some(x => !eb.includes(x)), delta: ea };
}

/** 对某个子句尝试多套环境/目标组合，命中即停 */
function probe(def, cl) {
  const ENVS = [
    {},                              // 基线
    { allyTank: true },              // 己方有坦克（"给友方坦克…"）
    { allyTank: true, manyAllies: true }, // 单位数量优势
    { foeBlitz: true },              // 敌方有闪击单位
    { hqLow: true },                 // 己方总部残血
    { hqHigh: true, allyTank: true },// 己方总部高防
    { allyFront: true },             // 己方有前线单位（"前排友军 +X"）
  ];
  const cfgs = [];
  const targetsFor = (front) => [
    { target: 'ground', front }, { target: 'air', front }, { target: 'front', front },
    { target: 'ally', front }, { target: 'ground', front, fromRightmost: true },
    { target: 'ground', front, fromLeftmost: true },
  ];
  if (cl.kind === 'deployment') {
    for (const env of ENVS) for (const front of [false, true]) for (const c of targetsFor(front)) cfgs.push({ ...c, env });
    cfgs.push({ precise: true });
  } else if (cl.kind === 'trigger') {
    // 部署类触发要把"新部署的单位"标记成不同关键词各试一次（高山/流亡/守护…）
    for (const kw of ['', 'alpine', 'exile', 'guard']) cfgs.push({ env: {}, front: false, triggerKw: kw || undefined });
    cfgs.push({ env: {}, front: false, pinTarget: true });
    cfgs.push({ env: {}, front: false, direct: true });   // 兜底：直接派发（验证接线本身）
    cfgs.push({ precise: true });                          // 精准场景（按事件构造真实前置状态）
  } else if (cl.kind === 'destruction' || cl.kind === 'pincer') {
    cfgs.push({ precise: true });
  } else {
    for (const env of ENVS) cfgs.push({ env, front: false });
  }
  for (const cfg of cfgs) {
    const r = runPair(def, cl, cfg);
    if (r.ok) return { ok: true, cfg };
    if (process.env.PROBE_DEBUG) {
      const d = String(r.delta || r.err || '');
      console.error(`  [${def.id}] kind=${cl.kind}${cl.event ? '/' + cl.event : ''} cfg=${JSON.stringify(cfg).slice(0, 50)} -> ${d.slice(0, 130)}`);
    }
  }
  return { ok: false, err: `${cl.kind}${cl.event ? '/' + cl.event : ''}: no delta` };
}

const wired = [], unwired = [], staticParsed = [], detail = {};
let total = 0;
for (const def of UNITS) {
  total++;
  const clauses = Engine.parseClauses(def.text || '');
  if (!clauses.length) {
    // 侧通道机制（手牌监听 / 伤害转移）算已接线
    const { g: g0 } = mkGame({});
    const inst = new Engine.CardInst(def, 0, g0);
    if (inst._handWatch || inst._redirectName) { wired.push(def); continue; }
    unwired.push(def); detail[def.id] = '无可解析子句'; continue;
  }
  const notes = [];
  let hit = false;
  for (const cl of clauses) {
    const r = probe(def, cl);
    if (r.ok) { hit = true; break; }
    notes.push(r.err || 'fail');
  }
  if (hit) { wired.push(def); continue; }
  const onlyStatic = clauses.every(cl => cl.kind === 'static');
  const hasOps = clauses.some(cl => (cl.ops || []).length > 0);
  if (onlyStatic && hasOps) { staticParsed.push(def); detail[def.id] = notes.join(' | '); }
  else { unwired.push(def); detail[def.id] = notes.join(' | '); }
}

let out = `# 单位卡接线审计（行为级 ${wired.length}/${total}，静态已解析 ${staticParsed.length}，真缺口 ${unwired.length}）\n\n## 真缺口（解析了没生效 / 无子句）\n\n`;
for (const u of unwired) out += `- **${u.name}** (${u.id}) — ${(u.text || '').replace(/\n/g, ' / ')}\n   ↳ ${detail[u.id] || ''}\n`;
out += `\n## 静态光环（已解析，行为探针不覆盖）\n\n`;
for (const u of staticParsed) out += `- ${u.name} (${u.id})\n`;
fs.writeFileSync(path.join(__dirname, '..', '.work', 'unit_wiring.md'), out);
console.log(`带文本单位 ${total} | 行为级接线 ${wired.length} | 静态已解析 ${staticParsed.length} | 真缺口 ${unwired.length}`);
