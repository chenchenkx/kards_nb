/* 验证：部署到前线时按落点插入 + 行内自动居中 */
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
    else if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails.exception || {}).slice(0, 200));
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
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const drag = async (from, to) => {
    await mouse('mousePressed', from.x, from.y);
    await sleep(70);
    for (let i = 1; i <= 6; i++) {
      await mouse('mouseMoved', from.x + (to.x - from.x) * i / 6, from.y + (to.y - from.y) * i / 6);
      await sleep(45);
    }
    await mouse('mouseReleased', to.x, to.y);
  };
  const shot = async n => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('shots/' + n + '.png', Buffer.from(r.data, 'base64'));
    console.log('shot ' + n);
  };
  const dump = async () => ev(`(() => {
    const row = document.getElementById('row-frontline');
    const rr = row.getBoundingClientRect();
    const cards = [...row.querySelectorAll('.card')].map(c => { const r = c.getBoundingClientRect(); return Math.round(r.left + r.width/2); });
    return { rowMid: Math.round(rr.left + rr.width/2), cardMids: cards,
             slots: window.UI.state.frontline.map(v => v.slot) };
  })()`);

  await new Promise(r => ws.on('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 951, height: 476, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(3200);
  await ev("document.getElementById('btn-vs-ai').click()");
  await sleep(2000);
  await ev(`(() => { const g = App.engine; g.players[0].kredits = 12; UI.state.players[0].kredits = 12; UI.render(UI.state, {noFlip:true}); })()`);
  await sleep(300);

  const handCard = async (i) => ev(`(() => { const el = document.querySelectorAll('#own-hand .card')[${i}]; const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  const pickUnit = async () => ev(`(() => { const h = App.engine.players[0].hand;
     return h.findIndex(c => ['infantry','tank','artillery'].includes(c.type)); })()`);

  // 1) 拖到正中
  let hi = await pickUnit();
  let from = await handCard(hi);
  await drag(from, { x: 475, y: 240 });
  await sleep(900);
  console.log('deploy#1 →', JSON.stringify(await dump()));

  // 2) 再拖一张到右侧
  hi = await pickUnit();
  from = await handCard(hi);
  await drag(from, { x: 600, y: 240 });
  await sleep(900);
  console.log('deploy#2 (右侧) →', JSON.stringify(await dump()));
  await shot('40-frontline-center');

  // 3) 第三张拖到最左
  hi = await pickUnit();
  from = await handCard(hi);
  await drag(from, { x: 320, y: 240 });
  await sleep(900);
  console.log('deploy#3 (左侧) →', JSON.stringify(await dump()));
  await shot('41-frontline-three');

  console.log('errors', errs.length ? errs.join(' | ') : 'none');
  await api('/json/close/' + target.id);
  ws.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
