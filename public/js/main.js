/* ============================================================
 * KARDS Web - main orchestration
 * ============================================================ */
(function () {
  'use strict';

  const Engine = window.KardsEngine;
  const App = {
    db: null,
    nation: 'Germany',
    ally: null,          // 副国（France/Italy/Poland/Finland/Anzac）
    deck: null,          // array of card ids (39)
    hqId: null,          // 所选总部（data/hqs.json 里的官方 location id）
    mode: 'auto',        // auto | preset | custom
    preset: null,
    engine: null,        // local engine (AI mode)
    netGame: false,
    mySeat: 0,
    busy: false,         // animation lock
    pendingEndTurn: false, // 结算中点了结束回合 → 排队
    pendingEvents: [],
  };

  // ---------------- boot ----------------
  /** 让浏览器先完成一次绘制，再做重活（2.3MB JSON 解析 + 建库不堵首屏） */
  function afterPaint() {
    return new Promise(resolve => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  }

  async function boot() {
    const bootStatus = document.getElementById('boot-status');
    if (bootStatus) { bootStatus.textContent = '正在载入卡牌数据…'; bootStatus.classList.remove('hidden'); }
    const [cards, hqs, deckcodes] = await Promise.all([
      fetch('data/cards.json').then(r => r.json()),
      fetch('data/hqs.json').then(r => r.json()),
      fetch('data/deckcodes.json').then(r => r.json()).catch(() => ({ codes: {} })),
    ]);
    // 先让起始界面完成绘制，再做建库与网格渲染
    await afterPaint();
    window.DECK_CODES = deckcodes.codes || {};
    App.db = Engine.buildDb(cards, hqs);
    window.CARD_DB = App.db;
    document.getElementById('card-count-label').textContent = `${cards.length + hqs.length} 张卡（${cards.length} 卡牌 + ${hqs.length} 总部）`;
    buildNationGrid();
    selectNation('Germany');
    wireStartScreen();
    fetchLanInfo();
    // preload engine into UI
    UI.engine = null;
    if (bootStatus) bootStatus.classList.add('hidden');
  }

  function fetchLanInfo() {
    fetch('/api/laninfo').then(r => r.json()).then(info => {
      const el = document.getElementById('lan-info');
      let html = '局域网访问地址：';
      html += `<b>http://${location.hostname}:${info.port}</b>`;
      for (const ip of info.ips) html += ` · <b>http://${ip}:${info.port}</b>`;
      el.innerHTML = html + '<br>同一 WiFi/局域网内的其他设备打开相同网址即可联机对战。';
    }).catch(() => {});
  }

  // ---------------- nation grid ----------------
  // 官方五大主国（有 HQ/location 数据）；其余五个国家只能当副国
  const NATIONS = Engine.MAJOR_NATIONS.slice();
  const ALLY_NATIONS = Engine.ALLY_NATIONS.slice();
  // 国旗用内联 SVG（Emoji 在 Windows/Android/iOS 上样式差异极大，且部分平台不显示）
  const FLAG_SVG = {
    Germany: "<rect width='30' height='6.67' fill='#111'/><rect y='6.67' width='30' height='6.67' fill='#d22'/><rect y='13.33' width='30' height='6.67' fill='#f3c500'/>",
    USA: "<rect width='30' height='20' fill='#fff'/><g fill='#b22234'><rect width='30' height='1.54'/><rect y='3.08' width='30' height='1.54'/><rect y='6.15' width='30' height='1.54'/><rect y='9.23' width='30' height='1.54'/><rect y='12.31' width='30' height='1.54'/><rect y='15.38' width='30' height='1.54'/><rect y='18.46' width='30' height='1.54'/></g><rect width='12' height='10.77' fill='#3c3b6e'/><g fill='#fff'><circle cx='2.4' cy='2' r='.7'/><circle cx='6' cy='2' r='.7'/><circle cx='9.6' cy='2' r='.7'/><circle cx='4.2' cy='5' r='.7'/><circle cx='7.8' cy='5' r='.7'/><circle cx='2.4' cy='8' r='.7'/><circle cx='6' cy='8' r='.7'/><circle cx='9.6' cy='8' r='.7'/></g>",
    Soviet: "<rect width='30' height='20' fill='#c8102e'/><path d='M8 4.2l1.05 3.2h3.4l-2.75 2 1.05 3.2L8 10.6 5.25 12.6l1.05-3.2L3.55 7.4h3.4z' fill='#f7c600'/>",
    Japan: "<rect width='30' height='20' fill='#fff'/><circle cx='15' cy='10' r='6' fill='#bc002d'/>",
    Britain: "<rect width='30' height='20' fill='#012169'/><path d='M0 0l30 20M30 0L0 20' stroke='#fff' stroke-width='4'/><path d='M0 0l30 20M30 0L0 20' stroke='#c8102e' stroke-width='1.8'/><path d='M15 0v20M0 10h30' stroke='#fff' stroke-width='6.7'/><path d='M15 0v20M0 10h30' stroke='#c8102e' stroke-width='4'/>",
    France: "<rect width='10' height='20' fill='#002395'/><rect x='10' width='10' height='20' fill='#fff'/><rect x='20' width='10' height='20' fill='#ed2939'/>",
    Italy: "<rect width='10' height='20' fill='#009246'/><rect x='10' width='10' height='20' fill='#fff'/><rect x='20' width='10' height='20' fill='#ce2b37'/>",
    Poland: "<rect width='30' height='10' fill='#fff'/><rect y='10' width='30' height='10' fill='#dc143c'/>",
    Finland: "<rect width='30' height='20' fill='#fff'/><path d='M0 8h30M11 0v20' stroke='#003580' stroke-width='4'/>",
    Anzac: "<rect width='30' height='20' fill='#00247d'/><g fill='#fff'><circle cx='22' cy='6' r='1.1'/><circle cx='25' cy='12' r='1.1'/><circle cx='20' cy='15' r='1.1'/><circle cx='24' cy='17' r='1'/><circle cx='17' cy='9' r='.9'/></g><rect width='12' height='9' fill='#012169'/><path d='M0 0l12 9M12 0L0 9' stroke='#fff' stroke-width='1.6'/><path d='M6 0v9M0 4.5h12' stroke='#fff' stroke-width='2.6'/><path d='M6 0v9M0 4.5h12' stroke='#c8102e' stroke-width='1.4'/>",
    Neutral: "<rect width='30' height='20' fill='#8a8a8a'/>",
  };
  function flagImg(n) {
    const body = FLAG_SVG[n] || FLAG_SVG.Neutral;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 20'>${body}</svg>`;
    return `<img class="flag-img" alt="" src="data:image/svg+xml,${encodeURIComponent(svg)}">`;
  }
  const NATION_FLAGS = {};   // 兼容旧引用
  const NATION_ZH = { Germany: '德国', USA: '美国', Soviet: '苏联', Japan: '日本', Britain: '英国', France: '法国', Italy: '意大利', Poland: '波兰', Finland: '芬兰', Anzac: '澳新军团', Neutral: '中立' };

  function buildNationGrid() {
    const grid = document.getElementById('nation-grid');
    grid.innerHTML = '';
    for (const n of NATIONS) {
      const chip = document.createElement('div');
      chip.className = 'nation-chip' + (n === App.nation ? ' selected' : '');
      chip.dataset.nation = n;
      chip.innerHTML = `<span class="flag">${flagImg(n)}</span>${NATION_ZH[n] || n}`;
      chip.title = NATION_ZH[n] || n;
      chip.addEventListener('click', () => selectNation(n));
      grid.appendChild(chip);
    }
  }

  /** 当前选择的总部对象（按 hqId 精确取，缺省回落国家默认 HQ） */
  function hqObj(nation) {
    const n = nation || App.nation;
    const id = (n === App.nation) ? App.hqId : null;
    if (id && App.db.hqById[id]) return App.db.hqById[id];
    return App.db.hqs[n] || App.db.hqs.Neutral;
  }

  /** 总部下拉：列出该国家全部可选 HQ（含真实防御值） */
  function renderHqSelect() {
    const sel = document.getElementById('hq-select');
    if (!sel) return;
    const list = App.db.hqsOf(App.nation);
    const keep = App.hqId;
    sel.innerHTML = '';
    for (const h of list) {
      const opt = document.createElement('option');
      opt.value = h.id;
      opt.textContent = `${h.name} · ${h.defense} 防`;
      if (h.id === keep) opt.selected = true;
      sel.appendChild(opt);
    }
    if (!list.some(h => h.id === keep)) {
      App.hqId = list.length ? list[0].id : App.db.hqs[App.nation].id;
      sel.value = App.hqId;
    }
    sel.onchange = () => {
      App.hqId = sel.value;
      markDeckLabel();
    };
  }

  /** 副国下拉：不能与主国相同 */
  function renderAllySelect() {
    const sel = document.getElementById('ally-select');
    if (!sel) return;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '无副国';
    sel.appendChild(none);
    for (const n of ALLY_NATIONS) {
      if (n === App.nation) continue;
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = `副国：${NATION_ZH[n] || n}`;
      if (App.ally === n) opt.selected = true;
      sel.appendChild(opt);
    }
    if (App.ally && App.ally === App.nation) App.ally = null;
    sel.value = App.ally || '';
    sel.onchange = () => {
      App.ally = sel.value || null;
      // 换副国后重算自动卡组（已有自定义/预设卡组则保留，交给校验提示）
      if (App.mode === 'auto') rebuildAutoDeck();
      markDeckLabel();
    };
  }

  function rebuildAutoDeck() {
    App.deck = Engine.autoDeck(App.nation, App.db, Engine.makeRng((Math.random() * 1e9) | 0), { ally: App.ally });
  }

  function markDeckLabel() {
    const hq = hqObj(App.nation);
    const ally = App.ally ? ' + ' + (NATION_ZH[App.ally] || App.ally) : '';
    const base = App.mode === 'auto' ? `自动${NATION_ZH[App.nation] || App.nation}`
      : App.mode === 'preset' && App.preset ? App.preset.name
      : `自定义${NATION_ZH[App.nation] || App.nation}`;
    document.getElementById('deck-name-label').textContent = `${base}${ally} · ${hq.name}`;
  }

  function selectNation(n) {
    App.nation = n;
    if (App.ally === n) App.ally = null;
    document.querySelectorAll('.nation-chip').forEach(c => c.classList.toggle('selected', c.dataset.nation === n));
    App.hqId = (App.db.hqsOf(n)[0] || App.db.hqs[n]).id;
    renderHqSelect();
    renderAllySelect();
    if (App.mode === 'auto') {
      rebuildAutoDeck();
      markDeckLabel();
    } else if (App.mode === 'preset' && App.preset) {
      applyPreset(App.preset);
    } else {
      markDeckLabel();
    }
  }

  // ---------------- deck sources ----------------
  const PRESETS = [
    { key: 'ger-fin', name: '德芬车辆', code: '%%19|303NE1gVwCxr;2Z3f3X4AoUrKwE;E4nlxoxpza;ux' },
    { key: 'bri-anz', name: '英澳联军', code: '%%2a|0m19DJDSgvoosQsTtXw2y7yJyO;0leFqYwbyc;1VDTy9yd;DR' },
    { key: 'ger-fin-cars', name: '德芬装甲车', code: '%%19|2S2Z303N4AE3iawCxryQ;3XrK;3f4vE4nloUxoza;ux' },
    { key: 'ger-anz-vet', name: '德澳老兵', code: '%%1a|3NgUu0xrxVz9zf;4pE3E4y1y9zdzx;3fz8;4wxXzc' },
    { key: 'bri-sov', name: '英苏中立', code: '%%24|0mDDgvooqQsTtXw2y7yJyO;DQE0qYxmyGyZzB;DRzC;tTyH' },
    { key: 'bri-usa-mice', name: '米色团', code: '%%25|0m19oow7;bqEbohsDtVw0wa;vSwbyw;DRpUsU' },
    { key: 'jp-pol-boom', name: '日波炸槽', code: '%%38|5CjQp2pezq;5B5Z6w6xtFztzw;p1p6zpzs;pczi' },
    { key: 'jp-anz-aggro', name: '日澳快攻', code: '%%3a|5C6B6yhHrktGwXznzqzvzx;DJE7tFy2;7ltKy9zs;7axX' },
  ];
  const PRESET_ZH_NAMES = {
    'ger-fin': '无名德芬', 'bri-anz': '无名英澳', 'ger-fin-cars': '德芬车',
    'ger-anz-vet': '德澳老兵', 'bri-sov': '英苏中立', 'bri-usa-mice': '米色团',
    'jp-pol-boom': '日波炸槽', 'jp-anz-aggro': '日澳快攻',
  };

  async function loadRealPresets() {
    // fetch the real preset deck codes from the kards-sim decks.json if served
    try {
      const r = await fetch('data/decks.json');
      if (r.ok) {
        const data = await r.json();
        if (data.decks) {
          App.realPresets = data.decks.map(d => ({ key: d.key, name: PRESET_ZH_NAMES[d.key] || d.name, code: d.code }));
        }
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * 应用社区卡组码。
   * 以前缺牌时用随机卡补满 39 张，等于把官方卡组污染成一半随机牌；
   * 现在只在数据层面还原，缺几张就如实提示几张（AI 对局时由引擎按实际张数开局）。
   */
  function applyPreset(preset) {
    App.preset = preset;
    const parsed = Engine.parseDeckCode(preset.code, window.DECK_CODES || {}, App.db);
    if (!parsed || !parsed.cards.length) {
      App.deck = Engine.autoDeck(App.nation, App.db, Engine.makeRng(42), { ally: App.ally });
      markDeckLabel();
      document.getElementById('deck-name-label').textContent = preset.name + '（卡组码无法解析，已用自动卡组替代）';
      return;
    }
    App.nation = parsed.main;
    App.ally = parsed.ally && parsed.ally !== parsed.main && Engine.ALLY_NATIONS.includes(parsed.ally)
      ? parsed.ally : null;
    document.querySelectorAll('.nation-chip').forEach(c => c.classList.toggle('selected', c.dataset.nation === App.nation));
    App.hqId = (App.db.hqsOf(parsed.main)[0] || App.db.hqs[parsed.main]).id;
    App.deck = parsed.cards.slice(0, 39);
    App.mode = 'preset';
    renderHqSelect();
    renderAllySelect();

    const missing = Math.max(0, 39 - App.deck.length);
    const v = Engine.validateDeck(App.deck, App.nation, App.ally, App.db);
    const allyTxt = App.ally ? ' + ' + (NATION_ZH[App.ally] || App.ally) : '';
    let label = `${preset.name}（${NATION_ZH[App.nation] || App.nation}${allyTxt}）`;
    if (missing > 0) label += ` · 本卡库缺 ${missing} 张`;
    document.getElementById('deck-name-label').textContent = label;
    if (missing > 0) {
      UI.logLine && UI.logLine(`⚠ 卡组「${preset.name}」在本地卡库中缺 ${missing} 张（官方数据本身只有 ${App.deck.length} 张可还原），未用随机牌填充`);
    }
    App.presetWarning = missing > 0 ? `该卡组在本卡库中缺 ${missing} 张` : null;
    if (!v.ok && v.errors.length) {
      App.presetWarning = (App.presetWarning ? App.presetWarning + '；' : '') + v.errors[0];
    }
  }

  // ---------------- start screen wiring ----------------
  function wireStartScreen() {
    document.getElementById('btn-auto-deck').addEventListener('click', () => {
      App.mode = 'auto';
      markDeckBtn('btn-auto-deck');
      rebuildAutoDeck();
      markDeckLabel();
    });
    document.getElementById('btn-preset-deck').addEventListener('click', () => {
      openPresetModal();
    });
    document.getElementById('btn-build-deck').addEventListener('click', () => {
      openDeckBuilder();
    });

    document.getElementById('btn-vs-ai').addEventListener('click', startAIGame);
    document.getElementById('btn-create-room').addEventListener('click', createRoom);
    document.getElementById('btn-join-room').addEventListener('click', () => {
      document.getElementById('join-modal').classList.remove('hidden');
      document.getElementById('join-code-input').focus();
    });
    document.getElementById('join-close').addEventListener('click', () => document.getElementById('join-modal').classList.add('hidden'));
    document.getElementById('join-confirm').addEventListener('click', joinRoom);
    document.getElementById('join-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
    document.getElementById('preset-close').addEventListener('click', () => document.getElementById('preset-modal').classList.add('hidden'));
    document.getElementById('lobby-leave').addEventListener('click', () => {
      Net.leave();
      document.getElementById('lobby-screen').classList.add('hidden');
      document.getElementById('start-screen').classList.remove('hidden');
    });
    document.getElementById('btn-collection').addEventListener('click', openCollection);
    document.getElementById('collection-close').addEventListener('click', () => document.getElementById('collection-modal').classList.add('hidden'));
    document.getElementById('collection-search').addEventListener('input', renderCollection);
    document.getElementById('collection-nation').addEventListener('change', renderCollection);
    document.getElementById('collection-type').addEventListener('change', renderCollection);
    document.getElementById('btn-end-turn').addEventListener('click', requestEndTurn);
    document.getElementById('btn-rematch').addEventListener('click', () => {
      document.getElementById('gameover-modal').classList.add('hidden');
      if (App.netGame) Net.rematch();
      else startAIGame();
    });
    document.getElementById('btn-gameover-menu').addEventListener('click', () => {
      document.getElementById('gameover-modal').classList.add('hidden');
      App.netGame = false;
      App.engine = null;
      UI.engine = null;
      Net.leave();
      document.getElementById('game-screen').classList.add('hidden');
      document.getElementById('start-screen').classList.remove('hidden');
    });

    loadRealPresets();
  }

  // ---------------- collection browser ----------------
  function openCollection() {
    const nationSel = document.getElementById('collection-nation');
    if (!nationSel.options.length) {
      nationSel.innerHTML = '<option value="">全部国家</option>';
      for (const n of NATIONS) {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = NATION_ZH[n] || n;
        nationSel.appendChild(opt);
      }
    }
    document.getElementById('collection-modal').classList.remove('hidden');
    renderCollection();
  }

  let collectionRendered = 0;
  function renderCollection() {
    const grid = document.getElementById('collection-grid');
    const q = (document.getElementById('collection-search').value || '').toLowerCase().trim();
    const nation = document.getElementById('collection-nation').value;
    const type = document.getElementById('collection-type').value;
    let list = (App.db.deckPool || App.db.cards).filter(c =>
      (!nation || c.nation === nation) &&
      (!type || c.type === type) &&
      (!q || c.name.toLowerCase().includes(q) || (c.text || '').toLowerCase().includes(q)));
    document.getElementById('collection-count').textContent = `— 共 ${list.length} 张`;
    // sort by nation then cost then name
    list.sort((a, b) => a.nation.localeCompare(b.nation) || (a.cost || 0) - (b.cost || 0) || a.name.localeCompare(b.name));
    // cap render for performance (lazy)
    const MAX = 600;
    grid.innerHTML = '';
    if (!list.length) {
      grid.innerHTML = '<div class="collection-empty">没有符合筛选条件的卡牌。</div>';
      return;
    }
    const shown = list.slice(0, MAX);
    for (const def of shown) {
      // build a pseudo card view
      const cardView = {
        uid: 'c_' + def.id, id: def.id, name: def.name, type: def.type, nation: def.nation,
        cost: def.cost, attack: def.attack, defense: def.defense, totalAttack: def.attack,
        text: def.text, keywords: def.keywords, rarity: def.rarity, image: def.image,
        flavor: def.flavor,
      };
      const el = UI.buildCardEl(cardView, { small: true });
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        UI.showPopup(Object.assign({}, def, cardView), ev.clientX, ev.clientY);
      });
      grid.appendChild(el);
    }
    if (list.length > MAX) {
      const more = document.createElement('div');
      more.className = 'collection-empty';
      more.textContent = `仅显示前 ${MAX} 张（共 ${list.length} 张）—— 请细化搜索条件查看更多。`;
      grid.appendChild(more);
    }
  }

  function markDeckBtn(id) {
    ['btn-auto-deck', 'btn-preset-deck', 'btn-build-deck'].forEach(b =>
      document.getElementById(b).classList.toggle('selected', b === id));
  }

  function openPresetModal() {
    const list = document.getElementById('preset-list');
    list.innerHTML = '';
    const presets = App.realPresets || PRESETS;
    for (const p of presets) {
      const item = document.createElement('div');
      item.className = 'preset-item';
      item.innerHTML = `<span class="p-name">${p.name}</span><span class="p-nation">预设卡组</span>`;
      item.addEventListener('click', () => {
        App.mode = 'preset';
        markDeckBtn('btn-preset-deck');
        applyPreset(p);
        document.getElementById('preset-modal').classList.add('hidden');
      });
      list.appendChild(item);
    }
    document.getElementById('preset-modal').classList.remove('hidden');
  }

  // ---------------- deck builder (simple) ----------------
  /**
   * 卡组构筑器（对齐官方规则）：
   * - 主国（五大主国）+ 副国（可选）+ 中立 组成卡池
   * - 副国卡 ≤ 12 张，且副国不能带精英/特殊精英
   * - 单卡张数按稀有度上限：标准 4 / 限定 3 / 特殊 2 / 精英 1
   * - 反制指令（gotcha）可加入卡组
   * - 总部从该国家官方 location 里选（含真实防御值）
   */
  function openDeckBuilder() {
    const modal = document.getElementById('preset-modal');
    const list = document.getElementById('preset-list');
    document.querySelector('.modal-box .modal-title').textContent = '卡组构筑';
    list.innerHTML = '';

    if (!App.deck || App.deck.length < 30) rebuildAutoDeck();
    const deckArr = App.deck.slice();
    const counts = {};
    for (const id of deckArr) counts[id] = (counts[id] || 0) + 1;

    const RARITY_ZH = { Common: '标准', Uncommon: '限定', Rare: '特殊', Unique: '精英' };

    // ---- 顶部配置行：副国 + 总部 ----
    const cfg = document.createElement('div');
    cfg.className = 'deck-row';
    cfg.style.marginBottom = '6px';
    const allySel = document.createElement('select');
    allySel.className = 'code-input';
    allySel.style.cssText = 'flex:1;font-size:12px;padding:6px 8px;letter-spacing:0;text-align:left';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '无副国';
    allySel.appendChild(noneOpt);
    for (const n of ALLY_NATIONS) {
      if (n === App.nation) continue;
      const o = document.createElement('option');
      o.value = n;
      o.textContent = `副国：${NATION_ZH[n] || n}`;
      if (App.ally === n) o.selected = true;
      allySel.appendChild(o);
    }
    const hqSel = document.createElement('select');
    hqSel.className = 'code-input';
    hqSel.style.cssText = 'flex:1;font-size:12px;padding:6px 8px;letter-spacing:0;text-align:left';
    for (const h of App.db.hqsOf(App.nation)) {
      const o = document.createElement('option');
      o.value = h.id;
      o.textContent = `${h.name} · ${h.defense} 防`;
      if (h.id === App.hqId) o.selected = true;
      hqSel.appendChild(o);
    }
    cfg.appendChild(allySel);
    cfg.appendChild(hqSel);
    list.appendChild(cfg);

    const info = document.createElement('div');
    info.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:6px;text-align:center';
    list.appendChild(info);

    const search = document.createElement('input');
    search.className = 'code-input';
    search.style.cssText = 'font-size:14px;letter-spacing:0.05em;text-align:left;padding:8px 10px;margin-bottom:8px';
    search.placeholder = '搜索卡牌…';
    list.appendChild(search);

    const poolWrap = document.createElement('div');
    poolWrap.style.cssText = 'max-height:40vh;overflow:auto;display:flex;flex-direction:column;gap:4px';
    list.appendChild(poolWrap);

    function allyCount() {
      let n = 0;
      for (const id of deckArr) {
        const d = App.db.byId[id];
        if (App.ally && d && d.nation === App.ally) n++;
      }
      return n;
    }

    function refreshInfo() {
      const ally = allyCount();
      const unique = Object.keys(counts).filter(k => counts[k] > 0).length;
      info.textContent = `${deckArr.length}/39 张 · ${unique} 种 · 主国：${NATION_ZH[App.nation] || App.nation}`
        + (App.ally ? ` · 副国：${NATION_ZH[App.ally] || App.ally} ${ally}/${Engine.ALLY_CARD_LIMIT}` : ' · 无副国');
      info.style.color = deckArr.length > 39 ? '#e08a72' : 'var(--text-dim)';
    }

    function canAdd(c) {
      if (deckArr.length >= 39) return { ok: false, why: '卡组已满 39 张' };
      const limit = Engine.rarityLimit(c);
      if ((counts[c.id] || 0) >= limit) return { ok: false, why: `已达 ${limit} 张上限（${RARITY_ZH[c.rarity] || c.rarity}）` };
      if (App.ally && c.nation === App.ally) {
        if (Engine.isEliteCard(c)) return { ok: false, why: '副国不能携带精英卡' };
        if (allyCount() >= Engine.ALLY_CARD_LIMIT) return { ok: false, why: `副国卡已达 ${Engine.ALLY_CARD_LIMIT} 张上限` };
      }
      return { ok: true };
    }

    function renderPool(filter) {
      poolWrap.innerHTML = '';
      const f = (filter || '').toLowerCase();
      const pool = (App.db.deckPool || App.db.cards).filter(c =>
        (c.nation === App.nation || c.nation === 'Neutral' || (App.ally && c.nation === App.ally)) &&
        c.type !== 'location' &&
        (!f || c.name.toLowerCase().includes(f) || (c.text || '').toLowerCase().includes(f)))
        .sort((a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name));
      if (!pool.length) {
        poolWrap.innerHTML = '<div class="collection-empty">没有匹配的卡牌</div>';
        return;
      }
      for (const c of pool.slice(0, 400)) {
        const n = counts[c.id] || 0;
        const limit = Engine.rarityLimit(c);
        const isAllyCard = !!App.ally && c.nation === App.ally;
        const row = document.createElement('div');
        row.className = 'preset-item';
        const flag = isAllyCard ? '副' : (c.nation === 'Neutral' ? '中' : '主');
        row.innerHTML = `<span class="p-name">${c.name}</span>
          <span class="p-nation">${flag} · ${RARITY_ZH[c.rarity] || c.rarity} · ${c.cost}K${c.attack ? ' ' + c.attack + '/' + c.defense : ''} · x${n}/${limit}</span>`;
        const addBtn = document.createElement('button');
        addBtn.className = 'btn';
        addBtn.style.cssText = 'padding:3px 10px;font-size:11px';
        const chk = canAdd(c);
        addBtn.textContent = chk.ok ? '＋' : '已满';
        addBtn.disabled = !chk.ok;
        addBtn.title = chk.why || '';
        addBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const r = canAdd(c);
          if (!r.ok) { UI.hint && UI.hint(r.why, 1200); return; }
          deckArr.push(c.id);
          counts[c.id] = (counts[c.id] || 0) + 1;
          refreshInfo();
          renderPool(search.value);
        });
        row.appendChild(addBtn);
        const subBtn = document.createElement('button');
        subBtn.className = 'btn';
        subBtn.style.cssText = 'padding:3px 10px;font-size:11px;margin-left:4px';
        subBtn.textContent = '－';
        subBtn.disabled = n <= 0;
        subBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (n > 0) {
            const idx = deckArr.indexOf(c.id);
            if (idx >= 0) deckArr.splice(idx, 1);
            counts[c.id] = n - 1;
            refreshInfo();
            renderPool(search.value);
          }
        });
        row.appendChild(subBtn);
        poolWrap.appendChild(row);
      }
    }

    allySel.addEventListener('change', () => {
      App.ally = allySel.value || null;
      // 换副国后，清掉不再合法的牌
      for (let i = deckArr.length - 1; i >= 0; i--) {
        const d = App.db.byId[deckArr[i]];
        const okNation = d && (d.nation === App.nation || d.nation === 'Neutral' || (App.ally && d.nation === App.ally));
        if (!okNation) { counts[deckArr[i]]--; deckArr.splice(i, 1); }
      }
      refreshInfo();
      renderPool(search.value);
    });
    hqSel.addEventListener('change', () => {
      App.hqId = hqSel.value;
    });
    search.addEventListener('input', () => renderPool(search.value));

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.style.cssText = 'width:100%;margin-top:10px';
    saveBtn.textContent = '保存卡组';
    saveBtn.addEventListener('click', () => {
      const v = Engine.validateDeck(deckArr, App.nation, App.ally, App.db);
      if (!v.ok) {
        alert('卡组不符合规则：\n· ' + v.errors.slice(0, 6).join('\n· '));
        return;
      }
      App.deck = deckArr;
      App.mode = 'custom';
      App.presetWarning = null;
      markDeckBtn('btn-build-deck');
      renderHqSelect();
      renderAllySelect();
      markDeckLabel();
      modal.classList.add('hidden');
    });
    list.appendChild(saveBtn);

    refreshInfo();
    renderPool('');
    modal.classList.remove('hidden');
  }

  // ---------------- AI game ----------------
  function startAIGame() {
    if (!App.deck || App.deck.length < 30) rebuildAutoDeck();
    if (!App.hqId) App.hqId = App.db.hqs[App.nation].id;
    const aiNations = NATIONS.filter(n => n !== App.nation);
    const aiNation = aiNations[(Math.random() * aiNations.length) | 0];
    const aiAlly = Engine.ALLY_NATIONS[(Math.random() * Engine.ALLY_NATIONS.length) | 0];
    App.aiDeck = Engine.autoDeck(aiNation, App.db, Engine.makeRng((Math.random() * 1e9) | 0),
      { ally: aiAlly === aiNation ? null : aiAlly });
    App.engine = new Engine.Game({
      db: App.db,
      seed: (Math.random() * 2147483647) | 0,
      decks: [App.deck, App.aiDeck],
      hqs: [hqObj(App.nation), App.db.hqs[aiNation]],
    });
    App.netGame = false;
    App.mySeat = 0;
    App.engine.humanSides = [true, false];   // 玩家手动二选一，AI 自动选第一项
    UI.engine = App.engine;
    UI.onAction = (type, payload) => handleLocalAction(type, payload);
    g_drainOpening(App.engine);
    UI.clearLog();
    enterGame();
    renderAll();
    UI.logLine(`战役开始：${NATION_ZH[App.nation] || App.nation} VS ${NATION_ZH[aiNation] || aiNation}（AI）`, 'log-turn');
    UI.turnBanner('你的回合', `第 1 回合 · ${App.engine.players[0].kredits} 指挥点`, true);
  }

  // 统一的开锁：动画播放结束后一定解锁，并处理排队中的「结束回合」
  function endBusy() {
    App.busy = false;
    if (UI.setSettling) UI.setSettling(false);
    if (App.pendingEndTurn) {
      App.pendingEndTurn = false;
      setTimeout(() => requestEndTurn(), 80);
    }
  }

  function beginBusy() {
    App.busy = true;
    if (UI.setSettling) UI.setSettling(true);
  }

  // 结束回合入口：任何情况下都有反馈，不会「点了没反应」
  function requestEndTurn() {
    if (App.netGame) { Net.action('endTurn', {}); return; }
    const g = App.engine;
    if (!g) return;
    if (g.done) return;
    if (g.current !== 0) { UI.hint('还没到你的回合', 1200); return; }
    if (App.busy) { App.pendingEndTurn = true; UI.hint('正在结算，稍候自动结束…', 1400); return; }
    endLocalTurn();
  }

  // 开局事件（回合/抽牌）立即丢弃，避免堆积到第一次操作才播放
  function g_drainOpening(engine) {
    try { engine.drainEvents(); } catch (e) { /* ignore */ }
  }

  /**
   * 联机模式没有本地引擎。UI 层需要 find/canAttack/canMove/attackTargets/hasRoomFor，
   * 这里用服务端下发的 view.legal 造一个只读替身，界面照常高亮与判定。
   */
  function netShadow(view) {
    const legal = view.legal || {};
    const attacks = legal.attacks || {};
    const moves = legal.moves || {};
    const byUid = new Map();
    const add = (c) => { if (c && c.uid != null) byUid.set(c.uid, c); };
    (view.players || []).forEach(p => {
      (p.hand || []).forEach(add);
      (p.board || []).forEach(add);
    });
    (view.frontline || []).forEach(add);
    const atkOf = (uid) => attacks[uid] || null;
    return {
      players: view.players || [],
      isNetShadow: true,
      find: (uid) => byUid.get(uid) || null,
      canAttack: (inst) => !!(inst && atkOf(inst.uid)),
      canMove: (inst, toFront) => {
        const m = inst && moves[inst.uid];
        return !!(m && (toFront ? m.front : m.support));
      },
      attackTargets: (inst) => (inst && atkOf(inst.uid)) || [],
      hasRoomFor: () => true,
      canEnterFrontline: () => true,
    };
  }

  function handleLocalAction(type, payload) {
    // 联机：所有操作交给服务器裁决，本地不做任何模拟
    if (App.netGame) {
      if (type === 'choose') { Net.action('choose', payload || {}); return; }
      if (App.busy) { UI.hint('正在结算，稍候…', 1200); return; }
      if (type === 'endTurn') { requestEndTurn(); return; }
      Net.action(type, payload || {});
      return;
    }
    const g = App.engine;
    if (!g || g.done) return;

    // 二选一：即使还在播放动画也必须立刻可点，否则会一直卡住
    if (type === 'choose') {
      const r = g.resolveChoose(0, payload && payload.index);
      if (!r.ok) { UI.logLine('⚠ ' + (r.error || '选择失败')); return; }
      const evs = g.drainEvents();
      renderAll();
      if (evs.length) UI.playEvents(evs, () => { renderAll(); checkEnd(); });
      return;
    }

    if (g.current !== 0 || App.busy) return;
    let res = { ok: false };
    try {
      if (type === 'play') res = g.playCard(0, payload.handIndex, { target: payload.target, toFront: payload.toFront, slot: payload.slot });
      else if (type === 'move') res = g.move(0, payload.uid, payload.toFront, payload.slot);
      else if (type === 'attack') res = g.attack(0, payload.uid, payload.target);
      else if (type === 'endTurn') { g.endTurn(); res = { ok: true }; }
    } catch (e) { res = { ok: false, error: String(e) }; }
    if (!res.ok && res.error) UI.logLine('⚠ ' + res.error);
    const events = g.drainEvents();
    renderAll();
    if (events.length) {
      beginBusy();
      UI.playEvents(events, () => {
        endBusy();
        renderAll();
        checkEnd();
        maybeAiTurn();
      });
    } else {
      checkEnd();
      maybeAiTurn();
    }
  }

  function endLocalTurn() {
    const g = App.engine;
    if (!g || g.done || g.current !== 0 || App.busy) return;
    App.pendingEndTurn = false;
    g.endTurn();
    const events = g.drainEvents();
    renderAll();
    if (events.length) {
      beginBusy();
      UI.playEvents(events, () => { endBusy(); renderAll(); checkEnd(); maybeAiTurn(); });
    } else { checkEnd(); maybeAiTurn(); }
  }

  function maybeAiTurn() {
    const g = App.engine;
    if (!g || g.done || g.current !== 1) return;
    setTimeout(() => {
      if (!App.engine || App.engine.done || App.engine.current !== 1) return;
      const before = App.engine.logLines.length;
      KardsAI.takeTurn(App.engine, 1);
      const newLines = App.engine.logLines.slice(before);
      for (const l of newLines) UI.logLine(l);
      const events = App.engine.drainEvents();
      renderAll();
      if (events.length) {
        beginBusy();
        UI.playEvents(events, () => { endBusy(); renderAll(); checkEnd(); });
      } else checkEnd();
    }, 700);
  }

  function checkEnd() {
    const g = App.engine;
    if (!g || !g.done) return;
    showGameOver(g.winner === 0);
  }

  // ---------------- LAN game ----------------
  async function createRoom() {
    if (!App.deck || App.deck.length < 30) rebuildAutoDeck();
    if (!App.hqId) App.hqId = App.db.hqs[App.nation].id;
    try {
      await Net.connect();
    } catch (e) {
      alert('无法连接游戏服务器，请确认服务器已启动。');
      return;
    }
    wireNetHandlers();
    Net.createRoom(App.deck, hqObj(App.nation), App.nation, App.ally);
  }

  async function joinRoom() {
    const code = document.getElementById('join-code-input').value.trim().toUpperCase();
    if (code.length !== 4) { alert('请输入 4 位房间码'); return; }
    if (!App.deck || App.deck.length < 30) rebuildAutoDeck();
    if (!App.hqId) App.hqId = App.db.hqs[App.nation].id;
    try {
      await Net.connect();
    } catch (e) {
      alert('无法连接游戏服务器。');
      return;
    }
    wireNetHandlers();
    Net.joinRoom(code, App.deck, hqObj(App.nation), App.nation, App.ally);
    document.getElementById('join-modal').classList.add('hidden');
  }

  function wireNetHandlers() {
    // 关键：联机模式也必须把 UI 的动作通道接到网络上，
    // 否则 UI.doAction(...) 是空转，拖拽/点击出牌全部无效。
    UI.onAction = (type, payload) => handleLocalAction(type, payload);

    Net.on('room', (msg) => {
      App.netGame = true;
      App.mySeat = msg.seat;
      Net.roomCode = msg.code;
      if (msg.seat === 0) {
        document.getElementById('room-code-display').textContent = msg.code;
        document.getElementById('lobby-url').textContent = location.host;
        document.getElementById('lobby-status').innerHTML = '<span class="dot"></span>等待对手加入…';
        document.getElementById('start-screen').classList.add('hidden');
        document.getElementById('lobby-screen').classList.remove('hidden');
      } else {
        document.getElementById('start-screen').classList.add('hidden');
        document.getElementById('lobby-screen').classList.remove('hidden');
        document.getElementById('room-code-display').textContent = msg.code;
        document.getElementById('lobby-status').textContent = '已连接，正在开始…';
      }
    });
    Net.on('opponentJoined', () => {
      document.getElementById('lobby-status').textContent = '对手已加入，正在开始…';
    });
    Net.on('needDeck', () => {
      document.getElementById('lobby-status').textContent = '双方都需要准备卡组…';
    });
    Net.on('start', (msg) => {
      document.getElementById('lobby-screen').classList.add('hidden');
      enterGame();
      UI.clearLog();
      UI.logLine(`局域网对局开始 · 你是 P${msg.you + 1}`, 'log-turn');
    });
    Net.on('state', (msg) => {
      // hide opponent hand details (only counts) — viewFor already does that
      applyNetState(msg.view);
    });
    Net.on('events', (msg) => {
      if (!msg.events || !msg.events.length) return;
      beginBusy();
      UI.playEvents(msg.events, () => { endBusy(); });
    });
    Net.on('error', (msg) => {
      UI.logLine('! ' + msg.error);
      alert(msg.error);
    });
    Net.on('opponentLeft', () => {
      UI.logLine('对手已离开对局。');
      setTimeout(() => {
        document.getElementById('game-screen').classList.add('hidden');
        document.getElementById('start-screen').classList.remove('hidden');
      }, 1500);
    });
    Net.on('gameover', (msg) => {
      setTimeout(() => showGameOver(msg.winner === App.mySeat), 900);
    });
    Net.on('close', () => {
      UI.logLine('与服务器断开连接。');
    });
  }

  function applyNetState(view) {
    App.netView = view;
    renderAll(view);
  }

  // ---------------- rendering ----------------
  function enterGame() {
    document.getElementById('start-screen').classList.add('hidden');
    document.getElementById('lobby-screen').classList.add('hidden');
    document.getElementById('game-screen').classList.remove('hidden');
    UI.fitTable();
  }

  function renderAll(view) {
    let v = view;
    if (!v) {
      if (App.netGame) v = App.netView;
      else if (App.engine) v = App.engine.viewFor(0);
    }
    if (v) {
      v.lanMode = App.netGame;
      v.oppName = App.oppName || (App.netGame ? '对手' : 'AI');
      UI.engine = App.netGame ? netShadow(v) : App.engine;
      UI.render(v);
    }
    // log lines diff for local engine
    if (!App.netGame && App.engine) {
      const lines = App.engine.logLines;
      const rendered = UI._renderedLogCount || 0;
      if (lines.length > rendered) {
        for (let i = rendered; i < lines.length; i++) {
          const l = lines[i];
          let cls = '';
          if (/^---/.test(l)) cls = 'log-turn';
          else if (/plays/.test(l)) cls = 'log-play';
          else if (/destroyed|wins/.test(l)) cls = 'log-kill';
          UI.logLine(l, cls);
        }
        UI._renderedLogCount = lines.length;
      }
    }
  }

  function showGameOver(win) {
    const modal = document.getElementById('gameover-modal');
    const title = document.getElementById('gameover-title');
    const sub = document.getElementById('gameover-sub');
    // 对齐官方结算：金色 16 瓣菊花徽记 + 「胜利 / 战败」大字
    title.textContent = win ? '胜利' : '战败';
    title.className = 'gameover-title ' + (win ? 'win' : 'lose');
    const flower = document.getElementById('gameover-flower');
    if (flower) {
      if (win) {
        let petals = '';
        for (let i = 0; i < 16; i++) {
          petals += `<ellipse cx="60" cy="27" rx="7" ry="19" transform="rotate(${i * 22.5} 60 60)"/>`;
        }
        flower.innerHTML = '<svg viewBox="0 0 120 120" width="132" height="132">' +
          '<g fill="#dfa63c" stroke="#7d5314" stroke-width="1.4">' + petals + '</g>' +
          '<circle cx="60" cy="60" r="9.5" fill="#f0c265" stroke="#7d5314" stroke-width="1.4"/></svg>';
        flower.classList.remove('hidden');
      } else {
        flower.innerHTML = '';
        flower.classList.add('hidden');
      }
    }
    sub.textContent = win ? '敌军总部已被摧毁，战役胜利！' : '你的总部已被攻陷，战役失败。';
    modal.classList.remove('hidden');
    // 胜利金爆（对齐原版胜利瞬间的全屏金色绽放）
    if (win) {
      if (UI.fxVictory) UI.fxVictory();
      SFX.play('victory');
    }
  }

  // AI action relay for UI
  UI.onAction = null;

  window.App = App;
  document.addEventListener('DOMContentLoaded', boot);
})();
