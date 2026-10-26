/* 验证结束回合按钮可点击 + 前线居中 */
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

  await new Promise(r => ws.on('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 951, height: 476, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(3200);
  await ev("document.getElementById('btn-vs-ai').click()");
  await sleep(2000);

  const geo = await ev(`(() => {
    const b = document.getElementById('btn-end-turn').getBoundingClientRect();
    const cx = b.left + b.width/2, cy = b.top + b.height/2;
    const under = document.elementFromPoint(cx, cy);
    const d = document.getElementById('fl-dashes').getBoundingClientRect();
    const row = document.getElementById('row-frontline').getBoundingClientRect();
    return { cx, cy, under: under ? (under.id || under.className) : null, isBtn: under === document.getElementById('btn-end-turn'),
      dashCenter: Math.round(d.top + d.height/2), rowCenter: Math.round(row.top + row.height/2), screenMid: Math.round(476/2) };
  })()`);
  console.log('geometry', JSON.stringify(geo));

  await click(geo.cx, geo.cy);
  await sleep(900);
  const s1 = await ev(`(() => ({ turn: window.App.engine.turn, current: window.App.engine.current, busy: window.App.busy, log: window.App.engine.logLines.slice(-3) }))()`);
  console.log('after click', JSON.stringify(s1));

  await sleep(3200);
  const s2 = await ev(`(() => ({ turn: window.App.engine.turn, current: window.App.engine.current, hand: window.App.engine.players[0].hand.length }))()`);
  console.log('after ai', JSON.stringify(s2));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('shots/31-endturn.png', Buffer.from(shot.data, 'base64'));
  console.log('errors', errs.length ? errs.join(' | ') : 'none');
  await api('/json/close/' + target.id);
  ws.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
