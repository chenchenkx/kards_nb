/* ============================================================
 * KARDS Web — 战斗界面渲染 / 拖拽 / 特效
 * 设计稿 1280×720，等比缩放
 * ============================================================ */
(function () {
  'use strict';

  const UI = {};
  window.UI = UI;

  const CW = 110, CH = 152;          // 卡牌尺寸（设计稿像素）
  const TABLE_W = 1280, TABLE_H = 720;

  const HQ_IMAGES = {
    Germany: 'Danzig.jpg', USA: 'Cherbourg.jpg', Soviet: 'Stalingrad.jpg',
    Japan: 'Truk.jpg', Britain: 'London.jpg', France: 'Villers_Bocage.jpg',
    Italy: 'Tunis.jpg', Poland: 'Arnhem.jpg', Finland: 'Bunker_Blank.jpg',
    Anzac: 'Darwin_Fortress_Blank.jpg', Neutral: 'Bunker_Blank.jpg',
  };
  const TYPE_NAME = { infantry: '步兵', tank: '坦克', artillery: '火炮', fighter: '战斗机', bomber: '轰炸机', order: '指令', gotcha: '反制', location: '地点', hq: '总部' };
  const KEYWORD_ZH = { blitz: '闪击', fury: '奋战', guard: '守护', smokescreen: '烟幕', ambush: '伏击', shock: '冲击', covert: '隐蔽', deployment: '部署', destruction: '亡计', alpine: '山地', pincer: '钳形', mobilize: '动员', salvage: '打捞', scrying: '窥探', veteran: '老兵' };
  const AVATAR = (n) => '/assets/avatars/' + String(n || 'Neutral').toLowerCase() + '.jpg';

  // ---------------- 缩放 ----------------
  let SCALE = 1;
  function fitTable() {
    const t = document.getElementById('table');
    if (!t) return;
    SCALE = Math.min(window.innerWidth / TABLE_W, window.innerHeight / TABLE_H) || 1;
    // GSAP 接管 #table 变换（xPercent/yPercent 居中 + scale），桌面震动才能与之共存
    const g = G();
    if (g) g.set(t, { xPercent: -50, yPercent: -50, scale: SCALE, x: 0, y: 0, transformOrigin: '50% 50%' });
    else t.style.transform = `translate(-50%, -50%) scale(${SCALE})`;
  }
  UI.fitTable = fitTable;
  window.addEventListener('resize', fitTable);

  function tableRect() {
    const t = document.getElementById('table');
    return t ? t.getBoundingClientRect() : { left: 0, top: 0, width: TABLE_W, height: TABLE_H };
  }
  /** 元素中心在 #table 坐标系中的位置 */
  function centerInTable(el) {
    const r = el.getBoundingClientRect();
    const t = tableRect();
    return {
      x: (r.left + r.width / 2 - t.left) / SCALE,
      y: (r.top + r.height / 2 - t.top) / SCALE,
    };
  }

  function fxLayer() { return document.getElementById('fx-layer'); }

  // ---------------- GSAP 动画核心 ----------------
  // 所有卡牌交互动画统一走 GSAP；未加载时退化为无动画（不破坏功能）
  const G = () => window.gsap || null;

  /** 桌面震动（打击感基础）：短、硬、机械式衰减 —— 对齐原版"干脆"的冲击节奏 */
  UI.shake = function (px) {
    const g = G(); if (!g || !px) return;
    px = Math.min(px, 4);
    g.fromTo('#table', { x: 0, y: 0 }, {
      keyframes: [
        { x: -px, y: px * 0.5 }, { x: px * 0.85, y: -px * 0.62 },
        { x: -px * 0.6, y: px * 0.3 }, { x: px * 0.32, y: -px * 0.16 },
        { x: -px * 0.12, y: 0 }, { x: 0, y: 0 },
      ],
      duration: 0.13, ease: 'none', overwrite: 'auto',
    });
  };

  /** 伤害飘字：弹出 → 上浮渐隐（红色打击数字） */
  UI.fxDamage = function (el, amount, heal) {
    if (!el || !amount) return;
    const g = G();
    const c = centerInTable(el);
    const d = document.createElement('div');
    d.className = 'dmg-number' + (heal ? ' heal' : '');
    d.textContent = (heal ? '+' : '−') + amount;
    const x = c.x + (Math.random() * 30 - 15);
    const y = c.y - 46;
    d.style.left = x + 'px';
    d.style.top = y + 'px';
    fxLayer().appendChild(d);
    if (!g) { setTimeout(() => d.remove(), 1000); return; }
    gsap.timeline()
      .fromTo(d, { scale: 0.3, opacity: 0, y: 16 },
        { scale: 1.35, opacity: 1, y: 0, duration: 0.13, ease: 'back.out(2.5)' })
      .to(d, { scale: 1, duration: 0.09, ease: 'power2.out' })
      .to(d, { y: -52, x: (Math.random() * 24 - 12), opacity: 0, duration: 0.62, ease: 'power1.out' })
      .set(d, { display: 'none' });
    setTimeout(() => d.remove(), 950);
  };

  // ---------------- 卡牌元素池 ----------------
  const cardEls = new Map();     // uid -> element
  const recentDead = new Map();  // uid -> { el, at }

  // 统一优先缩略图（300×421，用于 110px 卡面与 250px 预览都足够清晰）
  function thumbOf(p) {
    if (p.indexOf('thumb/') === 0) return p;
    return p.replace(/^img\//, 'thumb/').replace(/\.(png|jpg|jpeg)$/i, '.jpg');
  }

  function imgSrc(view) {
    if (!view || !view.image) return null;
    return '/cards/' + thumbOf(view.image);
  }

  /** 备用图路径（缩略图缺失时回退大图） */
  function imgSrcAlt(view) {
    if (!view || !view.image) return null;
    const p = view.image;
    if (p.indexOf('thumb/') === 0) return '/cards/' + p.replace(/^thumb\//, 'img/').replace(/\.jpg$/i, '.png');
    return '/cards/' + p;
  }

  function makeCardEl(view) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.uid = view.uid;

    const img = document.createElement('img');
    img.className = 'card-img';
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    el.appendChild(img);

    const nameTag = document.createElement('div');
    nameTag.className = 'card-nametag';
    el.appendChild(nameTag);

    // 统一事件（读取实时状态，避免闭包过期）
    el.addEventListener('mouseenter', (e) => {
      if (drag && drag.active) return;
      const v = viewOfEl(el);
      if (v) showPopup(v, e.clientX, e.clientY);
    });
    el.addEventListener('mouseleave', () => hidePopup());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (UI._suppressClick) return;
      if (drag && drag.moved) return;
      onCardClick(el);
    });

    return el;
  }

  function paintCard(el, view, small) {
    el._view = view;
    const img = el.querySelector('.card-img');
    const src = imgSrc(view);
    const alt = imgSrcAlt(view);
    const tag = el.querySelector('.card-nametag');
    if (tag) tag.textContent = view.name || '';

    // 受损卡面焦黑（对齐原版 gif_04 帧 113+：受伤单位卡面随伤害比例变暗，属性徽标保持明亮）
    if (img) {
      const maxDef = typeof view.maxDef === 'number' ? view.maxDef : 0;
      const curDef = typeof view.defense === 'number' ? view.defense : maxDef;
      const ratio = maxDef > 0 ? Math.max(0, Math.min(1, 1 - curDef / maxDef)) : 0;
      if (ratio > 0.01) {
        img.style.filter = `brightness(${(1.1 - 0.74 * ratio).toFixed(2)}) saturate(${(0.98 - 0.72 * ratio).toFixed(2)})`;
        el.classList.add('damaged');
      } else {
        img.style.filter = '';
        el.classList.remove('damaged');
      }
    }

    if (!src) {
      el.classList.add('no-img');
      return;
    }
    el.classList.remove('no-img');
    if (img.getAttribute('src') === src) return;

    // 缩略图缺失时回退到大图，再失败则显示名字牌
    img.dataset.stage = '1';
    img.onerror = () => {
      if (img.dataset.stage === '1' && alt && img.getAttribute('src') !== alt) {
        img.dataset.stage = '2';
        img.src = alt;
      } else {
        el.classList.add('no-img');
      }
    };
    img.removeAttribute('src');
    img.src = src;
  }

  function ensure(view, small) {
    let el = cardEls.get(view.uid);
    if (!el) {
      el = makeCardEl(view);
      el._isNew = true;
      cardEls.set(view.uid, el);
    }
    paintCard(el, view, small);
    return el;
  }

  function viewOfEl(el) {
    const st = UI.state;
    if (!st) return null;
    if (el.dataset.handIndex != null && el.parentElement && el.parentElement.id === 'own-hand') {
      return st.players[st.you].hand[+el.dataset.handIndex] || null;
    }
    const uid = +el.dataset.uid;
    for (const c of st.frontline) if (c.uid === uid) return c;
    for (const p of st.players) for (const c of p.board) if (c.uid === uid) return c;
    return null;
  }

  // ---------------- 状态 ----------------
  UI.state = null;
  UI.mySide = 0;
  UI.engine = null;
  UI.mode = 'idle';          // idle | targeting | targetingOrder
  UI.selectedHand = -1;
  UI.pendingAttack = null;
  UI.pendingOrder = null;
  UI.onAction = null;

  // ---------------- 主渲染 ----------------
  UI.render = function (state, opts) {
    opts = opts || {};
    if (!state) return;
    UI.state = state;
    const me = state.you;
    UI.mySide = me;

    // 1) FLIP 快照
    const before = new Map();
    if (!opts.noFlip) {
      for (const [uid, el] of cardEls) {
        if (!el.isConnected) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 1) before.set(uid, r);
      }
    }

    const claimed = new Set();

    // 2) 支援阵线
    placeLine(document.getElementById('line-own'), state.players[me].board, me, claimed);
    placeLine(document.getElementById('line-opp'), state.players[1 - me].board, 1 - me, claimed);

    // 3) 前线
    const frontRow = document.getElementById('row-frontline');
    const frontList = state.frontline.slice().sort((a, b) => (a.slot == null ? 99 : a.slot) - (b.slot == null ? 99 : b.slot));
    frontList.forEach((v) => {
      const el = ensure(v, true);
      placeInRow(el, frontRow);
      claimed.add(v.uid);
      decorateUnit(el, v);
    });

    // 4) 手牌
    layoutHand(state, me, claimed);
    layoutOppHand(state, me);

    // 5) HQ
    renderHQ('own', state.players[me]);
    renderHQ('opp', state.players[1 - me]);

    // 6) 面板 / 指挥点
    setKredit('own', state.players[me].kredits, state.players[me].slots);
    setKredit('opp', state.players[1 - me].kredits, state.players[1 - me].slots);
    document.getElementById('own-name').textContent = '你' + (state.lanMode ? ' · P' + (me + 1) : '');
    document.getElementById('opp-name').textContent = state.oppName || '对手';
    const ownAv = document.getElementById('own-avatar');
    const oppAv = document.getElementById('opp-avatar');
    if (ownAv) ownAv.style.backgroundImage = `url('${AVATAR((state.players[me].hq || {}).nation)}')`;
    if (oppAv) oppAv.style.backgroundImage = `url('${AVATAR((state.players[1 - me].hq || {}).nation)}')`;

    // 7) 前线状态：控制方决定线条压向哪一侧（占据前线 → 线推向对手）
    const dashes = document.getElementById('fl-dashes');
    const tag = document.getElementById('fl-tag');
    const owner = state.frontlineOwner;
    const dy = owner === me ? -56 : owner === 1 - me ? 56 : 0;
    if (dashes) {
      dashes.classList.toggle('owned-own', owner === me);
      dashes.classList.toggle('owned-opp', owner === 1 - me);
      dashes.style.transform = `translate(-50%, ${dy}px)`;
    }
    if (tag) {
      tag.className = 'fl-tag' + (owner === me ? ' own' : owner === 1 - me ? ' opp' : '');
      tag.textContent = owner === me ? '我方前线' : owner === 1 - me ? '敌方前线' : '前线';
      tag.style.transform = `translate(-366px, ${dy}px)`;
    }

    // 8) 结束回合按钮
    const endBtn = document.getElementById('btn-end-turn');
    if (endBtn) {
      const myTurn = state.current === me && !state.done;
      endBtn.classList.toggle('active-turn', myTurn);
      endBtn.classList.toggle('disabled', !myTurn);
      endBtn.textContent = myTurn ? '结束回合' : '敌方回合';
    }

    // 9) 清理离场卡牌
    for (const [uid, el] of Array.from(cardEls)) {
      if (claimed.has(uid)) continue;
      cardEls.delete(uid);
      killCard(el, uid);
    }

    // 10) FLIP 位移动画
    if (!opts.noFlip) flip(before);

    refreshHighlights();
  };

  /** 把卡牌放入卡槽：清除手牌遗留的内联定位/旋转，改用槽位绝对定位 */
  function placeInSlot(el, slot) {
    if (el.parentElement !== slot) slot.appendChild(el);
    if (el.style.left || el.style.top || el.style.transform || el.style.zIndex) {
      el.style.left = '';
      el.style.top = '';
      el.style.transform = '';
      el.style.zIndex = '';
    }
    el.dataset.base = '';
    if (el.dataset.handIndex !== undefined) delete el.dataset.handIndex;
    el.classList.remove('playable', 'dim', 'selected');
  }

  /** 把卡牌放入流式容器（前线：自动居中密排） */
  function placeInRow(el, row) {
    if (el.parentElement !== row) row.appendChild(el);
    el.style.left = '';
    el.style.top = '';
    el.style.transform = '';
    el.style.zIndex = '';
    el.dataset.base = '';
    if (el.dataset.handIndex !== undefined) delete el.dataset.handIndex;
    el.classList.remove('playable', 'dim', 'selected');
  }

  function placeLine(lineEl, board, owner, claimed) {
    if (!lineEl) return;
    const slots = Array.prototype.slice.call(lineEl.querySelectorAll('.slot'));
    // 按槽位号落位（空缺槽保持空）
    const bySlot = new Map();
    board.forEach((v, i) => {
      const idx = (v.slot != null && v.slot < slots.length) ? v.slot : i;
      if (!bySlot.has(idx)) bySlot.set(idx, v);
    });
    for (let i = 0; i < slots.length; i++) {
      const v = bySlot.get(i);
      if (!v) { slots[i].classList.remove('has-card'); continue; }
      const el = ensure(v, true);
      placeInSlot(el, slots[i]);
      slots[i].classList.add('has-card');
      claimed.add(v.uid);
      decorateUnit(el, v, owner);
    }
  }

  /** 单位卡上的实时数值 / 可用状态 */
  function decorateUnit(el, v, owner) {
    const def = window.CARD_DB && window.CARD_DB.byId[v.id];
    // 清除旧数值
    el.querySelectorAll('.val-badge').forEach(b => b.remove());
    if (def && v.type !== 'order' && v.type !== 'gotcha') {
      const mk = (txt, cls) => {
        const b = document.createElement('div');
        b.className = 'val-badge ' + cls;
        b.textContent = txt;
        el.appendChild(b);
        return b;
      };
      // 受伤：右下角红色减量
      if (v.defense != null && def.defense != null && v.defense < def.defense) {
        mk('−' + (def.defense - v.defense), 'def hurt');
      }
      // 增益：右上角绿色增量
      if (v.defense != null && def.defense != null && v.defense > def.defense) {
        mk('+' + (v.defense - def.defense), 'def buff');
      }
      if (v.totalAttack != null && def.attack != null && v.totalAttack > def.attack) {
        mk('+' + (v.totalAttack - def.attack), 'atk buff');
      } else if (v.totalAttack != null && def.attack != null && v.totalAttack < def.attack) {
        mk('−' + (def.attack - v.totalAttack), 'atk hurt');
      }
    }
    // 可行动提示
    let canAct = false;
    const g = UI.engine;
    if (g && owner === UI.state.you && !UI.state.done && UI.state.current === UI.state.you) {
      const inst = g.find ? g.find(v.uid) : null;
      if (inst) canAct = !!(g.canAttack(inst) || (g.canMove(inst, true) || g.canMove(inst, false)));
    }
    el.classList.toggle('can-act', !!canAct);
  }

  // ---------------- 手牌扇形 ----------------
  function layoutHand(state, me, claimed) {
    const wrap = document.getElementById('own-hand');
    const hand = state.players[me].hand;
    const n = hand.length;
    const maxSpan = 660;
    let step = n > 1 ? Math.min(CW - 8, (maxSpan - CW) / (n - 1)) : 0;
    step = Math.max(30, step);
    const totalW = CW + step * Math.max(0, n - 1);
    const startX = TABLE_W / 2 - totalW / 2;
    const mid = (n - 1) / 2;
    const rotUnit = n > 1 ? Math.min(2.6, 20 / n) : 0;

    hand.forEach((v, i) => {
      const el = ensure(v, false);
      if (el.parentElement !== wrap) wrap.appendChild(el);
      claimed.add(v.uid);
      el.dataset.handIndex = i;
      const rot = (i - mid) * rotUnit;
      const ty = Math.abs(i - mid) * 2.6;
      el.dataset.base = `rotate(${rot}deg) translateY(${ty}px)`;
      el.style.left = (startX + i * step) + 'px';
      el.style.top = '0px';
      el.style.zIndex = String(i + 1);
      el.style.transform = el.dataset.base;
      const playable = !state.done && state.current === me && v.cost <= state.players[me].kredits;
      el.classList.toggle('playable', playable);
      el.classList.toggle('dim', !playable);
      el.classList.toggle('selected', UI.selectedHand === i);
      el.classList.remove('can-act');
      // 新抽到的牌：从桌外滑入
      if (el._isNew) {
        el._isNew = false;
        const g = G();
        if (g) {
          gsap.fromTo(el, { y: '+=' + 92, opacity: 0, rotation: '+=' + (rot > 0 ? 7 : -7) },
            { y: '-=' + 92, opacity: 1, rotation: '-=' + (rot > 0 ? 7 : -7), duration: 0.36, ease: 'power3.out' });
        }
        SFX.play('draw');
      }
    });
  }

  function layoutOppHand(state, me) {
    const wrap = document.getElementById('opp-hand');
    if (!wrap) return;
    const count = state.players[1 - me].handCount | 0;
    while (wrap.children.length < count) {
      const b = document.createElement('div');
      b.className = 'card-back';
      wrap.appendChild(b);
    }
    while (wrap.children.length > count) wrap.removeChild(wrap.lastChild);
    const n = count;
    if (!n) return;
    let step = Math.min(CW - 12, 400 / Math.max(1, n - 1));
    step = Math.max(24, step);
    const totalW = CW + step * (n - 1);
    const startX = TABLE_W / 2 - totalW / 2;
    const mid = (n - 1) / 2;
    Array.prototype.forEach.call(wrap.children, (el, i) => {
      const rot = (i - mid) * Math.min(3.4, 22 / n);
      el.style.left = (startX + i * step) + 'px';
      el.style.zIndex = String(i + 1);
      el.style.transform = `rotate(${rot}deg)`;
    });
  }

  // ---------------- HQ ----------------
  function renderHQ(which, p) {
    const slot = document.getElementById(which + '-hq-slot');
    if (!slot) return;
    let el = slot.querySelector('.hq-card');
    if (!el) {
      el = document.createElement('div');
      el.className = 'hq-card';
      slot.appendChild(el);
      el.addEventListener('mouseenter', (e) => {
        const st = UI.state;
        const side = which === 'own' ? st.you : 1 - st.you;
        const hq = st.players[side].hq || {};
        showPopup({ name: hq.name || '总部', nation: hq.nation, type: 'hq', defense: st.players[side].hqDef, text: hq.text || '', image: null }, e.clientX, e.clientY);
      });
      el.addEventListener('mouseleave', () => hidePopup());
    }
    const nation = (p.hq && p.hq.nation) || 'Neutral';
    // 优先用该 HQ 卡自带的图（官方 id 精确映射），其次国家兜底，最后占位
    const img = (p.hq && p.hq.image) || HQ_IMAGES[nation] || 'Bunker_Blank.jpg';
    if (el.dataset.img !== img) {
      el.dataset.img = img;
      el.style.backgroundImage = `url('/assets/hq/${img}')`;
      el.title = (p.hq && p.hq.name) || '总部';
    }
    let badge = el.querySelector('.hq-def-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'hq-def-badge';
      el.appendChild(badge);
    }
    const val = Math.max(0, p.hqDef);
    const armor = p.hqArmor || 0;
    const label = armor > 0 ? `${val}+${armor}` : String(val);
    if (badge.textContent !== label) badge.textContent = label;
    badge.classList.toggle('hurt', val < (p.hqMaxDef || 20));
    badge.classList.toggle('armored', armor > 0);
  }

  function setKredit(which, cur, max) {
    const b = document.getElementById(which + '-kredit');
    if (!b) return;
    const curEl = b.querySelector('.kb-cur');
    if (curEl.textContent !== String(cur)) {
      curEl.textContent = cur;
      b.classList.remove('pop');
      void b.offsetWidth;
      b.classList.add('pop');
    }
    const k = b.querySelector('.kb-k');
    if (k) k.textContent = max > 12 ? 'K·' + max : 'K';
  }

  // ---------------- FLIP（GSAP 位移动画） ----------------
  function flip(before) {
    const s = SCALE || 1;
    const g = G();
    for (const [uid, oldR] of before) {
      const el = cardEls.get(uid);
      if (!el || !el.isConnected) continue;
      const nr = el.getBoundingClientRect();
      if (!nr.width) continue;
      const dx = (oldR.left - nr.left) / s;
      const dy = (oldR.top - nr.top) / s;
      if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5) continue;
      if (!g) continue;
      // gsap 会把当前 transform（扇形旋转等）解析为分量，x/y 只叠加位移
      gsap.fromTo(el, { x: dx, y: dy }, {
        x: 0, y: 0, duration: 0.34, ease: 'power3.out',
        overwrite: 'auto', clearProps: 'x,y',
      });
    }
  }

  function killCard(el, uid) {
    const g = G();
    try {
      const c = centerInTable(el);
      // 对齐原版摧毁：火焰燃烧 + 多团白烟 + 桌面焦痕
      UI.fxBurst(c, { small: true });
      UI.fxPuffs(c, { n: 7, spread: 58, life: 0.72 });
      UI.fxScorch(c);
      SFX.play('death');
    } catch (e) { /* ignore */ }
    if (g) {
      gsap.to(el, {
        y: 12, scale: 0.76, rotation: '-=8', opacity: 0,
        filter: 'brightness(0.18) saturate(0.35)',
        duration: 0.38, ease: 'power2.in', overwrite: 'auto',
        onComplete: () => { if (el.parentNode) el.parentNode.removeChild(el); },
      });
    } else {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    recentDead.set(uid, { el, at: Date.now() });
    setTimeout(() => recentDead.delete(uid), 1200);
  }

  // ---------------- 特效 ----------------

  /** 攻击轨迹：一条从攻击者飞向目标的光条 + 命中前拖尾 */
  UI.fxTrail = function (a, b) {
    const layer = document.getElementById('fx-layer');
    if (!layer) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    const el = document.createElement('div');
    el.className = 'attack-trail';
    el.style.left = a.x + 'px';
    el.style.top = a.y + 'px';
    el.style.width = dist + 'px';
    el.style.transform = `rotate(${angle}deg)`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 420);
  };

  UI.fxSpark = function (el) {
    if (!el) return;
    const c = centerInTable(el);
    const s = document.createElement('div');
    s.className = 'spark';
    s.style.left = c.x + 'px';
    s.style.top = c.y + 'px';
    fxLayer().appendChild(s);
    const r = document.createElement('div');
    r.className = 'ring';
    r.style.left = c.x + 'px';
    r.style.top = c.y + 'px';
    fxLayer().appendChild(r);
    const sl = document.createElement('div');
    sl.className = 'slash';
    sl.style.left = c.x + 'px';
    sl.style.top = c.y + 'px';
    fxLayer().appendChild(sl);
    setTimeout(() => { s.remove(); r.remove(); sl.remove(); }, 700);
  };

  /**
   * 多团白烟 —— 对齐原版摧毁烟雾（gif_04 帧 2-8）：
   * 4-6 团大小/位置随机的烟云，0.6-0.8s 缓慢外扩消散，不是单个规整圆。
   */
  UI.fxPuffs = function (c, opts) {
    const g = G();
    if (!g || !c) return;
    const n = (opts && opts.n) || 5;
    const spread = (opts && opts.spread) || 46;
    const life = (opts && opts.life) || 0.68;
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'puff';
      const ox = (Math.random() * 2 - 1) * spread;
      const oy = (Math.random() * 2 - 1) * spread * 0.5;
      d.style.left = (c.x + ox) + 'px';
      d.style.top = (c.y + oy) + 'px';
      fxLayer().appendChild(d);
      const sc = 0.45 + Math.random() * 0.55;
      const grow = sc * (1.9 + Math.random() * 0.9);
      g.timeline()
        .fromTo(d, { scale: 0.18, opacity: 0 },
          { scale: sc, opacity: 0.72 + Math.random() * 0.22, duration: 0.1, ease: 'power2.out' })
        .to(d, {
          x: ox * 0.45 + (Math.random() * 24 - 12),
          y: oy * 0.35 - 16 - Math.random() * 20,
          scale: grow, opacity: 0, duration: life * (0.8 + Math.random() * 0.4), ease: 'power1.out',
        }, 0.03 + Math.random() * 0.14)
        .add(() => d.remove());
    }
  };

  /**
   * 燃烧爆裂 —— 对齐原版命中/摧毁火焰（gif_04 帧 32-45）：
   * 白闪核心 + 6 条火焰舌（各自随机闪烁）+ 火星，总时长约 0.85-0.95s。
   */
  UI.fxBurst = function (c, opts) {
    const g = G();
    if (!g || !c) return;
    const big = !(opts && opts.small);
    const scale = big ? 1 : 0.72;

    // ① 中央白闪核心（200ms 内炸开消散）
    const core = document.createElement('div');
    core.className = 'blast-core';
    core.style.left = c.x + 'px';
    core.style.top = c.y + 'px';
    fxLayer().appendChild(core);
    g.timeline().fromTo(core, { scale: 0.25 * scale, opacity: 0.95 },
      { scale: 1.9 * scale, opacity: 0, duration: 0.26, ease: 'power3.out' })
      .add(() => core.remove());

    // ② 火焰舌：6 条，随机方位/大小，各自独立闪烁（原版帧间亮度起伏大）
    const n = big ? 6 : 4;
    for (let i = 0; i < n; i++) {
      const f = document.createElement('div');
      f.className = 'flame';
      const ang = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.9;
      const dist = (14 + Math.random() * 30) * scale;
      f.style.left = c.x + 'px';
      f.style.top = c.y + 'px';
      fxLayer().appendChild(f);
      const tl = g.timeline({ delay: i * 0.028 + Math.random() * 0.03 });
      tl.fromTo(f, { scale: 0.2 * scale, opacity: 0, rotation: (Math.random() - 0.5) * 40 },
        { scale: (0.78 + Math.random() * 0.4) * scale, opacity: 0.95, rotation: (Math.random() - 0.5) * 16,
          duration: 0.09, ease: 'back.out(2.2)' })
        .to(f, {
          x: Math.cos(ang) * dist, y: Math.sin(ang) * dist - 8 * scale,
          duration: 0.16, ease: 'power2.out',
        }, 0);
      // 闪烁：6 段随机脉冲
      for (let k = 0; k < 6; k++) {
        tl.to(f, {
          scale: (0.72 + Math.random() * 0.62) * scale,
          opacity: 0.62 + Math.random() * 0.38,
          x: Math.cos(ang) * (dist + (Math.random() * 10 - 5)),
          y: Math.sin(ang) * dist - 8 * scale + (Math.random() * 10 - 5),
          duration: 0.05 + Math.random() * 0.04, ease: 'none',
        });
      }
      tl.to(f, { scale: (0.45 + Math.random() * 0.3) * scale, opacity: 0.4, duration: 0.13, ease: 'power2.in' })
        .to(f, { scale: 0.1, opacity: 0, duration: 0.14, ease: 'power2.in' })
        .add(() => f.remove());
    }

    // ③ 烧尽后的黑烟（原版：火焰熄灭后黑烟笼罩约 0.45s）
    setTimeout(() => UI.fxDarkSmoke(c, { n: 4 }), 520);

    // ③ 火星：向外飞散 + 下坠
    const ne = big ? 9 : 5;
    for (let i = 0; i < ne; i++) {
      const e = document.createElement('div');
      e.className = 'ember';
      e.style.left = c.x + 'px';
      e.style.top = c.y + 'px';
      fxLayer().appendChild(e);
      const ang = Math.random() * Math.PI * 2;
      const r = 26 + Math.random() * 46;
      g.timeline({ delay: Math.random() * 0.12 }).to(e, {
        x: Math.cos(ang) * r, y: Math.sin(ang) * r * 0.7 + 12,
        scale: 0.2, opacity: 0,
        duration: 0.36 + Math.random() * 0.3, ease: 'power2.out',
      })
        .add(() => e.remove());
    }
  };

  /** 焦痕：摧毁后桌面残留的黑色焦斑（约 2.4s 后淡出） */
  UI.fxScorch = function (c) {
    const g = G();
    if (!g || !c) return;
    const s = document.createElement('div');
    s.className = 'scorch';
    s.style.left = c.x + 'px';
    s.style.top = c.y + 'px';
    s.style.opacity = '0';
    fxLayer().appendChild(s);
    g.timeline()
      .to(s, { opacity: 0.85, scale: 1, duration: 0.12, ease: 'power2.out' })
      .to(s, { opacity: 0, duration: 0.7, ease: 'power1.in' }, '+=1.7')
      .add(() => s.remove());
  };

  /** 燃烧黑烟（原版火焰烧尽后的黑烟阶段，约 0.45s 散去） */
  UI.fxDarkSmoke = function (c, opts) {
    const g = G();
    if (!g || !c) return;
    const n = (opts && opts.n) || 4;
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'smoke-dark';
      const ox = (Math.random() * 2 - 1) * 26;
      const oy = (Math.random() * 2 - 1) * 16;
      d.style.left = (c.x + ox) + 'px';
      d.style.top = (c.y + oy) + 'px';
      fxLayer().appendChild(d);
      const sc = 0.6 + Math.random() * 0.5;
      g.timeline()
        .fromTo(d, { scale: 0.35, opacity: 0 }, { scale: sc, opacity: 0.82, duration: 0.12, ease: 'power2.out' })
        .to(d, { x: ox * 0.4, y: oy - 20, scale: sc * 1.7, opacity: 0, duration: 0.42, ease: 'power1.out' }, 0.06)
        .add(() => d.remove());
    }
  };

  /** 卡牌白闪：命中瞬间的高光覆盖（90ms 拉满 → 180ms 消退） */
  UI.fxCardFlash = function (el) {
    const g = G();
    if (!g || !el) return;
    const f = document.createElement('div');
    f.className = 'card-flash';
    el.appendChild(f);
    g.timeline()
      .fromTo(f, { opacity: 0 }, { opacity: 0.62, duration: 0.04, ease: 'power4.out' })
      .to(f, { opacity: 0, duration: 0.17, ease: 'power2.in' })
      .add(() => f.remove());
  };

  /** 残影：出牌坠落时的 2 层拖影（对齐原版重量感的运动模糊） */
  UI.fxAfterimage = function (el, dy) {
    const g = G();
    if (!g || !el) return;
    const table = document.getElementById('table');
    if (!table) return;
    const r = el.getBoundingClientRect();
    const t = table.getBoundingClientRect();
    const sc = SCALE || 1;
    for (let i = 0; i < 2; i++) {
      const c = el.cloneNode(true);
      c.classList.add('afterimage');
      c.removeAttribute('data-uid');
      c.style.cssText = `left:${(r.left - t.left) / sc}px; top:${(r.top - t.top) / sc}px;`
        + `width:${r.width / sc}px; height:${r.height / sc}px;`;
      fxLayer().appendChild(c);
      g.timeline().fromTo(c, { opacity: 0.34 - i * 0.14, y: dy * (0.42 + i * 0.34), scale: 1 + i * 0.05 },
        { opacity: 0, duration: 0.18 + i * 0.07, ease: 'power1.out' })
        .add(() => c.remove());
    }
  };

  /** 老兵化（对齐原版录像：蓝白流光绕卡旋转，卡面提亮换装后回稳） */
  UI.fxVeteran = function (el) {
    const g = G();
    if (!g || !el) return;
    const c = centerInTable(el);
    const s = document.createElement('div');
    s.className = 'veteran-swirl';
    s.style.left = c.x + 'px';
    s.style.top = c.y + 'px';
    fxLayer().appendChild(s);
    SFX.play('veteran');
    g.timeline()
      .fromTo(s, { scale: 0.28, opacity: 0, rotation: -50 },
        { scale: 1, opacity: 1, rotation: 0, duration: 0.2, ease: 'power2.out' })
      .to(s, { rotation: 160, scale: 1.25, opacity: 0, duration: 0.55, ease: 'power2.in' })
      .add(() => s.remove());
    g.timeline()
      .to(el, { scale: 1.1, duration: 0.16, ease: 'power2.out' })
      .to(el, { scale: 1, duration: 0.32, ease: 'elastic.out(1.1, 0.5)' });
    g.fromTo(el, { filter: 'brightness(2.3) saturate(0.55) hue-rotate(12deg)' },
      { filter: 'brightness(1) saturate(1) hue-rotate(0deg)', duration: 0.55, ease: 'power2.out', overwrite: 'auto' });
  };

  /** 胜利金爆：全屏金色绽放 —— 对齐原版胜利瞬间（gif_06 帧 46-47 全屏 25910px 金色） */
  UI.fxVictory = function () {
    const g = G();
    if (!g) return;
    const w = document.createElement('div');
    w.className = 'victory-burst';
    fxLayer().appendChild(w);
    g.timeline()
      .fromTo(w, { scale: 0.15, opacity: 0, rotation: -18 },
        { scale: 1, opacity: 1, rotation: 0, duration: 0.16, ease: 'back.out(2.4)' })
      .to(w, { scale: 1.18, opacity: 0, duration: 0.62, ease: 'power2.in' }, '+=0.28')
      .add(() => w.remove());
  };

  /** 摧毁白烟（保留旧接口，内部改为多团烟云） */
  UI.fxSmoke = function (c) {
    UI.fxPuffs(c, { n: 6, spread: 52, life: 0.72 });
  };

  UI.fxHQHit = function (which, amount) {
    const slot = document.getElementById(which + '-hq-slot');
    if (!slot) return;
    const card = slot.querySelector('.hq-card');
    const g = G();
    if (card) {
      if (g) {
        // 重击晃动：向后压 + 快速抖动回弹
        gsap.timeline()
          .to(card, { rotation: -5, scale: 1.06, duration: 0.07, ease: 'power3.out' })
          .to(card, { rotation: 3.5, x: 4, duration: 0.06 })
          .to(card, { rotation: -2, x: -3, duration: 0.07 })
          .to(card, { rotation: 1.5, x: 2, duration: 0.07 })
          .to(card, { rotation: 0, x: 0, scale: 1, duration: 0.35, ease: 'elastic.out(1.1, 0.4)' });
        gsap.fromTo(card, { filter: 'brightness(2.2) saturate(1.5)' },
          { filter: 'brightness(1) saturate(1)', duration: 0.45, ease: 'power2.out', overwrite: 'auto' });
      }
    }
    if (amount) UI.fxDamage(card || slot, amount);
    const flash = document.createElement('div');
    flash.className = 'screen-flash';
    fxLayer().appendChild(flash);
    setTimeout(() => flash.remove(), 520);
    UI.shake(5);
    SFX.play('hqhit');
  };

  UI.turnBanner = function (title, sub, mine) {
    const b = document.getElementById('turn-banner');
    if (!b) return;
    b.className = 'turn-banner';
    b.innerHTML = `<div><div class="tb-inner">${escapeHtml(title)}</div>${sub ? `<div class="tb-sub">${escapeHtml(sub)}</div>` : ''}</div>`;
    void b.offsetWidth;
    setTimeout(() => { b.className = 'turn-banner hidden'; }, 1450);
  };

  UI.setSettling = function (on) {
    const b = document.getElementById('btn-end-turn');
    if (b) b.classList.toggle('settling', !!on);
  };

  UI.hint = function (msg, ms) {
    const h = document.getElementById('target-hint');
    if (!h) return;
    h.textContent = msg;
    h.classList.remove('hidden');
    clearTimeout(UI._hintTimer);
    UI._hintTimer = setTimeout(() => h.classList.add('hidden'), ms || 1600);
  };
  UI.clearHint = function () {
    const h = document.getElementById('target-hint');
    if (h) h.classList.add('hidden');
  };
  /** 带错误音效的提示 */
  UI.warn = function (msg, ms) {
    SFX.play('error');
    UI.hint(msg, ms);
  };

  // ---------------- 事件播放 ----------------
  function findCardEl(uid) {
    const el = cardEls.get(uid);
    if (el && el.isConnected) return el;
    const rd = recentDead.get(uid);
    if (rd && rd.el && rd.el.isConnected) return rd.el;
    return null;
  }

  function hqElOf(side) {
    const which = side === UI.mySide ? 'own' : 'opp';
    const slot = document.getElementById(which + '-hq-slot');
    return slot ? (slot.querySelector('.hq-card') || slot) : null;
  }

  UI.playEvents = function (events, done) {
    const steps = [];
    for (const ev of events) {
      if (!ev) continue;
      if (ev.e === 'attack') {
        const fromEl = findCardEl(ev.from);
        const toEl = ev.to === 0 ? hqElOf(1 - ev.owner) : findCardEl(ev.to);
        if (fromEl && toEl) {
          steps.push((next) => {
            const a = centerInTable(fromEl);
            const b = centerInTable(toEl);
            const dx = b.x - a.x, dy = b.y - a.y;
            const g = G();
            if (!g) {
              // 无 GSAP 时的极简退化
              UI.fxTrail(a, b);
              UI.fxSpark(toEl);
              setTimeout(next, 260);
              return;
            }
            SFX.play('whoosh');
            UI.fxTrail(a, b);
            const tl = gsap.timeline({ onComplete: next });
              // ① 蓄力：更短更紧的后压
              tl.to(fromEl, {
                x: -dx * 0.08, y: -dy * 0.08, scale: 0.94,
                duration: 0.1, ease: 'power2.out',
              })
              // ② 冲撞：更快更远（power4.in = 加速撞击）
              .to(fromEl, {
                x: dx * 0.7, y: dy * 0.7, scale: 1.13,
                duration: 0.12, ease: 'power4.in',
              })
              // ③ 命中瞬间：白闪 + 火焰爆裂 + 硬击退 + 干脆震动
              .add(() => {
                SFX.play('hit');
                UI.fxCardFlash(toEl);
                UI.fxBurst(centerInTable(toEl), {});
                UI.shake(4);
                // 受击方：55ms 推出 12% 距离 → 110ms 硬回位（原版无回弹尾巴）
                gsap.timeline({ overwrite: 'auto' })
                  .to(toEl, {
                    x: dx * 0.12, y: dy * 0.12, rotation: dx > 0 ? 1.8 : -1.8,
                    duration: 0.055, ease: 'power4.out',
                  })
                  .to(toEl, { x: 0, y: 0, rotation: 0, duration: 0.11, ease: 'power2.out' });
                gsap.fromTo(toEl, { filter: 'brightness(2.4) saturate(1.4)' },
                  { filter: 'brightness(1) saturate(1)', duration: 0.22, ease: 'power2.out', overwrite: 'auto' });
              })
              // ④ 攻击方收势（干脆，不做拖沓回弹）
              .to(fromEl, {
                x: 0, y: 0, scale: 1,
                duration: 0.24, ease: 'power3.out',
              }, '+=0.06');
            // 声明本步骤时长：让火焰/伤害飘字在命中之后展开
            return 620;
          });
        }
      } else if (ev.e === 'damage') {
        const el = findCardEl(ev.uid);
        if (el) steps.push(() => { UI.fxDamage(el, ev.amount); });
      } else if (ev.e === 'hqdamage') {
        steps.push(() => {
          UI.fxHQHit(ev.side === UI.mySide ? 'own' : 'opp', ev.amount);
        });
      } else if (ev.e === 'deploy') {
        const el = findCardEl(ev.uid);
        if (el) {
          steps.push((next) => {
            const g = G();
            if (!g) { setTimeout(next, 240); return; }
            SFX.play('deploy');
            const c = centerInTable(el);
            const tl = gsap.timeline({
              onComplete: () => { gsap.set(el, { clearProps: 'transform,filter' }); next(); },
            });
            // ① 落地：从拖拽大卡（1.38x）快速缩回 —— 原版实测仅 2 帧（≈67ms），
            //    这里拉长到 0.2s 保留"手感"，但保持干脆
            tl.add(() => UI.fxAfterimage(el, -46), 0)
              .fromTo(el, { y: -70, scale: 1.34, opacity: 0.6, rotation: -2.5 },
                { y: 0, scale: 1, opacity: 1, rotation: 0, duration: 0.2, ease: 'back.out(1.5)' })
              // ② 落地压扁-回弹（幅度克制，避免卡通化）
              .to(el, { scaleX: 1.05, scaleY: 0.94, duration: 0.05, ease: 'power4.out' })
              .to(el, { scaleX: 1, scaleY: 1, duration: 0.13, ease: 'elastic.out(1.2, 0.5)' })
              // ③ 冲击：小范围尘烟 + 短促硬震 + 细环
              .add(() => {
                UI.fxPuffs(c, { n: 3, spread: 26, life: 0.42 });
                UI.fxCardFlash(el);
                UI.shake(3);
                const r = document.createElement('div');
                r.className = 'ring';
                r.style.left = c.x + 'px';
                r.style.top = c.y + 'px';
                fxLayer().appendChild(r);
                setTimeout(() => r.remove(), 650);
              }, '-=0.1')
              // ④ 出场高光渐收
              .fromTo(el, { filter: 'brightness(1.8) saturate(1.2)' },
                { filter: 'brightness(1) saturate(1)', duration: 0.24, ease: 'power2.out' }, '-=0.26');
            return 430;
          });
        }
      } else if (ev.e === 'turn') {
        const mine = ev.side === UI.mySide;
        steps.push(() => { SFX.play('turn'); UI.turnBanner(mine ? '你的回合' : '敌方回合', `第 ${ev.turn} 回合 · ${ev.kredits} 指挥点`, mine); });
      } else if (ev.e === 'death') {
        const el = findCardEl(ev.uid);
        if (el) steps.push(() => UI.fxSmoke(centerInTable(el)));
      } else if (ev.e === 'veteran') {
        const el = findCardEl(ev.uid);
        if (el) steps.push((next) => { UI.fxVeteran(el); setTimeout(next, 380); return 380; });
      } else if (ev.e === 'order') {
        steps.push(() => { SFX.play('select'); UI.hint(ev.name, 900); });
      }
    }

    // 播放结束回调（带 2.8s 硬超时，避免任何异常把输入锁死）
    let finished = false;
    let guard = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (guard) clearTimeout(guard);
      if (done) done();
    };

    if (!steps.length) { finish(); return; }
    guard = setTimeout(finish, 4500);

    const gap = steps.length > 6 ? 120 : 240;
    let i = 0;
    const run = () => {
      if (i >= steps.length) { finish(); return; }
      const step = steps[i++];
      let advanced = false;
      const next = () => { if (advanced) return; advanced = true; run(); };
      let declared = 0;
      try { const r = step(next); if (typeof r === 'number') declared = r; } catch (e) { next(); }
      // 步骤可声明自身时长（长动画不被 gap 拦腰截断），否则用 gap 兜底
      setTimeout(next, Math.max(gap, declared));
    };
    run();
  };

  // ---------------- 交互：点击 ----------------
  function onCardClick(el) {
    const st = UI.state;
    if (!st || st.done) return;

    // 目标选择模式：点牌即开火
    if (UI.mode === 'targeting') {
      const uid = +el.dataset.uid;
      if (uid && UI.pendingAttack) {
        fireAt(uid);
        return;
      }
    }
    if (UI.mode === 'targetingOrder') {
      const uid = +el.dataset.uid;
      if (uid) { playOrderAt(uid); return; }
    }

    const isHand = el.dataset.handIndex != null && el.parentElement && el.parentElement.id === 'own-hand';
    if (isHand) {
      if (st.current !== st.you) { UI.warn('还没到你的回合'); return; }
      const idx = +el.dataset.handIndex;
      const v = st.players[st.you].hand[idx];
      if (!v) return;
      if (v.cost > st.players[st.you].kredits) { UI.warn('指挥点不足'); return; }
      if (UI.selectedHand === idx) { playHand(idx); }
      else { UI.selectedHand = idx; refreshHighlights(); }
      return;
    }

    // 场上单位
    const uid = +el.dataset.uid;
    const v = viewOfEl(el);
    if (!v) return;
    if (v.owner !== st.you) return;
    if (st.current !== st.you) { UI.warn('还没到你的回合'); return; }

    const g = UI.engine;
    if (g && g.find) {
      const inst = g.find(uid);
      if (inst && g.canAttack(inst)) { beginTargeting(inst); return; }
    }
    UI.hint('拖拽到前线 / 支援阵线可移动', 1400);
  }

  function playHand(idx) {
    const st = UI.state;
    const v = st.players[st.you].hand[idx];
    if (!v) return;
    if (v.type === 'order' && v.targets && v.targets.length) {
      UI.mode = 'targetingOrder';
      UI.pendingOrder = { handIndex: idx, name: v.name };
      markTargets(v.targets);
      document.getElementById('target-hint').textContent = '选择目标';
      document.getElementById('target-hint').classList.remove('hidden');
      return;
    }
    UI.selectedHand = -1;
    refreshHighlights();
    UI.doAction('play', { handIndex: idx });
  }

  function playOrderAt(uid) {
    const po = UI.pendingOrder;
    clearTargets();
    UI.mode = 'idle';
    UI.pendingOrder = null;
    UI.selectedHand = -1;
    UI.clearHint();
    if (!po) return;
    UI.doAction('play', { handIndex: po.handIndex, target: uid });
  }

  // ---------------- 交互：攻击目标 ----------------
  function beginTargeting(inst) {
    const g = UI.engine;
    if (!g) return;
    const targets = g.attackTargets(inst) || [];
    if (!targets.length) return;
    UI.mode = 'targeting';
    UI.pendingAttack = inst.uid;
    clearTargets();
    markTargets(targets);
    document.getElementById('target-hint').textContent = '选择目标';
    document.getElementById('target-hint').classList.remove('hidden');
  }

  function markTargets(list) {
    for (const t of list) {
      if (t === 0) {
        const which = 'opp';
        const slot = document.getElementById(which + '-hq-slot');
        if (slot) {
          slot.classList.add('targetable');
          slot.onclick = (e) => { e.stopPropagation(); fireAt(0); };
        }
        continue;
      }
      const el = cardEls.get(t);
      if (el) {
        el.classList.add('targetable');
        el.dataset.tgt = '1';
      }
    }
  }

  function clearTargets() {
    document.querySelectorAll('.targetable').forEach(e => e.classList.remove('targetable'));
    const slot = document.getElementById('opp-hq-slot');
    if (slot) slot.onclick = null;
  }

  function fireAt(target) {
    const uid = UI.pendingAttack;
    clearTargets();
    UI.mode = 'idle';
    UI.pendingAttack = null;
    document.getElementById('target-hint').classList.add('hidden');
    if (uid) UI.doAction('attack', { uid: uid, target: target });
  }

  // ---------------- 交互：拖拽 ----------------
  let drag = null;

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const st = UI.state;
    if (!st || st.done) return;
    const el = e.target.closest ? e.target.closest('.card') : null;
    if (!el || !el.dataset.uid) return;
    if (UI.mode === 'targeting' || UI.mode === 'targetingOrder') return;

    const isHand = el.parentElement && el.parentElement.id === 'own-hand';
    const v = viewOfEl(el);
    if (!v) return;
    if (v.owner !== st.you) return;
    if (st.current !== st.you) return;

    drag = {
      el: el, v: v, isHand: isHand, handIndex: isHand ? +el.dataset.handIndex : null,
      sx: e.clientX, sy: e.clientY, active: false, moved: false,
      ghost: null, offX: 0, offY: 0, pointerId: e.pointerId,
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (!drag.active) {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.hypot(dx, dy) < 7) return;
      if (!canDrag(drag)) { cleanupDrag(); return; }
      startDrag(e);
    }
    positionGhost(e.clientX, e.clientY);
    updateDropHover(e.clientX, e.clientY);
  }

  function canDrag(d) {
    const st = UI.state;
    const g = UI.engine;
    if (d.isHand) {
      const v = d.v;
      if (v.cost > st.players[st.you].kredits) { UI.warn('指挥点不足'); return false; }
      if (v.type === 'order' || v.type === 'gotcha' || v.type === 'location') {
        // 指令卡不支持拖拽落位（点击使用）
        return false;
      }
      if (g && g.hasRoomFor && !g.hasRoomFor(g.players[st.you].hand[d.handIndex])) {
        UI.warn('战场没有空位');
        return false;
      }
      return true;
    }
    if (!g || !g.find) return false;
    const inst = g.find(d.v.uid);
    if (!inst) return false;
    const canFront = g.canMove(inst, true), canBack = g.canMove(inst, false);
    const canAtk = g.canAttack(inst) && (g.attackTargets(inst) || []).length > 0;
    return !!(canFront || canBack || canAtk);
  }

  function startDrag(e) {
    drag.active = true;
    drag.moved = true;
    const r = drag.el.getBoundingClientRect();
    drag.offX = r.width / 2;
    drag.offY = r.height / 2;

    const ghost = drag.el.cloneNode(true);
    ghost.id = 'drag-ghost';
    ghost.style.left = (e.clientX - drag.offX) + 'px';
    ghost.style.top = (e.clientY - drag.offY) + 'px';
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    // 对齐原版拖拽：卡牌放大到约 1.4 倍跟随指针（实测录像 31.5s 段）
    ghost.style.position = 'fixed';
    ghost.style.transform = 'rotate(2deg) scale(1.38)';
    if (window.gsap) {
      gsap.fromTo(ghost, { scale: 1.04, rotation: 1 },
        { scale: 1.38, rotation: 2, duration: 0.09, ease: 'power2.out' });
    }
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.el.classList.add('dragging-src');
    SFX.play('select');
    hidePopup();

    // 高亮可用落点
    const st = UI.state, g = UI.engine;
    if (drag.isHand) {
      highlightSlots(['front', 'support']);
    } else {
      const inst = g.find(drag.v.uid);
      const canFront = inst && g.canMove(inst, true);
      const canBack = inst && g.canMove(inst, false);
      highlightSlots([canFront ? 'front' : null, canBack ? 'support' : null].filter(Boolean));
      // 可攻击目标
      if (inst && g.canAttack(inst)) {
        const ts = g.attackTargets(inst) || [];
        for (const t of ts) {
          if (t === 0) {
            const slot = document.getElementById('opp-hq-slot');
            if (slot) slot.classList.add('targetable');
          } else {
            const el = cardEls.get(t);
            if (el) el.classList.add('targetable');
          }
        }
      }
    }
  }

  function highlightSlots(kinds) {
    // 只高亮己方：支援阵线各槽 + 前线整行
    const own = Array.prototype.slice.call(document.querySelectorAll('#line-own .slot'));
    own.forEach(s => {
      const k = s.dataset.drop;
      s.classList.toggle('drop-ok', kinds.indexOf(k) >= 0);
    });
    const row = document.getElementById('row-frontline');
    if (row) row.classList.toggle('drop-ok', kinds.indexOf('front') >= 0);
  }

  function positionGhost(x, y) {
    if (!drag || !drag.ghost) return;
    drag.ghost.style.left = (x - drag.offX) + 'px';
    drag.ghost.style.top = (y - drag.offY) + 'px';
  }

  function updateDropHover(x, y) {
    document.querySelectorAll('.drop-hover').forEach(s => s.classList.remove('drop-hover'));
    const t = dropTargetAt(x, y);
    if (t && t.slot) t.slot.classList.add('drop-hover');
  }

  function dropTargetAt(x, y) {
    if (drag.ghost) drag.ghost.style.display = 'none';
    const under = document.elementFromPoint(x, y);
    if (drag.ghost) drag.ghost.style.display = '';
    if (!under) return null;
    const cardEl = under.closest ? under.closest('.card') : null;
    if (cardEl && cardEl !== drag.el && cardEl.dataset.uid) {
      return { card: cardEl, uid: +cardEl.dataset.uid };
    }
    const slot = under.closest ? under.closest('[data-drop]') : null;
    if (slot) return { slot: slot, kind: slot.dataset.drop };
    return null;
  }

  function onPointerUp(e) {
    if (!drag) return;
    const d = drag;
    if (!d.active) { cleanupDrag(); return; }

    hidePopup();
    const t = dropTargetAt(e.clientX, e.clientY);
    const st = UI.state;
    let acted = false;

    if (t) {
      if (d.isHand) {
        if (t.kind === 'front' || (t.slot && t.kind === 'support')) {
          UI.selectedHand = -1;
          const slot = t.kind === 'front'
            ? frontInsertIndex(e.clientX)
            : (t.slot.dataset.slot != null ? +t.slot.dataset.slot : undefined);
          UI.doAction('play', {
            handIndex: d.handIndex,
            toFront: t.kind === 'front',
            slot: slot,
          });
          acted = true;
        }
      } else {
        if (t.card && t.uid && t.uid !== d.v.uid) {
          const g = UI.engine;
          const inst = g && g.find ? g.find(d.v.uid) : null;
          if (inst && g.canAttack(inst) && (g.attackTargets(inst) || []).indexOf(t.uid) >= 0) {
            UI.doAction('attack', { uid: d.v.uid, target: t.uid });
            acted = true;
          }
        } else if (t.kind === 'hq') {
          const g = UI.engine;
          const inst = g && g.find ? g.find(d.v.uid) : null;
          if (inst && g.canAttack(inst) && (g.attackTargets(inst) || []).indexOf(0) >= 0) {
            UI.doAction('attack', { uid: d.v.uid, target: 0 });
            acted = true;
          } else {
            UI.warn('无法攻击敌方总部');
          }
        } else if (t.kind === 'front' || (t.slot && t.kind === 'support')) {
          const g = UI.engine;
          const inst = g && g.find ? g.find(d.v.uid) : null;
          if (inst) {
            const toFront = t.kind === 'front';
            if (g.canMove(inst, toFront)) {
              UI.doAction('move', {
                uid: d.v.uid, toFront: toFront,
                slot: toFront
                  ? frontInsertIndex(e.clientX)
                  : (t.slot.dataset.slot != null ? +t.slot.dataset.slot : undefined),
              });
              acted = true;
            } else {
              UI.hint(toFront ? '无法移动到前线' : '无法撤回支援阵线');
            }
          }
        }
      }
    }

    if (!acted && d.isHand && d.moved) {
      // 拖到无效区域：飘回
      UI.warn('拖到前线或支援阵线才能部署');
    }

    cleanupDrag();
  }

  /** 前线插入位置：根据指针 x 落在第几张牌之后 */
  function frontInsertIndex(clientX) {
    const row = document.getElementById('row-frontline');
    if (!row) return undefined;
    const cards = Array.prototype.slice.call(row.querySelectorAll('.card'));
    let n = 0;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (r.left + r.width / 2 < clientX) n++;
    }
    return n;
  }

  function cleanupDrag() {
    const wasActive = !!(drag && drag.active);
    if (wasActive) {
      UI._suppressClick = true;
      setTimeout(() => { UI._suppressClick = false; }, 80);
    }
    if (drag && drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    if (drag && drag.el) drag.el.classList.remove('dragging-src');
    document.querySelectorAll('.drop-ok,.drop-hover').forEach(s => s.classList.remove('drop-ok', 'drop-hover'));
    document.querySelectorAll('.targetable').forEach(s => s.classList.remove('targetable'));
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    drag = null;
  }
  UI.cancelDrag = cleanupDrag;

  // ---------------- 高亮 ----------------
  function refreshHighlights() {
    const st = UI.state;
    if (!st) return;
    document.querySelectorAll('#own-hand .card').forEach(el => {
      el.classList.toggle('selected', +el.dataset.handIndex === UI.selectedHand);
    });
    if (UI.engine && UI.engine.find) {
      document.querySelectorAll('.card[data-uid]').forEach(el => {
        const inst = UI.engine.find(+el.dataset.uid);
        if (!inst || inst.owner !== st.you) return;
        const can = !st.done && st.current === st.you &&
          (UI.engine.canAttack(inst) || UI.engine.canMove(inst, true) || UI.engine.canMove(inst, false));
        el.classList.toggle('can-act', !!can);
      });
    }
  }
  UI.refreshHighlights = refreshHighlights;

  // ---------------- 弹窗 ----------------
  let popupEl = null;
  function showPopup(v, x, y) {
    const el = document.getElementById('card-popup');
    if (!el) return;
    popupEl = el;
    const def = (window.CARD_DB && window.CARD_DB.byId[v.id]) || v;
    const img = def.image ? `<img src="/cards/${def.image}" alt="">` : '';
    const isUnit = v.type && v.type !== 'order' && v.type !== 'gotcha' && v.type !== 'hq';
    const atk = v.totalAttack != null ? v.totalAttack : (def.attack != null ? def.attack : null);
    const dfn = v.defense != null ? v.defense : def.defense;
    const kws = (v.keywords && v.keywords.length ? v.keywords : def.keywords) || [];
    el.innerHTML = img +
      `<div class="cp-name">${escapeHtml(v.name || def.name || '')}</div>
       <div class="cp-meta">${escapeHtml(nationZh(v.nation || def.nation))} · ${TYPE_NAME[v.type || def.type] || ''}${def.rarity ? ' · ' + rarityZh(def.rarity) : ''}</div>
       <div class="cp-stats">
         ${isUnit ? `<div class="cp-stat"><b>${atk != null ? atk : '—'}</b><span>攻击</span></div>` : ''}
         ${isUnit ? `<div class="cp-stat"><b>${dfn != null ? dfn : '—'}</b><span>防御</span></div>` : ''}
         ${def.cost != null ? `<div class="cp-stat"><b>${def.cost}</b><span>费用</span></div>` : ''}
         ${def.opCost ? `<div class="cp-stat"><b>${def.opCost}</b><span>行动费</span></div>` : ''}
       </div>
       ${(def.text ? `<div class="cp-text">${escapeHtml(def.text)}</div>` : '')}
       ${kws.length ? `<div class="cp-kw">${kws.map(kwZh).join(' · ')}</div>` : ''}
       ${def.flavor ? `<div class="cp-flavor">${escapeHtml(def.flavor)}</div>` : ''}`;
    el.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    let px = x + 22, py = y - r.height / 2;
    if (px + r.width > window.innerWidth - 10) px = x - r.width - 22;
    py = Math.max(8, Math.min(window.innerHeight - r.height - 8, py));
    el.style.left = px + 'px';
    el.style.top = py + 'px';
  }
  function hidePopup() { if (popupEl) popupEl.classList.add('hidden'); }
  UI.showPopup = showPopup;
  UI.hidePopup = hidePopup;

  const NATION_ZH_MAP = { Germany: '德国', USA: '美国', Soviet: '苏联', Japan: '日本', Britain: '英国', France: '法国', Italy: '意大利', Poland: '波兰', Finland: '芬兰', Anzac: '澳新军团', Neutral: '中立' };
  function nationZh(n) { return NATION_ZH_MAP[n] || n || ''; }
  function rarityZh(r) { return ({ Common: '普通', Uncommon: '精良', Rare: '稀有', Unique: '唯一', Limited: '限定', Special: '特殊' })[r] || r; }
  function kwZh(k) {
    const m = /^heavyArmor(\d)$/.exec(k);
    if (m) return '重甲 ' + m[1];
    return KEYWORD_ZH[k] || k;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  UI.escapeHtml = escapeHtml;

  // ---------------- 日志 ----------------
  UI.logLine = function (line, cls) {
    const p = document.getElementById('log-panel');
    if (!p) return;
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = line;
    p.appendChild(d);
    while (p.children.length > 80) p.removeChild(p.firstChild);
    p.scrollTop = p.scrollHeight;
  };
  UI.clearLog = function () {
    const p = document.getElementById('log-panel');
    if (p) p.innerHTML = '';
  };

  // ---------------- 通用卡牌（收藏 / 构筑） ----------------
  UI.buildCardEl = function (view, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'card';
    const src = imgSrc(view, opts.small !== false);
    if (src) {
      const img = document.createElement('img');
      img.className = 'card-img';
      img.src = src;
      img.loading = 'lazy';
      img.draggable = false;
      img.onerror = () => { el.classList.add('no-img'); };
      el.appendChild(img);
    } else {
      el.classList.add('no-img');
      const tag = document.createElement('div');
      tag.className = 'card-nametag';
      tag.textContent = view.name || '';
      el.appendChild(tag);
    }
    return el;
  };

  // ---------------- 全局事件 ----------------
  UI.doAction = function (type, payload) {
    if (UI.onAction) UI.onAction(type, payload);
  };

  document.addEventListener('click', (e) => {
    if (UI.mode === 'targeting' || UI.mode === 'targetingOrder') return;
    if (e.target.closest && (e.target.closest('.card') || e.target.closest('.game-btn') ||
        e.target.closest('.icon-btn') || e.target.closest('.modal') || e.target.closest('.card-popup'))) return;
    UI.selectedHand = -1;
    refreshHighlights();
  });

  // 拖拽入口
  function bindTable() {
    const t = document.getElementById('table');
    if (!t || t.dataset.bound) return;
    t.dataset.bound = '1';
    t.addEventListener('pointerdown', onPointerDown);
    t.addEventListener('contextmenu', (e) => {
      if (UI.mode === 'targeting' || UI.mode === 'targetingOrder') {
        e.preventDefault();
        clearTargets();
        UI.mode = 'idle';
        UI.pendingAttack = null;
        UI.pendingOrder = null;
        UI.clearHint();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { fitTable(); bindTable(); });
  } else { fitTable(); bindTable(); }

  const _origRender = UI.render;
  UI.render = function (state, opts) {
    bindTable();
    _origRender(state, opts);
  };

})();
