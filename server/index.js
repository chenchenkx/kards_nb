/**
 * KARDS Web Server
 * - Serves static files from public/ (the game client)
 * - WebSocket rooms for LAN multiplayer (authoritative game engine)
 * - Binds 0.0.0.0 so any device on the LAN can connect
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('./wsmini'); // 零依赖 WebSocket 服务端
const Engine = require('../public/js/engine.js');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ROOT = path.join(__dirname, '..', 'public');

// ---------------- data ----------------
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

// ---------------- static server ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

/**
 * 静态文件 stat 缓存：短时间内重复请求不再触发同步 syscall。
 * 命中后 5s 内直接复用；未命中（含 404）也缓存 2s，避免扫目录打爆磁盘。
 */
const statCache = new Map();      // filePath -> { at, st }
const STAT_TTL_HIT = 5000;
const STAT_TTL_MISS = 2000;
function statCached(filePath) {
  const now = Date.now();
  const hit = statCache.get(filePath);
  if (hit && now - hit.at < (hit.st ? STAT_TTL_HIT : STAT_TTL_MISS)) return hit.st;
  let st = null;
  try { st = fs.statSync(filePath); } catch (e) { st = null; }
  // 缓存过大时整体丢弃，防止长期运行内存膨胀
  if (statCache.size > 4000) statCache.clear();
  statCache.set(filePath, { at: now, st });
  return st;
}

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/api/laninfo') {
      const nets = os.networkInterfaces();
      const ips = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ port: PORT, ips }));
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    // asset routes: /cards/<file> serves card images.
    // 1) local bundle in public/assets/cards (thumbs + resources, always present)
    // 2) full image library in ../kards-img (full-size card faces)
    let filePath;
    if (urlPath.startsWith('/cards/')) {
      const rel = urlPath.slice('/cards/'.length);
      const local = path.join(ROOT, 'assets', 'cards', rel);
      const repoRoot = process.env.KARDS_IMG_DIR || path.join(__dirname, '..', 'kards-img');
      const external = path.join(repoRoot, rel);
      if (fs.existsSync(local) && fs.statSync(local).isFile()) filePath = local;
      else filePath = external;
    } else if (urlPath.startsWith('/data/')) {
      filePath = path.join(__dirname, '..', 'data', urlPath.slice('/data/'.length));
    } else {
      filePath = path.join(ROOT, urlPath);
    }
    // prevent path traversal
    const cardsLocalBase = path.join(ROOT, 'assets', 'cards');
    const cardsRepoBase = process.env.KARDS_IMG_DIR || path.join(__dirname, '..', 'kards-img');
    let base;
    if (urlPath.startsWith('/cards/')) {
      base = filePath.startsWith(cardsLocalBase) ? cardsLocalBase : cardsRepoBase;
    } else if (urlPath.startsWith('/data/')) base = path.join(__dirname, '..', 'data');
    else base = ROOT;
    if (!filePath.startsWith(base)) { res.writeHead(403); res.end('Forbidden'); return; }
    // stat 结果缓存（热路径不再每次同步 syscall）
    const st = statCached(filePath);
    if (!st || !st.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    // 代码/页面必须每次校验，图片可长缓存（避免改了 UI 但浏览器还跑旧文件）
    const noStore = ['.html', '.js', '.css', '.json'].includes(ext);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': noStore ? 'no-cache, no-store, must-revalidate' : 'public, max-age=604800',
      'pragma': noStore ? 'no-cache' : '',
      'expires': noStore ? '0' : '',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500); res.end('Server Error');
  }
});

// ---------------- 输入校验（防恶意客户端） ----------------
const MAX_DECK = 39;

/** 卡组校验：必须是数组、张数 1..39、每个元素都是已知卡牌 id */
function sanitizeDeck(deck) {
  if (!Array.isArray(deck)) return { ok: false, error: '卡组必须是数组' };
  if (deck.length === 0) return { ok: false, error: '卡组为空' };
  if (deck.length > MAX_DECK) return { ok: false, error: `卡组张数不能超过 ${MAX_DECK}` };
  const out = new Array(deck.length);
  for (let i = 0; i < deck.length; i++) {
    const id = deck[i];
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      return { ok: false, error: '卡牌 id 非法' };
    }
    if (!Object.prototype.hasOwnProperty.call(db.byId, id)) {
      return { ok: false, error: '未知卡牌 id: ' + id };
    }
    out[i] = id;
  }
  return { ok: true, deck: out };
}

/** 总部校验：必须是卡库里已知的总部；否则回落到该国家默认总部 */
function sanitizeHq(hq, nation) {
  if (hq && typeof hq === 'object' && typeof hq.id === 'string'
      && db.hqById && db.hqById[hq.id]) {
    return db.hqById[hq.id];
  }
  const fallback = (db.hqs && (db.hqs[nation] || Object.values(db.hqs)[0])) || null;
  return fallback;
}

function sanitizeNation(n) {
  if (typeof n !== 'string' || n.length > 24) return null;
  return db.hqs && db.hqs[n] ? n : null;
}

