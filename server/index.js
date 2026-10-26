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
const { WebSocketServer } = require('ws');
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
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404); res.end('Not Found'); return;
    }
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

function sendView(room) {
  if (!room.game) return;
  for (const p of room.players) {
    if (!p || p.ws.readyState !== 1) continue;
    p.ws.send(JSON.stringify({ t: 'state', view: room.game.viewFor(p.seat) }));
  }
}

function startGame(room) {
  const seed = Math.floor(Math.random() * 2147483647);
  room.game = new Engine.Game({
    db, seed,
    decks: [room.players[0].deck, room.players[1].deck],
    hqs: [room.players[0].hq, room.players[1].hq],
  });
  room.started = true;
  for (const p of room.players) {
    p.ws.send(JSON.stringify({ t: 'start', you: p.seat, seed }));
  }
  sendView(room);
}

function handleAction(room, player, msg) {
  const g = room.game;
  if (!g || !room.started) return;
  const seat = player.seat;
  let res = { ok: false };
  const a = msg.a || {};
  try {
    switch (a.type) {
      case 'play':
        res = g.playCard(seat, a.handIndex, { target: a.target });
        break;
      case 'move':
        res = g.move(seat, a.uid, a.toFront);
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
  const conn = { ws, room: null, seat: -1, deck: null, hq: null, nation: null };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    try {
      switch (msg.t) {
        case 'create': {
          // leave old room
          if (conn.room) leaveRoom(conn);
          const code = genCode();
          const room = { code, players: [conn, null], game: null, started: false };
          rooms.set(code, room);
          conn.room = room; conn.seat = 0;
          conn.deck = msg.deck || null;
          conn.hq = msg.hq || null;
          conn.nation = msg.nation || null;
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
          room.players[1] = conn;
          conn.room = room; conn.seat = 1;
          conn.deck = msg.deck || null;
          conn.hq = msg.hq || null;
          conn.nation = msg.nation || null;
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
          conn.deck = msg.deck; conn.hq = msg.hq; conn.nation = msg.nation;
          if (conn.room && conn.room.players[0] && conn.room.players[1] && !conn.room.started) {
            if (conn.room.players[0].deck && conn.room.players[1].deck) startGame(conn.room);
          }
          break;
        }
        case 'action': {
          if (conn.room) handleAction(conn.room, conn, msg);
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
