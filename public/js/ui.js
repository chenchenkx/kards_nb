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
    t.style.transform = `translate(-50%, -50%) scale(${SCALE})`;
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
      // 新抽到的牌：从桌外飞入
      if (el._isNew) {
        el._isNew = false;
        const dy = 70;
        try {
          el.animate([
            { transform: `translateY(${dy}px) scale(.9) ${el.dataset.base}`, opacity: 0 },
            { transform: el.dataset.base, opacity: 1 },
          ], { duration: 340, easing: 'cubic-bezier(.2,.9,.25,1)' });
        } catch (err) { /* ignore */ }
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
    const img = HQ_IMAGES[nation] || 'Bunker_Blank.jpg';
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
    if (badge.textContent !== String(val)) badge.textContent = val;
    badge.classList.toggle('hurt', val < (p.hqMaxDef || 20));
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

  // ---------------- FLIP ----------------
  function flip(before) {
    const s = SCALE || 1;
    for (const [uid, oldR] of before) {
      const el = cardEls.get(uid);
      if (!el || !el.isConnected) continue;
      const nr = el.getBoundingClientRect();
      if (!nr.width) continue;
      const dx = (oldR.left - nr.left) / s;
      const dy = (oldR.top - nr.top) / s;
      if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5) continue;
      const base = el.dataset.base || '';
      try {
        el.animate([
          { transform: `translate(${dx}px, ${dy}px) ${base}`.trim() },
          { transform: base || 'none' },
        ], { duration: 330, easing: 'cubic-bezier(.22,.9,.28,1)' });
      } catch (e) { /* ignore */ }
    }
  }

  function killCard(el, uid) {
    try {
      const c = centerInTable(el);
      UI.fxSmoke(c);
    } catch (e) { /* ignore */ }
    try {
      el.animate([
        { transform: 'none', opacity: 1, filter: 'brightness(1)' },
        { transform: 'translateY(8px) scale(.82) rotate(-7deg)', opacity: 0, filter: 'brightness(.3)' },
      ], { duration: 420, easing: 'ease-in', fill: 'forwards' });
    } catch (e) { /* ignore */ }
    recentDead.set(uid, { el, at: Date.now() });
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 430);
    setTimeout(() => recentDead.delete(uid), 1200);
  }

  // ---------------- 特效 ----------------
  UI.fxDamage = function (el, amount, heal) {
    if (!el || !amount) return;
    const c = centerInTable(el);
    const d = document.createElement('div');
    d.className = 'dmg-number' + (heal ? ' heal' : '');
    d.textContent = (heal ? '+' : '−') + amount;
    d.style.left = (c.x + (Math.random() * 26 - 13)) + 'px';
    d.style.top = (c.y - 52) + 'px';
    fxLayer().appendChild(d);
    setTimeout(() => d.remove(), 1000);
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

  UI.fxSmoke = function (c) {
    const s = document.createElement('div');
    s.className = 'smoke';
    s.style.left = c.x + 'px';
    s.style.top = c.y + 'px';
    fxLayer().appendChild(s);
    setTimeout(() => s.remove(), 750);
  };

  UI.fxHQHit = function (which, amount) {
    const slot = document.getElementById(which + '-hq-slot');
    if (!slot) return;
    const card = slot.querySelector('.hq-card');
    if (card) {
      card.classList.remove('hq-hit');
      void card.offsetWidth;
      card.classList.add('hq-hit');
      setTimeout(() => card.classList.remove('hq-hit'), 500);
    }
    if (amount) UI.fxDamage(card || slot, amount);
    const flash = document.createElement('div');
    flash.className = 'screen-flash';
    fxLayer().appendChild(flash);
    setTimeout(() => flash.remove(), 520);
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
            const dx = (b.x - a.x) * 0.6, dy = (b.y - a.y) * 0.6;
            try {
              fromEl.animate([
                { transform: 'translate(0,0) scale(1)' },
                { transform: `translate(${dx}px, ${dy}px) scale(1.08)`, offset: 0.42 },
                { transform: 'translate(0,0) scale(1)' },
              ], { duration: 440, easing: 'cubic-bezier(.35,0,.3,1)' });
            } catch (e) { /* ignore */ }
            setTimeout(() => {
              UI.fxSpark(toEl);
              try {
                toEl.animate([{ filter: 'brightness(2.8)' }, { filter: 'brightness(1)' }], { duration: 300 });
              } catch (e) { /* ignore */ }
            }, 190);
            setTimeout(next, 300);
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
          steps.push(() => {
            try {
              el.animate([
                { filter: 'brightness(2.4) saturate(1.4)' },
                { filter: 'brightness(1.1) saturate(.98)' },
              ], { duration: 520, easing: 'ease-out' });
            } catch (e) { /* ignore */ }
            const c = centerInTable(el);
            const r = document.createElement('div');
            r.className = 'ring';
            r.style.left = c.x + 'px';
            r.style.top = c.y + 'px';
            fxLayer().appendChild(r);
            setTimeout(() => r.remove(), 650);
          });
        }
      } else if (ev.e === 'turn') {
        const mine = ev.side === UI.mySide;
        steps.push(() => UI.turnBanner(mine ? '你的回合' : '敌方回合', `第 ${ev.turn} 回合 · ${ev.kredits} 指挥点`, mine));
      } else if (ev.e === 'death') {
        const el = findCardEl(ev.uid);
        if (el) steps.push(() => UI.fxSmoke(centerInTable(el)));
      } else if (ev.e === 'order') {
        steps.push(() => UI.hint(ev.name, 900));
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
    guard = setTimeout(finish, 2800);

    const gap = steps.length > 6 ? 100 : 180;
    let i = 0;
    const run = () => {
      if (i >= steps.length) { finish(); return; }
      const step = steps[i++];
      let advanced = false;
      const next = () => { if (advanced) return; advanced = true; run(); };
      try { step(next); } catch (e) { next(); }
      setTimeout(next, gap);
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
      if (st.current !== st.you) { UI.hint('还没到你的回合'); return; }
      const idx = +el.dataset.handIndex;
      const v = st.players[st.you].hand[idx];
      if (!v) return;
      if (v.cost > st.players[st.you].kredits) { UI.hint('指挥点不足'); return; }
      if (UI.selectedHand === idx) { playHand(idx); }
      else { UI.selectedHand = idx; refreshHighlights(); }
      return;
    }

    // 场上单位
    const uid = +el.dataset.uid;
    const v = viewOfEl(el);
    if (!v) return;
    if (v.owner !== st.you) return;
    if (st.current !== st.you) { UI.hint('还没到你的回合'); return; }

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
      if (v.cost > st.players[st.you].kredits) { UI.hint('指挥点不足'); return false; }
      if (v.type === 'order' || v.type === 'gotcha' || v.type === 'location') {
        // 指令卡不支持拖拽落位（点击使用）
        return false;
      }
      if (g && g.hasRoomFor && !g.hasRoomFor(g.players[st.you].hand[d.handIndex])) {
        UI.hint('战场没有空位');
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
    ghost.style.transform = 'rotate(2deg) scale(1.04)';
    ghost.style.position = 'fixed';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.el.classList.add('dragging-src');
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
            UI.hint('无法攻击敌方总部');
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
      UI.hint('拖到前线或支援阵线才能部署');
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
