/* 动画关键帧截图：出牌中段/落地、攻击命中、胜利金爆 */
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const CDP = 9345;
const PAGE = process.argv[2] || 'http://127.0.0.1:8088/';
const OUTDIR = process.argv[3] || 'shots';

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
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'Runtime.exceptionThrown') errors.push(String((msg.params.exceptionDetails.exception || {}).description || '').slice(0, 300));
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
    fs.writeFileSync(`${OUTDIR}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('SAVED', name);
  };

  await new Promise(r => ws.on('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: PAGE });
  await sleep(3500);
  await ev("document.getElementById('btn-vs-ai').click()");
  await sleep(2500);

  // 到第 2 回合
  await ev(`(async () => {
    UI.doAction('endTurn');
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 500));
      const st = UI.state;
      if (st && st.current === st.you && st.turn >= 2 && !App.busy) break;
    }
    return true;
  })()`);

  // A：部署起手 + 120ms（空中/压扁瞬间）
  await ev(`(() => {
    const st = UI.state;
    App.engine.players[st.you].kredits = 12;
    const idx = st.players[st.you].hand.findIndex(v => v && v.type !== 'order' && v.type !== 'gotcha');
    window.__playIdx = idx;
    UI.doAction('play', { handIndex: idx, toFront: true });
    return idx;
  })()`);
  await sleep(110);
  await shot('v12-deploy-a');
  await sleep(520);
  await shot('v12-deploy-b');

  // B：攻击命中（等到第 3 回合用刚部署的单位）
  const atk = await ev(`(async () => {
    await new Promise(r => setTimeout(r, 900));
    UI.doAction('endTurn');
    for (let i = 0; i < 26; i++) {
      await new Promise(r => setTimeout(r, 500));
      const st = UI.state;
      if (st && st.current === st.you && st.turn >= 3 && !App.busy) break;
    }
    const st = UI.state, g = App.engine;
    let uid = null, tgt = null;
    for (const c of st.frontline) {
      if (c.owner !== st.you) continue;
      const inst = g.find(c.uid);
      if (!inst || !g.canAttack(inst)) continue;
      const ts = g.attackTargets(inst) || [];
      const u = ts.find(t => t !== 0);
      if (u != null) { uid = c.uid; tgt = u; break; }
    }
    if (uid == null) return { skipped: true };
    App.engine.players[st.you].kredits = 12;
    UI.doAction('attack', { uid, target: tgt });
    return { uid, tgt };
  })()`);
  console.log('ATTACK', JSON.stringify(atk));
  if (atk && !atk.skipped) {
    await sleep(250);
    await shot('v12-impact-a');
    await sleep(420);
    await shot('v12-impact-b');
  }

  // C：胜利金爆
  await ev("UI.fxVictory(); SFX.play('victory');");
  await sleep(130);
  await shot('v12-victory');

  console.log('ERRORS', errors.length ? errors : 'none');
  await api('/json/close/' + target.id);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
