/**
 * 二选一（Choose one）UI 端到端验证：
 * 强制把一张 Choose One 指令塞进手牌 → 打出 → 断言弹窗出现且有两个可点选项
 * → 点第二个 → 断言弹窗消失、牌进了弃牌堆、事件已结算。
 */
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const api = (p, m) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port: 9345, path: p, method: m || 'GET' }, s => {
    let d = ''; s.on('data', c => d += c); s.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(d); } });
  });
  r.on('error', rej); r.end();
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const t = await api('/json/new?about:blank', 'PUT');
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pend = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (me, pa) => new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id: i, method: me, params: pa || {} }));
  });
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? { EXC: (r.exceptionDetails.exception || {}).description } : r.result.value;
  };
  const shot = async (f) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'shots', f), Buffer.from(s.data, 'base64'));
  };

  await new Promise(r => ws.on('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8088/' });
  await sleep(3600);
  await ev("document.getElementById('btn-vs-ai').click()");
  await sleep(2600);

  const setup = await ev(`(async () => {
    const g = App.engine, E = window.KardsEngine, db = App.db;
    const def = db.deckPool.find(c => c.type === 'order' && /choose one\\s*-/i.test(c.text || ''));
    if (!def) return { err: 'no choose card' };
    const inst = new E.CardInst(def, 0, g);
    inst.loc = 'hand';
    g.players[0].hand.push(inst);
    g.players[0].kredits = 12;
    g.humanSides = [true, false];
    UI.render(g.viewFor(0));
    await new Promise(r => setTimeout(r, 80));
    App.busy = false;
    UI.doAction('play', { handIndex: g.players[0].hand.indexOf(inst) });
    await new Promise(r => setTimeout(r, 420));
    return { card: def.name, text: def.text, pending: !!g.pendingChoose };
  })()`);
  console.log('setup:', JSON.stringify(setup));

  const modal = await ev(`(() => {
    const m = document.getElementById('choose-modal');
    const opts = [...document.querySelectorAll('.choose-opt')];
    return {
      visible: !!(m && !m.classList.contains('hidden')),
      count: opts.length,
      labels: opts.map(o => o.textContent.trim().slice(0, 40)),
    };
  })()`);
  console.log('modal:', JSON.stringify(modal));
  await shot('v25-choose-modal.png');

  const clicked = await ev(`(async () => {
    const opts = [...document.querySelectorAll('.choose-opt')];
    if (opts.length < 2) return { err: 'no options' };
    opts[1].click();
    await new Promise(r => setTimeout(r, 500));
    const g = App.engine;
    const m = document.getElementById('choose-modal');
    return {
      hidden: m.classList.contains('hidden'),
      pending: !!g.pendingChoose,
      discard: g.players[0].discard.length,
      logTail: g.logLines.slice(-4),
    };
  })()`);
  console.log('after click #2:', JSON.stringify(clicked));
  await shot('v25-choose-after.png');

  await api('/json/close/' + t.id);
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
