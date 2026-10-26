/* 解析层覆盖审计：找出完全解析不出子句 / 子句无 op 的卡（真正"技能没用"的） */
const fs = require('fs');
const Engine = require('../public/js/engine.js');

const cards = JSON.parse(fs.readFileSync(__dirname + '/../data/cards.json', 'utf8'));
const hqs = JSON.parse(fs.readFileSync(__dirname + '/../data/hqs.json', 'utf8'));
const db = Engine.buildDb(cards, hqs);

const withText = db.cards.filter(c => (c.text || '').trim());
const units = withText.filter(c => ['infantry', 'tank', 'artillery', 'fighter', 'bomber'].includes(c.type));
const orders = withText.filter(c => c.type === 'order');

function audit(list, label) {
  const none = [];
  const emptyOps = [];
  for (const c of list) {
    const cls = Engine.parseClauses(c.text);
    // 文本级机制（手牌监听 / 伤害转移）不走子句解析，单独计为已实现
    if (!cls.length && /if in your hand,.*each time|is dealt to this unit instead/i.test(c.text)) continue;
    if (!cls.length) { none.push(c); continue; }
    if (!cls.some(cl => cl.ops && cl.ops.length)) emptyOps.push(c);
  }
  const pat = {};
  for (const c of none) {
    const t = c.text.toLowerCase();
    let k = 'other';
    if (/^deployment:\s*becomes veteran/.test(t)) k = '部署变老兵';
    else if (/gain an? (extra )?kredit/.test(t)) k = '加指挥点槽';
    else if (/^deployment:\s*forecast/.test(t)) k = '预见';
    else if (/retreat/.test(t)) k = '撤退';
    else if (/cost \d+ (less|more)|costs? \d+ (less|more)/.test(t)) k = '费用修正';
    else if (/can't be|immune|cannot be/.test(t)) k = '免疫/限制';
    else if (/deal \d+ damage/.test(t)) k = '伤害';
    else if (/draw|add .* to your hand/.test(t)) k = '抽牌/入手';
    pat[k] = (pat[k] || 0) + 1;
  }
  console.log(`\n=== ${label}: 共 ${list.length} 张，解析不出子句 ${none.length}（${(none.length / list.length * 100).toFixed(1)}%），子句无 op ${emptyOps.length}`);
  console.log('类型分布:', JSON.stringify(pat));
  return { none, emptyOps };
}

const u = audit(units, '单位');
const o = audit(orders, '指令');

console.log('\n单位未解析样例:');
for (const c of u.none.slice(0, 12)) console.log(' -', c.name, ':', c.text.slice(0, 78));
console.log('\n指令未解析样例:');
for (const c of o.none.slice(0, 8)) console.log(' -', c.name, ':', c.text.slice(0, 78));

fs.writeFileSync(__dirname + '/../.work/unparsed.json',
  JSON.stringify({ units: u.none.map(c => [c.name, c.text]), orders: o.none.map(c => [c.name, c.text]) }, null, 1));
