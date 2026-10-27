/**
 * 指令牌施法特效端到端验证：
 * 进对局 → 强制把一张指令牌放进手牌 → 打出 → 在 220ms / 520ms 抓帧，
 * 断言 .cast-card / .cast-frame / .cast-halo / .cast-rays / .cast-pulse 的存在与几何。
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
  const shot = async (file) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'shots', file), Buffer.from(s.data, 'base64'));
  };

  await new Promise(r => ws.on('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8088/' });
  await sleep(3600);
  await ev("document.getElementById('btn-vs-ai').click()");
  await sleep(2600);

  // 找一张便宜的指令牌，直接塞进手牌并打出
  const setup = await ev(`(async () => {
    const g = App.engine;
    if (!g) return { err: 'no engine' };
    const db = App.db;
    const cand = db.deckPool.filter(c => c.type === 'order' && (c.cost || 0) <= 3 && /deal \\d+ damage/i.test(c.text || ''));
    if (!cand.length) return { err: 'no order card' };
    const def = cand[0];
    const E = window.KardsEngine;
    const inst = new E.CardInst(def, 0, g);
    inst.loc = 'hand';
    g.players[0].hand.push(inst);
    g.players[0].kredits = 12;
    // 放一个敌方单位当目标
    const foeDef = db.deckPool.find(c => c.type === 'infantry' && !c.text);
    const foe = new E.CardInst(foeDef, 1, g);
    foe.loc = 'board'; foe.summonedTurn = 0;
    g.players[1].board.push(foe);
    UI.render(g.viewFor(0));
    await new Promise(r => setTimeout(r, 60));
    const idx = g.players[0].hand.indexOf(inst);
    App.busy = false;
    UI.doAction('play', { handIndex: idx, target: foe.uid });
    return { card: def.name, text: def.text, uid: inst.uid };
  })()`);
  console.log('setup:', JSON.stringify(setup));

  await sleep(230);
  const mid = await ev(`(() => {
    const w = document.querySelector('.cast-card');
    const f = document.querySelector('.cast-card .cast-frame');
    const h = document.querySelector('.cast-halo');
    const r = document.querySelector('.cast-rays');
    const img = f && f.querySelector('img');
    const t = w ? getComputedStyle(w).transform : null;
    return {
      exists: !!w, frame: !!f, halo: !!h, rays: !!r,
      imgLoaded: !!(img && img.complete && img.naturalWidth > 0),
      transform: t ? String(t).slice(0, 60) : null,
      opacity: w ? getComputedStyle(w).opacity : null,
      size: f ? [Math.round(f.getBoundingClientRect().width), Math.round(f.getBoundingClientRect().height)] : null,
    };
  })()`);
  console.log('220ms:', JSON.stringify(mid));
  await shot('v25-cast-220ms.png');

  await sleep(320);
  const mid2 = await ev(`(() => {
    const w = document.querySelector('.cast-card');
    const p = document.querySelectorAll('.cast-pulse').length;
    const e = document.querySelectorAll('.cast-ember').length;
    return { exists: !!w, pulse: p, ember: e, opacity: w ? getComputedStyle(w).opacity : null };
  })()`);
  console.log('540ms:', JSON.stringify(mid2));
  await shot('v25-cast-540ms.png');

  await sleep(900);
  const after = await ev(`(() => ({
    leftover: document.querySelectorAll('.cast-card').length,
    pulse: document.querySelectorAll('.cast-pulse').length,
    ember: document.querySelectorAll('.cast-ember').length,
  }))()`);
  console.log('after 1.44s:', JSON.stringify(after));
  await shot('v25-cast-after.png');

  await api('/json/close/' + t.id);
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
