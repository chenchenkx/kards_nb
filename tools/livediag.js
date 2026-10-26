/* 对线上站点做完整联机诊断 */
const fs = require('fs');
const Engine = require('../public/js/engine.js');
const { WebSocket } = require('ws');

const URL = process.env.KARDS_URL || 'wss://kards.bonto.run';
const cards = JSON.parse(fs.readFileSync(__dirname + '/../data/cards.json', 'utf8'));
const hqs = JSON.parse(fs.readFileSync(__dirname + '/../data/hqs.json', 'utf8'));
const db = Engine.buildDb(cards, hqs);

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name, nation) {
  const c = { name, msgs: [], view: null, seat: -1, started: false, errors: [] };
  const ws = new WebSocket(URL);
  c.ws = ws;
  ws.on('open', () => log(name, '已连接'));
  ws.on('error', e => { c.errors.push(String(e.message || e)); log(name, 'WS错误:', e.message || '(空)'); });
  ws.on('close', (code, r) => log(name, 'WS关闭', code, String(r || '')));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    c.msgs.push(m.t);
    if (m.t === 'room') { c.seat = m.seat; c.code = m.code; log(name, '进房', m.code, '座位', m.seat); }
    if (m.t === 'start') { c.started = true; log(name, '对局开始 seat', m.you); }
    if (m.t === 'state') { c.view = m.view; }
    if (m.t === 'error') { c.errors.push(m.error); log(name, '服务端错误:', m.error); }
    if (m.t === 'opponentLeft') log(name, '对手离开');
    if (m.t === 'gameover') log(name, '对局结束 winner', m.winner);
  });
  return c;
}

(async () => {
  const nationA = 'Germany', nationB = 'Soviet';
  const deckA = Engine.autoDeck(nationA, db, Engine.makeRng(11));
  const deckB = Engine.autoDeck(nationB, db, Engine.makeRng(12));

  const A = client('A(host)', nationA);
  await new Promise(r => A.ws.on('open', r));

  A.ws.send(JSON.stringify({ t: 'create', deck: deckA, hq: db.hqs[nationA], nation: nationA }));
  // 等房间码
  for (let i = 0; i < 80 && !A.code; i++) await sleep(200);
  const roomMsg = !!A.code;
  log('A 是否拿到房间/座位:', roomMsg, '座位', A.seat);
  if (!roomMsg) { log('建房失败，消息序列:', A.msgs.join(',')); process.exit(1); }

  const B = client('B(guest)', nationB);
  await new Promise(r => B.ws.on('open', r));
  B.ws.send(JSON.stringify({ t: 'join', code: A.code, deck: deckB, hq: db.hqs[nationB], nation: nationB }));

  // 等对局开始
  for (let i = 0; i < 50 && !(A.started && B.started); i++) await sleep(200);
  log('双方是否开始:', A.started, B.started);
  log('A 消息:', A.msgs.join(','));
  log('B 消息:', B.msgs.join(','));
  if (A.errors.length || B.errors.length) log('错误:', A.errors, B.errors);

  if (A.started && B.started) {
    // 试一手真实操作：A 出第一张能出的牌
    const v = A.view;
    const me = v.you;
    const p = v.players[me];
    log('A 视角 手牌', p.hand.length, '指挥点', p.kredits, '回合', v.turn, '当前', v.current);
    const idx = p.hand.findIndex(c => (c.cost || 0) <= p.kredits);
    if (idx >= 0) {
      const before = A.msgs.length;
      A.ws.send(JSON.stringify({ t: 'action', a: { type: 'play', handIndex: idx } }));
      await sleep(1500);
      log('出牌后新增消息:', A.msgs.slice(before).join(',') || '(无)');
      log('出牌后 A 手牌数:', A.view.players[A.view.you].hand.length, '日志尾部:',
        (A.view.log || []).slice(-3).join(' | '));
    } else {
      log('没有可出的牌');
    }
  }
  A.ws.close(); B.ws.close();
  await sleep(300);
  process.exit(0);
})();
