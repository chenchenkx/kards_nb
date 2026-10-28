/* DOM-level UI test using jsdom: loads the real page and plays a game. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('JSDOM: ' + (e.message || e)));
vc.on('error', (...a) => errors.push('CONSOLE: ' + a.join(' ')));

const dom = new JSDOM(html, {
  url: 'http://localhost:8080/',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;

// stub fetch to load local data files
window.fetch = (url) => {
  const p = url.replace(/^.*?\/\/[^/]+/, '').split('?')[0];
  const file = path.join(ROOT, p.replace(/^\//, ''));
  try {
    const data = fs.readFileSync(file, 'utf8');
    return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(data)) });
  } catch (e) {
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }
};
// stub WebSocket (no server needed for AI mode)
window.WebSocket = function () {
  this.readyState = 1;
  this.send = () => {};
  this.close = () => {};
};

setTimeout(async () => {
  try {
    const doc = window.document;
    let pass = 0, fail = 0;
    const check = (n, c) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } };

    // wait for boot
    await new Promise(r => setTimeout(r, 800));
    check('card DB loaded in browser', window.CARD_DB && window.CARD_DB.cards.length > 1600);
    check('engine exposed', !!window.KardsEngine);
    check('nation grid rendered (5 major nations)', doc.querySelectorAll('.nation-chip').length === 5);
    check('card count label (1728 cards + 178 HQ = 1906)', /1728/.test(doc.getElementById('card-count-label').textContent));
    check('auto deck built', window.App && window.App.deck && window.App.deck.length === 39);

    // start AI game
    doc.getElementById('btn-vs-ai').click();
    await new Promise(r => setTimeout(r, 600));
    check('game screen visible', !doc.getElementById('game-screen').classList.contains('hidden'));
    check('own hand rendered', doc.querySelectorAll('#own-hand .card').length === 4);
    check('HQ defense badges show 20', [...doc.querySelectorAll('.hq-def-badge')].every(b => b.textContent === '20'));
    check('kredits displayed', doc.querySelector('#own-kredit .kb-cur').textContent === '1');
    check('kredit K label', !!doc.querySelector('#own-kredit .kb-k'));
    check('support slots exist (4)', doc.querySelectorAll('#line-own .slot').length === 4);
    check('opponent support slots (4)', doc.querySelectorAll('#line-opp .slot').length === 4);
    check('frontline row is a centered flex row', (() => { const r = doc.getElementById('row-frontline'); return !!r && r.dataset.drop === 'front'; })());
    check('HQ centered between slots', (() => {
      const kids = [...doc.getElementById('line-own').children];
      return kids.length === 5 && kids[2].id === 'own-hq-slot';
    })());
    check('HQ cards rendered in rows', doc.querySelectorAll('.hq-card').length === 2);
    check('HQ card has art', (() => {
      const bg = doc.querySelector('.hq-card').style.backgroundImage;
      // 合法路由二选一：/assets/hq/<纯文件名> 或 /cards/res/hq-cards/<文件名>；其余（如 /assets/hq/res/...）都是 404 坏路径
      return /\/assets\/hq\/[^/'"]+\.jpg/.test(bg) || /\/cards\/res\/hq-cards\/[^/'"]+\.jpg/.test(bg);
    })());
    check('frontline dashed line rendered', !!doc.querySelector('.fl-dashes'));
    check('end turn button rendered', !!doc.getElementById('btn-end-turn'));
    check('opponent card backs rendered', doc.querySelectorAll('#opp-hand .card-back').length >= 4);
    check('UI state set', window.UI.state && window.UI.state.you === 0);
    check('engine set on UI', !!window.UI.engine);
    check('hand cards carry uid', [...doc.querySelectorAll('#own-hand .card')].every(c => !!c.dataset.uid));

    // ---- 拖拽部署测试（模拟 pointer 事件 + elementFromPoint）----
    {
      const g = window.App.engine;
      const p0 = g.players[0];
      // 给足指挥点后重新渲染（模拟中期回合）
      p0.kredits = 12;
      p0.slots = 12;
      window.UI.state.players[0].kredits = 12;
      window.UI.state.players[0].slots = 12;
      window.UI.render(window.UI.state, { noFlip: true });
      // 找一张费用够的单位牌
      let hi = -1;
      for (let i = 0; i < p0.hand.length; i++) {
        const c = p0.hand[i];
        if ((c.type === 'infantry' || c.type === 'tank' || c.type === 'artillery' || c.type === 'fighter' || c.type === 'bomber') && c.cost <= 12) { hi = i; break; }
      }
      check('found deployable unit in hand', hi >= 0);
      if (hi >= 0) {
        const before = p0.board.length + g.frontline.filter(c => c.owner === 0).length;
        const cardEl = doc.querySelectorAll('#own-hand .card')[hi];
        const targetSlot = doc.querySelector('#line-own .slot');
        doc.elementFromPoint = () => targetSlot;   // stub 落点
        const mk = (type, x, y) => { const e = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }); return e; };
        cardEl.dispatchEvent(mk('pointerdown', 300, 400));
        doc.dispatchEvent(mk('pointermove', 320, 430));
        doc.dispatchEvent(mk('pointerup', 320, 430));
        await new Promise(r => setTimeout(r, 700));
        const after = p0.board.length + g.frontline.filter(c => c.owner === 0).length;
        check('drag deployed a unit to board', after > before);
        check('drag created no leftover ghost', !doc.getElementById('drag-ghost'));
      }
    }

    // play through a full game with the AI by clicking
    const clickPlayable = () => {
      const el = doc.querySelector('#own-hand .card.playable');
      if (!el) return false;
      el.click();
      setTimeout(() => { const again = doc.querySelector('#own-hand .card.playable'); }, 0);
      return true;
    };
    let actions = 0;
    for (let step = 0; step < 170 && !window.App.engine.done; step++) {
      const g = window.App.engine;
      // play a card if affordable
      const hand = g.players[0].hand;
      const idx = hand.findIndex(c => c.cost <= g.players[0].kredits);
      if (idx >= 0) {
        window.UI.doAction('play', { handIndex: idx });
        actions++;
      }
      // move units to frontline
      for (const u of g.unitsOf(0)) {
        if (g.canMove(u, true) && g.players[0].kredits >= u.opCost) {
          window.UI.doAction('move', { uid: u.uid, toFront: true });
          actions++;
        }
      }
      // attack with anything able (HQ if no enemy frontline units)
      const foeFront = g.frontline.filter(c => c.owner === 1).length;
      for (const u of g.unitsOf(0)) {
        if (!g.canAttack(u)) continue;
        const targets = g.attackTargets(u);
        if (!targets.length || g.players[0].kredits < u.opCost) continue;
        const t = foeFront ? targets.find(x => x !== 0) : (targets.includes(0) ? 0 : targets[0]);
        window.UI.doAction('attack', { uid: u.uid, target: t });
        actions++;
      }
      window.UI.doAction('endTurn', {});
      await new Promise(r => setTimeout(r, 650));
      if (window.App.engine.done) break;
    }
    // wait for AI turn callbacks to settle
    await new Promise(r => setTimeout(r, 2000));
    check('game played to completion via UI actions', window.App.engine.done);
    check('actions executed', actions > 10);
    check('gameover modal shown', !doc.getElementById('gameover-modal').classList.contains('hidden'));
    check('victory/defeat title', /VICTORY|DEFEAT|胜利|战败/.test(doc.getElementById('gameover-title').textContent));

    // log has entries
    check('battle log populated', doc.getElementById('log-panel').children.length > 10);

    // card popup on hover
    const firstCard = doc.querySelector('#own-hand .card');
    if (firstCard) {
      firstCard.dispatchEvent(new window.MouseEvent('mouseenter', { clientX: 100, clientY: 100 }));
      await new Promise(r => setTimeout(r, 100));
      check('card popup shows detail', !doc.getElementById('card-popup').classList.contains('hidden'));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (errors.length) {
      console.log('\n=== JS ERRORS ===');
      errors.slice(0, 15).forEach(e => console.log(e));
    } else {
      console.log('no JS errors');
    }
    process.exit(fail || errors.length ? 1 : 0);
  } catch (e) {
    console.error('TEST CRASH:', e);
    process.exit(1);
  }
}, 1500);
