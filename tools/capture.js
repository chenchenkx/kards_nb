/* 端到端截图：进入对局 → 真实鼠标拖拽 → 结束回合，验证动画与拖拽 */
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const PORT = +(process.env.CDP_PORT || 9345);
const OUTDIR = process.env.OUTDIR || 'shots';
const W = +(process.env.SHOT_W || 1600);
const H = +(process.env.SHOT_H || 900);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function api(pathname, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: method || 'GET' }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const target = await api('/json/new?about:blank', 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('ERR: ' + JSON.stringify(m.params.args).slice(0, 200));
  });
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, m => m.error ? rej(new Error(method + ' ' + JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 300) };
    return r.result && r.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const f = OUTDIR + '/' + name + '.png';
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('shot ' + f);
  };
  const mouse = (type, x, y, extra) => send('Input.dispatchMouseEvent', Object.assign({
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  }, extra || {}));

  await new Promise(r => ws.on('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(3000);
  await shot('01-menu');

  await evaluate("document.getElementById('btn-vs-ai').click()");
  await sleep(2200);
  await shot('02-battle');

  // 给足指挥点，保证可部署
  await evaluate(`(() => { const g = window.App.engine; g.players[0].kredits = 10; g.players[0].slots = 10;
      window.UI.state.players[0].kredits = 10; window.UI.render(window.UI.state, {noFlip:true}); return 'ok'; })()`);
  await sleep(400);

  // 找到一张单位手牌与它的屏幕坐标
  const info = await evaluate(`(() => {
    const g = window.App.engine, st = window.UI.state;
    const hand = st.players[0].hand;
    let idx = hand.findIndex(c => ['infantry','tank','artillery','fighter','bomber'].includes(c.type));
    if (idx < 0) idx = 0;
    const el = document.querySelectorAll('#own-hand .card')[idx];
    const r = el.getBoundingClientRect();
    const slot = document.querySelector('#row-frontline .slot:nth-child(3)').getBoundingClientRect();
    return { idx, name: hand[idx] && hand[idx].name,
      sx: r.left + r.width/2, sy: r.top + r.height/2,
      tx: slot.left + slot.width/2, ty: slot.top + slot.height/2 };
  })()`);
  console.log('drag', JSON.stringify(info));

  await mouse('mousePressed', info.sx, info.sy);
  await sleep(120);
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', info.sx + (info.tx - info.sx) * i / 6, info.sy + (info.ty - info.sy) * i / 6);
    await sleep(60);
  }
  await shot('03-dragging');
  await sleep(200);
  await mouse('mouseReleased', info.tx, info.ty);
  await sleep(900);
  await shot('04-deployed');
  const rects = await evaluate(`(() => Array.from(document.querySelectorAll('.card')).map(el => {
      const b = el.getBoundingClientRect();
      return { uid: el.dataset.uid, cls: el.className, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), tr: getComputedStyle(el).transform };
    }))()`);
  console.log('rects@900ms', JSON.stringify(rects));
  await sleep(1500);
  await shot('04b-settled');

  const after = await evaluate(`(() => { const g = window.App.engine;
    return { board: g.players[0].board.length, front: g.frontline.filter(c => c.owner === 0).length,
             cards: document.querySelectorAll('#row-frontline .card').length,
             ghost: !!document.getElementById('drag-ghost'),
             log: g.logLines.slice(-3) };
  })()`);
  console.log('after drag', JSON.stringify(after));

  // 结束回合 → 观察 AI 回合动画
  await evaluate("document.getElementById('btn-end-turn').click()");
  await sleep(1200);
  await shot('05-ai-turn');
  await sleep(2500);
  await shot('06-after-ai');

  const state2 = await evaluate(`(() => { const g = window.App.engine;
    return { turn: g.turn, current: g.current, hq: [g.players[0].hqDef, g.players[1].hqDef],
             handCount: g.players[0].hand.length, log: g.logLines.slice(-6) };
  })()`);
  console.log('state', JSON.stringify(state2));
  console.log('console errors:', logs.length ? logs.join(' | ') : 'none');

  await api('/json/close/' + target.id);
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