// ---------------- rooms ----------------
const rooms = new Map(); // code -> room
let nextSeatSeq = 1;

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p && p.ws.readyState === 1 && p !== except) p.ws.send(data);
  }
}

/**
 * 给某个座位算出「现在能做什么」，随 view 一起下发。
 * 客户端联机模式下没有本地引擎，界面全靠这份数据判断是否可点/可拖。
 */
function legalFor(g, seat) {
  const empty = { attacks: {}, moves: {}, canPlay: [], canEnd: false, active: false };
  if (!g || g.done || g.current !== seat) return empty;
  const p = g.players[seat];
  const attacks = {};
  const moves = {};
  try {
    for (const u of g.unitsOf(seat)) {
      try { if (g.canAttack(u)) attacks[u.uid] = g.attackTargets(u) || []; } catch (e) { /* ignore */ }
      let front = false, support = false;
      try { front = !!g.canMove(u, true); } catch (e) { /* ignore */ }
      try { support = !!g.canMove(u, false); } catch (e) { /* ignore */ }
      if (front || support) moves[u.uid] = { front, support };
    }
  } catch (e) { /* ignore */ }
  const canPlay = [];
  try {
    p.hand.forEach((c, i) => {
      const eff = Math.max(0, (c.cost || 0) + (c._costMod || 0));
      let room = true;
      try { room = g.hasRoomFor(c); } catch (e) { room = true; }
      if (eff <= p.kredits && room) canPlay.push(i);
    });
  } catch (e) { /* ignore */ }
  return { attacks, moves, canPlay, canEnd: true, active: true };
}

function sendView(room) {
  if (!room.game) return;
  for (const p of room.players) {
    if (!p || p.ws.readyState !== 1) continue;
    const view = room.game.viewFor(p.seat);
    view.legal = legalFor(room.game, p.seat);
    p.ws.send(JSON.stringify({ t: 'state', view }));
  }
}

function startGame(room) {
  const seed = Math.floor(Math.random() * 2147483647);
  // 卡组合法性（主国/副国/稀有度）——仅记录，开局仍按实际张数进行
  for (const p of room.players) {
    if (!p || !p.deck) continue;
    try {
      const v = Engine.validateDeck(p.deck, p.nation, p.ally, db);
      if (!v.ok) console.log(`[房间 ${room.code}] 座位 ${p.seat} 卡组非法:`, v.errors.slice(0, 3).join('; '));
    } catch (e) { /* ignore */ }
  }
  try {
    room.game = new Engine.Game({
      db, seed,
      decks: [room.players[0].deck, room.players[1].deck],
      hqs: [room.players[0].hq, room.players[1].hq],
    });
  } catch (e) {
    // 卡组/总部数据异常时不要让整个进程崩掉
    console.log(`[房间 ${room.code}] 开局失败:`, e && e.message);
    for (const p of room.players) {
      if (!p) continue;
      try { p.ws.send(JSON.stringify({ t: 'error', error: '开局失败（卡组数据异常），请重新选卡' })); } catch (err) { /* ignore */ }
    }
    room.started = false;
    room.game = null;
    return;
  }
  room.started = true;
  for (const p of room.players) {
    p.ws.send(JSON.stringify({ t: 'start', you: p.seat, seed }));
  }
  sendView(room);
}

function handleAction(room, player, msg) {
  room.lastActive = Date.now();
  const g = room.game;
  if (!g || !room.started) return;
  const seat = player.seat;
  let res = { ok: false };
  const a = msg.a || {};
  try {
    switch (a.type) {
      case 'play':
        res = g.playCard(seat, a.handIndex, { target: a.target, toFront: a.toFront, slot: a.slot });
        break;
      case 'move':
        res = g.move(seat, a.uid, a.toFront, a.slot);
        break;
      case 'attack':
        res = g.attack(seat, a.uid, a.target);
        break;
      case 'endTurn':
        if (g.current === seat && !g.done) { g.endTurn(); res = { ok: true }; }
        break;
      default: res = { ok: false, error: '未知操作' };
    }
  } catch (err) {
    res = { ok: false, error: String(err && err.message || err) };
  }
  const events = g.drainEvents();
  broadcast(room, { t: 'events', events }, null);
  if (events.some(e => e.e === 'end')) {
    broadcast(room, { t: 'gameover', winner: g.winner });
  }
  sendView(room);
  if (!res.ok && res.error) {
    player.ws.send(JSON.stringify({ t: 'error', error: res.error }));
  }
}

