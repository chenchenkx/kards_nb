const fs = require('fs');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(__dirname + '/../data/cards.json', 'utf8'));
const hqs = JSON.parse(fs.readFileSync(__dirname + '/../data/hqs.json', 'utf8'));
const db = Engine.buildDb(cards, hqs);
const mk = (id, o, g) => new Engine.CardInst(db.byId[id], o, g);
const slug = n => Object.keys(db.byId).find(k => db.byId[k].name === n);

// 场景A：轰炸机打地面单位
{
  const hud = slug('HUDSON Mk III');
  const g = new Engine.Game({ db, seed: 6, decks: [[hud], []], hqs: [db.hqs.Britain, db.hqs.Soviet] });
  const w = mk('card_unit_128th_rifles', 1, g); w.loc = 'front'; g.frontline.push(w);
  g.players[0].hand = [mk(hud, 0, g)]; g.players[0].kredits = 99;
  g.playCard(0, 0, {});
  const h = g.unitsOf(0).find(u => /HUDSON/i.test(u.name));
  console.log('HUDSON opCost=', h.opCost, 'effOpCost=', h.effOpCost, 'kredits=', g.players[0].kredits, 'attacksLeft=', h.attacksLeft, 'canAttack=', g.canAttack(h));
  const r = g.attack(0, h.uid, w.uid);
  console.log('打地面单位 ->', JSON.stringify(r), '敌方剩余=', g.unitsOf(1).length);
}
// 场景B：轰炸机打 HQ
{
  const hud = slug('HUDSON Mk III');
  const g = new Engine.Game({ db, seed: 7, decks: [[hud], []], hqs: [db.hqs.Britain, db.hqs.Soviet] });
  g.players[0].hand = [mk(hud, 0, g)]; g.players[0].kredits = 99;
  g.playCard(0, 0, {});
  const h = g.unitsOf(0).find(u => /HUDSON/i.test(u.name));
  const r = g.attack(0, h.uid, 0);
  console.log('打HQ ->', JSON.stringify(r), '敌方HQ=', g.players[1].hqDef);
}
// 场景C：战斗机打地面单位（对照）
{
  const f = Object.keys(db.byId).find(k => db.byId[k].nation === 'Britain' && db.byId[k].type === 'fighter' && db.byId[k].cost <= 3);
  const g = new Engine.Game({ db, seed: 8, decks: [[f], []], hqs: [db.hqs.Britain, db.hqs.Soviet] });
  const w = mk('card_unit_128th_rifles', 1, g); w.loc = 'front'; g.frontline.push(w);
  g.players[0].hand = [mk(f, 0, g)]; g.players[0].kredits = 99;
  g.playCard(0, 0, {});
  const h = g.unitsOf(0).find(u => u.type === 'fighter');
  const r = g.attack(0, h.uid, w.uid);
  console.log('战斗机(' + db.byId[f].name + ')打地面 ->', JSON.stringify(r), '敌方剩余=', g.unitsOf(1).length);
}
