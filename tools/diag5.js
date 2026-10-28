const path = require('path');
const ROOT = path.join(__dirname, '..');
const Engine = require(path.join(ROOT, 'public/js/engine.js'));
const fs = require('fs');
const cards = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);
const ids = ['card_unit_royal_sussex_regiment','card_unit_5e_cuirassier','card_unit_182_landwehr_vet','card_unit_fw_190_ta_152_vet','card_unit_the_123s'];
for (const id of ids) {
  const c = db.cards.find(x => x.id === id);
  console.log('\n==== '+id+' :: '+c.text);
  let cl;
  try { cl = Engine.parseClauses(c.text); } catch(e){ console.log('ERR', e.message); continue; }
  console.log(JSON.stringify(cl, (k,v)=> typeof v==='function'?undefined:v, 1));
}
