/* 给 data/cards.json 的 order 卡补 subtype 字段（Blast/Plan/Production）。
 * KARDS 官方子类型：
 *   - Blast：造成直接伤害的指令
 *   - Production：获得 kredits/资源的指令
 *   - Plan：其他 utility
 *   - Countermeasure：反制——数据里已是独立 type 'gotcha'，不处理
 * 无权威标签，按卡牌文本启发式分类（Production 特征更独占，先判）。
 * 用法：node tools/add_order_subtypes.js  （幂等，可重复运行） */
const fs = require('fs'), path = require('path');
const FILE = path.join(__dirname, '..', 'data', 'cards.json');
const cards = JSON.parse(fs.readFileSync(FILE, 'utf8'));

let n = { blast: 0, production: 0, plan: 0, skipped: 0 };
const samples = { blast: [], production: [] };
for (const c of cards) {
  if (c.type !== 'order') continue;
  const s = String(c.text || '').toLowerCase();
  const isProd = /\bgain (?:\d+ |an |one )?(?:additional |extra )?kredits?\b/.test(s)
    && !/\bkredit slots?\b/.test(s);   // "gain N kredit slots" 是加永久槽位，非 Production
  const isBlast = /\bdeals? \d+ damage\b|\bdeal \d+ damage\b|\bdeals? double damage\b|\bdistribute \d+ damage\b|\bdeals? \d+ damage to (?:the )?enemy hq\b/.test(s);
  let sub;
  if (isProd) { sub = 'production'; n.production++; if (samples.production.length < 3) samples.production.push(c.name); }
  else if (isBlast) { sub = 'blast'; n.blast++; if (samples.blast.length < 3) samples.blast.push(c.name); }
  else { sub = 'plan'; n.plan++; }
  c.subtype = sub;
}
fs.writeFileSync(FILE, JSON.stringify(cards));
console.log(`order 子类型完成：blast=${n.blast} production=${n.production} plan=${n.plan}`);
console.log('production 样例:', samples.production.join(' | '));
console.log('blast 样例:', samples.blast.join(' | '));
