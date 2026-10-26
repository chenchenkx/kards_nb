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
  const A = await openPage('A(主机)');
  const B = await openPage('B(客机)');
  let failed = 0;
  const check = (name, ok, extra) => {
    console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? ' — ' + extra : ''));
    if (!ok) failed++;
  };

  // ---------- 1. A 建房 ----------
  if (!await waitFor(A, "document.getElementById('btn-create-room')", 20000, '开始界面')) {
    await A.shot('90-A-fail.png');
    process.exit(1);
  }
  await A.evalJs("document.getElementById('btn-create-room').click()");
  await waitFor(A, "(document.getElementById('room-code-display')||{}).textContent.trim && document.getElementById('room-code-display').textContent.trim() !== '----'", 15000, '房间码');
  const code = (await A.evalJs("document.getElementById('room-code-display').textContent.trim()")).trim();
  check('A 建房拿到房间码', /^[A-Z0-9]{4}$/.test(code), code);

  // ---------- 2. B 加入 ----------
  await waitFor(B, "document.getElementById('btn-join-room')", 20000, 'B 开始界面');
  await B.evalJs("document.getElementById('btn-join-room').click()");
  await sleep(400);
  await B.evalJs("document.getElementById('join-code-input').value = " + JSON.stringify(code));
  await B.evalJs("document.getElementById('join-confirm').click()");

  // ---------- 3. 进入对局 ----------
  const aIn = await waitFor(A, "!document.getElementById('game-screen').classList.contains('hidden')", 20000, 'A 进入对局');
  const bIn = await waitFor(B, "!document.getElementById('game-screen').classList.contains('hidden')", 20000, 'B 进入对局');
  check('A 进入对局界面', aIn);
  check('B 进入对局界面', bIn);
  await sleep(1500);

  let sa = await A.evalJs(STATE_EXPR);
  let sb = await B.evalJs(STATE_EXPR);
  check('A 手牌已渲染', sa.hand >= 4, 'hand=' + sa.hand);
  check('B 手牌已渲染', sb.hand >= 4, 'hand=' + sb.hand);
  check('A 动作通道已接通', sa.onAction);
  check('A 处于联机模式', sa.lanMode);
  await A.shot('90-A-start.png');

  // ---------- 4. 轮流回合，直到 A 有牌可出，然后真实点击出牌 ----------
  let playResult = null;
  let round = 0;
  for (; round < 14 && !playResult; round++) {
    sa = await A.evalJs(STATE_EXPR);
    if (sa.done) break;
    if (sa.myTurn) {
      if (sa.playable > 0) {
        playResult = await A.evalJs(`(async () => {
          const before = (UI.state.players[UI.state.you].hand || []).length;
          const hand = UI.state.players[UI.state.you].hand;
          const cards = [...document.querySelectorAll('#own-hand .card')];
          const isUnit = i => hand[i] && ['infantry', 'tank', 'artillery', 'fighter', 'bomber', 'location'].indexOf(hand[i].type) >= 0;
          let idx = cards.findIndex((c, i) => c.classList.contains('playable') && isUnit(i));
          if (idx < 0) idx = cards.findIndex(c => c.classList.contains('playable'));
          const picked = { idx, before, kredits: UI.state.players[UI.state.you].kredits,
                           playedType: hand[idx] && hand[idx].type, playedName: hand[idx] && hand[idx].name };
          cards[idx].click();
          await new Promise(r => setTimeout(r, 300));
          picked.selected = UI.selectedHand;
          const again = document.querySelectorAll('#own-hand .card')[idx];
          if (again) again.click();
          await new Promise(r => setTimeout(r, 2000));
          const after = (UI.state.players[UI.state.you].hand || []).length;
          return Object.assign(picked, {
            after, worked: after < before,
            log: (UI.state.log || []).slice(-2),
            myBoard: document.querySelectorAll('#line-own .card').length
              + document.querySelectorAll('#row-frontline .card').length,
          });
        })()`);
      } else {
        await A.evalJs("document.getElementById('btn-end-turn').click()");
        await sleep(2400);
      }
    } else {
      await B.evalJs("document.getElementById('btn-end-turn').click()");
      await sleep(2400);
    }
  }

  check('A 真实点击成功出牌', !!(playResult && playResult.worked),
    playResult ? JSON.stringify(playResult) : '（' + round + ' 轮内没有可出的牌）');

  if (playResult && playResult.worked) {
    await A.shot('91-A-after-play.png');
    await sleep(1000);
    sb = await B.evalJs(STATE_EXPR);
    const isUnitPlay = ['infantry', 'tank', 'artillery', 'fighter', 'bomber', 'location'].indexOf(playResult.playedType) >= 0;
    if (isUnitPlay) check('B 看到 A 部署的单位', sb.oppCards >= 1, 'oppCards=' + sb.oppCards);
    else log('A 出的是指令卡（' + playResult.playedType + '），跳过场面断言');
    await B.shot('92-B-view.png');

    const turnBefore = (await A.evalJs(STATE_EXPR)).turn;
    await A.evalJs("document.getElementById('btn-end-turn').click()");
    await sleep(2600);
    sa = await A.evalJs(STATE_EXPR);
    sb = await B.evalJs(STATE_EXPR);
    check('结束回合后 A 失去回合权', sa.myTurn === false, JSON.stringify({ aCurrent: sa.current, aYou: sa.you }));
    check('回合权交给 B', sb.myTurn === true, JSON.stringify({ bCurrent: sb.current, bYou: sb.you }));
    check('回合数不倒退', sa.turn >= turnBefore, turnBefore + ' → ' + sa.turn);
    await B.shot('93-B-myturn.png');

    const bPlayed = await B.evalJs(`(async () => {
      const cards = [...document.querySelectorAll('#own-hand .card')];
      const idx = cards.findIndex(c => c.classList.contains('playable'));
      if (idx < 0) return { worked: false, reason: 'B 无可用牌' };
      const before = UI.state.players[UI.state.you].hand.length;
      cards[idx].click();
      await new Promise(r => setTimeout(r, 300));
      const again = document.querySelectorAll('#own-hand .card')[idx];
      if (again) again.click();
      await new Promise(r => setTimeout(r, 2000));
      return { worked: UI.state.players[UI.state.you].hand.length < before,
               before, after: UI.state.players[UI.state.you].hand.length };
    })()`);
    check('B 反向出牌成功', !!(bPlayed && bPlayed.worked), JSON.stringify(bPlayed));
    await B.shot('94-B-after-play.png');
    sa = await A.evalJs(STATE_EXPR);
    check('A 看到 B 的场面', sa.oppCards >= 1, 'oppCards=' + sa.oppCards);
  }

  // ---------- 5. 控制台错误 ----------
  const aErr = A.consoleErrors.filter(Boolean).slice(0, 3);
  const bErr = B.consoleErrors.filter(Boolean).slice(0, 3);
  check('A 无控制台异常', aErr.length === 0, aErr.join(' | ').slice(0, 300));
  check('B 无控制台异常', bErr.length === 0, bErr.join(' | ').slice(0, 300));

  console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
  await A.close();
  await B.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('脚本异常:', e && e.stack || e); process.exit(2); });
