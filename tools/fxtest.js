/* 特效确定性验证：触发各特效并统计 fx 元素 */
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const CDP = 9345;
function api(pathname, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CDP, path: pathname, method: method || 'GET' }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on('error', reject);
    req.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const target = await api('/json/new?about:blank', 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map(); const errors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'Runtime.exceptionThrown') errors.push(String((msg.params.exceptionDetails.exception || {}).description || '').slice(0, 240));
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result));
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { EXC: (r.exceptionDetails.exception || {}).description || 'exc' };
    return r.result && r.result.value;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`shots/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('SAVED', name);
  };

  await new Promise(r => ws.on('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8088/' });
  await sleep(3500);
  await ev("document.getElementById('btn-vs-ai').click()");
  await sleep(2500);

  const counts = await ev(`(async () => {
    const card = document.querySelector('#row-frontline .card, #line-own .slot .card, #own-hq-slot .hq-card');
    const r = card.getBoundingClientRect();
    const t = document.getElementById('table').getBoundingClientRect();
    const sc = (Math.min(window.innerWidth/1280, window.innerHeight/720) || 1);
    const c = { x: (r.left - t.left + r.width/2) / sc, y: (r.top - t.top + r.height/2) / sc };
    UI.fxBurst(c, {});
    const immediately = {
      flame: document.querySelectorAll('.flame').length,
      core: document.querySelectorAll('.blast-core').length,
      ember: document.querySelectorAll('.ember').length,
    };
    await new Promise(r2 => setTimeout(r2, 120));
    return { immediately, c, flameAt120: document.querySelectorAll('.flame').length };
  })()`);
  console.log('BURST', JSON.stringify(counts));
  await shot('v12-burst-120ms');

  await sleep(500);
  const late = await ev(`({
    flameAt620: document.querySelectorAll('.flame').length,
    darkSmoke: document.querySelectorAll('.smoke-dark').length,
  })`);
  console.log('BURST_LATE', JSON.stringify(late));
  await shot('v12-burst-620ms');

  const puffs = await ev(`(async () => {
    const el = document.querySelector('.card') || document.querySelector('.hq-card');
    if (!el) return { skipped: 'no card' };
    const r = el.getBoundingClientRect();
    const t = document.getElementById('table').getBoundingClientRect();
    const sc = (Math.min(window.innerWidth/1280, window.innerHeight/720) || 1);
    const c = { x: (r.left - t.left + r.width/2)/sc, y: (r.top - t.top + r.height/2)/sc };
    UI.fxPuffs(c, {});
    UI.fxScorch(c);
    await new Promise(r2 => setTimeout(r2, 100));
    return { puff: document.querySelectorAll('.puff').length, scorch: document.querySelectorAll('.scorch').length };
  })()`);
  console.log('PUFFS', JSON.stringify(puffs));
  await shot('v12-puffs');

  const vic = await ev(`(async () => {
    UI.fxVictory();
    await new Promise(r => setTimeout(r, 110));
    return { burst: document.querySelectorAll('.victory-burst').length };
  })()`);
  console.log('VICTORY', JSON.stringify(vic));
  await shot('v12-victory2');

  // 受损卡面焦黑检查
  const dmg = await ev(`(() => {
    const imgs = [...document.querySelectorAll('.card .card-img')].map(i => i.style.filter).filter(Boolean);
    return { filtered: imgs.length, sample: imgs.slice(0, 3) };
  })()`);
  console.log('DAMAGED_ART', JSON.stringify(dmg));
  console.log('ERRORS', errors.length ? errors : 'none');
  await api('/json/close/' + target.id);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
