/* 审计：parseOps 产出的 op 是否都有 execOp 实现（防静默丢弃） */
const fs = require('fs');
const s = fs.readFileSync(__dirname + '/../public/js/engine.js', 'utf8');

const P = [...new Set([...s.matchAll(/op:\s*'([a-zA-Z]+)'/g)].map(m => m[1]))];
// execOp 的 switch 段
const start = s.indexOf('execOp(op, src, ctx)');
const end = s.indexOf('returnCard(c, toDeck)');
const body = s.slice(start, end);
const C = [...new Set([...body.matchAll(/case'([a-zA-Z]+)':|case '([a-zA-Z]+)':/g)].map(m => m[1] || m[2]))];

const missing = P.filter(x => !C.includes(x));
console.log('parseOps 产出 op (' + P.length + '):', P.join(', '));
console.log('\nexecOp 实现 (' + C.length + '):', C.join(', '));
console.log('\n==> parseOps 产出但 execOp 未处理:', missing.length ? missing.join(', ') : '（无）');
console.log('==> execOp 有但解析器不产:', C.filter(x => !P.includes(x)).join(', ') || '（无）');
process.exit(missing.length ? 1 : 0);
