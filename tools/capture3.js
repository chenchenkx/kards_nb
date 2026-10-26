/* 自动对打到中期，截取有单位的战场 */
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const PORT = +(process.env.CDP_PORT || 9345);
const OUTDIR = 'shots';
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
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails.exception || {}).slice(0, 160));
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

  await new Promise(r => ws.on('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(3200);
  await ev("document.getElementById('btn-vs-ai').click()");
  await sleep(1800);

  for (let turn = 0; turn < 3; turn++) {
    const st = await ev(`(() => {
      const g = window.App.engine;
      if (g.current !== 0 || g.done) return 'wait';
      const p = g.players[0];
      p.kredits = Math.max(p.kredits, 6);
      window.UI.state.players[0].kredits = p.kredits;
      // 出牌：单位优先放前线
      let guard = 0;
      while (guard++ < 6) {
        const idx = p.hand.findIndex(c => c.cost <= p.kredits && ['infantry','tank','artillery','fighter','bomber'].includes(c.type));
        if (idx < 0) break;
        const r = g.playCard(0, idx, { toFront: true });
        if (!r.ok) break;
        window.UI.render(g.viewFor(0), { noFlip: true });
      }
      // 手牌里能用但出不去的指令也用掉
      window.UI.render(g.viewFor(0), { noFlip: true });
      return 'played';
    })()`);
    await sleep(400);
    // 攻击
    await ev(`(() => {
      const g = window.App.engine;
      if (g.current !== 0) return 'no';
      for (const u of [...g.unitsOf(0)]) {
        if (!g.canAttack(u)) continue;
        const ts = g.attackTargets(u);
        if (!ts.length) continue;
        g.attack(0, u.uid, ts.includes(0) ? 0 : ts[0]);
      }
      window.UI.render(g.viewFor(0), { noFlip: true });
    })()`);
    await sleep(300);
    await ev("document.getElementById('btn-end-turn').click()");
    await sleep(2400);
  }
  await sleep(600);
  await shot('20-midgame');
  const st = await ev(`(() => { const g = window.App.engine;
    return { turn: g.turn, board: [g.players[0].board.length, g.players[1].board.length],
             front: g.frontline.map(c => (c.owner === 0 ? 'P1' : 'P2') + ':' + c.name),
             hq: [g.players[0].hqDef, g.players[1].hqDef] }; })()`);
  console.log(JSON.stringify(st));
  console.log('errors', logs.length ? logs.join(' | ') : 'none');
  await api('/json/close/' + target.id);
  ws.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
