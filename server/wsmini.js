/**
 * wsmini —— 零依赖 WebSocket 服务端（RFC 6455 最小实现）
 *
 * 为什么自己写：部署平台（Bonto/Render 等）的依赖安装经常出问题
 * （例如 yarn 在 Node 18 上解析 jsdom 的 engines 失败，导致整次安装中断、
 *  ws 装不上、联机直接不可用）。这里只用 Node 内置模块实现服务端所需的
 * 握手 + 帧编解码，让服务端**零依赖**启动，装不装包都不影响联机。
 *
 * 支持的子集（足够本项目使用）：
 *  - 握手（Sec-WebSocket-Accept）
 *  - 文本帧收发、分片接收、close/ping/pong
 *  - 服务端主动心跳，避免代理层把空闲连接断开
 *
 * 用法与 ws 保持一致：
 *   const { WebSocketServer } = require('./wsmini');
 *   const wss = new WebSocketServer({ server });
 *   wss.on('connection', ws => { ws.on('message', ...); ws.send('x'); });
 */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MAX_PAYLOAD = 4 * 1024 * 1024; // 4MB 上限，防止异常帧吃内存

const STATE_OPEN = 1;
const STATE_CLOSING = 2;
const STATE_CLOSED = 3;

/** 生成一个服务端 → 客户端的数据帧（服务端发出的帧不加掩码） */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

class MiniSocket extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.readyState = STATE_OPEN;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragOpcode = 0;
    this._alive = true;
    this.remoteAddress = (req && req.socket && req.socket.remoteAddress) || '';

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._finish(err));
    socket.on('close', () => this._finish());
    socket.on('end', () => this._finish());
  }

  // ---------------- 接收 ----------------
  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try {
      this._parse();
    } catch (err) {
      this._finish(err);
    }
  }

  _parse() {
    for (;;) {
      const buf = this._buf;
      if (buf.length < 2) return;

      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset);
        if (big > BigInt(MAX_PAYLOAD)) { this.close(1009, 'too large'); return; }
        len = Number(big);
        offset += 8;
      }

      if (len > MAX_PAYLOAD) { this.close(1009, 'too large'); return; }

      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buf.length < offset + len) return;

      let payload = Buffer.from(buf.subarray(offset, offset + len));
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      this._buf = buf.subarray(offset + len);
      this._handleFrame(fin, opcode, payload);
      if (this.readyState !== STATE_OPEN) return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_TEXT:
      case OP_BINARY:
        if (!fin) {
          this._fragOpcode = opcode;
          this._fragments = [payload];
          return;
        }
        this._emitMessage(opcode, payload);
        return;

      case OP_CONT:
        if (!this._fragments.length) return;
        this._fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this._fragments);
          const op = this._fragOpcode;
          this._fragments = [];
          this._fragOpcode = 0;
          this._emitMessage(op, whole);
        }
        return;

      case OP_PING:
        this._write(encodeFrame(OP_PONG, payload));
        return;

      case OP_PONG:
        this._alive = true;
        return;

      case OP_CLOSE:
        this.readyState = STATE_CLOSING;
        try { this._write(encodeFrame(OP_CLOSE, payload.subarray(0, 2))); } catch (e) { /* ignore */ }
        this._finish();
        return;

      default:
        return;
    }
  }

  _emitMessage(opcode, payload) {
    // 本项目只发文本，二进制也转成字符串交给上层
    this.emit('message', payload.toString('utf8'));
  }

  // ---------------- 发送 ----------------
  _write(buf) {
    if (this.readyState === STATE_CLOSED) return false;
    try {
      return this.socket.write(buf);
    } catch (e) {
      this._finish(e);
      return false;
    }
  }

  send(data) {
    if (this.readyState !== STATE_OPEN) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return this._write(encodeFrame(OP_TEXT, payload));
  }

  ping() {
    if (this.readyState !== STATE_OPEN) return;
    this._write(encodeFrame(OP_PING, Buffer.alloc(0)));
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== STATE_OPEN) return;
    this.readyState = STATE_CLOSING;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._write(encodeFrame(OP_CLOSE, body));
    setTimeout(() => this._finish(), 80);
  }

  terminate() {
    this._finish();
  }

  _finish(err) {
    if (this.readyState === STATE_CLOSED) return;
    this.readyState = STATE_CLOSED;
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
    if (err) this.emit('error', err);
    this.emit('close');
  }
}

class WebSocketServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.clients = new Set();
    this.options = options;

    if (options.server) this.attach(options.server);

    // 心跳：定期 ping，避免中间代理把空闲连接掐断（长对局很重要）
    const interval = options.heartbeat || 25000;
    if (interval > 0) {
      this._timer = setInterval(() => {
        for (const ws of this.clients) {
          if (ws.readyState !== STATE_OPEN) continue;
          if (!ws._alive) { ws.terminate(); continue; }
          ws._alive = false;
          ws.ping();
        }
      }, interval);
      if (this._timer.unref) this._timer.unref();
    }
  }

  attach(server) {
    this._onUpgrade = (req, socket, head) => this._handleUpgrade(req, socket, head);
    server.on('upgrade', this._onUpgrade);
    this.server = server;
    return this;
  }

  _handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (!key || upgrade !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    socket.write(headers.join('\r\n') + '\r\n\r\n');

    const ws = new MiniSocket(socket, req);
    this.clients.add(ws);
    if (head && head.length) ws._onData(head);

    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));

    this.emit('connection', ws, req);
  }

  close(cb) {
    if (this._timer) clearInterval(this._timer);
    if (this._onUpgrade && this.server) this.server.removeListener('upgrade', this._onUpgrade);
    for (const ws of this.clients) ws.close(1001, 'server shutdown');
    this.clients.clear();
    if (cb) setTimeout(cb, 100);
  }
}

module.exports = { WebSocketServer, MiniSocket, STATE_OPEN };
