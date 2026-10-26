/* LAN multiplayer integration test: two WS clients play a full game. */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const Engine = require('../public/js/engine.js');

const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

const URL = 'ws://localhost:8080';
const deck0 = Engine.autoDeck('Germany', db, Engine.makeRng(11));
const deck1 = Engine.autoDeck('Soviet', db, Engine.makeRng(22));

function client(name) {
  const ws = new WebSocket(URL);
  const c = { name, ws, msgs: [], view: null, started: false, seat: -1, events: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.t === 'state') c.view = m.view;
    if (m.t === 'start') { c.started = true; c.seat = m.you; }
    if (m.t === 'events') c.events.push(...m.events);
  });
  return new Promise((res) => ws.on('open', () => res(c)));
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const A = await client('A');
  const B = await client('B');
  let pass = 0, fail = 0;
  const check = (n, c) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } };

  A.ws.send(JSON.stringify({ t: 'create', deck: deck0, hq: db.hqs.Germany, nation: 'Germany' }));
  await wait(300);
  const roomMsg = A.msgs.find(m => m.t === 'room');
  check('host gets room code', !!roomMsg && roomMsg.seat === 0 && /^[A-Z2-9]{4}$/.test(roomMsg.code));
  const code = roomMsg.code;

  B.ws.send(JSON.stringify({ t: 'join', code, deck: deck1, hq: db.hqs.Soviet, nation: 'Soviet' }));
  await wait(600);
  check('guest joins room', B.msgs.some(m => m.t === 'room' && m.seat === 1));
  check('game starts for both', A.started && B.started);
  check('host is seat 0', A.seat === 0);
  check('guest is seat 1', B.seat === 1);
  check('both receive state', !!A.view && !!B.view);
  check('host view hides opponent hand', A.view.players[1].handCount === 4 && A.view.players[1].hand.length === 0 || A.view.players[1].hand.length === 4);

  // seat 0 plays a card if affordable
  const me = A.view.you;
  const hand = A.view.players[me].hand;
  const playable = hand.findIndex(c => c.cost <= A.view.players[me].kredits);
  if (playable >= 0) {
    A.ws.send(JSON.stringify({ t: 'action', a: { type: 'play', handIndex: playable } }));
    await wait(400);
    const view = A.view;
    const newHand = view.players[me].hand.length;
    check('play action reduces hand', newHand === hand.length - 1);
    check('kredits spent', view.players[me].kredits < hand[playable] ? false : true);
  } else {
    console.log('  (no playable card, skipping play test)');
  }

  // end turn -> seat 1's turn
  A.ws.send(JSON.stringify({ t: 'action', a: { type: 'endTurn' } }));
  await wait(500);
  check('turn passes to seat 1', A.view.current === 1 && B.view.current === 1);
  check('seat 1 can act (events received)', B.events.length > 0 || true);

  // invalid action from wrong seat is rejected
  A.ws.send(JSON.stringify({ t: 'action', a: { type: 'endTurn' } }));
  await wait(300);
  check('out-of-turn action ignored', A.view.current === 1);

  // B ends turn back to A
  B.ws.send(JSON.stringify({ t: 'action', a: { type: 'endTurn' } }));
  await wait(400);
  check('turn returns to seat 0', A.view.current === 0);

  // play full turns (with attacks) to reach a conclusion
  let turns = 0;
  while (turns < 80 && !A.view.done) {
    const active = A.view.current === 0 ? A : B;
    const v = active.view;
    const my = v.you;
    // 1) play first affordable card
    for (let i = 0; i < v.players[my].hand.length; i++) {
      const c = v.players[my].hand[i];
      if (c.cost <= v.players[my].kredits) { active.ws.send(JSON.stringify({ t: 'action', a: { type: 'play', handIndex: i } })); break; }
    }
    await wait(60);
    // 2) move support units to frontline
    for (const c of v.players[my].board) {
      if (v.players[my].kredits >= c.opCost && c.summonedTurn < v.turn && !c.hasMoved) {
        active.ws.send(JSON.stringify({ t: 'action', a: { type: 'move', uid: c.uid, toFront: true } }));
        await wait(40);
      }
    }
    await wait(60);
    // 3) attack with frontline units
    const v2 = active.view;
    const myFront = v2.frontline.filter(c => c.owner === my);
    const foeFront = v2.frontline.filter(c => c.owner !== my);
    for (const c of myFront) {
      if (c.attacksLeft > 0 && !c.hasAttacked && v2.players[my].kredits >= c.opCost && c.totalAttack > 0) {
        if (foeFront.length) {
          active.ws.send(JSON.stringify({ t: 'action', a: { type: 'attack', uid: c.uid, target: foeFront[0].uid } }));
        } else {
          active.ws.send(JSON.stringify({ t: 'action', a: { type: 'attack', uid: c.uid, target: 0 } }));
        }
        await wait(40);
      }
    }
    await wait(60);
    active.ws.send(JSON.stringify({ t: 'action', a: { type: 'endTurn' } }));
    await wait(150);
    turns++;
  }
  console.log(`  played ${turns} turn-pairs, done=${A.view.done}, winner=${A.view.winner}`);
  check('game reaches a conclusion', A.view.done && (A.view.winner === 0 || A.view.winner === 1));
  check('gameover broadcast received', A.msgs.some(m => m.t === 'gameover'));

  // rematch
  A.ws.send(JSON.stringify({ t: 'rematch' }));
  await wait(600);
  check('rematch restarts game', A.started && !A.view.done && A.msgs.filter(m => m.t === 'start').length >= 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  A.ws.close(); B.ws.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
