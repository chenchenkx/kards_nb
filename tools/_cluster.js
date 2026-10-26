/* 未实现卡片的句式聚类，找优先实现模式 */
const fs = require('fs');
const d = JSON.parse(fs.readFileSync(__dirname + '/../.work/unparsed.json', 'utf8'));

const norm = (s) => s.toLowerCase().replace(/\d+/g, 'N');

function bucket(list) {
  const m = {};
  for (const [name, text] of list) {
    const t = (text || '').replace(/^Deployment:\s*/i, '').trim();
    const head = t.split(/[.,;:]/)[0].toLowerCase().slice(0, 46);
    const k = norm(head).replace(/[^a-z0-9 ]/g, '');
    if (!m[k]) m[k] = [];
    m[k].push(name);
  }
  return Object.entries(m).sort((a, b) => b[1].length - a[1].length);
}

console.log('=== 单位 top 句式 ===');
for (const [k, v] of bucket(d.units).slice(0, 18)) console.log(String(v.length).padStart(3), '|', k, '| e.g.', v[0]);
console.log('\n=== 指令 top 句式 ===');
for (const [k, v] of bucket(d.orders).slice(0, 14)) console.log(String(v.length).padStart(3), '|', k, '| e.g.', v[0]);
