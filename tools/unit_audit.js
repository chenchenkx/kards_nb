/* 单位技能审计：逐张部署，检测状态是否变化（buff/关键词/手牌/牌库/HQ/场面） */
const fs=require('fs'),path=require('path');
const Engine=require('../public/js/engine.js');
const cards=JSON.parse(fs.readFileSync(path.join(__dirname,'..','data','cards.json'),'utf8'));
const hqs=JSON.parse(fs.readFileSync(path.join(__dirname,'..','data','hqs.json'),'utf8'));
const db=Engine.buildDb(cards,hqs);
const UNITS=db.cards.filter(c=>['infantry','tank','artillery','fighter','bomber'].includes(c.type)&&(c.text||'').trim());
const FILL=db.deckPool.filter(c=>c.type==='infantry'&&!c.text&&(c.cost||0)<=3);

function sig(g, excludeUid){
  const b=s=>g.players[s].board.filter(c=>c.uid!==excludeUid)
    .map(c=>[c.id,c.defense,c.buffAttack,c.buffDefense,[...c.keywords].sort().join('+')].join(':')).sort().join('|');
  return JSON.stringify({
    hq:[g.players[0].hqDef,g.players[1].hqDef],
    b0:b(0),b1:b(1),
    front:g.frontline.filter(c=>c.uid!==excludeUid).map(c=>[c.id,c.defense].join(':')).sort().join('|'),
    hand:g.players[0].hand.filter(c=>c.uid!==excludeUid).map(c=>c.id).sort().join(','),
    deck:[g.players[0].deck.length,g.players[1].deck.length],
    discard:g.players[0].discard.map(c=>c.id).sort().join(','),
  });
}
function game(){
  const d=FILL.slice(0,5).map(c=>c.id); const deck=[];
  for(let i=0;i<39;i++) deck.push(d[i%d.length]);
  const g=new Engine.Game({db,seed:7,decks:[deck,deck.slice()],hqs:[db.hqs.Germany,db.hqs.Soviet]});
  const pick=t=>db.deckPool.find(c=>c.type===t&&(c.cost||0)<=4&&!c.text)||db.deckPool.find(c=>c.type===t);
  const foe=new Engine.CardInst(pick('infantry'),1,g); foe.loc='board'; foe.summonedTurn=0; g.players[1].board.push(foe);
  const ally=new Engine.CardInst(pick('infantry'),0,g); ally.loc='board'; ally.summonedTurn=0; g.players[0].board.push(ally);
  for(let i=0;i<3;i++){const c=new Engine.CardInst(db.byId[d[i%d.length]],0,g);c.loc='hand';g.players[0].hand.push(c);}
  return g;
}
const ok=[],bad=[];
for(const def of UNITS){
  let g; try{g=game();}catch(e){continue;}
  const inst=new Engine.CardInst(def,0,g); inst.loc='hand';
  g.players[0].hand.push(inst);
  g.players[0].kredits=20; g.players[0].slots=20;
  const hi=g.players[0].hand.indexOf(inst);
  const before=sig(g, inst.uid);
  let r; try{ r=g.playCard(0,hi,{target:g.players[1].board[0].uid, toFront:false}); }catch(e){ r={ok:false,error:String(e)}; }
  if(!r.ok){ bad.push([def.name,'REJECT:'+(r.error||''),(def.text||'').slice(0,70)]); continue; }
  const after=sig(g, inst.uid);
  // 自身变化：打印值以外的属性/关键词变化（部署生效的直接体现）
  const selfDef = inst.defense !== (def.defense || 0) || inst.buffAttack !== 0 || inst.buffDefense !== 0;
  const staticKw = new Set((def.keywords || []).map(k => String(k).toLowerCase()));
  const selfKw = [...inst.keywords].some(k => !staticKw.has(k));
  const changed = before !== after || selfDef || selfKw;
  (changed ? ok : bad).push(changed ? def.name : [def.name, 'NOEFFECT', (def.text || '').slice(0, 80)]);
}
const total=UNITS.length;
console.log(`带文本单位 ${total} | 有效果 ${ok.length} (${(ok.length/total*100).toFixed(1)}%) | 疑似无效 ${bad.length}`);
const groups={};
for(const [name,kind,text] of bad){
  const t=(text||'').toLowerCase();
  let k=kind==='NOEFFECT'?'无变化':'被拒绝';
  if(kind==='NOEFFECT'){
    if(!t) k='空文本';
    else if(/^deployment:/.test(t)) k='部署效果未解析';
    else if(/\bwhen\b|\bwhenever\b/.test(t)) k='触发句';
    else if(/\bif\b/.test(t)) k='条件句';
    else if(/for each/.test(t)) k='for-each';
    else if(/\bgains?\b|\bgets?\b/.test(t)) k='增益句';
  }
  (groups[k]=groups[k]||[]).push([name,text]);
}
for(const k of Object.keys(groups)) console.log(`  ${k}: ${groups[k].length}`);
fs.writeFileSync(path.join(__dirname,'..','.work','unit_audit.json'),JSON.stringify(groups,null,1));
console.log('\n样例:');
for(const k of Object.keys(groups)) for(const [n,t] of groups[k].slice(0,4)) console.log(` [${k}] ${n}: ${t}`);
