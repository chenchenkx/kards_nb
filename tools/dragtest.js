/* 双浏览器端到端联机验证：A 建房 → B 加入 → 轮流回合 → A 真实点击出牌 → 结束回合
 * 用法（先在本机起 Edge 调试端口 9345）：
 *   node tools/livetwo.js [URL]
 */
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const PORT = +(process.env.CDP_PORT || 9345);
const PAGE_URL = process.argv[2] || 'http://localhost:8080/';
const SHOT_DIR = 'shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[' + new Date().toISOString().slice(11, 19) + ']', ...a);

function api(pathname, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: method || 'GET' }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function openPage(name, w = 1280, h = 720) {
  const target = await api('/json/new?about:blank', 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      consoleErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map(a => a.value || a.description).join(' '));
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, mm => mm.error ? reject(new Error(method + ': ' + JSON.stringify(mm.error))) : resolve(mm.result));
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  await new Promise(r => ws.on('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(3500);

  return {
    name, consoleErrors, send,
    async evalJs(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('EVAL 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result && r.result.value;
    },
    async shot(file) {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(SHOT_DIR + '/' + file, Buffer.from(s.data, 'base64'));
      log(name, '截图', file);
    },
    async close() { try { await api('/json/close/' + target.id); } catch (e) {} ws.close(); },
  };
}

const waitFor = async (page, expr, ms = 15000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await page.evalJs('!!(' + expr + ')').catch(() => false);
    if (ok) return true;
    await sleep(200);
  }
  log(page.name, '等待超时:', label || expr);
  return false;
};

const STATE_EXPR = `(() => {
  const st = UI.state || {};
  return {
    turn: st.turn, you: st.you, current: st.current, done: !!st.done,
    hand: (st.players && st.players[st.you] ? st.players[st.you].hand : []).length,
    kredits: (st.players && st.players[st.you] ? st.players[st.you].kredits : 0),
    playable: document.querySelectorAll('#own-hand .card.playable').length,
    myTurn: st.current === st.you && !st.done,
    oppCards: document.querySelectorAll('#row-frontline .card').length
      + document.querySelectorAll('#line-opp .card').length,
    onAction: !!UI.onAction,
    lanMode: !!st.lanMode,
  };
})()`;


(async () => {
  const A = await openPage('A(主机)', 1400, 800);
  const B = await openPage('B(客机)', 1400, 800);
  let failed = 0;
  const check = (name, ok, extra) => {
    console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? ' — ' + extra : ''));
    if (!ok) failed++;
  };

  await waitFor(A, "document.getElementById('btn-create-room')", 20000, 'A 开始界面');
  await A.evalJs("document.getElementById('btn-create-room').click()");
  await waitFor(A, "(document.getElementById('room-code-display')||{}).textContent.trim && document.getElementById('room-code-display').textContent.trim() !== '----'", 15000, '房间码');
  const code = (await A.evalJs("document.getElementById('room-code-display').textContent.trim()")).trim();

  await waitFor(B, "document.getElementById('btn-join-room')", 20000, 'B 开始界面');
  await B.evalJs("document.getElementById('btn-join-room').click()");
  await sleep(400);
  await B.evalJs("document.getElementById('join-code-input').value = " + JSON.stringify(code));
  await B.evalJs("document.getElementById('join-confirm').click()");

  await waitFor(A, "!document.getElementById('game-screen').classList.contains('hidden')", 20000, 'A 进入对局');
  await waitFor(B, "!document.getElementById('game-screen').classList.contains('hidden')", 20000, 'B 进入对局');
  await sleep(1500);

  // 等到 A 回合且有可出单位
  let info = null;
  for (let round = 0; round < 14 && !info; round++) {
    const st = await A.evalJs(STATE_EXPR);
    if (st.myTurn && st.playable > 0) {
      info = await A.evalJs(`(() => {
        const st = UI.state, me = st.you;
        const hand = st.players[me].hand;
        const cards = [...document.querySelectorAll('#own-hand .card')];
        const isUnit = i => hand[i] && ['infantry','tank','artillery','fighter','bomber','location'].indexOf(hand[i].type) >= 0;
        let i = cards.findIndex((c, k) => c.classList.contains('playable') && isUnit(k));
        if (i < 0) return { ok: false, reason: '没有可出的单位牌' };
        const handheld = cards[i].getBoundingClientRect();
        const target = document.getElementById('row-frontline').getBoundingClientRect();
        return { ok: true, hand: hand.length, idx: i, name: hand[i].name, type: hand[i].type,
          from: { x: Math.round(handheld.left + handheld.width / 2), y: Math.round(handheld.top + handheld.height / 2) },
          to:   { x: Math.round(target.left + target.width / 2), y: Math.round(target.top + target.height / 2) },
          frontCards: document.querySelectorAll('#row-frontline .card').length };
      })()`);
    } else if (st.myTurn) {
      await A.evalJs("document.getElementById('btn-end-turn').click()");
      await sleep(2400);
    } else {
      await B.evalJs("document.getElementById('btn-end-turn').click()");
      await sleep(2400);
    }
  }
  check('找到可拖拽的单位牌', !!(info && info.ok), JSON.stringify(info).slice(0, 260));
  if (!info || !info.ok) { console.log('\n结果：无法进行拖拽测试'); await A.close(); await B.close(); process.exit(1); }

  await A.shot('95-before-drag.png');

  // ---- 真实鼠标拖拽 ----
  const m = (type, x, y, extra) => A.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', clickCount: 1 }, extra || {}));
  await m('mousePressed', info.from.x, info.from.y, { buttons: 1 });
  await sleep(120);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(info.from.x + (info.to.x - info.from.x) * i / steps);
    const y = Math.round(info.from.y + (info.to.y - info.from.y) * i / steps);
    await m('mouseMoved', x, y, { buttons: 1 });
    await sleep(45);
    if (i === 6) {
      const mid = await A.evalJs("({ ghost: !!document.getElementById('drag-ghost'), ok: document.querySelectorAll('.drop-ok').length, hover: document.querySelectorAll('.drop-hover').length })");
      check('拖拽中出现幽灵牌', mid.ghost, JSON.stringify(mid));
      check('拖拽中高亮合法落点', mid.ok > 0 || mid.hover > 0, JSON.stringify(mid));
      await A.shot('96-dragging.png');
    }
  }
  await m('mouseReleased', info.to.x, info.to.y, { buttons: 0 });
  await sleep(2200);
  await A.shot('97-after-drop.png');

  const after = await A.evalJs(`(() => {
    const st = UI.state, me = st.you;
    return { hand: st.players[me].hand.length,
             front: document.querySelectorAll('#row-frontline .card').length,
             ownedFront: (st.frontline || []).length,
             ghost: !!document.getElementById('drag-ghost'),
             log: (st.log || []).slice(-2) };
  })()`);
  check('拖拽后手牌减少', after.hand < info.hand, info.hand + ' → ' + after.hand);
  check('拖拽后单位上了前线', after.front > info.frontCards, info.frontCards + ' → ' + after.front);
  check('拖拽结束无幽灵残留', !after.ghost, JSON.stringify(after));

  const bView = await B.evalJs("({ opp: document.querySelectorAll('#row-frontline .card').length + document.querySelectorAll('#line-opp .card').length })");
  check('对手看到拖上去的单位', bView.opp >= 1, JSON.stringify(bView));
  await B.shot('98-B-sees-drag.png');

  const errs = A.consoleErrors.filter(Boolean).slice(0, 3);
  check('无控制台异常', errs.length === 0, errs.join(' | ').slice(0, 300));

  console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
  await A.close(); await B.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('脚本异常:', e && e.stack || e); process.exit(2); });
