/* v17 复验：条件/触发关键字 + 轰炸机攻击 + HUDSON 击杀触发，避开内联 -e 瞬时读文件问题。 */
const fs = require('fs');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(__dirname + '/../data/cards.json', 'utf8'));
const hqs = JSON.parse(fs.readFileSync(__dirname + '/../data/hqs.json', 'utf8'));
const db = Engine.buildDb(cards, hqs);
const mk = (id, o, g) => new Engine.CardInst(db.byId[id], o, g);
const slug = n => Object.keys(db.byId).find(k => db.byId[k].name === n);
let fail = 0;
const check = (n, c) => { console.log((c ? '  PASS ' : '  FAIL ') + n); if (!c) fail++; };

// --- 1) VOLKSGRENADIER 条件 guard ---
{
  const vg = slug('1097. VOLKSGRENADIER');
  const blitz = Object.keys(db.byId).find(k => db.byId[k].nation === 'Soviet' && db.byId[k].type !== 'order' && (db.byId[k].keywords || []).includes('blitz'));
  const g = new Engine.Game({ db, seed: 1, decks: [[vg], []], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  const e = mk(blitz, 1, g); e.loc = 'front'; g.frontline.push(e);
  g.players[0].hand = [mk(vg, 0, g)]; g.players[0].kredits = 99;
  g.playCard(0, 0, {});
  const v = g.unitsOf(0).find(u => /VOLKS/i.test(u.name));
  check('VG+敌方Blitz → 得 guard', v && v.has('guard'));
  const g2 = new Engine.Game({ db, seed: 2, decks: [[vg], []], hqs: [db.hqs.Germany, db.hqs.Soviet] });
  g2.players[0].hand = [mk(vg, 0, g2)]; g2.players[0].kredits = 99;
  g2.playCard(0, 0, {});
  const v2 = g2.unitsOf(0).find(u => /VOLKS/i.test(u.name));
  check('VG无敌方Blitz → 无 guard', v2 && !v2.has('guard'));
}
// --- 2) SPITFIRE 条件 fury ---
{
  const sp = slug('SPITFIRE Mk IIa');
  const g = new Engine.Game({ db, seed: 3, decks: [[sp], []], hqs: [db.hqs.Britain, db.hqs.Soviet] });
  g.players[0].hand = [mk(sp, 0, g)]; g.players[0].kredits = 99;
  g.playCard(0, 0, {});
  const s = g.unitsOf(0).find(u => /SPITFIRE/i.test(u.name));
  check('SPITFIRE+无敌方空军 → fury(attacksLeft=2)', s && s.attacksLeft === 2);
}
// --- 3) 轰炸机可攻击地面单位 ---
{
  const hud = slug('HUDSON Mk III');
  const g = new Engine.Game({ db, seed: 6, decks: [[hud], []], hqs: [db.hqs.Britain, db.hqs.Soviet] });
  const w = mk('card_unit_128th_rifles', 1, g); w.loc = 'front'; g.frontline.push(w);
  g.players[0].hand = [mk(hud, 0, g)]; g.players[0].kredits = 99;
  g.playCard(0, 0, {});
  const h = g.unitsOf(0).find(u => /HUDSON/i.test(u.name));
  const tgts = g.attackTargets(h);
  check('HUDSON 对地面单位有攻击目标', tgts.includes(w.uid));
  const r = g.attack(0, h.uid, w.uid);
  check('HUDSON 击杀地面单位成功', r.ok && g.unitsOf(1).length === 0);
  const h2 = g.unitsOf(0).find(u => /HUDSON/i.test(u.name));
  check('HUDSON 击杀后获得 fury(attacksLeft=2)', h2 && h2.has('fury') && h2.attacksLeft === 2);
}
console.log('\n_v17 复验: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail ? 1 : 0);
