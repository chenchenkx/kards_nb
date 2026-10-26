/* 验证：结束回合（含结算中排队） + 前线随归属平移 */
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const PORT = +(process.env.CDP_PORT || 9345);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function api(p, m) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m || 'GET' }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(d); } });
    });
    req.on('error', rej); req.end();
  });
}
(async () => {
  const target = await api('/json/new?about:blank', 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map(); const errs = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails.exception || {}).slice(0, 160));
  });
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, m => m.error ? rej(new Error(method + ' ' + JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 300) };
    return r.result.value;
  };
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(40);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const btnXY = async () => ev(`(() => { const r = document.getElementById('btn-end-turn').getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('shots/' + name + '.png', Buffer.from(r.data, 'base64'));
    console.log('shot ' + name);
  };

  await new Promise(r => ws.on('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 951, height: 476, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(3200);
  await ev("document.getElementById('btn-vs-ai').click()");
  await sleep(1800);

  // A. 立刻点结束回合
  let p = await btnXY();
  console.log('A: about to click', JSON.stringify(p));
  await click(p.x, p.y);
  await sleep(500);
  console.log('A after click', JSON.stringify(await ev(`({turn: App.engine.turn, current: App.engine.current, busy: App.busy})`)));
  await sleep(3500);

  // B. 结算中再点（决定回合一结束就点）
  console.log('B: state', JSON.stringify(await ev(`({turn: App.engine.turn, current: App.engine.current, busy: App.busy, txt: document.getElementById('btn-end-turn').textContent})`)));
  p = await btnXY();
  // 先出牌造成 busy，再点结束回合
  await ev(`(() => { const g = App.engine, p0 = g.players[0];
    p0.kredits = 8; UI.state.players[0].kredits = 8; UI.render(UI.state, {noFlip:true});
    const i = p0.hand.findIndex(c => ['infantry','tank','artillery'].includes(c.type) && c.cost <= 8);
    if (i >= 0) UI.doAction('play', { handIndex: i, toFront: true });
    return 'ok'; })()`);
  await sleep(60);
  await click(p.x, p.y);
  await sleep(300);
  console.log('B during settle', JSON.stringify(await ev(`({busy: App.busy, pending: App.pendingEndTurn, current: App.engine.current})`)));
  await sleep(4000);
  console.log('B settled', JSON.stringify(await ev(`({turn: App.engine.turn, current: App.engine.current, busy: App.busy, pending: App.pendingEndTurn})`)));

  // C. 前线归属 → 线偏移
  const fl = await ev(`(() => {
    const g = App.engine;
    const d = document.getElementById('fl-dashes').getBoundingClientRect();
    return { owner: g.frontlineOwner, dashTop: Math.round(d.top), mySide: App.engine.players[0] ? 0 : 0,
             baseY: window.UI.state.frontlineOwner };
  })()`);
  console.log('C frontline', JSON.stringify(fl));
  await shot('32-check');

  console.log('errors', errs.length ? errs.join(' | ') : 'none');
  await api('/json/close/' + target.id);
  ws.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
