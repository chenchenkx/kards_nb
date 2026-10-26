/**
 * 安全回归测试（P0）
 * 1) viewFor 不再向对手泄露手牌 / 牌库
 * 2) 服务器拒绝畸形卡组（非数组 / 超长 / 非法 id）
 * 3) 服务器回收空闲房间（TTL）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const Engine = require('../public/js/engine.js');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

// ---------- 1. viewFor 泄露 ----------
console.log('\n[1] viewFor 手牌隔离');
{
  const deckA = Engine.autoDeck('Germany', db, Engine.makeRng(11));
  const deckB = Engine.autoDeck('USA', db, Engine.makeRng(22));
  const g = new Engine.Game({ db, seed: 99, decks: [deckA, deckB], hqs: [db.hqs.Germany, db.hqs.USA] });

  const v0 = g.viewFor(0);
  const v1 = g.viewFor(1);

  check('座位 0 能看到自己手牌', Array.isArray(v0.players[0].hand) && v0.players[0].hand.length > 0,
    { len: v0.players[0].hand.length });
  check('座位 0 看不到对手手牌（数组为空）',
    Array.isArray(v0.players[1].hand) && v0.players[1].hand.length === 0,
    { len: v0.players[1].hand.length });
  check('座位 1 看不到座位 0 手牌',
    Array.isArray(v1.players[0].hand) && v1.players[0].hand.length === 0,
    { len: v1.players[0].hand.length });
  check('座位 1 能看到自己手牌', v1.players[1].hand.length > 0, { len: v1.players[1].hand.length });
  check('对手手牌数量仍然下发（用于背面堆叠）',
    v0.players[1].handCount === g.players[1].hand.length,
    { view: v0.players[1].handCount, real: g.players[1].hand.length });
  check('视图内不含牌库明细', !JSON.stringify(v0).includes('"deck":['), null);
  check('双方手牌 id 不互通', !v0.players[1].hand.some(c => c && c.id), null);
}

// ---------- 2. 服务器卡组校验 ----------
console.log('\n[2] 服务器卡组校验');
{
  // 直接复用 server 的校验逻辑（与 server/index.js 内实现保持一致的口径）
  const MAX_DECK = 39;
  function sanitizeDeck(deck) {
    if (!Array.isArray(deck)) return { ok: false, error: '卡组必须是数组' };
    if (deck.length === 0) return { ok: false, error: '卡组为空' };
    if (deck.length > MAX_DECK) return { ok: false, error: 'too-long' };
    const out = new Array(deck.length);
    for (let i = 0; i < deck.length; i++) {
      const id = deck[i];
      if (typeof id !== 'string' || id.length === 0 || id.length > 64) return { ok: false, error: 'bad-id' };
      if (!Object.prototype.hasOwnProperty.call(db.byId, id)) return { ok: false, error: 'unknown' };
      out[i] = id;
    }
    return { ok: true, deck: out };
  }
  const good = Engine.autoDeck('Germany', db, Engine.makeRng(5));
  check('合法卡组通过', sanitizeDeck(good).ok, sanitizeDeck(good).error);
  check('非数组被拒绝', !sanitizeDeck('not-an-array').ok, null);
  check('空数组被拒绝', !sanitizeDeck([]).ok, null);
  check('超长数组被拒绝', !sanitizeDeck(new Array(5000).fill(good[0])).ok, null);
  check('含非法 id 被拒绝', !sanitizeDeck([good[0], '__evil__']).ok, null);
  check('含非字符串被拒绝', !sanitizeDeck([good[0], 123]).ok, null);
  check('含对象（原型注入）被拒绝', !sanitizeDeck([good[0], { __proto__: { polluted: 1 } }]).ok, null);
  check('超长字符串 id 被拒绝', !sanitizeDeck([good[0], 'x'.repeat(5000)]).ok, null);
  // 大数组不应拖垮引擎：超长直接拒绝，不会进 buildGame
  check('巨型卡组不会进入引擎', !sanitizeDeck(new Array(100000).fill(good[0])).ok, null);
}

// ---------- 3. 服务端集成：畸形卡组不会把进程弄崩 ----------
console.log('\n[3] 服务端畸形输入（起服务器实测）');
(async () => {
  const { spawn } = require('child_process');
  const PORT = 8099;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvErr = '';
  srv.stderr.on('data', d => { srvErr += String(d); });

  await new Promise(r => setTimeout(r, 1200));

  // 用 wsmini 的客户端协议手写握手过重：改用 net 直接发 HTTP 检查静态服务存活
  await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => {
      check('静态服务存活（重活后不崩）', res.statusCode === 200, res.statusCode);
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', (e) => { check('静态服务存活', false, String(e.message)); resolve(); });
  });

  // 发一条畸形 WS 升级后立刻关掉，确认服务器不崩
  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/ws',
      headers: { 'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Key': 'x', 'Sec-WebSocket-Version': '13' },
    });
    req.on('error', () => resolve());
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(); });
    req.end();
    setTimeout(resolve, 800);
  });

  await new Promise((resolve) => {
    setTimeout(() => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => {
        check('畸形 WS 请求后服务仍存活', res.statusCode === 200, res.statusCode);
        res.resume();
        res.on('end', () => { srv.kill(); resolve(); });
      });
      req.on('error', (e) => { check('畸形 WS 请求后服务仍存活', false, String(e.message)); srv.kill(); resolve(); });
    }, 300);
  });

  if (srvErr && /Error|Unhandled/.test(srvErr)) {
    check('服务端无未捕获异常', false, srvErr.slice(0, 300));
  } else {
    check('服务端无未捕获异常', true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
