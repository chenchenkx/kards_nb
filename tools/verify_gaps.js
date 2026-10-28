// 决定性诊断：把真缺口清单里每张卡解析，提取所有 op，核对 execOp/execOps 是否有对应 case。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const Engine = require(path.join(ROOT, 'public/js/engine.js'));
const cards = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);

const engSrc = fs.readFileSync(path.join(ROOT, 'public/js/engine.js'), 'utf8');
// 收集所有 case 'X': 标签
const caseSet = new Set();
const re = /case '([^']+)':/g;
let m;
while ((m = re.exec(engSrc)) !== null) caseSet.add(m[1]);

// 真缺口卡 id 列表（来自 unit_wiring.md）
const ids = [
  'card_unit_coastwatchers','card_unit_2nd_para_c','card_unit_avro_anson1','card_unit_kings_own_scottish',
  'card_unit_royal_sussex_regiment','card_unit_light_detachment_15','card_unit_5e_cuirassier','card_unit_french_p_36',
  'card_unit_182_landwehr_vet','card_unit_fw_200_condor','card_unit_fw_190_ta_152_vet','card_unit_jagdpanzer_iv',
  'card_unit_ju_88_g6','card_unit_kurmark_aufklarungs','card_unit_cannone_da_47','card_unit_fiat_cr_32',
  'card_unit_sm_79','card_unit_144th_infantry_regiment','card_unit_73rd_infantry_regiment','card_unit_cedar_division_vet',
  'card_unit_kokuras_sword','card_unit_lublin_r_xiii','card_unit_pzl_7','card_unit_12th_guards_mechanised',
  'card_unit_175th_motorized','card_unit_222th_guard_rifles','card_unit_266th_guards_rifles_vet','card_unit_269th_rifles',
  'card_unit_57th_rifles','card_unit_77th_guards','card_unit_99th_kholm','card_unit_ilyushin_10','card_unit_katyusha',
  'card_unit_katyusha_cam1','card_unit_kv_85','card_unit_t_28_pincer','card_unit_tupolev_sb_2','card_unit_the_123s',
  'card_unit_162nd_regiment','card_unit_32nd_infantry_regiment'
];

function walkOps(node, acc) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => walkOps(n, acc)); return; }
  if (typeof node === 'object') {
    if (node.op) acc.push(node.op);
    for (const k of Object.keys(node)) {
      if (k === 'clauses' || k === 'ops' || k === 'then' || k === 'if') walkOps(node[k], acc);
    }
  }
}

let realGaps = [];
let allHandled = [];
for (const id of ids) {
  const c = db.cards.find(x => x.id === id);
  if (!c) { console.log('MISSING', id); continue; }
  let clauses;
  try { clauses = Engine.parseClauses(c.text); } catch (e) { console.log('PARSE ERR', id, e.message); continue; }
  const ops = [];
  walkOps(clauses, ops);
  const uniq = [...new Set(ops)];
  const missing = uniq.filter(o => !caseSet.has(o));
  if (ops.length === 0) {
    console.log(`UNPARSED  ${id}  :: ${c.text}`);
  } else if (missing.length) {
    realGaps.push({ id, text: c.text, missing, full: uniq });
    console.log(`GAP       ${id}  missing=[${missing.join(', ')}]  all=[${uniq.join(', ')}]`);
  } else {
    allHandled.push({ id, text: c.text, ops: uniq });
  }
}
console.log('\n=== 汇总 ===');
console.log('UNPARSED 数量:', ids.length - realGaps.length - allHandled.length - 0);
console.log('真缺口(有op无case):', realGaps.length);
console.log('已解析且全部有handler:', allHandled.length);
console.log('\n--- 全部有handler但审计报no delta（疑似探测假阴性）---');
for (const x of allHandled) console.log(`  ${x.id} :: ${x.text}`);
console.log('\n--- 真缺口明细 ---');
for (const x of realGaps) console.log(`  ${x.id} :: ${x.text}  => 缺 ${x.missing.join(',')}`);
