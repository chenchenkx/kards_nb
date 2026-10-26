/* ============================================================
 * KARDS Web - LAN multiplayer client (WebSocket)
 * ============================================================ */
(function () {
  'use strict';

  const Net = {
    ws: null,
    connected: false,
    roomCode: null,
    seat: -1,
    handlers: {},
  };

  Net.on = function (type, fn) { Net.handlers[type] = fn; };

  Net.connect = function () {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}`;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) { reject(e); return; }
      Net.ws = ws;
      const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('timeout')); }, 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        Net.connected = true;
        resolve();
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
      ws.onclose = () => {
        Net.connected = false;
        if (Net.handlers.close) Net.handlers.close();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        const h = Net.handlers[msg.t];
        if (h) h(msg);
      };
    });
  };

  Net.send = function (obj) {
    if (Net.ws && Net.ws.readyState === 1) Net.ws.send(JSON.stringify(obj));
  };

  Net.createRoom = function (deck, hq, nation, ally) {
    Net.send({ t: 'create', deck, hq, nation, ally: ally || null });
  };
  Net.joinRoom = function (code, deck, hq, nation, ally) {
    Net.send({ t: 'join', code, deck, hq, nation, ally: ally || null });
  };
  Net.setDeck = function (deck, hq, nation) {
    Net.send({ t: 'setDeck', deck, hq, nation });
  };
  Net.action = function (type, payload) {
    Net.send({ t: 'action', a: Object.assign({ type }, payload) });
  };
  Net.rematch = function () { Net.send({ t: 'rematch' }); };
  Net.leave = function () {
    if (Net.ws) { try { Net.ws.close(); } catch (e) {} }
    Net.connected = false;
    Net.roomCode = null;
  };

  window.Net = Net;
})();
