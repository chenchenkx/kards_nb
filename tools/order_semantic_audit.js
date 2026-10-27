/* 指令牌语义审计：卡面文本 ⟷ 解析出的 ops 是否一致
 * 检查项：数字（伤害/抽牌/费用）、目标（敌方/友方/全体/随机）、动词（摧毁/压制/弃牌/关键词授予）
 * 输出 .work/order_semantic.md
 */
const fs = require('fs'), path = require('path');
const Engine = require('../public/js/engine.js');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));

function allOps(ops, acc) {
  acc = acc || [];
  for (const o of ops || []) {
    acc.push(o);
    if (o.op === 'choose') for (const opt of o.options || []) allOps(opt.ops, acc);
    if (o.op === 'grant' && o.ops) allOps(o.ops, acc);   // 授予的能力也算已实现
  }
  return acc;
}
const num = (s, re) => { const m = re.exec(s); return m ? +m[1] : null; };

const issues = {};
const add = (k, id, msg) => { (issues[k] = issues[k] || []).push([id, msg]); };

const ORDERS = cards.filter(c => c.type === 'order');

for (const c of ORDERS) {
  const text = (c.text || '').trim();
  if (!text) continue;
  const tl = text.toLowerCase();
  const clauses = Engine.parseClauses(text);
  const ops = allOps(clauses.reduce((a, cl) => a.concat(cl.ops || []), []));
  const opNames = new Set(ops.map(o => o.op));
  const id = c.id;

  // 1) 伤害数值
  const dmgNums = [...text.matchAll(/deal (\d+) damage/gi)].map(m => +m[1]);
  const dmgOps = ops.filter(o => o.op === 'damage');
  if (dmgNums.length && !dmgOps.length) add('文本有伤害但未解析', id, `${c.name}: ${text.slice(0, 80)}`);
  else if (dmgNums.length && dmgOps.length) {
    const opNums = dmgOps.map(o => o.n).filter(n => typeof n === 'number');
    if (opNums.length && !dmgNums.some(n => opNums.includes(n))) {
      add('伤害数值不符', id, `${c.name}: 文本 ${dmgNums.join('/')} → ops ${JSON.stringify(dmgOps.map(o => o.n))}`);
    }
  }

  // 2) 抽牌数量
  const drawNums = [...text.matchAll(/draw (\d+|a|an|two|three|four) cards?/gi)].map(m => {
    const v = m[1].toLowerCase();
    return v === 'a' || v === 'an' ? 1 : (v === 'two' ? 2 : v === 'three' ? 3 : v === 'four' ? 4 : +v);
  });
  const drawOps = ops.filter(o => o.op === 'draw' || o.op === 'drawPer');
  if (drawNums.length && !drawOps.length) add('文本有抽牌但未解析', id, `${c.name}: ${text.slice(0, 80)}`);
  else if (drawNums.length && drawOps.length) {
    const opNums = drawOps.map(o => o.n || 1);
    if (!drawNums.some(n => opNums.includes(n))) add('抽牌数量不符', id, `${c.name}: 文本 ${drawNums.join('/')} → ops ${JSON.stringify(opNums)}`);
  }

  // 3) 摧毁
  if (/\bdestroy\b/i.test(tl) && !opNames.has('destroy') && !opNames.has('damage')) {
    add('文本有摧毁但未解析', id, `${c.name}: ${text.slice(0, 80)}`);
  }

  // 4) 压制 / 钉住
  if (/\b(pin|suppress)\b/i.test(tl) && !opNames.has('pin')) add('文本有压制但未解析', id, `${c.name}: ${text.slice(0, 80)}`);

  // 5) 指挥点/槽
  const kredNums = [...text.matchAll(/(?:gain|get) (\d+) (?:extra )?kredits?(?: slots?)?/gi)].map(m => +m[1]);
  const kredOps = ops.filter(o => ['kredits', 'slots'].includes(o.op));
  if (kredNums.length && !kredOps.length) add('文本有指挥点但未解析', id, `${c.name}: ${text.slice(0, 80)}`);
  else if (kredNums.length && kredOps.length) {
    const opNums = kredOps.map(o => o.n);
    if (!kredNums.some(n => opNums.includes(n))) add('指挥点数量不符', id, `${c.name}: 文本 ${kredNums} → ops ${JSON.stringify(opNums)}`);
  }

  // 6) 关键词授予
  const giveKw = [...text.matchAll(/\b(?:give|gives|grant|gains?|gets?)\b[^.]*?\b(blitz|guard|fury|smokescreen|ambush|shock|mobilize|alpine|pincer|covert)\b/gi)]
    .filter(m => !/\bwith (guard|covert|alpine|smokescreen|ambush)\b/i.test(m[0]) && !/your alpine units|alpine unit\b/i.test(m[0]));
  if (giveKw.length && !opNames.has('keyword') && !opNames.has('teamAura') && !opNames.has('condKw')) {
    add('文本有关键词授予但未解析', id, `${c.name}: ${text.slice(0, 80)}`);
  }

  // 7) 敌方/友方目标方向
  const mentionsEnemy = /\benemy\b|\benemies\b/i.test(tl);
  const mentionsFriendly = /\byour units?\b|\bfriendly\b/i.test(tl);
  const targetsFriendlyOnly = ops.length && ops.every(o => /allFriendly|friendlyUnit|ownUnit|self/.test(String(o.target || '')));
  const targetsEnemyOnly = ops.length && ops.every(o => /allEnem|enemyUnit|enemyHQ|enemy/.test(String(o.target || '')));
  if (mentionsEnemy && !mentionsFriendly && targetsFriendlyOnly && !opNames.has('buff') === false) {
    add('目标方向可能相反', id, `${c.name}: 文本提敌方，ops 全指向友方 → ${JSON.stringify(ops.map(o => o.op + ':' + o.target))}`);
  }
  if (mentionsFriendly && !mentionsEnemy && targetsEnemyOnly) {
    add('目标方向可能相反', id, `${c.name}: 文本提友方，ops 全指向敌方 → ${JSON.stringify(ops.map(o => o.op + ':' + o.target))}`);
  }

  // 8) 解析为空 / 选择项为空
  if (!ops.length) add('解析为空', id, `${c.name}: ${text.slice(0, 90)}`);
  for (const o of ops) {
    if (o.op === 'choose' && (!o.options || o.options.some(x => !x.ops || !x.ops.length))) {
      add('二选一有空分支', id, `${c.name}: ${JSON.stringify(o).slice(0, 120)}`);
    }
  }
}

const order = ['解析为空', '二选一有空分支', '文本有伤害但未解析', '伤害数值不符', '文本有抽牌但未解析',
  '抽牌数量不符', '文本有摧毁但未解析', '文本有压制但未解析', '文本有指挥点但未解析', '指挥点数量不符',
  '文本有关键词授予但未解析', '目标方向可能相反'];
let total = 0;
for (const k of order) total += (issues[k] || []).length;

let out = `# 指令牌语义审计（${ORDERS.length} 张，问题 ${total} 处）\n`;
for (const k of order) {
  const list = issues[k] || [];
  if (!list.length) continue;
  out += `\n## ${k}（${list.length}）\n\n`;
  for (const [id, msg] of list) out += `- \`${id}\` — ${msg}\n`;
}
fs.writeFileSync(path.join(__dirname, '..', '.work', 'order_semantic.md'), out, 'utf8');
console.log(`指令 ${ORDERS.length} 张，问题 ${total} 处`);
for (const k of order) if ((issues[k] || []).length) console.log(`  ${k}: ${issues[k].length}`);
console.log('-> .work/order_semantic.md');
