/* 动画端到端验证：进对局 → 到第 2 回合 → 出牌 → 采样 transform / 事件回放探针 */
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const CDP = 9345;
const PAGE = process.argv[2] || 'http://127.0.0.1:8088/';
const OUT = process.argv[3] || 'shots/animtest.png';

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
    else if (msg.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result));
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { EXC: (r.exceptionDetails.exception || {}).description || JSON.stringify(r.exceptionDetails).slice(0, 300) };
    return r.result && r.result.value;
  };

  await new Promise(r => ws.on('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: PAGE });
  await sleep(3500);
  await ev("document.getElementById('btn-vs-ai').click()");
  await sleep(2500);

  // 等到自己的第 2 回合
  const turnOk = await ev(`(async () => {
    UI.doAction('endTurn');
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 500));
      const st = UI.state;
      if (st && st.current === st.you && st.turn >= 2 && !App.busy) break;
    }
    const st = UI.state;
    return { turn: st.turn, cur: st.current, busy: App.busy };
  })()`);
  console.log('TURN', JSON.stringify(turnOk));

  // 打探针：记录 SFX 调用与 gsap timeline 数量，然后出牌
  const play = await ev(`(async () => {
    window.__probe = { sfx: [], tl: 0, steps: [] };
    const origPlay = SFX.play.bind(SFX);
    SFX.play = (n) => { window.__probe.sfx.push(n); return origPlay(n); };
    const origTL = gsap.timeline.bind(gsap);
    gsap.timeline = (...a) => { window.__probe.tl++; return origTL(...a); };
    const st = UI.state;
    App.engine.players[st.you].kredits = 12;   // 测试专用：解除费用限制
    const afford = st.players[st.you].hand.findIndex(v =>
      v && v.type !== 'order' && v.type !== 'gotcha');
    if (afford < 0) return { skipped: 'no affordable unit', hand: st.players[st.you].hand.map(v => v && [v.type, v.cost]) };
    const events0 = App.engine.drainEvents();
    UI.doAction('play', { handIndex: afford, toFront: true });
    const samples = [];
    for (let t = 0; t < 10; t++) {
      await new Promise(r => setTimeout(r, 110));
      const el = document.querySelector('#row-frontline .card, #line-own .slot .card');
      samples.push(el ? {
        uid: el.dataset.uid,
        conn: el.isConnected,
        parent: el.parentElement ? (el.parentElement.id || el.parentElement.className) : 'none',
        inline: (el.style.transform || 'NONE').slice(0, 55),
        opacity: el.style.opacity,
        disp: getComputedStyle(el).display,
      } : 'null');
    }
    SFX.play = origPlay; gsap.timeline = origTL;
    return { afford, probe: window.__probe, samples };
  })()`);
  console.log('PLAY', JSON.stringify(play, null, 1));

  // 攻击动画验证：部署单位 → 过回合 → 第 3 回合攻击
  const atk = await ev(`(async () => {
    const st0 = UI.state;
    // 第 2 回合再部署一个单位，然后过回合
    App.engine.players[st0.you].kredits = 12;
    const idx2 = st0.players[st0.you].hand.findIndex(v => v && v.type !== 'order' && v.type !== 'gotcha');
    if (idx2 >= 0) { UI.doAction('play', { handIndex: idx2, toFront: true }); await new Promise(r => setTimeout(r, 1500)); }
    UI.doAction('endTurn');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      const st = UI.state;
      if (st && st.current === st.you && st.turn >= 3 && !App.busy) break;
    }
    const st = UI.state;
    if (!st || st.done) return { skipped: 'game state' };
    const g = App.engine;
    if (!g || !g.find) return { skipped: 'net mode' };
    let atkUid = null, tgt = null;
    for (const c of st.frontline) {
      if (c.owner !== st.you) continue;
      const inst = g.find(c.uid);
      if (!inst || !g.canAttack(inst)) continue;
      const ts = g.attackTargets(inst) || [];
      if (ts.length) { atkUid = c.uid; tgt = ts[0]; break; }
    }
    if (atkUid == null) return { skipped: 'no attacker', turn: st.turn };
    window.__probe2 = { sfx: [] };
    const origPlay = SFX.play.bind(SFX);
    SFX.play = (n) => { window.__probe2.sfx.push(n); return origPlay(n); };
    UI.doAction('attack', { uid: atkUid, target: tgt });
    const samples = [];
    for (let t = 0; t < 12; t++) {
      await new Promise(r => setTimeout(r, 110));
      const el = document.querySelector('.card[data-uid="' + atkUid + '"]');
      const df = typeof tgt === 'number' && tgt > 0 ? document.querySelector('.card[data-uid="' + tgt + '"]') : null;
      samples.push('atk:' + (el ? (el.style.transform || 'NONE').slice(0, 55) : 'gone') + (df ? ' | def:' + (df.style.transform || 'NONE').slice(0, 55) : ''));
    }
    SFX.play = origPlay;
    return { atkUid, tgt, probe2: window.__probe2, samples };
  })()`);
  console.log('ATK', JSON.stringify(atk, null, 1));
  console.log('PAGE_ERRORS', errors.length ? errors : 'none');

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('SAVED ' + OUT);
  await api('/json/close/' + target.id);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