// ---------------- websocket ----------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const conn = { ws, room: null, seat: -1, deck: null, hq: null, nation: null, ally: null };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    try {
      switch (msg.t) {
        case 'create': {
          // leave old room
          if (conn.room) leaveRoom(conn);
          const code = genCode();
          const room = { code, players: [conn, null], game: null, started: false, lastActive: Date.now() };
          rooms.set(code, room);
          conn.room = room; conn.seat = 0;
          const cNat = sanitizeNation(msg.nation);
          const cDeck = msg.deck ? sanitizeDeck(msg.deck) : { ok: true, deck: null };
          if (msg.deck && !cDeck.ok) { ws.send(JSON.stringify({ t: 'error', error: '卡组非法：' + cDeck.error })); break; }
          conn.deck = cDeck.deck;
          conn.hq = sanitizeHq(msg.hq, cNat);
          conn.nation = cNat;
          conn.ally = sanitizeNation(msg.ally);
          ws.send(JSON.stringify({ t: 'room', code, seat: 0 }));
          break;
        }
        case 'join': {
          if (conn.room) leaveRoom(conn);
          const code = (msg.code || '').toUpperCase().trim();
          const room = rooms.get(code);
          if (!room) { ws.send(JSON.stringify({ t: 'error', error: '未找到房间：' + code })); break; }
          if (room.players[1]) { ws.send(JSON.stringify({ t: 'error', error: '房间已满' })); break; }
          if (room.started) { ws.send(JSON.stringify({ t: 'error', error: '对局已开始' })); break; }
          const jNat = sanitizeNation(msg.nation);
          const jDeck = msg.deck ? sanitizeDeck(msg.deck) : { ok: true, deck: null };
          if (msg.deck && !jDeck.ok) { ws.send(JSON.stringify({ t: 'error', error: '卡组非法：' + jDeck.error })); break; }
          room.players[1] = conn;
          conn.room = room; conn.seat = 1;
          conn.deck = jDeck.deck;
          conn.hq = sanitizeHq(msg.hq, jNat);
          conn.nation = jNat;
          conn.ally = sanitizeNation(msg.ally);
          ws.send(JSON.stringify({ t: 'room', code, seat: 1 }));
          broadcast(room, { t: 'opponentJoined', nation: conn.nation }, conn);
          // auto-start when both ready
          if (room.players[0] && room.players[1]) {
            if (room.players[0].deck && room.players[1].deck) startGame(room);
            else broadcast(room, { t: 'needDeck' });
          }
          break;
        }
        case 'setDeck': {
          const sNat = sanitizeNation(msg.nation);
          const sDeck = sanitizeDeck(msg.deck);
          if (!sDeck.ok) { ws.send(JSON.stringify({ t: 'error', error: '卡组非法：' + sDeck.error })); break; }
          conn.deck = sDeck.deck;
          conn.hq = sanitizeHq(msg.hq, sNat);
          conn.nation = sNat;
          if (conn.room && conn.room.players[0] && conn.room.players[1] && !conn.room.started) {
            if (conn.room.players[0].deck && conn.room.players[1].deck) startGame(conn.room);
          }
          break;
        }
        case 'action': {
          if (conn.room) { conn.room.lastActive = Date.now(); handleAction(conn.room, conn, msg); }
          break;
        }
        case 'rematch': {
          if (conn.room && conn.room.started && conn.room.game && conn.room.game.done) {
            const room = conn.room;
            room.game = null; room.started = false;
            if (room.players[0].deck && room.players[1].deck) startGame(room);
            else broadcast(room, { t: 'needDeck' });
          }
          break;
        }
        case 'ping': ws.send(JSON.stringify({ t: 'pong' })); break;
        default: break;
      }
    } catch (err) {
      try { ws.send(JSON.stringify({ t: 'error', error: String(err && err.message || err) })); } catch (e) { /* ignore */ }
    }
  });

  ws.on('close', () => leaveRoom(conn));
  ws.on('error', () => leaveRoom(conn));
});

function leaveRoom(conn) {
  const room = conn.room;
  if (!room) return;
  if (room.players[0] === conn) room.players[0] = null;
  if (room.players[1] === conn) room.players[1] = null;
  broadcast(room, { t: 'opponentLeft' });
  if (!room.players[0] && !room.players[1]) rooms.delete(room.code);
  conn.room = null;
}

// ---------------- 空闲房间回收 ----------------
const ROOM_TTL_MS = 10 * 60 * 1000;      // 无人在线且 10 分钟无活动 → 回收
const ROOM_IDLE_TTL_MS = 60 * 60 * 1000; // 有人在线但 1 小时无操作 → 回收
const roomGC = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const occupied = room.players.some(p => p && p.ws.readyState === 1);
    const idle = now - (room.lastActive || 0);
    if ((!occupied && idle > ROOM_TTL_MS) || idle > ROOM_IDLE_TTL_MS) {
      for (const p of room.players) {
        if (!p) continue;
        try { p.ws.send(JSON.stringify({ t: 'error', error: '房间已因长时间空闲关闭' })); } catch (e) { /* ignore */ }
        p.room = null;
      }
      rooms.delete(code);
    }
  }
}, 60 * 1000);
if (roomGC.unref) roomGC.unref();

// ---------------- start ----------------
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log('===========================================');
  console.log('  KARDS 网页版 - 二战卡牌游戏');
  console.log('===========================================');
  console.log(`  已加载卡牌：${cards.length} 张`);
  console.log('');
  console.log('  本机访问：http://localhost:' + PORT);
  for (const ip of ips) console.log(`  局域网访问：http://${ip}:${PORT}`);
  console.log('');
  console.log('  同一 WiFi/局域网内的其他设备打开局域网地址即可联机。');
  console.log('===========================================');
});
