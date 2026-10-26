/**
 * 精简 data/cards.json / hqs.json —— 去掉客户端与服务端都不再使用的字段。
 *
 * 背景：cards.json 2.2MB，其中 flavor（风味文本，约 1.14MB）、artist、setName、
 * 各类 is* 布尔标记共占一半以上体积；v15 之后悬停详情已不再显示风味文本，
 * 这些字段在 public/js 与 server/ 里 0 引用。首屏 JSON.parse 的一半开销纯粹浪费。
 *
 * 保留字段（经 grep 确认有引用）：
 *   id name type nation rarity set cost opCost attack defense range
 *   text keywords heavyArmor image spawn
 *
 * 用法：node tools/slim_data.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const KEEP_CARD = [
  'id', 'name', 'type', 'nation', 'rarity', 'set',
  'cost', 'opCost', 'attack', 'defense', 'range',
  'text', 'keywords', 'heavyArmor', 'image', 'spawn',
];
// hqs 额外保留 playable / isDefault（buildDb 用它挑每个国家的默认总部）
const KEEP_HQ = [
  'id', 'name', 'type', 'nation', 'rarity', 'set',
  'cost', 'opCost', 'attack', 'defense', 'text', 'keywords', 'image',
  'playable', 'isDefault', 'campaign',
];

const dry = process.argv.includes('--dry');
const root = path.join(__dirname, '..', 'data');

function slim(file, keep) {
  const full = path.join(root, file);
  const raw = fs.readFileSync(full, 'utf8');
  const list = JSON.parse(raw);
  const arr = Array.isArray(list) ? list : (list.cards || Object.values(list));
  if (!Array.isArray(arr)) throw new Error(file + ' 结构异常');

  // 只保留确实存在的字段，避免给没有该字段的卡塞 null
  const out = arr.map(c => {
    const o = {};
    for (const k of keep) if (Object.prototype.hasOwnProperty.call(c, k)) o[k] = c[k];
    return o;
  });
  const before = Buffer.byteLength(raw, 'utf8');
  const next = JSON.stringify(out);
  const after = Buffer.byteLength(next, 'utf8');
  console.log(`${file}: ${arr.length} 条  ${(before / 1048576).toFixed(2)}MB → ${(after / 1048576).toFixed(2)}MB` +
    `  省 ${((1 - after / before) * 100).toFixed(0)}%`);
  if (!dry) fs.writeFileSync(full, next, 'utf8');
  return { before, after };
}

const a = slim('cards.json', KEEP_CARD);
let b = { before: 0, after: 0 };
try { b = slim('hqs.json', KEEP_HQ); } catch (e) { console.log('hqs.json 跳过:', e.message); }
console.log(`合计 ${((a.before + b.before) / 1048576).toFixed(2)}MB → ${((a.after + b.after) / 1048576).toFixed(2)}MB`);
if (dry) console.log('（--dry 试运行，未写盘）');
