/* ============================================================
 * KARDS Web - main orchestration
 * ============================================================ */
(function () {
  'use strict';

  const Engine = window.KardsEngine;
  const App = {
    db: null,
    nation: 'Germany',
    deck: null,          // array of card ids (39)
    hqId: null,
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
  async function boot() {
    const [cards, hqs, deckcodes] = await Promise.all([
      fetch('data/cards.json').then(r => r.json()),
      fetch('data/hqs.json').then(r => r.json()),
      fetch('data/deckcodes.json').then(r => r.json()).catch(() => ({ codes: {} })),
    ]);
    window.DECK_CODES = deckcodes.codes || {};
    App.db = Engine.buildDb(cards, hqs);
    window.CARD_DB = App.db;
    document.getElementById('card-count-label').textContent = `${cards.length} cards`;
    buildNationGrid();
    selectNation('Germany');
    wireStartScreen();
    fetchLanInfo();
    // preload engine into UI
    UI.engine = null;
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
  const NATIONS = ['Germany', 'USA', 'Soviet', 'Japan', 'Britain', 'France', 'Italy', 'Poland', 'Finland', 'Anzac'];
  const NATION_FLAGS = { Germany: '🇩🇪', USA: '🇺🇸', Soviet: '☭', Japan: '🇯🇵', Britain: '🇬🇧', France: '🇫🇷', Italy: '🇮🇹', Poland: '🇵🇱', Finland: '🇫🇮', Anzac: '🇦🇺' };
  const NATION_ZH = { Germany: '德国', USA: '美国', Soviet: '苏联', Japan: '日本', Britain: '英国', France: '法国', Italy: '意大利', Poland: '波兰', Finland: '芬兰', Anzac: '澳新军团', Neutral: '中立' };

  function buildNationGrid() {
    const grid = document.getElementById('nation-grid');
    grid.innerHTML = '';
    for (const n of NATIONS) {
      const chip = document.createElement('div');
      chip.className = 'nation-chip' + (n === App.nation ? ' selected' : '');
      chip.dataset.nation = n;
      chip.innerHTML = `<span class="flag">${NATION_FLAGS[n]}</span>${NATION_ZH[n] || n}`;
      chip.title = NATION_ZH[n] || n;
      chip.addEventListener('click', () => selectNation(n));
      grid.appendChild(chip);
    }
  }

  function selectNation(n) {
    App.nation = n;
    document.querySelectorAll('.nation-chip').forEach(c => c.classList.toggle('selected', c.dataset.nation === n));
    if (App.mode === 'auto') {
      App.deck = Engine.autoDeck(n, App.db, Engine.makeRng((Math.random() * 1e9) | 0));
      App.hqId = App.db.hqs[n].id;
      document.getElementById('deck-name-label').textContent = `自动${NATION_ZH[n] || n}卡组`;
    } else if (App.mode === 'preset' && App.preset) {
      applyPreset(App.preset);
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

  function applyPreset(preset) {
    App.preset = preset;
    const parsed = Engine.parseDeckCode(preset.code, window.DECK_CODES || {}, App.db);
    if (parsed && parsed.cards.length >= 25) {
      let deck = parsed.cards.slice(0, 39);
      // pad to 39 with random cards from the main nation if the code references
      // cards missing from our database
      if (deck.length < 39) {
        const filler = Engine.autoDeck(parsed.main, App.db, Engine.makeRng(1234));
        const maxCopies = { Common: 4, Uncommon: 3, Rare: 2, Unique: 1 };
        const counts = {};
        for (const id of deck) counts[id] = (counts[id] || 0) + 1;
        for (const id of filler) {
          if (deck.length >= 39) break;
          const def = App.db.byId[id];
          if (!def) continue;
          const max = maxCopies[def.rarity] || 2;
          if ((counts[id] || 0) >= max) continue;
          deck.push(id);
          counts[id] = (counts[id] || 0) + 1;
        }
      }
      App.deck = deck;
      App.hqId = App.db.hqs[parsed.main].id;
      document.getElementById('deck-name-label').textContent = `${preset.name}（${NATION_ZH[parsed.main] || parsed.main}）`;
    } else {
      // fallback to auto
      App.deck = Engine.autoDeck(App.nation, App.db, Engine.makeRng(42));
      document.getElementById('deck-name-label').textContent = preset.name + '（数据缺失，已用自动卡组替代）';
    }
  }

  // ---------------- start screen wiring ----------------
  function wireStartScreen() {
    document.getElementById('btn-auto-deck').addEventListener('click', () => {
      App.mode = 'auto';
      markDeckBtn('btn-auto-deck');
      App.deck = Engine.autoDeck(App.nation, App.db, Engine.makeRng((Math.random() * 1e9) | 0));
      App.hqId = App.db.hqs[App.nation].id;
      document.getElementById('deck-name-label').textContent = `自动${NATION_ZH[App.nation] || App.nation}卡组`;
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
    let list = App.db.cards.filter(c =>
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
  function openDeckBuilder() {
    const modal = document.getElementById('preset-modal');
    const list = document.getElementById('preset-list');
    document.querySelector('.modal-box .modal-title').textContent = '卡组构筑';
    list.innerHTML = '';

    const counts = {};
    const deckArr = App.mode === 'custom' && App.deck ? App.deck.slice() : Engine.autoDeck(App.nation, App.db, Engine.makeRng(7)).slice();
    for (const id of deckArr) counts[id] = (counts[id] || 0) + 1;

    const info = document.createElement('div');
    info.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:8px;text-align:center';
    list.appendChild(info);

    const poolWrap = document.createElement('div');
    poolWrap.style.cssText = 'max-height:46vh;overflow:auto;display:flex;flex-direction:column;gap:4px';
    list.appendChild(poolWrap);

    const search = document.createElement('input');
    search.className = 'code-input';
    search.style.cssText = 'font-size:14px;letter-spacing:0.05em;text-align:left;padding:8px 10px;margin-bottom:8px';
    search.placeholder = '搜索卡牌…';
    list.insertBefore(search, poolWrap);

    function refreshInfo() {
      const total = deckArr.length;
      const unique = Object.keys(counts).length;
      info.textContent = `${total}/39 张 · ${unique} 种不同卡牌 · 国家：${NATION_ZH[App.nation] || App.nation}`;
    }

    function renderPool(filter) {
      poolWrap.innerHTML = '';
      const pool = App.db.cards.filter(c =>
        (c.nation === App.nation || c.nation === 'Neutral') &&
        c.type !== 'gotcha' && c.type !== 'location' && c.cost > 0 &&
        (!filter || c.name.toLowerCase().includes(filter.toLowerCase())));
      const maxCopies = { Common: 4, Uncommon: 3, Rare: 2, Unique: 1 };
      for (const c of pool.slice(0, 300)) {
        const row = document.createElement('div');
        row.className = 'preset-item';
        const n = counts[c.id] || 0;
        const max = maxCopies[c.rarity] || 2;
        row.innerHTML = `<span class="p-name">${c.name}</span>
          <span class="p-nation">${c.type} ${c.cost}K${c.attack ? ' ' + c.attack + '/' + c.defense : ''} · x${n}/${max}</span>`;
        const addBtn = document.createElement('button');
        addBtn.className = 'btn';
        addBtn.style.cssText = 'padding:3px 10px;font-size:11px';
        addBtn.textContent = n >= max ? '已满' : '＋';
        addBtn.disabled = n >= max || deckArr.length >= 39;
        addBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (deckArr.length < 39 && n < max) {
            deckArr.push(c.id);
            counts[c.id] = n + 1;
            refreshInfo();
            renderPool(search.value);
          }
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

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.style.cssText = 'width:100%;margin-top:10px';
    saveBtn.textContent = '保存卡组';
    saveBtn.addEventListener('click', () => {
      if (deckArr.length !== 39) { alert('卡组必须恰好为 39 张（当前 ' + deckArr.length + ' 张）'); return; }
      App.deck = deckArr;
      App.hqId = App.db.hqs[App.nation].id;
      App.mode = 'custom';
      markDeckBtn('btn-build-deck');
      document.getElementById('deck-name-label').textContent = `自定义${NATION_ZH[App.nation] || App.nation}卡组`;
      modal.classList.add('hidden');
    });
    list.appendChild(saveBtn);

    document.querySelector('.modal-box .modal-title').textContent = '卡组构筑';
    refreshInfo();
    renderPool('');
    modal.classList.remove('hidden');
  }

  // ---------------- AI game ----------------
  function startAIGame() {
    if (!App.deck || App.deck.length < 30) {
      App.deck = Engine.autoDeck(App.nation, App.db, Engine.makeRng(99));
    }
    if (!App.hqId) App.hqId = App.db.hqs[App.nation].id;
    const aiNations = NATIONS.filter(n => n !== App.nation);
    const aiNation = aiNations[(Math.random() * aiNations.length) | 0];
    App.aiDeck = Engine.autoDeck(aiNation, App.db, Engine.makeRng((Math.random() * 1e9) | 0));
    App.engine = new Engine.Game({
      db: App.db,
      seed: (Math.random() * 2147483647) | 0,
      decks: [App.deck, App.aiDeck],
      hqs: [App.db.hqs[App.nation], App.db.hqs[aiNation]],
    });
    App.netGame = false;
    App.mySeat = 0;
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

  function handleLocalAction(type, payload) {
    const g = App.engine;
    if (!g || g.done || g.current !== 0 || App.busy) return;
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
    if (!App.deck || App.deck.length < 30) App.deck = Engine.autoDeck(App.nation, App.db, Engine.makeRng(5));
    if (!App.hqId) App.hqId = App.db.hqs[App.nation].id;
    try {
      await Net.connect();
    } catch (e) {
      alert('无法连接游戏服务器，请确认服务器已启动。');
      return;
    }
    wireNetHandlers();
    Net.createRoom(App.deck, App.db.hqs[App.nation], App.nation);
  }

  async function joinRoom() {
    const code = document.getElementById('join-code-input').value.trim().toUpperCase();
    if (code.length !== 4) { alert('请输入 4 位房间码'); return; }
    if (!App.deck || App.deck.length < 30) App.deck = Engine.autoDeck(App.nation, App.db, Engine.makeRng(5));
    if (!App.hqId) App.hqId = App.db.hqs[App.nation].id;
    try {
      await Net.connect();
    } catch (e) {
      alert('无法连接游戏服务器。');
      return;
    }
    wireNetHandlers();
    Net.joinRoom(code, App.deck, App.db.hqs[App.nation], App.nation);
    document.getElementById('join-modal').classList.add('hidden');
  }

  function wireNetHandlers() {
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
    title.textContent = win ? 'VICTORY' : 'DEFEAT';
    title.className = 'gameover-title ' + (win ? 'win' : 'lose');
    sub.textContent = win ? '敌军总部已被摧毁，战役胜利！' : '你的总部已被攻陷，战役失败。';
    modal.classList.remove('hidden');
  }

  // AI action relay for UI
  UI.onAction = null;

  window.App = App;
  document.addEventListener('DOMContentLoaded', boot);
})();
