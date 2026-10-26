/* 战斗动画验证：部署 → 结束回合 → 下一回合攻击总部（捕捉冲刺/火花/伤害数字） */
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const PORT = +(process.env.CDP_PORT || 9345);
const OUTDIR = process.env.OUTDIR || 'shots';
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
  let id = 0; const pending = new Map(); const logs = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails.exception || {}).slice(0, 200));
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
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUTDIR + '/' + name + '.png', Buffer.from(r.data, 'base64'));
    console.log('shot ' + name);
  };
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const dragTo = async (from, to, midwayShot) => {
    await mouse('mousePressed', from.x, from.y);
    await sleep(80);
    for (let i = 1; i <= 8; i++) {
      await mouse('mouseMoved', from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8);
      await sleep(45);
    }
    if (midwayShot) await shot(midwayShot);
    await mouse('mouseReleased', to.x, to.y);
  };

  await new Promise(r => ws.on('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(3000);
  await ev("document.getElementById('btn-vs-ai').click()");
  await sleep(2000);

  // 给足指挥点
  await ev(`(() => { const g = window.App.engine; g.players[0].kredits = 12; g.players[0].slots = 12;
      window.UI.state.players[0].kredits = 12; window.UI.render(window.UI.state, {noFlip:true}); })()`);
  await sleep(300);

  // 部署一个单位到前线中间
  let info = await ev(`(() => {
    const st = window.UI.state, hand = st.players[0].hand;
    let i = hand.findIndex(c => ['infantry','tank','artillery'].includes(c.type));
    if (i < 0) i = 0;
    const el = document.querySelectorAll('#own-hand .card')[i];
    const a = el.getBoundingClientRect();
    const s = document.querySelectorAll('#row-frontline .slot')[2].getBoundingClientRect();
    return { name: hand[i].name, fx: a.left + a.width/2, fy: a.top + a.height/2, tx: s.left + s.width/2, ty: s.top + s.height/2 };
  })()`);
  console.log('deploy', JSON.stringify(info));
  await dragTo({ x: info.fx, y: info.fy }, { x: info.tx, y: info.ty }, '10-drag-highlight');
  await sleep(1200);
  await shot('11-deployed');

  // 结束回合，让 AI 行动
  await ev("document.getElementById('btn-end-turn').click()");
  await sleep(2600);
  await shot('12-ai-played');

  // 回到自己回合：给足指挥点，攻击敌方总部
  await ev(`(() => { const g = window.App.engine; g.players[0].kredits = 12; g.players[0].slots = 12;
      window.UI.state.players[0].kredits = 12; window.UI.render(window.UI.state, {noFlip:true}); })()`);
  await sleep(400);
  info = await ev(`(() => {
    const g = window.App.engine;
    const u = g.frontline.find(c => c.owner === 0) || g.players[0].board[0];
    if (!u) return { none: true };
    const el = document.querySelector('.card[data-uid="' + u.uid + '"]');
    if (!el) return { none: true };
    const a = el.getBoundingClientRect();
    const hq = document.getElementById('opp-hq-slot').getBoundingClientRect();
    return { uid: u.uid, canAttack: g.canAttack(u), targets: g.attackTargets(u),
      fx: a.left + a.width/2, fy: a.top + a.height/2, tx: hq.left + hq.width/2, ty: hq.top + hq.height/2 };
  })()`);
  console.log('attack', JSON.stringify(info));

  if (!info.none && info.canAttack) {
    await dragTo({ x: info.fx, y: info.fy }, { x: info.tx, y: info.ty }, '13-attack-targeting');
    await sleep(170);
    await shot('14a-lunge');
    await sleep(180);
    await shot('14b-impact');
    await sleep(220);
    await shot('14c-number');
    await sleep(900);
    await shot('15-after-attack');
  }

  const st = await ev(`(() => { const g = window.App.engine;
    return { hq: [g.players[0].hqDef, g.players[1].hqDef], turn: g.turn, log: g.logLines.slice(-5) }; })()`);
  console.log('final', JSON.stringify(st));
  console.log('errors', logs.length ? logs.join(' | ') : 'none');
  await api('/json/close/' + target.id);
  ws.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
