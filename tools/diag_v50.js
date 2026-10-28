const Engine = require('../public/js/engine.js');
const fs = require('fs');
const path = require('path');
const cards = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards.json'), 'utf8'));
const hqs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hqs.json'), 'utf8'));
const db = Engine.buildDb(cards, hqs);
const byId = {};
for (const c of db.cards) byId[c.id] = c;
const ids = ['card_unit_coastwatchers','card_unit_2nd_para_c','card_unit_avro_anson1','card_unit_kings_own_scottish','card_unit_royal_sussex_regiment','card_unit_light_detachment_15','card_unit_5e_cuirassier','card_unit_french_p_36','card_unit_182_landwehr_vet','card_unit_fw_200_condor','card_unit_fw_190_ta_152_vet','card_unit_jagdpanzer_iv','card_unit_ju_88_g6','card_unit_kurmark_aufklarungs','card_unit_cannone_da_47','card_unit_fiat_cr_32','card_unit_sm_79','card_unit_144th_infantry_regiment','card_unit_73rd_infantry_regiment','card_unit_cedar_division_vet','card_unit_kokuras_sword','card_unit_lublin_r_xiii','card_unit_pzl_7','card_unit_12th_guards_mechanised','card_unit_175th_motorized','card_unit_222th_guard_rifles','card_unit_266th_guards_rifles_vet','card_unit_269th_rifles','card_unit_57th_rifles','card_unit_77th_guards','card_unit_99th_kholm','card_unit_ilyushin_10','card_unit_katyusha','card_unit_katyusha_cam1','card_unit_kv_85','card_unit_t_28_pincer','card_unit_tupolev_sb_2','card_unit_the_123s','card_unit_162nd_regiment'];
for (const id of ids) {
  const c = byId[id];
  if (!c) { console.log(id, 'MISSING'); continue; }
  const clauses = Engine.parseClauses(c.text);
  console.log('==== ' + id + ' :: ' + c.text);
  console.log(JSON.stringify(clauses, (k, v) => typeof v === 'function' ? undefined : v));
}
