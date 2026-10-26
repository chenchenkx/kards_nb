/* 通过 CDP 驱动 Edge headless：截图 + 运行页面脚本 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PORT = 9345;
const URL_PAGE = process.argv[2] || 'http://localhost:8080/';
const OUT = process.argv[3] || 'shot.png';
const FLOW = process.argv[4] || '';      // 可选：ai = 进入人机对战
const EVAL = process.argv[5] || '';      // 可选：页面内执行的表达式（JSON 化输出）
const W = +(process.env.SHOT_W || 1600);
const H = +(process.env.SHOT_H || 900);

function api(pathname, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: method || 'GET' }, (res) => {
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
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result));
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await new Promise(r => ws.on('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_PAGE });
  await sleep(3500);

  if (FLOW === 'ai') {
    await send('Runtime.evaluate', { expression: "document.getElementById('btn-vs-ai').click()" });
    await sleep(2500);
  }

  let evalResult = null;
  if (EVAL) {
    const r = await send('Runtime.evaluate', { expression: EVAL, returnByValue: true, awaitPromise: true });
    evalResult = r.result && r.result.value;
    if (r.exceptionDetails) evalResult = 'EXCEPTION: ' + JSON.stringify(r.exceptionDetails).slice(0, 500);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('SAVED ' + OUT + ' (' + fs.statSync(OUT).size + ' bytes)');
  if (evalResult != null) console.log('EVAL ' + JSON.stringify(evalResult, null, 1));
  await api('/json/close/' + target.id);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
