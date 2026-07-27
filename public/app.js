const gg=id=>document.getElementById(id);

/* ── On-demand script loader: xlsx (SheetJS) and Plaid Link are heavy CDN
   bundles only needed for export / bank-linking, not first paint. Cached
   per-src so repeat calls don't inject duplicate <script> tags. ── */
const _scriptPromises={};
function _loadScript(src){
  if(_scriptPromises[src]) return _scriptPromises[src];
  _scriptPromises[src]=new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src=src; s.onload=()=>resolve(); s.onerror=()=>reject(new Error('Failed to load '+src));
    document.head.appendChild(s);
  });
  return _scriptPromises[src];
}
const XLSX_CDN_SRC='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
const PLAID_LINK_CDN_SRC='https://cdn.plaid.com/link/v2/stable/link-initialize.js';

/* ── Safe storage: falls back to in-memory when the browser blocks
   localStorage/sessionStorage (e.g. Edge Tracking Prevention, private mode).
   The whole app reads/writes through LS/SS so it never crashes on blocked storage. ── */
const _memStore={};
const _memSession={};
function _makeSafe(real, mem){
  return {
    // Fall back to the in-memory copy whenever real storage yields nothing — not only when it
    // THROWS. Edge tracking prevention silently drops writes and returns null on read (no
    // throw), which stranded a just-restored dashboard as unreadable → stuck at the build gate.
    getItem(k){ try{ const v=real.getItem(k); if(v!=null) return v; }catch(e){} return (k in mem)?mem[k]:null; },
    setItem(k,v){ mem[k]=String(v); try{ real.setItem(k,v); }catch(e){} },
    removeItem(k){ delete mem[k]; try{ real.removeItem(k); }catch(e){} },
  };
}
let _lsReal=null, _ssReal=null;
try{ _lsReal=window.localStorage; }catch(e){}
try{ _ssReal=window.sessionStorage; }catch(e){}
const LS=_makeSafe(_lsReal||{getItem(){return null},setItem(){},removeItem(){}}, _memStore);
const SS=_makeSafe(_ssReal||{getItem(){return null},setItem(){},removeItem(){}}, _memSession);
let _storageBlocked=false;
try{ const _t='__mdf_test__'; (_lsReal||{setItem(){throw 0}}).setItem(_t,'1'); _lsReal.removeItem(_t); }
catch(e){ _storageBlocked=true; }

/* ═══════════════════════════════════════════════════════════════════
   ENGINE (ported from pre-Richie live app)
   Data layer + category model + metric calcs. Real Plaid-backed.
═══════════════════════════════════════════════════════════════════ */
const fmtM=n=>'$'+(Math.abs(n)>=1e6?(Math.abs(n)/1e6).toFixed(2)+'M':Math.abs(n)>=1000?Math.round(Math.abs(n)/1000)+'K':Math.round(Math.abs(n)).toLocaleString());
const fmtK=n=>'$'+Math.round(Math.abs(n)).toLocaleString();
const moneyCol=n=>(+n>0?'var(--pos)':(+n<0?'var(--red)':'var(--muted)'));   // positive → green, negative → red
const fmt2=n=>'$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

/* ── Category model (single source of truth) ── */
const DEFAULT_CATEGORIES=[
  {id:'everyday',label:'Everyday Living',color:'#3dda91',plaid:[],group:true},
  {id:'food',label:'Food & Groceries',color:'#3dda91',plaid:['FOOD_AND_DRINK','GROCERIES'],parent:'everyday'},
  {id:'dining',label:'Dining Out',color:'#f5a623',plaid:['FOOD_AND_DRINK'],parent:'everyday'},
  {id:'shopping',label:'Shopping',color:'#fb923c',plaid:['GENERAL_MERCHANDISE','CLOTHING'],parent:'everyday'},
  {id:'subscriptions',label:'Subscriptions',color:'#22d3ee',plaid:['SUBSCRIPTION','TELECOM'],parent:'everyday'},
  {id:'home_group',label:'Home & Fixed',color:'#6b9ef5',plaid:[],group:true},
  {id:'housing',label:'Housing',color:'#6b9ef5',plaid:['RENT_AND_UTILITIES','MORTGAGE'],parent:'home_group'},
  {id:'utilities',label:'Utilities',color:'#45c8fc',plaid:['RENT_AND_UTILITIES','UTILITIES'],parent:'home_group'},
  {id:'insurance',label:'Insurance',color:'#a3e635',plaid:['INSURANCE'],parent:'home_group'},
  {id:'loans',label:'Loan Payments',color:'#f87171',plaid:['LOAN_PAYMENTS','CREDIT_CARD'],parent:'home_group'},
  {id:'auto_group',label:'Auto & Transport',color:'#b09afa',plaid:[],group:true},
  {id:'transport',label:'Auto Payments',color:'#b09afa',plaid:['TRANSPORTATION','AUTO'],parent:'auto_group'},
  {id:'gas',label:'Gas & Fuel',color:'#f46a6a',plaid:['TRANSPORTATION'],parent:'auto_group'},
  {id:'health_group',label:'Health & Wellness',color:'#34d399',plaid:[],group:true},
  {id:'health',label:'Medical',color:'#34d399',plaid:['MEDICAL','HEALTHCARE_SERVICES'],parent:'health_group'},
  {id:'lifestyle',label:'Lifestyle',color:'#f472b6',plaid:[],group:true},
  {id:'entertainment',label:'Entertainment',color:'#f472b6',plaid:['ENTERTAINMENT','RECREATION'],parent:'lifestyle'},
  {id:'travel',label:'Travel',color:'#818cf8',plaid:['TRAVEL','AIRLINES'],parent:'lifestyle'},
  {id:'financial',label:'Financial',color:'#4ade80',plaid:[],group:true},
  {id:'savings',label:'Savings & Invest',color:'#4ade80',plaid:['TRANSFER_OUT','INVESTMENT'],parent:'financial'},
  {id:'income',label:'Income',color:'#3dda91',plaid:['TRANSFER_IN','INCOME','PAYROLL'],parent:'financial'},
  {id:'other',label:'Other',color:'#94a3b8',plaid:[]},
];
function getUserCategories(){ try{ const s=JSON.parse(LS.getItem('mdf_categories')); return (s&&s.length)?s:DEFAULT_CATEGORIES.map(c=>({...c})); }catch(e){ return DEFAULT_CATEGORIES.map(c=>({...c})); } }

/* ══ ACCOUNT CATEGORY TREE — a taxonomy for ACCOUNTS, separate from spending categories.
   Auto-detected from Plaid type/subtype; user can override per-account in Settings.
   Widgets that use accounts filter by these category ids. ══ */
const ACCOUNT_CATEGORIES=[
  {id:'cash',       label:'Cash',        icon:'💵', kind:'asset',     liquid:true},
  {id:'savings',    label:'Savings',     icon:'🛟', kind:'asset',     liquid:true},
  {id:'investment', label:'Investment',  icon:'📈', kind:'asset',     liquid:false},
  {id:'retirement', label:'Retirement',  icon:'🏦', kind:'asset',     liquid:false},
  {id:'hsa',        label:'HSA',         icon:'🩺', kind:'asset',     liquid:false},
  {id:'property',   label:'Property',    icon:'🏠', kind:'asset',     liquid:false},
  {id:'credit',     label:'Credit Card', icon:'💳', kind:'liability', liquid:false},
  {id:'loan',       label:'Loan',        icon:'📄', kind:'liability', liquid:false},
  {id:'mortgage',   label:'Mortgage',    icon:'🏡', kind:'liability', liquid:false},
  {id:'other',      label:'Other',       icon:'📦', kind:'asset',     liquid:false},
];
const ACCT_CAT_BY_ID={}; ACCOUNT_CATEGORIES.forEach(c=>ACCT_CAT_BY_ID[c.id]=c);
function acctCatDef(id){ return ACCT_CAT_BY_ID[id]||ACCT_CAT_BY_ID.other; }
function _acctKey(a){ return (a&&(a.id||a.account_id||a.name))||'?'; }
function _acctCatOverrides(){ try{ return JSON.parse(LS.getItem('mdf_acct_cats'))||{}; }catch(e){ return {}; } }
function setAccountCategory(a, catId){ const o=_acctCatOverrides(); const k=(typeof a==='string')?a:_acctKey(a); if(catId)o[k]=catId; else delete o[k]; try{ LS.setItem('mdf_acct_cats',JSON.stringify(o)); }catch(e){} }
function _autoAcctCat(a){
  const t=(a&&a.type||'').toLowerCase(), s=(a&&a.subtype||'').toLowerCase(), nm=(a&&a.name||'').toLowerCase(), blob=s+' '+nm;
  if(/hsa|health\s?savings/.test(blob)) return 'hsa';
  if(t==='credit') return 'credit';
  if(t==='loan') return /mortgage|home\s?loan|heloc/.test(blob)?'mortgage':'loan';
  if(/mortgage/.test(blob)) return 'mortgage';
  if(t==='depository') return /saving|cd\b|money\s?market|mmkt/.test(s)?'savings':'cash';
  if(t==='investment') return /401|403|457|ira|roth|pension|retire|sep|thrift|tsp|annuit/.test(blob)?'retirement':'investment';
  if(/real\s?estate|property|\bhome\b|\bhouse\b|vehicle|\bcar\b|\bauto\b/.test(blob)) return 'property';
  return (a&&a.bal<0)?'loan':'other';
}
function getAccountCategory(a){ const o=_acctCatOverrides(); const k=_acctKey(a); if(o[k]&&ACCT_CAT_BY_ID[o[k]]) return o[k]; return _autoAcctCat(a); }
function _findWidget(uid){ for(const p of (APP.pages||[])){ const w=(p.widgets||[]).find(x=>x&&x.uid===uid); if(w) return w; } return null; }
function mapPlaidCategory(plaidPrimary){ const cats=getUserCategories(); const p=(plaidPrimary||'').toUpperCase().replace(/\s+/g,'_'); for(const cat of cats){ if(cat.plaid&&cat.plaid.some(k=>p.includes(k)||k.includes(p))) return cat.label; } return 'Other'; }
function getCatColor(label){ const cats=getUserCategories(); const f=cats.find(c=>c.label===label); return f?f.color:'#94a3b8'; }
// Map a (child) category label to its first-tier parent group {id,label,color}.
// Top-level categories (like "Other") map to themselves.
function getCatParent(label){
  const cats=getUserCategories();
  const c=cats.find(x=>x.label===label);
  if(!c) return {id:'other',label:'Other',color:'#94a3b8'};
  if(c.parent){ const p=cats.find(x=>x.id===c.parent); if(p) return {id:p.id,label:p.label,color:p.color}; }
  return {id:c.id,label:c.label,color:c.color};
}
const _catOverrides=JSON.parse(LS.getItem('mdf_cat_overrides')||'{}');
const _txnNotes=JSON.parse(LS.getItem('mdf_txn_notes')||'{}');
let _txnTags=JSON.parse(LS.getItem('mdf_txn_tags')||'{}');
const TXN_TAGS=[
  {id:'paycheck',   label:'Paycheck',      icon:'💵'},
  {id:'transfer',   label:'Transfer',      icon:'🔁'},
  {id:'refund',     label:'Refund',        icon:'↩️'},
  {id:'business',   label:'Business',      icon:'💼'},
  {id:'reimburse',  label:'Reimbursement', icon:'🧾'},
  {id:'subscription',label:'Subscription', icon:'🔄'},
  {id:'ccpayment',  label:'Credit Card Payment', icon:'💳'},
  {id:'ignore',     label:'Ignore',        icon:'🚫'},
];
const TXN_TAG_BY_ID={}; TXN_TAGS.forEach(t=>TXN_TAG_BY_ID[t.id]=t);
function getTxnTag(t){ return _txnTags[_txnKey(t)]||''; }
function setTxnTag(key, tag){ if(!key) return; if(tag) _txnTags[key]=tag; else delete _txnTags[key]; try{ LS.setItem('mdf_txn_tags', JSON.stringify(_txnTags)); }catch(e){} }
// Tags that mean "not real spending" (transfers, paybacks, ignored) — excluded from spend totals.
/* A credit-card payment leaving a bank account is NOT spending — the card's purchases are
   the real spending, so counting the payment too double-counts. Detected by user tag,
   Plaid's category (CREDIT_CARD_PAYMENT), the legacy category array, or a conservative
   payee-name pattern ("AMEX EPAYMENT", "CHASE CREDIT CRD AUTOPAY", ...). */
function _isCCPaymentTxn(t){
  if(getTxnTag(t)==='ccpayment') return true;
  if(!(t.amount>0)) return false;   // only outflows from a bank account can be card payments
  const det=((t.personal_finance_category&&(t.personal_finance_category.detailed||t.personal_finance_category.primary))||'').toUpperCase();
  if(det.includes('CREDIT_CARD_PAYMENT')) return true;
  const legacy=(Array.isArray(t.category)?t.category.join(' '):String(t.category||'')).toLowerCase();
  if(legacy.includes('credit card') && legacy.includes('payment')) return true;
  const nm=(t.merchant_name||t.name||'').toLowerCase();
  if(/(credit ?crd|credit ?card|amex|american express|discover|barclays?|citi ?card|card ?(pmt|payment|autopay|e-?pay))/.test(nm) && /(pmt|payment|autopay|e-?pay|ach)/.test(nm)) return true;
  return false;
}
function _txnExcludedFromSpend(t){ const g=getTxnTag(t); return g==='transfer'||g==='ignore'||g==='reimburse'||g==='ccpayment'||_isCCPaymentTxn(t); }
// Tags that mean "not real income" (a transfer in, a refund, etc.) — excluded from income totals.
function _txnExcludedFromIncome(t){ const g=getTxnTag(t); return g==='transfer'||g==='ignore'||g==='refund'||g==='reimburse'; }
function _txnKey(t){ return t.transaction_id || t.id || ((t.date||'')+'|'+(t.merchant_name||t.name||'')+'|'+t.amount); }
let _catRules=JSON.parse(LS.getItem('mdf_cat_rules')||'{}');   // merchant key → category (auto-apply)
function setCatRule(mk, cat){ if(!mk) return; if(cat) _catRules[mk]=cat; else delete _catRules[mk]; try{ LS.setItem('mdf_cat_rules', JSON.stringify(_catRules)); }catch(e){} }
/* ═══ CATEGORY RULES MANAGER (Settings) ═══
   Every "always categorize this merchant as X" rule in one place — view, re-point, delete,
   or add by hand. Rules live in _catRules (merchant key → category), synced via mdf_cat_rules. */
function _titleCaseKey(s){ return String(s||'').replace(/\b\w/g,c=>c.toUpperCase()); }
function renderRulesManager(){
  const host=gg('rulesList'); if(!host) return;
  const cats=getUserCategories().filter(c=>!c.group).map(c=>c.label);
  const keys=Object.keys(_catRules).sort();
  const counts={}; try{ (allTxns||[]).forEach(t=>{ const mk=_merchKey(t); if(mk&&_catRules[mk]!==undefined) counts[mk]=(counts[mk]||0)+1; }); }catch(e){}
  const catOpts=(sel)=>cats.map(c=>`<option value="${esc(c)}"${c===sel?' selected':''}>${esc(c)}</option>`).join('');
  const addRow=`<div class="rule-add">
    <input id="ruleAddName" class="mf-in" placeholder="Merchant (e.g. Starbucks)" aria-label="Merchant name for new rule">
    <select id="ruleAddCat" class="txn-cat-sel" aria-label="Category for new rule"><option value="">Category…</option>${catOpts('')}</select>
    <button class="btn primary rule-addbtn" onclick="ruleAdd()">Add</button>
  </div>`;
  if(!keys.length){ host.innerHTML=`<div class="ws-hint">No rules yet. Tap the ＝ button on any transaction to always categorize that merchant — or add one below.</div>${addRow}`; return; }
  const rows=keys.map(mk=>{
    const cat=_catRules[mk]; const catList=cats.includes(cat)?cats:[cat].concat(cats);
    const opts=catList.map(c=>`<option value="${esc(c)}"${c===cat?' selected':''}>${esc(c)}</option>`).join('');
    const n=counts[mk]||0; const k=esc(mk).replace(/'/g,"\\'");
    return `<div class="rule-row"><span class="rule-nm">${esc(_titleCaseKey(mk))}${n?`<span class="rule-count">${n} txn${n!==1?'s':''}</span>`:''}</span><span class="rule-arrow" aria-hidden="true">→</span><select class="txn-cat-sel" onchange="ruleSetCat('${k}',this.value)" aria-label="Category for ${esc(mk)}">${opts}</select><button class="rule-del" onclick="ruleDelete('${k}')" title="Delete rule" aria-label="Delete rule for ${esc(mk)}">🗑</button></div>`;
  }).join('');
  host.innerHTML=`<div class="rule-list">${rows}</div>${addRow}`;
}
function _rulesRefresh(){ renderRulesManager(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg&&pg.id!=='__settings__') renderCanvas(pg); }
function ruleSetCat(mk,cat){ if(!mk||!cat) return; setCatRule(mk,cat); _rulesRefresh(); if(sbRichie)sbRichie.do('nod'); }
function ruleDelete(mk){ if(!mk) return; setCatRule(mk,''); _rulesRefresh(); }
function ruleAdd(){
  const nEl=gg('ruleAddName'), cEl=gg('ruleAddCat'); if(!nEl||!cEl) return;
  const mk=_merchKeyName(nEl.value); const cat=cEl.value;
  if(!mk){ nEl.focus(); return; }
  if(!cat){ cEl.focus(); return; }
  setCatRule(mk,cat); nEl.value=''; cEl.value=''; _rulesRefresh(); if(sbRichie)sbRichie.do('tada');
}
function getTxnCategory(t){
  const id=_txnKey(t);
  if(id&&_catOverrides[id]) return _catOverrides[id];               // 1) per-transaction override wins
  const mk=(typeof _merchKey==='function')?_merchKey(t):'';
  if(mk&&_catRules[mk]) return _catRules[mk];                        // 2) merchant rule ("always X")
  const raw=(t.personal_finance_category&&t.personal_finance_category.primary)||(t.category&&t.category[0])||'';
  return mapPlaidCategory(raw);                                      // 3) auto from Plaid
}
function getTxnNote(t){ return _txnNotes[_txnKey(t)]||''; }

/* ═══ GLOBAL TRANSACTION SEARCH ═══
   A topbar-launched overlay that searches across every transaction (merchant,
   category, note, account, amount) with quick structured filters. */
let _txnSearch={q:'', chips:{month:false,big:false,income:false,spend:false,uncat:false}};
const TXS_CHIPS=[{id:'month',label:'This month'},{id:'big',label:'≥ $50'},{id:'income',label:'Income'},{id:'spend',label:'Spending'},{id:'uncat',label:'Uncategorized'}];
function openTxnSearch(){
  const m=gg('txnSearchModal'); if(!m) return;
  try{ discoverXp('search',10,'global search'); }catch(e){}
  m.style.display='flex';
  const chipsEl=gg('txsChips'); if(chipsEl) chipsEl.innerHTML=TXS_CHIPS.map(c=>`<button class="txs-chip${_txnSearch.chips[c.id]?' on':''}" onclick="txnSearchChip('${c.id}')">${esc(c.label)}</button>`).join('');
  txnSearchRender();
  setTimeout(()=>{ const i=gg('txsInput'); if(i){ i.value=_txnSearch.q; i.focus(); } },60);
}
function closeTxnSearch(){ const m=gg('txnSearchModal'); if(m) m.style.display='none'; }
function txnSearchInput(v){ _txnSearch.q=v; txnSearchRender(); }
function txnSearchChip(id){
  _txnSearch.chips[id]=!_txnSearch.chips[id];
  const b=gg('txsChips'); if(b) Array.prototype.forEach.call(b.children,(el,i)=>{ el.classList.toggle('on', !!_txnSearch.chips[TXS_CHIPS[i].id]); });
  txnSearchRender();
}
function _txnAcctName(t){ const a=(allAccts||[]).find(x=>x.account_id===t.account_id); return a?(a.name||a.official_name||a.institution||''):''; }
// Parse an amount operator out of the query (">50", "<=20", "50-100", "=12.5"). Returns a predicate or null.
function _parseAmtQuery(q){
  let m=q.match(/^([<>]=?|=)\s*\$?(\d+(?:\.\d+)?)$/);
  if(m){ const op=m[1], n=parseFloat(m[2]); return v=>{ v=Math.abs(v); switch(op){case '>':return v>n;case '>=':return v>=n;case '<':return v<n;case '<=':return v<=n;default:return Math.abs(v-n)<0.005;} }; }
  m=q.match(/^\$?(\d+(?:\.\d+)?)\s*-\s*\$?(\d+(?:\.\d+)?)$/);
  if(m){ const a=parseFloat(m[1]), b=parseFloat(m[2]), lo=Math.min(a,b), hi=Math.max(a,b); return v=>{ v=Math.abs(v); return v>=lo&&v<=hi; }; }
  return null;
}
function _txnSearchData(){
  let list = (dataLoaded && allTxns.length) ? allTxns.slice() : [
    {date:'2026-07-20',name:'Starbucks',amount:6.45,transaction_id:'txs1'},
    {date:'2026-07-18',name:'Whole Foods',amount:83.20,transaction_id:'txs2'},
    {date:'2026-07-15',name:'Paycheck — Employer',amount:-2400,transaction_id:'txs3'},
    {date:'2026-07-12',name:'Shell Gas',amount:47.10,transaction_id:'txs4'},
    {date:'2026-06-28',name:'Netflix',amount:15.49,transaction_id:'txs5'},
  ];
  const raw=(_txnSearch.q||'').trim(), q=raw.toLowerCase();
  const amtPred=raw?_parseAmtQuery(raw):null;
  const ch=_txnSearch.chips;
  const now=new Date(), curStart=new Date(now.getFullYear(),now.getMonth(),1);
  list=list.filter(t=>{
    if(ch.month && new Date(t.date)<curStart) return false;
    if(ch.big && Math.abs(t.amount)<50) return false;
    if(ch.income && !_isIncomeTxn(t)) return false;
    if(ch.spend && !(t.amount>0 && !_txnExcludedFromSpend(t))) return false;
    if(ch.uncat && getTxnCategory(t)!=='Other') return false;
    if(q){
      if(amtPred){ if(!amtPred(t.amount)) return false; }
      else { const hay=[(t.merchant_name||t.name||''),getTxnCategory(t),getTxnNote(t),_txnAcctName(t),Math.abs(t.amount).toFixed(2)].join(' ').toLowerCase(); if(!hay.includes(q)) return false; }
    }
    return true;
  });
  list.sort((a,b)=>new Date(b.date)-new Date(a.date));
  return list;
}
function txnSearchRender(){
  const list=_txnSearchData();
  const sumEl=gg('txsSummary');
  const inTot=list.filter(t=>t.amount<0).reduce((s,t)=>s+Math.abs(t.amount),0);
  const outTot=list.filter(t=>t.amount>0).reduce((s,t)=>s+t.amount,0);
  if(sumEl) sumEl.innerHTML = list.length ? `<span>${list.length} result${list.length!==1?'s':''}</span><span class="txs-in">+${fmtK(inTot)}</span><span class="txs-out">−${fmtK(outTot)}</span>` : '';
  const el=gg('txsList'); if(!el) return;
  const active=(_txnSearch.q||Object.values(_txnSearch.chips).some(Boolean));
  if(!list.length){ el.innerHTML=`<div class="txs-empty">${active?'No transactions match.':'Type to search across every transaction — or tap a filter above.'}</div>`; return; }
  const capped=list.slice(0,400);
  el.innerHTML=capped.map(t=>{
    const pos=t.amount>0, col=pos?'var(--red)':'var(--pos)', amt=(pos?'−':'+')+fmt2(Math.abs(t.amount));
    const cat=getTxnCategory(t), note=getTxnNote(t), acct=_txnAcctName(t);
    const name=t.merchant_name||t.name||'', dt=new Date(t.date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    return `<div class="txs-row">
      <span class="txs-dot" style="background:${getCatColor(cat)}"></span>
      <div class="txs-main"><div class="txs-name">${esc(name)}</div><div class="txs-meta">${esc(dt)} · ${esc(cat)}${acct?' · '+esc(acct):''}${note?' · 📝 '+esc(note):''}</div></div>
      <b class="txs-amt" style="color:${col}">${amt}</b>
    </div>`;
  }).join('') + (list.length>400?`<div class="txs-empty">Showing the 400 most recent of ${list.length} matches — refine your search.</div>`:'');
}
// Ctrl/⌘+K toggles search (ignored on the login screen and while typing in another field).
try{ document.addEventListener('keydown',function(e){
  if(!((e.metaKey||e.ctrlKey)&&(e.key==='k'||e.key==='K'))) return;
  const login=gg('loginScreen'); if(login && login.style.display!=='none' && login.offsetParent!==null) return;
  const m=gg('txnSearchModal'); if(!m) return;
  e.preventDefault();
  if(m.style.display==='flex') closeTxnSearch(); else openTxnSearch();
}); }catch(e){}

/* ── Live data layer (Plaid-backed via server API) ── */
let allAccts=[], allTxns=[], _plaidTxns=[], dataLoaded=false, serverAvailable=true;
// Once a real dashboard (any widgets) has been seen this session, the client must NEVER push
// a widget-less/gate state over it — that overwrote the server on storage-clearing browsers.
let _sawWidgets=false;
function _rebuildTxns(){ allTxns=(_plaidTxns||[]).concat(APP.importedTxns||[]); }
/* ── Pending transactions (Plaid sends them with pending:true) — used for "expected" totals.
   Expected balance = current balance minus the net of pending amounts (Plaid amount>0 = money out),
   which works for both asset balances (+) and debt balances stored negative. Banks that already
   fold pending into the reported balance will make this an estimate — hence the "expected" label. ── */
function engAcctPending(a){
  if(!dataLoaded||!a||a.manual) return {count:0,sum:0};
  const list=allTxns.filter(t=>t.pending&&t.account_id===a.id);
  return {count:list.length, sum:list.reduce((s,t)=>s+(+t.amount||0),0)};
}
function engExpectedBalance(a){ const p=engAcctPending(a); return (a.bal||0)-p.sum; }
async function _fetchJSON(url){
  // Returns parsed JSON, or null when no API server is present (standalone/offline).
  let r;
  try{ r=await fetch(url); }catch(e){ serverAvailable=false; return null; }
  const ct=(r.headers.get('content-type')||'').toLowerCase();
  if(!r.ok || !ct.includes('json')){ serverAvailable=false; return null; } // server returned HTML/error → not connected
  // Self-heal: one cold-start 502 must not latch the flag false for the whole session —
  // that silently disabled every state push, so the server copy went permanently stale.
  try{ const j=await r.json(); serverAvailable=true; return j; }catch(e){ serverAvailable=false; return null; }
}
let _acctErrors=[];  // per-institution sync failures from /api/accounts (e.g. ITEM_LOGIN_REQUIRED → bank needs reconnect)
let _reconnectDismissed=false;
async function loadAccounts(){
  const d=await _fetchJSON('/api/accounts'); if(!d) return false;
  allAccts=d.accounts||[]; _acctErrors=d.errors||[];
  try{ renderReconnectBanner(); }catch(e){}   // surface any bank that needs re-linking
  return true;
}
// Banks whose Plaid access expired and need the user to sign in again (update-mode re-link).
function _relinkErrors(){ return (_acctErrors||[]).filter(e=>e && e.needsRelink && e.itemId); }
// Persistent bar under the topbar — the #1 reliability pain in every budgeting app.
function renderReconnectBanner(){
  const main=gg('main'), pc=gg('page-content'); if(!main||!pc) return;
  const rl=_relinkErrors();
  let bn=gg('reconnectBanner');
  if(!rl.length || _reconnectDismissed){ if(bn) bn.style.display='none'; return; }
  if(!bn){ bn=document.createElement('div'); bn.id='reconnectBanner'; bn.className='reconnect-banner'; main.insertBefore(bn, pc); }
  bn.style.display='flex';
  const one=rl.length===1;
  const lead=one?`${esc(rl[0].institution||'A bank')} needs`:`${rl.length} banks need`;
  const btn=one
    ? `<button class="reconnect-btn" onclick="openLinkHandler('${esc(String(rl[0].itemId)).replace(/'/g,"\\'")}')">Reconnect ${esc(rl[0].institution||'bank')}</button>`
    : `<button class="reconnect-btn" onclick="openBriefing()">Reconnect ${rl.length} banks</button>`;
  bn.innerHTML=`<span class="reconnect-ic" aria-hidden="true">⚠️</span><span class="reconnect-msg"><b>${lead} reconnecting</b> — sign in again so your balances and transactions stay live.</span>${btn}<button class="reconnect-x" onclick="dismissReconnectBanner()" title="Dismiss" aria-label="Dismiss reconnect banner">✕</button>`;
}
function dismissReconnectBanner(){ _reconnectDismissed=true; const bn=gg('reconnectBanner'); if(bn) bn.style.display='none'; }
async function loadTransactions(){
  const d=await _fetchJSON('/api/transactions'); if(!d) return false;
  _plaidTxns=d.transactions||[]; _rebuildTxns(); return true;
}
let plaidLiabilities=null; // {credit_cards:[], mortgages:[]} from server when connected
async function loadLiabilities(){
  const d=await _fetchJSON('/api/liabilities'); if(!d) return false;
  plaidLiabilities=d; return true;
}
async function loadEngineData(){
  const [a,b]=await Promise.all([loadAccounts(),loadTransactions()]);
  loadLiabilities(); // fire-and-forget; enriches SWOT/debt when available
  _rebuildTxns();
  try{ _memoInvalidate(); }catch(e){}   // fresh bank data → drop any memoized derivations
  dataLoaded=((a||b)&&(allAccts.length>0||allTxns.length>0)) || ((APP.importedTxns||[]).length>0);
  try{ if(typeof checkGoalCompletion==='function') checkGoalCompletion(); }catch(e){}
  try{ if(typeof bucketCheckGoals==='function') bucketCheckGoals(); }catch(e){}
  try{ if(typeof financialMilestones==='function') financialMilestones(); }catch(e){}
  try{ if(typeof maybeWarnPromos==='function') maybeWarnPromos(); }catch(e){}
  return dataLoaded;
}

/* ── Metric computations (ported formulas) ── */
function _isDebtAcct(a){ return !!(a && (a.type==='credit' || a.type==='loan')); }   // Plaid loans (mortgage/auto/student) carry positive balances = money OWED
// Net bank balance from the master account list (engAccounts) so dedupe, per-account
// exclusions, and nicknames stay consistent with every widget. Manual accounts are left
// out to preserve the historical meaning (bank-linked net only); debt bals are negative.
function engNetBalance(){
  if(!dataLoaded||!allAccts.length) return 0;
  return engAccounts().reduce((s,a)=>(a.manual||a.excluded)?s:s+(a.bal||0),0);
}
// Account IDs whose account the user excluded — their transactions drop out of ALL analytics.
function _excludedAcctIds(){
  // Frame-memoized: engRecent calls this for every spend/income scan in a render pass.
  return _memoFrame('exclAcctIds', ()=>{
    const set=new Set();
    engAccounts().forEach(a=>{ if(a.excluded&&a.id) set.add(a.id); });
    return set;
  });
}
function engRecent(days){ const cut=new Date(Date.now()-days*86400000); const ex=_excludedAcctIds(); return allTxns.filter(t=>new Date(t.date)>=cut && !ex.has(t.account_id)); }

/* ── P&L engine: group income vs spending by day/week/month with full stats ── */
function engPLBuckets(days, group){
  const rec=engRecent(days);
  const buckets={};
  rec.forEach(t=>{
    const d=new Date(t.date+'T12:00:00'); let key;
    if(group==='monthly') key=d.toLocaleDateString('en-US',{month:'short',year:'2-digit'});
    else if(group==='weekly'){ const wk=new Date(d); wk.setDate(d.getDate()-d.getDay()); key=wk.toISOString().slice(5,10); }
    else key=d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    if(!buckets[key]) buckets[key]={key,inc:0,spend:0,n:0,order:d.getTime()};
    // Income side goes through _isIncomeTxn so credit-card payments landing on the card,
    // tagged transfers/refunds, and liability categories never count as income; spend side
    // goes through _txnExcludedFromSpend so the payment leaving checking isn't double-counted
    // on top of the card purchases it paid for.
    if(t.amount<0){ if(_isIncomeTxn(t)) buckets[key].inc+=Math.abs(t.amount); }
    else if(!_txnExcludedFromSpend(t)) buckets[key].spend+=t.amount;
    buckets[key].n++;
  });
  return Object.values(buckets).sort((a,b)=>a.order-b.order);
}
function engPLStats(days, group){
  const b=engPLBuckets(days, group);
  const totalInc=b.reduce((s,x)=>s+x.inc,0);
  const totalSpend=b.reduce((s,x)=>s+x.spend,0);
  const net=totalInc-totalSpend;
  const sr=totalInc>0?Math.round(net/totalInc*100):0;
  const nets=b.map(x=>x.inc-x.spend);
  const best=b.length?b[nets.indexOf(Math.max(...nets))]:null;
  const worst=b.length?b[nets.indexOf(Math.min(...nets))]:null;
  const txnCount=b.reduce((s,x)=>s+x.n,0);
  const avgNet=b.length?Math.round(net/b.length):0;
  return {buckets:b,totalInc,totalSpend,net,sr,best,worst,txnCount,avgNet,periods:b.length};
}
// Sample P&L when no live data
function engPLSample(group){
  const labels=group==='monthly'?['Mar','Apr','May','Jun']:group==='weekly'?['05-01','05-08','05-15','05-22']:['Jun 1','Jun 8','Jun 15','Jun 21'];
  const data=[[5400,3100],[5200,3600],[5800,2900],[5400,3118]];
  return labels.map((l,i)=>({key:l,inc:data[i][0],spend:data[i][1],n:12+i,order:i}));
}

/* ── Accounts engine: list with type icons + per-account 30d net ── */
function _acctIcon(a){ if(a.type==='credit')return '💳'; if(a.type==='loan')return '📄'; if(a.subtype==='savings')return '🏦'; if(a.subtype==='checking')return '🏧'; if(a.type==='investment')return '📈'; return '💰'; }
function _acctExcluded(nameOrObj){ const nm=(typeof nameOrObj==='string')?nameOrObj:(nameOrObj&&nameOrObj.name); return !!((APP.cardData||{})[_cardKey(nm)]||{}).excluded; }
/* ── Frame-scoped memo ──
   engAccounts()/engBills() are pure derivations called dozens of times inside one
   synchronous render pass (each widget recomputes them). Inputs can't change mid-pass
   (single-threaded), so cache for the current frame; a microtask clears it before the
   next event tick, and saveState()/data loads/sync-pull clear it explicitly — so a
   mutate-then-rerender in the same tick can never read stale data. ── */
let _frameMemo=null;
function _memoFrame(key, fn){
  if(!_frameMemo){ _frameMemo={}; queueMicrotask(()=>{ _frameMemo=null; }); }
  if(!(key in _frameMemo)) _frameMemo[key]=fn();
  return _frameMemo[key];
}
function _memoInvalidate(){ _frameMemo=null; }
/* ── Accessibility: give icon-only controls an accessible name for screen readers ──
   Copies each icon-only button's title → aria-label and labels the common close buttons.
   A debounced observer keeps it live as widgets/modals render. */
let _a11yStarted=false, _a11yTimer=null;
function _a11ySweep(root){
  root=root||document; if(!root.querySelectorAll) return;
  try{
    root.querySelectorAll('button[title]:not([aria-label])').forEach(b=>{
      const txt=(b.textContent||'').replace(/[\s\u{1F000}-\u{1FAFF}←-⯿ -⁯️×✕✓✎★☆＋＝…·🔊🔕]/gu,'').trim();
      if(!txt){ const t=b.getAttribute('title'); if(t) b.setAttribute('aria-label', t); }   // icon-only → name it
    });
    root.querySelectorAll('.doc-x,.rp-close,.wdt-x,.ce-x,.rwiz-x,.cele-close,.brief-x,.hub-tab').forEach(b=>{
      if(!b.getAttribute('aria-label')){ if(b.classList.contains('hub-tab')) b.setAttribute('aria-label', (b.textContent||'').trim()); else b.setAttribute('aria-label','Close'); }
    });
    // Div/span elements that act as buttons (chips, option cards) — make them keyboard-reachable.
    // Native <button> chips already handle this; this only touches the non-native clickables.
    root.querySelectorAll(_A11Y_CLICKABLE).forEach(el=>{
      if(el.hasAttribute('tabindex')) return;
      if(!el.getAttribute('onclick') && !el.onclick) return;   // only genuinely clickable ones
      el.setAttribute('tabindex','0');
      if(!el.getAttribute('role')) el.setAttribute('role','button');
    });
  }catch(e){}
}
const _A11Y_CLICKABLE='.acct-chip,.pf-row,.ww-card,.ws-opt,.ww-size-opt,.fd-scen,.persona-opt,.icon-opt,.color-opt,.ri-choice,.profile-avatar-pick,.page-nav-btn';
function _a11yObserve(){
  if(_a11yStarted) return; _a11yStarted=true;
  try{
    _a11ySweep(document);
    const mo=new MutationObserver(()=>{ clearTimeout(_a11yTimer); _a11yTimer=setTimeout(()=>_a11ySweep(document), 300); });
    mo.observe(document.body||document.documentElement, {childList:true, subtree:true});
    _initKbdA11y();
  }catch(e){}
}
// Modal overlays and how to dismiss each — used for Escape-to-close + focus trapping.
const _A11Y_MODALS=[
  ['manualModal',()=>closeManual()],['docModal',()=>closeDocModal()],['researchModal',()=>closeResearch()],
  ['holdModal',()=>closeHold()],['widgetStudio',()=>closeStudio()],['catEditorModal',()=>closeCatEditor()],
  ['widgetDetailModal',()=>closeWidgetDetail()],['fullResetModal',()=>closeFullReset()],
  ['pageEditorModal',()=>closePageEditor()],['richieChat',()=>closeRichieChat()],['richieWiz',()=>rwizClose()]
];
function _topVisibleModal(){
  let best=null, bestZ=-1;
  for(const [id,close] of _A11Y_MODALS){
    const el=document.getElementById(id); if(!el) continue;
    let cs; try{ cs=getComputedStyle(el); }catch(e){ continue; }
    if(cs.display==='none' || cs.visibility==='hidden' || !el.getClientRects().length) continue;
    const z=parseInt(cs.zIndex,10)||0;
    if(z>=bestZ){ bestZ=z; best={el,close}; }   // ties resolve to later-listed (assumed on top)
  }
  return best;
}
function _focusTrap(modal, e){
  const sel='a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const nodes=Array.prototype.slice.call(modal.querySelectorAll(sel)).filter(n=>n.offsetParent!==null || getComputedStyle(n).position==='fixed');
  if(!nodes.length) return;
  const first=nodes[0], last=nodes[nodes.length-1], a=document.activeElement;
  if(e.shiftKey){ if(a===first || !modal.contains(a)){ e.preventDefault(); last.focus(); } }
  else { if(a===last || !modal.contains(a)){ e.preventDefault(); first.focus(); } }
}
function _initKbdA11y(){
  if(window._kbdA11yOn) return; window._kbdA11yOn=true;
  document.addEventListener('keydown', function(e){
    // Enter/Space activates a non-native element we made role="button"
    if(e.key==='Enter' || e.key===' ' || e.key==='Spacebar'){
      const t=e.target;
      if(t && t.getAttribute && t.getAttribute('role')==='button'){
        const tag=(t.tagName||'').toLowerCase();
        if(tag!=='button'&&tag!=='a'&&tag!=='input'&&tag!=='textarea'&&tag!=='select'){ e.preventDefault(); if(typeof t.click==='function') t.click(); return; }
      }
    }
    if(e.key!=='Escape' && e.key!=='Tab') return;
    const m=_topVisibleModal(); if(!m) return;
    if(e.key==='Escape'){ e.preventDefault(); try{ m.close(); }catch(err){ m.el.style.display='none'; } }
    else if(e.key==='Tab'){ _focusTrap(m.el, e); }
  });
}
// Manual "reduce motion" preference (in addition to the OS-level prefers-reduced-motion).
let _reduceMotion=false; try{ _reduceMotion=LS.getItem('mdf_reduce_motion')==='1'; }catch(e){}
function _applyReduceMotion(){ try{ document.body.classList.toggle('reduce-motion', _reduceMotion); }catch(e){} }
function setReduceMotion(on){ _reduceMotion=!!on; try{ LS.setItem('mdf_reduce_motion', on?'1':'0'); }catch(e){} _applyReduceMotion(); const t=gg('reduceMotionToggle'); if(t) t.classList.toggle('on', _reduceMotion); }
function engAccounts(){ return _memoFrame('accounts', _engAccountsRaw); }
function _engAccountsRaw(){
  const manual=(APP.manualAccounts||[]).map(a=>({...a, manual:true, excluded:_acctExcluded(a.name)}));
  if(!dataLoaded||!allAccts.length){
    return [
      {name:'Checking (example)',type:'depository',subtype:'checking',bal:2500,institution:'Example Bank',id:'s1'},
      {name:'Savings (example)',type:'depository',subtype:'savings',bal:6000,institution:'Example Bank',id:'s2'},
      {name:'Retirement (example)',type:'investment',subtype:'401k',bal:15000,institution:'Example',id:'s3'},
      {name:'Credit Card (example)',type:'credit',subtype:'credit card',bal:-750,institution:'Example',id:'s4'},
    ].concat(manual);
  }
  return _dedupeAcctList(allAccts.map((a,i)=>{
    const nm=(a.name||a.official_name||a.type);
    const cd=_cdFor({institution:a.institution, mask:a.mask, name:nm});
    return {
      name:(cd.nickname||nm), rawName:nm, type:a.type, subtype:a.subtype, mask:a.mask||'',
      bal:(_isDebtAcct(a)?-(Math.abs(a.balances.current||0)):(a.balances.current??a.balances.available??0)),
      institution:a.institution||'', id:a.account_id||('a'+i), excluded:!!cd.excluded, contrib:(+cd.contrib||+a.contrib||0), _acct:a
    };
  }).concat(manual));
}
function _dedupeAcctList(list){
  // Mask (account-number suffix) is part of the key — several same-named accounts at one
  // bank (e.g. four Amex HYSAs) are distinct accounts, not duplicates.
  const seen=new Set(), out=[];
  for(const a of (list||[])){
    const k=[(a.institution||'').toLowerCase().trim(),(a.mask||''),(a.rawName||a.name||'').toLowerCase().trim(),(a.subtype||a.type||''),Math.round(a.bal||0)].join('|');
    if(seen.has(k)) continue; seen.add(k); out.push(a);
  }
  return out;
}
function engAcctNet30(acct){
  if(!dataLoaded||!acct._acct) return null;
  const cut=new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  const txns=allTxns.filter(t=>t.account_id===acct.id&&t.date>=cut);
  const net=txns.reduce((s,t)=>s+(t.amount>0?-t.amount:Math.abs(t.amount)),0);
  return {net, count:txns.length, txns:txns.slice(0,25)};
}
function engAcctTypeTotals(){
  const accts=engAccounts(); const t={cash:0,investment:0,credit:0};
  accts.forEach(a=>{ if(a.excluded)return; if(_isDebtAcct(a))t.credit+=Math.abs(a.bal); else if(a.type==='investment')t.investment+=a.bal; else t.cash+=a.bal; });
  return t;
}

/* ── Bill management: mark paid / set custom payment (persists to APP) ── */
function _billOverrides(){ APP.billOverrides=APP.billOverrides||{}; return APP.billOverrides; }
function billKey(b){ return (b.name||'')+'|'+(b.cat||''); }
function applyBillOverrides(list){
  const ov=_billOverrides();
  return list.map(b=>{
    const o=ov[billKey(b)]||{};
    const min=b.min!=null?b.min:b.pay;            // Plaid (or manual) minimum
    const expected=o.pay!==undefined?o.pay:b.pay; // user's expected payment (defaults to bill's pay)
    return {...b, min, pay:expected, expected, paid:o.paid!==undefined?o.paid:b.paid};
  });
}
function toggleBillPaid(key){
  const ov=_billOverrides(); ov[key]=ov[key]||{}; ov[key].paid=!ov[key].paid; saveState();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(ov[key].paid){ try{ gamiMarkEngaged('billpaid'); }catch(e){} try{ emojiBurst('coin',{particle:'coin',count:8,life:1600}); }catch(e){} const nm=(key.split('|')[0]||'that').trim(); try{ richieCelebrate(`Boom — ${nm} marked paid! ✅ One less thing on the list.`); }catch(e){} }
}
function setBillPay(key,val){
  const ov=_billOverrides(); ov[key]=ov[key]||{}; const n=parseFloat(val); if(!isNaN(n)&&n>=0) ov[key].pay=n; saveState();
}
function setBillPayCommit(){ const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }

/* ── Manual bills & accounts editor (items not linked to Plaid) ── */
let _manualEdit={kind:'bill', idx:null};
let _aeKey=null;   // storage key for the account currently open in the account editor
function openManualBill(idx){ _manualEdit={kind:'bill', idx:(idx==null?null:idx)}; gg('manualModal').style.display='flex'; manualRender(); }
function openManualCard(){ _manualEdit={kind:'bill', idx:null, preset:'card'}; gg('manualModal').style.display='flex'; manualRender(); }
function openManualAccount(idx){ _manualEdit={kind:'account', idx:(idx==null?null:idx)}; gg('manualModal').style.display='flex'; manualRender(); }
function closeManual(){ gg('manualModal').style.display='none'; }
function manualRender(){
  const k=_manualEdit.kind, editing=_manualEdit.idx!=null, card=(_manualEdit.preset==='card');
  gg('manualTitle').textContent=(editing?'Edit ':'Add ')+(k==='bill'?(card?'a credit card':'a bill'):'an account');
  gg('manualSub').textContent=k==='bill'?(card?'Enter its balance, limit, and any 0% promo end date.':'A bill or recurring payment you manage manually.'):'An account or balance not linked to a bank.';
  const body=gg('manualBody');
  if(k==='bill'){
    const b=editing?(APP.manualBills||[])[_manualEdit.idx]:{name:'',pay:'',min:'',bal:'',apr:'',due:1,cat:(_manualEdit.preset==='card'?'CC':'OTHER'),note:''};
    body.innerHTML=`
      <label class="mf-label">Name</label><input class="mf-in" id="mfName" value="${esc(b.name||'')}" placeholder="e.g. Car insurance">
      <div class="mf-row">
        <div><label class="mf-label">You pay / mo</label><input class="mf-in" id="mfPay" type="number" value="${b.pay||''}" placeholder="0"></div>
        <div><label class="mf-label">Minimum (optional)</label><input class="mf-in" id="mfMin" type="number" value="${b.min||''}" placeholder="same as pay"></div>
      </div>
      <div class="mf-row">
        <div><label class="mf-label">Balance owed (optional)</label><input class="mf-in" id="mfBal" type="number" value="${b.bal?Math.abs(b.bal):''}" placeholder="0 = just a bill"></div>
        <div><label class="mf-label">APR % (optional)</label><input class="mf-in" id="mfApr" type="number" value="${b.apr||''}" placeholder="0"></div>
      </div>
      <div class="mf-row">
        <div><label class="mf-label">Due day (1–31)</label><input class="mf-in" id="mfDue" type="number" min="1" max="31" value="${b.due||1}"></div>
        <div><label class="mf-label">Category</label><select class="mf-in" id="mfCat">${['OTHER','CC','LOAN','HM','SUB','UTIL','INS','AUTO'].map(c=>`<option value="${c}"${b.cat===c?' selected':''}>${c}</option>`).join('')}</select></div>
      </div>
      <div class="mf-row">
        <div><label class="mf-label">0% promo ends (optional)</label><input class="mf-in" id="mfPromoEnd" type="date" value="${b.promoEnd||''}"></div>
        <div><label class="mf-label">Credit limit (optional)</label><input class="mf-in" id="mfLimit" type="number" value="${b.limit||''}" placeholder="for utilization"></div>
      </div>
      <div class="mf-actions">
        ${editing?`<button class="btn danger-btn" onclick="deleteManualBill(${_manualEdit.idx})">Delete</button>`:'<span></span>'}
        <button class="btn primary" onclick="saveManualBill()">${editing?'Save':'Add bill'}</button>
      </div>`;
  } else {
    const a=editing?(APP.manualAccounts||[])[_manualEdit.idx]:{name:'',bal:'',type:'depository',subtype:'checking',institution:''};
    body.innerHTML=`
      <label class="mf-label">Account name</label><input class="mf-in" id="mfName" value="${esc(a.name||'')}" placeholder="e.g. Cash envelope, Crypto wallet">
      <div class="mf-row">
        <div><label class="mf-label">Balance</label><input class="mf-in" id="mfBal" type="number" value="${a.bal||''}" placeholder="0"></div>
        <div><label class="mf-label">Type</label><select class="mf-in" id="mfType" onchange="document.getElementById('mfNeg').style.display=this.value==='credit'?'block':'none';document.getElementById('mfContribWrap').style.display=this.value==='investment'?'block':'none'">${[['depository','Cash / Bank'],['investment','Investment'],['credit','Credit / Debt'],['other','Other asset']].map(t=>`<option value="${t[0]}"${a.type===t[0]?' selected':''}>${t[1]}</option>`).join('')}</select></div>
      </div>
      <div id="mfNeg" style="display:${a.type==='credit'?'block':'none'};font-size:11.5px;color:var(--muted);margin-bottom:8px">Credit/debt balances are counted as money owed.</div>
      <div id="mfContribWrap" style="display:${a.type==='investment'?'block':'none'}"><label class="mf-label">Planned contribution / mo</label><input class="mf-in" id="mfContrib" type="number" inputmode="decimal" value="${a.contrib||''}" placeholder="e.g. 500 — feeds the retirement calculator"></div>
      <label class="mf-label">Institution (optional)</label><input class="mf-in" id="mfInst" value="${esc(a.institution||'')}" placeholder="e.g. Local Credit Union">
      <div class="mf-actions">
        ${editing?`<button class="btn danger-btn" onclick="deleteManualAccount(${_manualEdit.idx})">Delete</button>`:'<span></span>'}
        <button class="btn primary" onclick="saveManualAccount()">${editing?'Save':'Add account'}</button>
      </div>`;
  }
}
/* ═══ INCOME STREAM EDITOR (multi-cadence paychecks) ═══ */
function _incomeList(){
  if(!APP.incomeSources || !APP.incomeSources.length){
    APP.incomeSources = incomeSources.map(s=>({...s}));
  }
  return APP.incomeSources;
}
function openIncomeEditor(){
  _incomeList();
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Income streams';
  gg('manualSub').textContent='Set each paycheck and its cadence — biweekly streams naturally land 3× in some months.';
  incomeEditorRender();
}
function incomeEditorRender(){
  const list=_incomeList();
  const mo=engMonthlyIncome();
  const freqLabel={weekly:'Weekly',biweekly:'Every 2 weeks',monthly:'Monthly',quarterly:'Quarterly',annual:'Annual'};
  // Streams detected from transactions tagged 💵 Paycheck — live-linked, per payee.
  const detected=_paycheckSources();
  const detRows=detected.map(s=>{
    const active=_paycheckActive(s);
    const perMo=Math.round(s.amt*(FREQ_TO_MONTHLY[s.freq]||1));
    let status='';
    if(s.disabled) status=`<span style="color:var(--red)"> · ⏸ paused</span>`;
    else if(s.endDate){ const ended=!active; status=`<span style="color:${ended?'var(--red)':'var(--amber)'}"> · ${ended?'ended':'ends'} ${new Date(s.endDate+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>`; }
    else if(s.overridden) status=`<span style="color:var(--amber)"> · adjusted</span>`;
    return `<div class="inc-row"${active?'':' style="opacity:.55"'}>
      <div class="inc-main">
        <div class="inc-nm">🔗 ${esc(s.name)}${status}</div>
        <div class="inc-sub">${fmtK(s.amt)} · ${freqLabel[s.freq]||s.freq} · from ${s.count} tagged deposit${s.count!==1?'s':''}${active?` → ${fmtK(perMo)}/mo`:' → not counted'}</div>
      </div>
      <div class="inc-actions"><button class="goal-mini" onclick="editDetectedIncome('${esc(s.key).replace(/'/g,"\\'")}')" title="Adjust or stop">✎</button></div>
    </div>`;
  }).join('');
  const detSection=detected.length?`<div class="nw-sec-h"><span>🔗 From tagged paychecks</span></div>${detRows}<div class="ws-hint" style="margin:4px 0 10px">Detected from transactions tagged 💵 Paycheck — median amount, real payday cadence. Tap ✎ to adjust the amount/cadence, set an end date (e.g. a job loss), or pause a stream.</div>`:'';
  const rows=list.map((s,i)=>{
    const perMo=Math.round(s.amt*(FREQ_TO_MONTHLY[s.freq]||1));
    return `<div class="inc-row">
      <div class="inc-main">
        <div class="inc-nm">${esc(s.name)}</div>
        <div class="inc-sub">${fmtK(s.amt)} · ${freqLabel[s.freq]||s.freq}${s.anchor?` · next ${new Date(s.anchor+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})}`:s.day?` · day ${s.day}`:''} → ${fmtK(perMo)}/mo</div>
      </div>
      <div class="inc-actions">
        <button class="goal-mini" onclick="editIncome(${i})" title="Edit">✎</button>
        <button class="goal-mini danger" onclick="deleteIncome(${i})" title="Remove">✕</button>
      </div>
    </div>`;
  }).join('');
  gg('manualBody').innerHTML=`
    <div class="inc-total">Total estimated income <b style="color:var(--green)">${fmtK(mo)}/mo</b></div>
    ${detSection}
    ${detected.length?`<div class="nw-sec-h"><span>Manual streams</span></div>`:''}
    <div class="inc-list">${rows||'<div class="ws-hint">No income streams yet.</div>'}</div>
    <button class="manual-add-btn" onclick="editIncome(-1)">➕ Add an income stream</button>
    <div class="nw-sec-h" style="margin-top:14px"><span>🎁 One-time deposits</span></div>
    <div class="ws-hint" style="margin:0 0 6px">A bonus, gift, or tax refund — appears on its date in Cash Flow, not counted as recurring monthly income.</div>
    <div class="inc-list">${((APP.oneOffIncome||[]).map((o,i)=>`<div class="inc-row"><div class="inc-main"><div class="inc-nm">🎁 ${esc(o.name||'One-time deposit')}</div><div class="inc-sub">${fmtK(+o.amt||0)} · ${o.date?new Date(o.date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'no date'}</div></div><div class="inc-actions"><button class="goal-mini" onclick="openOneOffForm(${i})" title="Edit">✎</button><button class="goal-mini danger" onclick="deleteOneOff(${i})" title="Remove">✕</button></div></div>`).join(''))||'<div class="ws-hint">None yet.</div>'}</div>
    <button class="manual-add-btn" onclick="openOneOffForm(-1)">➕ Add a one-time deposit</button>`;
}
// Adjust or stop a detected (tag-linked) stream. Detection stays live; this overrides it.
function editDetectedIncome(key){
  const s=_paycheckSources().find(x=>x.key===key); if(!s) return;
  const freqOpts=[['weekly','Weekly'],['biweekly','Every 2 weeks'],['monthly','Monthly'],['quarterly','Quarterly'],['annual','Annual']];
  gg('manualTitle').textContent='Adjust income stream';
  gg('manualSub').textContent=esc(s.name)+' · detected from '+s.count+' tagged deposit'+(s.count!==1?'s':'');
  gg('manualBody').innerHTML=`
    <div class="mf-row">
      <div><label class="mf-label">Amount per check</label><input class="mf-in" id="doAmt" type="number" value="${s.amt}" placeholder="${s.detAmt}"></div>
      <div><label class="mf-label">Frequency</label><select class="mf-in" id="doFreq">${freqOpts.map(o=>`<option value="${o[0]}"${s.freq===o[0]?' selected':''}>${o[1]}</option>`).join('')}</select></div>
    </div>
    <label class="mf-label">Next / last payday</label>
    <input class="mf-in" id="doAnchor" type="date" value="${esc(s.anchor||'')}">
    <label class="mf-label" style="margin-top:10px">Stops after <span class="ws-hint" style="display:inline">· leave blank if ongoing</span></label>
    <input class="mf-in" id="doEnd" type="date" value="${esc(s.endDate||'')}">
    <div class="ws-hint" style="margin-top:3px">Set this to the last real paycheck — e.g. when a job ends — and no future income is projected past it.</div>
    <label class="ae-toggle" style="margin-top:10px"><input type="checkbox" id="doPause" ${s.disabled?'checked':''}><span>⏸ Pause this stream — stop counting it entirely, now</span></label>
    <div class="mf-actions">
      ${s.overridden?`<button class="btn danger-btn" onclick="resetDetectedOverride('${esc(key).replace(/'/g,"\\'")}')" title="Clear overrides, go back to auto-detected">↺ Reset to detected</button>`:'<span></span>'}
      <button class="btn" onclick="incomeEditorRender()">Cancel</button>
      <button class="btn primary" onclick="saveDetectedOverride('${esc(key).replace(/'/g,"\\'")}')">Save</button>
    </div>`;
}
function saveDetectedOverride(key){
  const s=_paycheckSources().find(x=>x.key===key)||{};
  const amt=_num('doAmt'), freq=gg('doFreq').value, anchor=(gg('doAnchor').value||'').trim();
  const endDate=(gg('doEnd').value||'').trim(), disabled=!!(gg('doPause')&&gg('doPause').checked);
  const rec={};
  if(amt>0 && amt!==s.detAmt) rec.amt=amt;
  if(freq && freq!==s.detFreq) rec.freq=freq;
  if(anchor && anchor!==s.detAnchor) rec.anchor=anchor;
  if(endDate) rec.endDate=endDate;
  if(disabled) rec.disabled=true;
  const ov=_incomeOverrides();
  if(Object.keys(rec).length) ov[key]=rec; else delete ov[key];
  saveState(); incomeEditorRender();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod');
}
function resetDetectedOverride(key){
  delete _incomeOverrides()[key]; saveState(); incomeEditorRender();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}
let _incEdit=null;
function editIncome(i){
  _incEdit=i;
  const list=_incomeList();
  const s = i>=0 ? list[i] : {name:'',amt:'',freq:'biweekly',anchor:'',day:1};
  const freqOpts=[['weekly','Weekly'],['biweekly','Every 2 weeks'],['monthly','Monthly'],['quarterly','Quarterly'],['annual','Annual']];
  gg('manualTitle').textContent = i>=0?'Edit income':'Add income';
  gg('manualSub').textContent='How much, how often, and when the next one lands.';
  gg('manualBody').innerHTML=`
    <label class="mf-label">Name</label>
    <input class="mf-in" id="incName" value="${esc(s.name||'')}" placeholder="e.g. Paycheck">
    <div class="mf-row">
      <div><label class="mf-label">Amount per check</label><input class="mf-in" id="incAmt" type="number" value="${s.amt||''}" placeholder="0"></div>
      <div><label class="mf-label">Frequency</label><select class="mf-in" id="incFreq" onchange="incFreqChange()">${freqOpts.map(o=>`<option value="${o[0]}"${s.freq===o[0]?' selected':''}>${o[1]}</option>`).join('')}</select></div>
    </div>
    <div id="incAnchorWrap">
      <label class="mf-label" id="incAnchorLabel">Next payday</label>
      <input class="mf-in" id="incAnchor" type="date" value="${s.anchor||''}">
      <div class="ws-hint" id="incAnchorHint">Biweekly/weekly: pick any real payday — I'll project the rest forward, including 3-paycheck months.</div>
    </div>
    <div id="incDayWrap" style="display:none">
      <label class="mf-label">Day of month (1–31)</label>
      <input class="mf-in" id="incDay" type="number" min="1" max="31" value="${s.day||1}">
    </div>
    <div class="mf-actions">
      ${i>=0?`<button class="btn danger-btn" onclick="deleteIncome(${i})">Delete</button>`:'<span></span>'}
      <button class="btn primary" onclick="saveIncome()">${i>=0?'Save':'Add'}</button>
    </div>`;
  incFreqChange();
}
function incFreqChange(){
  const f=gg('incFreq').value;
  const isMonthly = f==='monthly';
  gg('incDayWrap').style.display = isMonthly?'block':'none';
  gg('incAnchorWrap').style.display = isMonthly?'none':'block';
  const lbl=gg('incAnchorLabel'), hint=gg('incAnchorHint');
  if(f==='quarterly'){ if(lbl)lbl.textContent='Next payment date'; if(hint)hint.textContent='I\'ll repeat this every 3 months.'; }
  else if(lbl){ lbl.textContent='Next payday'; if(hint)hint.textContent='Pick any real payday — I\'ll project the rest forward, including 3-paycheck months.'; }
}
function saveIncome(){
  const name=(gg('incName').value||'').trim(); if(!name){ gg('incName').focus(); return; }
  const amt=_num('incAmt'); const freq=gg('incFreq').value;
  const item={name, amt, freq};
  if(freq==='monthly'){ item.day=Math.max(1,Math.min(31,_num('incDay')||1)); }
  else { const a=gg('incAnchor').value; if(a) item.anchor=a; }
  const list=_incomeList();
  if(_incEdit>=0) list[_incEdit]=item; else list.push(item);
  saveState(); incomeEditorRender();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod');
}
function deleteIncome(i){
  if(!confirm('Remove this income stream?')) return;
  _incomeList().splice(i,1); saveState(); incomeEditorRender();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}
// One-time deposits (bonus/gift/refund) — single dated inflows in Cash Flow, not monthly income.
function openOneOffForm(i){
  const list=APP.oneOffIncome||[]; const o = i>=0?(list[i]||{}):{name:'',amt:'',date:''};
  gg('manualTitle').textContent = i>=0?'Edit one-time deposit':'Add one-time deposit';
  gg('manualSub').textContent = 'A single dated inflow — bonus, gift, tax refund. Shows in Cash Flow on its date.';
  gg('manualBody').innerHTML=`
    <label class="mf-label">What is it?</label>
    <input class="mf-in" id="ooName" type="text" placeholder="Bonus / Gift / Tax refund" value="${esc(o.name||'')}">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      <div><label class="mf-label">Amount</label><input class="mf-in" id="ooAmt" type="number" min="0" step="10" value="${o.amt!=null?esc(String(o.amt)):''}"></div>
      <div><label class="mf-label">Date</label><input class="mf-in" id="ooDate" type="date" value="${esc(o.date||'')}"></div>
    </div>
    <div class="mf-actions">
      <button class="btn" onclick="incomeEditorRender()">Cancel</button>
      <button class="btn primary" onclick="saveOneOff(${i})">Save</button>
    </div>`;
  setTimeout(()=>{ const n=gg('ooName'); if(n) n.focus(); },60);
}
function saveOneOff(i){
  const amt=Math.max(0, parseFloat(gg('ooAmt').value)||0);
  const date=(gg('ooDate').value||'').trim();
  if(!(amt>0)){ gg('ooAmt').focus(); return; }
  if(!date){ gg('ooDate').focus(); return; }
  const name=(gg('ooName').value||'').trim()||'One-time deposit';
  APP.oneOffIncome=APP.oneOffIncome||[];
  const rec={ id:(i>=0&&APP.oneOffIncome[i]&&APP.oneOffIncome[i].id)||('oo'+Date.now()), name, amt, date };
  if(i>=0) APP.oneOffIncome[i]=rec; else APP.oneOffIncome.push(rec);
  saveState(); try{ _memoInvalidate&&_memoInvalidate(); }catch(e){}
  incomeEditorRender();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(typeof richieSay==='function' && i<0){ try{ richieSay(`Added ${fmtK(amt)} on ${new Date(date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})} — it's in your Cash Flow now. Uncheck it there if plans change.`); }catch(e){} }
}
function deleteOneOff(i){
  const list=APP.oneOffIncome||[]; if(i<0||i>=list.length) return;
  list.splice(i,1); saveState(); try{ _memoInvalidate&&_memoInvalidate(); }catch(e){}
  incomeEditorRender();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}

function _num(id){ const v=parseFloat(gg(id)?.value); return isNaN(v)?0:v; }
function saveManualBill(){
  const name=(gg('mfName').value||'').trim(); if(!name){ gg('mfName').focus(); return; }
  const pay=_num('mfPay'), min=gg('mfMin').value?_num('mfMin'):pay, bal=_num('mfBal'), apr=_num('mfApr'), due=Math.max(1,Math.min(31,_num('mfDue')||1));
  const cat=gg('mfCat').value;
  const promoEnd=(gg('mfPromoEnd')&&gg('mfPromoEnd').value)||'';
  const limit=gg('mfLimit')?_num('mfLimit'):0;
  const item={name, pay, min, bal:bal?-Math.abs(bal):0, apr, due, cat, promoEnd, limit, promo:promoEnd?'0% APR':'', note:'manual', paid:false};
  APP.manualBills=APP.manualBills||[];
  if(_manualEdit.idx!=null) APP.manualBills[_manualEdit.idx]=item; else APP.manualBills.push(item);
  saveState(); closeManual(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod');
}
function deleteManualBill(idx){ if(!confirm('Delete this bill?'))return; APP.manualBills.splice(idx,1); saveState(); closeManual(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function saveManualAccount(){
  const name=(gg('mfName').value||'').trim(); if(!name){ gg('mfName').focus(); return; }
  const type=gg('mfType').value; let bal=_num('mfBal');
  if(type==='credit') bal=-Math.abs(bal);
  const subtype={depository:'checking',investment:'investment',credit:'credit card',other:'other'}[type];
  const item={name, bal, type, subtype, institution:(gg('mfInst').value||'').trim(), id:'m'+Date.now()};
  if(type==='investment'&&gg('mfContrib')) item.contrib=_num('mfContrib');
  APP.manualAccounts=APP.manualAccounts||[];
  if(_manualEdit.idx!=null) APP.manualAccounts[_manualEdit.idx]=item; else APP.manualAccounts.push(item);
  saveState(); closeManual(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod');
}
function deleteManualAccount(idx){ if(!confirm('Delete this account?'))return; APP.manualAccounts.splice(idx,1); saveState(); closeManual(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function engSpend30(){ return engRecent(30).filter(t=>t.amount>0 && !_txnExcludedFromSpend(t)).reduce((s,t)=>s+t.amount,0); }
function engIncome30(){ return engRecent(30).filter(_isIncomeTxn).reduce((s,t)=>s+Math.abs(t.amount),0); }
// Generalized windowed spend/income (any day count)
function engSpend(days){ return engRecent(days).filter(t=>t.amount>0 && !_txnExcludedFromSpend(t)).reduce((s,t)=>s+t.amount,0); }
// Any inflow landing on a liability account (credit card, loan, mortgage) is a debt paydown, not income.
// Set of liability account ids, built once per frame — the old per-transaction
// allAccts.find() made every income scan O(accounts × transactions).
function _debtAcctIds(){
  return _memoFrame('debtAcctIds', ()=>{
    const set=new Set();
    (allAccts||[]).forEach(a=>{
      if(a.type==='credit'||a.type==='loan'){ set.add(a.account_id); return; }
      try{ const def=ACCT_CAT_BY_ID[getAccountCategory(a)]; if(def&&def.kind==='liability') set.add(a.account_id); }catch(e){}
    });
    return set;
  });
}
function _txnIsToDebtAcct(t){ return _debtAcctIds().has(t.account_id); }
// Categories that are NEVER income — debt/liability payments and internal transfers.
const NON_INCOME_CATEGORIES=new Set(['Loan Payments','Auto Payments','Mortgage','Credit Card','Loans','Loan','Savings & Invest','Debt','Housing']);
// A transaction counts as income only if it's an inflow that isn't a tagged transfer/refund,
// isn't a payment landing on a liability account, and isn't in a liability/transfer category.
function _isIncomeTxn(t){ return t.amount<0 && !_txnExcludedFromIncome(t) && !_txnIsToDebtAcct(t) && !NON_INCOME_CATEGORIES.has(getTxnCategory(t)); }
function engIncome(days){ return engRecent(days).filter(_isIncomeTxn).reduce((s,t)=>s+Math.abs(t.amount),0); }
// Timeframe options: label, days, and a noun for "per period"
const TIMEFRAMES=[{key:'1w',label:'1 wk',days:7},{key:'30d',label:'30 days',days:30},{key:'3m',label:'3 mo',days:90},{key:'1y',label:'1 yr',days:365}];
function tfDays(key){ const t=TIMEFRAMES.find(x=>x.key===key); return t?t.days:30; }
function tfLabel(key){ const t=TIMEFRAMES.find(x=>x.key===key); return t?t.label:'30 days'; }
function engTotalDebt(){ return allAccts.filter(a=>_isDebtAcct(a)).reduce((s,a)=>s+Math.abs((a.balances&&a.balances.current)||0),0); }
function engCategoryBreakdown(days){
  const rec=engRecent(days).filter(t=>t.amount>0 && !_txnExcludedFromSpend(t)); const byCat={};
  rec.forEach(t=>{ const c=getTxnCategory(t); byCat[c]=(byCat[c]||0)+t.amount; });
  return Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([label,value])=>({label,value,color:getCatColor(label)}));
}
/* ═══ DISCRETIONARY SPENDING ═══
   "Discretionary" = day-to-day controllable spend. Excludes fixed bills (housing,
   utilities, insurance, loans, auto payments) and non-spend flows (savings, income). */
const NON_DISCRETIONARY=new Set(['Housing','Utilities','Insurance','Loan Payments','Auto Payments','Savings & Invest','Income','Mortgage','House','Auto','Rent','Loans','Loan']);
function isDiscretionary(label){ return !NON_DISCRETIONARY.has(label); }
function engDiscretionaryBreakdown(days){ return engCategoryBreakdown(days).filter(r=>isDiscretionary(r.label)); }
function engDiscretionarySpend(days){ return engDiscretionaryBreakdown(days).reduce((s,r)=>s+r.value,0); }
// Discretionary monthly budget = zero-based envelopes minus savings/emergency
function engDiscretionaryBudget(){
  const buckets=(APP.zeroBuckets||zeroBuckets);
  const skip=new Set(['savings','emergency fund','emergency']);
  return buckets.filter(b=>!skip.has((b.name||'').toLowerCase())).reduce((s,b)=>s+(b.amt||0),0);
}
/* ── Budget-linked spending: Current Spending tracks exactly the categories that have a
   Zero-Based Budget envelope (amt>0), so the widget and the budget always agree.
   Savings-type envelopes are skipped — moving money to savings isn't spending. ── */
const _BUDGET_SKIP=new Set(['savings','emergency fund','emergency','savings & invest']);
function _budgetCatSet(){
  const out=new Set();
  _zbBuckets().forEach(b=>{ if((b.amt||0)>0 && !_BUDGET_SKIP.has((b.name||'').toLowerCase())) out.add(b.name); });
  return out;
}
function engBudgetLinkedBudget(){
  const cats=_budgetCatSet();
  return _zbBuckets().filter(b=>cats.has(b.name)).reduce((s,b)=>s+(b.amt||0),0);
}
// Spend per month for the trend sparkline — budget categories when a catSet is given,
// else the legacy discretionary set.
function engDiscretionaryMonthly(months, catSet){
  months=months||6;
  const g=engCategoryMonthGrid(months);
  const discCats=g.cats.filter(c=>catSet?catSet.has(c.label):isDiscretionary(c.label));
  return g.months.map((mo,i)=>({label:mo, value:Math.round(discCats.reduce((s,c)=>s+(c.vals[i]||0),0))}));
}
// tiny inline SVG sparkline
function _sparkline(vals, color, w, h){
  w=w||120; h=h||28; if(!vals.length) return '';
  const max=Math.max(...vals,1), min=Math.min(...vals,0);
  const rng=(max-min)||1;
  const pts=vals.map((v,i)=>{ const x=(i/(vals.length-1||1))*w; const y=h-((v-min)/rng)*(h-4)-2; return `${x.toFixed(1)},${y.toFixed(1)}`; }).join(' ');
  const lastX=w, lastY=h-((vals[vals.length-1]-min)/rng)*(h-4)-2;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" fill="${color}"/></svg>`;
}
// SVG donut chart (used by Budget by Category two-tier view)
function _arcPath(cx,cy,r,ir,a0,a1){
  const x0=cx+r*Math.cos(a0), y0=cy+r*Math.sin(a0);
  const x1=cx+r*Math.cos(a1), y1=cy+r*Math.sin(a1);
  const xi1=cx+ir*Math.cos(a1), yi1=cy+ir*Math.sin(a1);
  const xi0=cx+ir*Math.cos(a0), yi0=cy+ir*Math.sin(a0);
  const large=(a1-a0)>Math.PI?1:0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L ${xi1.toFixed(2)} ${yi1.toFixed(2)} A ${ir} ${ir} 0 ${large} 0 ${xi0.toFixed(2)} ${yi0.toFixed(2)} Z`;
}
function _donutSVG(items, size, centerLabel, centerSub){
  size=size||130; const cx=size/2, cy=size/2, r=size/2-3, ir=r*0.6;
  const live=items.filter(i=>i.value>0);
  const total=live.reduce((s,i)=>s+i.value,0)||1;
  let segs;
  if(live.length<=1){
    const it=live[0]||{color:'var(--surface3)'};
    segs=`<circle cx="${cx}" cy="${cy}" r="${((r+ir)/2).toFixed(2)}" fill="none" stroke="${it.color}" stroke-width="${(r-ir).toFixed(2)}"/>`;
  } else {
    let a0=-Math.PI/2;
    segs=live.map(it=>{ const frac=it.value/total; const a1=a0+frac*2*Math.PI; const p=_arcPath(cx,cy,r,ir,a0,a1); a0=a1; return `<path d="${p}" fill="${it.color}"/>`; }).join('');
  }
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="max-width:100%">${segs}
    <text x="${cx}" y="${cy-1}" text-anchor="middle" font-size="14" font-weight="700" fill="var(--text)">${centerLabel||''}</text>
    <text x="${cx}" y="${cy+12}" text-anchor="middle" font-size="8.5" fill="var(--muted)">${centerSub||''}</text></svg>`;
}
// Query-aware breakdown: honors category include-list and amount filters from widget config
function engCategoryBreakdownQ(days, query){
  let rows=engCategoryBreakdown(days);
  if(query){
    if(query.categories&&query.categories.length){ rows=rows.filter(r=>query.categories.includes(r.label)); }
    if(query.minAmt!=null){ rows=rows.filter(r=>r.value>=query.minAmt); }
    if(query.maxAmt!=null){ rows=rows.filter(r=>r.value<=query.maxAmt); }
  }
  return rows;
}
// All known category labels (for the query builder UI)
function allCategoryLabels(){ return getUserCategories().filter(c=>!c.group).map(c=>c.label); }
// All account names (for the query builder UI)
function allAccountNames(){ return dataLoaded?allAccts.map(a=>a.name||a.official_name||a.type):['Checking','Savings','Credit Card']; }

/* ═══ SAVINGS BUCKETS / SINKING FUNDS ═══ */
function _savingsBuckets(){
  if(!APP.savingsBuckets) APP.savingsBuckets=savingsBuckets.map(b=>({...b}));
  return APP.savingsBuckets;
}
// A bucket linked to a Plaid account pulls its balance live; otherwise uses the manual amount.
function _bucketBalance(b){
  if(b.acctId){ const a=engAccounts().find(x=>x.id===b.acctId); if(a) return a.bal; }
  return b.balance||0;
}
function engSavingsBuckets(){
  return _savingsBuckets().map(b=>{
    const balance=_bucketBalance(b);
    const pct = b.target>0 ? Math.max(0,Math.min(100, balance/b.target*100)) : (balance>0?100:0);
    const remaining = Math.max(0, (b.target||0)-balance);
    const monthsToGoal = (b.monthly>0 && remaining>0) ? Math.ceil(remaining/b.monthly) : (remaining<=0?0:Infinity);
    return {...b, balance, linked:!!b.acctId, pct, remaining, monthsToGoal, done: b.target>0 && balance>=b.target};
  });
}
function engSavingsTotal(){ return _savingsBuckets().reduce((s,b)=>s+_bucketBalance(b),0); }

/* ═══ BUDGET vs ACTUAL ═══
   Compares each zero-based budget envelope against actual spending in that category
   over the selected window. Falls back to sample data when no live txns. */
// Is any category spending ahead of pace this month? (actual vs budget × fraction of month elapsed)
function engPaceAlert(){
  if(!dataLoaded) return null;
  const now=new Date();
  const dom=now.getDate(), dim=new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const frac=dom/dim;
  if(frac<0.2) return null;   // too early in the month to judge
  const buckets=_zbBuckets();
  const actual={}; try{ engCategoryBreakdown(dom).forEach(r=>{ actual[r.label]=r.value; }); }catch(e){ return null; }
  let worst=null;
  buckets.forEach(b=>{
    const budget=b.amt||0; if(budget<=0) return;
    const spent=actual[b.name]||0; if(spent<25) return;
    const expected=budget*frac;
    if(spent>expected*1.25){ const over=spent-expected; if(!worst||over>worst.over) worst={name:b.name, spent, budget, over, daysLeft:dim-dom}; }
  });
  return worst;
}
function engBudgetVsActual(days){
  days = days||30;
  const buckets = _zbBuckets();  // category-linked envelopes ({catId,name,amt})
  const scale = days/30;
  let actualByLabel={}, live=false;
  if(dataLoaded){
    live=true;
    engCategoryBreakdown(days).forEach(r=>{ actualByLabel[r.label]=r.value; });
  } else {
    const sample={'Food & Groceries':412,'Dining Out':286,'Gas & Fuel':233,'Medical':178,'Shopping':64,'Entertainment':121,'Subscriptions':142,'Savings & Invest':500,'Other':92,'Housing':2640,'Utilities':320,'Insurance':266,'Loan Payments':780,'Auto Payments':452,'Travel':96};
    Object.entries(sample).forEach(([k,v])=>actualByLabel[k]=v*scale);
  }
  const budgeted=new Set();
  const rows = buckets.map(b=>{
    budgeted.add(b.name);
    const budget = (b.amt||0)*scale;
    const actual = actualByLabel[b.name] || 0;
    const diff = budget - actual;            // positive = under budget (good)
    const pct = budget>0 ? Math.min(150, actual/budget*100) : (actual>0?150:0);
    return { name:b.name, color:getCatColor(b.name), budget, actual, diff, pct, over: actual>budget, unbudgeted:false };
  });
  // discretionary categories you spent in but never budgeted (bills are covered separately)
  Object.keys(actualByLabel).forEach(label=>{
    if(budgeted.has(label)) return;
    if(!isDiscretionary(label)) return;     // skip fixed bills — they're not "unbudgeted"
    const actual=actualByLabel[label]; if(actual<1) return;
    rows.push({ name:label, color:getCatColor(label), budget:0, actual, diff:-actual, pct:150, over:true, unbudgeted:true });
  });
  rows.sort((a,b)=> (a.unbudgeted?1:0)-(b.unbudgeted?1:0) || b.actual-a.actual);
  const totBudget=rows.reduce((s,r)=>s+r.budget,0);
  const totActual=rows.reduce((s,r)=>s+r.actual,0);
  return { rows, totBudget, totActual, totDiff: totBudget-totActual, days, live };
}

/* ── Real financial data (ported from live app) ── */
let bills=[
  {cat:'HM',name:'Rent / Mortgage',note:'Example',apr:0,due:1,bal:0,min:1500,pay:1500,promo:'',promoEnd:'',limit:0,paid:false},
  {cat:'CAR',name:'Car Loan',note:'Example',apr:5.9,due:15,bal:-12000,min:325,pay:325,promo:'',promoEnd:'',limit:0,paid:false},
  {cat:'HM',name:'Utilities',note:'Example',apr:0,due:10,bal:0,min:180,pay:180,promo:'',promoEnd:'',limit:0,paid:false},
  {cat:'CC',name:'Credit Card',note:'Example · 0% promo',apr:19.99,due:5,bal:-850,min:35,pay:150,promo:'0% APR',promoEnd:'2026-12-01',limit:5000,paid:false},
];
let incomeSources=[
  {name:'Paycheck (example)',freq:'biweekly',amt:2000,anchor:'2026-01-09'},
];
let zeroBuckets=[
  {name:'Groceries',amt:400},{name:'Dining out',amt:150},
  {name:'Gas',amt:120},{name:'Savings',amt:300},
];
// Sinking funds / savings buckets — a couple of generic examples to learn from.
let savingsBuckets=[
  {name:'Emergency Fund',icon:'🛟',balance:1000,target:10000,monthly:100,note:'Example'},
  {name:'Vacation',icon:'🏖️',balance:400,target:3000,monthly:50,note:'Example'},
];
// Net-worth: Plaid-linked rows fill in when you connect; manual example rows start at 0 for you to edit.
let nwAssets=[
  {cat:'Cash & Bank',name:'Checking accounts',value:0,note:'From Plaid',plaid:true},
  {cat:'Cash & Bank',name:'Savings accounts',value:0,note:'From Plaid',plaid:true},
  {cat:'Investments',name:'Retirement (401k / IRA)',value:0,note:'From Plaid',plaid:true},
  {cat:'Investments',name:'Brokerage accounts',value:0,note:'From Plaid',plaid:true},
  {cat:'Real Estate',name:'Home (example)',value:0,note:'Add your estimate'},
  {cat:'Vehicles',name:'Vehicle (example)',value:0,note:'Add your estimate'},
];
let nwLiab=[
  {cat:'Mortgage',name:'Mortgage (example)',value:0,note:'Add your balance'},
  {cat:'Auto Loans',name:'Car loan (example)',value:0,note:'Add your balance'},
  {cat:'Credit Cards',name:'Credit cards (example)',value:0,note:'From bills'},
];

/* ── Derived metrics from bills/income/net worth ── */
const FREQ_TO_MONTHLY={weekly:52/12, biweekly:26/12, monthly:1, quarterly:1/3, annual:1/12, yearly:1/12};
function engMonthlyIncome(){ return _effectiveIncomeSources().reduce((s,i)=>s+i.amt*(FREQ_TO_MONTHLY[i.freq]||1),0); }

/* ── Cash Flow Projection: build dated income/expense events forward N days,
   then compute a running daily balance starting from current cash. ── */
// Liquid cash = depository balances, EXCLUDING accounts the user marked excluded (a work card,
// a reimbursement account, etc.). Single source of truth so cash never counts money you've hidden.
function _liquidCash(){
  if(dataLoaded){ const ex=(typeof _excludedAcctIds==='function')?_excludedAcctIds():new Set(); return allAccts.filter(a=>a.type==='depository' && !ex.has(a.account_id)).reduce((s,a)=>s+((a.balances&&(a.balances.available??a.balances.current))||0),0); }
  return nwAssets.filter(a=>a.cat==='Cash & Bank').reduce((s,a)=>s+(a.value||0),0);
}
function engStartCash(cats){
  if(cats && cats.length){ return engAccounts().filter(a=>!a.excluded && cats.includes(getAccountCategory(a))).reduce((s,a)=>s+(a.bal||0),0); }
  return _liquidCash();
}
// Build recurring income sources from transactions tagged "Paycheck" in the All
// Transactions widget — the single source of truth for pay. Grouped by PAYEE so each
// earner/employer is its own stream (Matt biweekly, Dana weekly, a side gig) — like
// separate columns in a payroll spreadsheet. Amount uses the MEDIAN deposit, so a
// bonus or three-paycheck month doesn't distort the base pay; cadence comes from the
// median gap between real deposits; the anchor is the latest actual payday.
// User overrides on a detected stream, keyed by payee key: {amt, freq, anchor, endDate, disabled}.
// Detection stays live (median/cadence recompute as deposits arrive); the override adjusts or
// stops a stream — e.g. an earner loses their job, so future income ends on a set date.
function _incomeOverrides(){ APP.incomeOverrides=APP.incomeOverrides||{}; return APP.incomeOverrides; }
function _paycheckSources(){
  const pcs=(dataLoaded?allTxns:[]).filter(t=>getTxnTag(t)==='paycheck' && t.amount<0)
                                    .sort((a,b)=>new Date(a.date)-new Date(b.date));
  if(!pcs.length) return [];
  const groups={};
  pcs.forEach(t=>{ const k=((t.merchant_name||t.name||'paycheck').toLowerCase().replace(/[^a-z]/g,'').slice(0,14))||'paycheck'; (groups[k]=groups[k]||[]).push(t); });
  const ovAll=_incomeOverrides();
  return Object.entries(groups).map(([key,list])=>{
    const amts=list.map(t=>Math.abs(t.amount)).sort((a,b)=>a-b);
    const detAmt=Math.round(amts[Math.floor(amts.length/2)]);
    let detFreq='biweekly';
    if(list.length>=2){
      const gaps=[]; for(let i=1;i<list.length;i++) gaps.push((new Date(list[i].date)-new Date(list[i-1].date))/86400000);
      gaps.sort((a,b)=>a-b); const med=gaps[Math.floor(gaps.length/2)]||14;
      detFreq = med<=8?'weekly' : med<=18?'biweekly' : med<=45?'monthly' : med<=100?'quarterly' : 'monthly';
    }
    const raw=(list[list.length-1].merchant_name||list[list.length-1].name||'Paycheck');
    const detAnchor=list[list.length-1].date;
    const ov=ovAll[key]||{};
    return {
      key, name:(raw.length>26?raw.slice(0,26)+'…':raw),
      amt:(ov.amt!=null?ov.amt:detAmt), freq:(ov.freq||detFreq), anchor:(ov.anchor||detAnchor),
      endDate:(ov.endDate||''), disabled:!!ov.disabled,
      overridden:!!(ov.amt!=null||ov.freq||ov.anchor||ov.endDate||ov.disabled),
      detAmt, detFreq, detAnchor, fromTags:true, count:list.length,
    };
  }).filter(s=>s.amt>0);
}
// Active = not paused and not past its end date. Ended/paused streams still appear in the
// editor (so they can be resumed) but produce no income or future events.
function _paycheckActive(s){
  if(s.disabled) return false;
  if(s.endDate){ const t=new Date(s.endDate+'T23:59:59'); const now=new Date(); now.setHours(0,0,0,0); if(t<now) return false; }
  return true;
}
function _paycheckSource(){ const s=_paycheckSources().filter(_paycheckActive); return s.length?s[0]:null; }   // legacy singular
// Income sources: active tagged paycheck streams win (keeping any manual streams that aren't
// paychecks, e.g. a quarterly bonus you enter by hand); else manual sources / seed.
function _effectiveIncomeSources(){
  const base = (APP.incomeSources && APP.incomeSources.length) ? APP.incomeSources : incomeSources;
  const pcs=_paycheckSources().filter(_paycheckActive);
  if(pcs.length) return [...pcs, ...base.filter(s=>!/pay ?check/i.test(s.name||''))];
  return base;
}
// generate income events with REAL date-anchored cadence within the window.
// Walking actual calendar dates makes biweekly streams naturally land 3x in some
// months ("3rd paycheck"), and puts monthly/quarterly income on real days.
function _incomeEvents(days){
  const out=[]; const today=new Date(); today.setHours(0,0,0,0);
  const horizon=new Date(today); horizon.setDate(horizon.getDate()+days);
  const dayOffset=(d)=>Math.round((d-today)/86400000);
  _effectiveIncomeSources().forEach((src)=>{
    if(src.amt<=0) return;
    // Stream end date (e.g. a job loss): no paychecks projected after it.
    const endTs=src.endDate?new Date(src.endDate+'T23:59:59'):null;
    const okEnd=(d)=>!endTs||d<=endTs;
    const monthly=src.amt*(FREQ_TO_MONTHLY[src.freq]||1);
    if(src.freq==='weekly' || src.freq==='biweekly'){
      const step=src.freq==='weekly'?7:14;
      let cur = src.anchor ? new Date(src.anchor+'T00:00:00') : new Date(today.getTime()+ (src.freq==='weekly'?3:5)*86400000);
      if(isNaN(cur)) cur=new Date(today);
      // A PAST anchor is the last real payday → advance on-cadence to the first occurrence today
      // or later. A FUTURE anchor is a start date (e.g. a new job / est. stream) → begin there,
      // never rewind before it (that was pulling future income back to today and skewing cash flow).
      if(cur < today){ const behind=Math.ceil((today-cur)/(step*86400000)); cur.setDate(cur.getDate()+behind*step); }
      while(cur<=horizon){
        const off=dayOffset(cur);
        if(off>=1 && off<=days && okEnd(cur)) out.push({day:off, amt:src.amt, name:src.name, type:'income', freq:src.freq});
        cur.setDate(cur.getDate()+step);
      }
    } else if(src.freq==='monthly'){
      const dom=src.day||1;
      let cur=new Date(today.getFullYear(), today.getMonth(), dom);
      if(cur<today) cur=new Date(today.getFullYear(), today.getMonth()+1, dom);
      while(cur<=horizon){
        const off=dayOffset(cur);
        if(off>=1 && off<=days && okEnd(cur)) out.push({day:off, amt:src.amt, name:src.name, type:'income', freq:'monthly'});
        cur=new Date(cur.getFullYear(), cur.getMonth()+1, dom);
      }
    } else if(src.freq==='quarterly'){
      let cur = src.anchor ? new Date(src.anchor+'T00:00:00') : new Date(today.getFullYear(), today.getMonth(), 15);
      if(isNaN(cur)) cur=new Date(today.getFullYear(),today.getMonth(),15);
      while(cur < today) cur.setMonth(cur.getMonth()+3);
      while(cur<=horizon){
        const off=dayOffset(cur);
        if(off>=1 && off<=days && okEnd(cur)) out.push({day:off, amt:src.amt, name:src.name, type:'income', freq:'quarterly'});
        cur.setMonth(cur.getMonth()+3);
      }
    } else { // annual / fallback: spread monthly
      for(let d=15; d<=days; d+=30){ const ed=new Date(today.getTime()+d*86400000); if(okEnd(ed)) out.push({day:d, amt:Math.round(monthly), name:src.name, type:'income', freq:src.freq}); }
    }
  });
  // One-time deposits the user added (bonus, gift, tax refund) — a single dated inflow, no cadence.
  (APP.oneOffIncome||[]).forEach(o=>{
    if(!o || !(+o.amt>0) || !o.date) return;
    const d=new Date(o.date+'T00:00:00'); if(isNaN(d)) return;
    const off=dayOffset(d);
    if(off>=1 && off<=days) out.push({day:off, amt:+o.amt, name:o.name||'One-time deposit', type:'income', freq:'once', oneOff:true});
  });
  return out;
}
// A bill's real due date in a given month, clamped to the month's last day (so a "31st" bill
// lands on Feb 28, Apr 30, etc. instead of rolling into the next month).
function _dueDateInMonth(y,m,dom){ const last=new Date(y,m+1,0).getDate(); return new Date(y,m,Math.min(Math.max(dom||1,1),last)); }
// today-relative day offset → a real Date at midnight (for showing actual due dates)
function _projDate(off){ const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+(off||0)); return d; }
// bill events: place each unpaid bill on its REAL due date each calendar month within the window
// (not a rough 30-day step, which drifts off the actual statement date over time).
function _billEvents(days){
  const out=[]; const today=new Date(); today.setHours(0,0,0,0);
  const horizon=new Date(today); horizon.setDate(horizon.getDate()+days);
  engUpcomingBills().filter(b=>!b.paid && b.pay>0).forEach(b=>{
    let cur=_dueDateInMonth(today.getFullYear(), today.getMonth(), b.due);
    if(cur<today) cur=_dueDateInMonth(today.getFullYear(), today.getMonth()+1, b.due);
    while(cur<=horizon){
      const off=Math.round((cur-today)/86400000);
      if(off>=0 && off<=days) out.push({day:off, amt:-(b.pay), name:b.name, type:'bill', key:billKey(b), okey:billKey(b)+'|'+_dk(cur), due:b.due});
      cur=_dueDateInMonth(cur.getFullYear(), cur.getMonth()+1, b.due);
    }
  });
  return out;
}
/* ── Bank business-day awareness (weekends + US federal/bank holidays) ── */
function _nthWeekdayOfMonth(y,m,wd,n){ const first=new Date(y,m,1); const day=1+((wd-first.getDay()+7)%7)+(n-1)*7; return new Date(y,m,day); }
function _lastWeekdayOfMonth(y,m,wd){ const last=new Date(y,m+1,0); const day=last.getDate()-((last.getDay()-wd+7)%7); return new Date(y,m,day); }
function _observedHoliday(d){ const wd=d.getDay(); if(wd===6) return new Date(d.getTime()-86400000); if(wd===0) return new Date(d.getTime()+86400000); return d; }
const _holCache={};
function _bankHolidaySet(year){
  if(_holCache[year]) return _holCache[year];
  const s=new Set(); const key=d=>d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate(); const add=d=>s.add(key(d));
  add(_observedHoliday(new Date(year,0,1)));    // New Year's Day
  add(_nthWeekdayOfMonth(year,0,1,3));          // MLK Day (3rd Mon Jan)
  add(_nthWeekdayOfMonth(year,1,1,3));          // Presidents' Day (3rd Mon Feb)
  add(_lastWeekdayOfMonth(year,4,1));           // Memorial Day (last Mon May)
  add(_observedHoliday(new Date(year,5,19)));   // Juneteenth
  add(_observedHoliday(new Date(year,6,4)));    // Independence Day
  add(_nthWeekdayOfMonth(year,8,1,1));          // Labor Day (1st Mon Sep)
  add(_nthWeekdayOfMonth(year,9,1,2));          // Columbus Day (2nd Mon Oct)
  add(_observedHoliday(new Date(year,10,11)));  // Veterans Day
  add(_nthWeekdayOfMonth(year,10,4,4));         // Thanksgiving (4th Thu Nov)
  add(_observedHoliday(new Date(year,11,25)));  // Christmas
  _holCache[year]=s; return s;
}
function _isBankClosed(d){ const wd=d.getDay(); if(wd===0||wd===6) return true; return _bankHolidaySet(d.getFullYear()).has(d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate()); }
// Deposits post the prior business day (dir -1); autopay drafts the next business day (dir +1).
function _shiftBusinessDay(date, dir){ const d=new Date(date); let g=0; while(_isBankClosed(d) && g++<12){ d.setDate(d.getDate()+dir); } return d; }

/* ── Planned savings / goal contributions as scheduled outflows ──
   Sinking-fund buckets you're actively funding draw cash out of the spendable pool each month —
   placed on that month's first payday ("pay yourself first"), falling back to the 1st in any
   month with no modeled income. Shown as their own line so the projection reflects money you've
   committed to save, not just bills. `incomeEvents` are the already-shifted paydays. */
function _savingsEvents(days, incomeEvents){
  const out=[]; const today=new Date(); today.setHours(0,0,0,0);
  const horizon=new Date(today); horizon.setDate(horizon.getDate()+days);
  let monthly=0; try{ monthly=engSavingsBuckets().filter(b=>!b.done).reduce((s,b)=>s+(+b.monthly||0),0); }catch(e){}
  if(monthly<=0) return out;
  // earliest payday offset within each calendar month
  const firstPayday={};
  (incomeEvents||[]).forEach(e=>{ if(e.type!=='income') return; const d=_projDate(e.day); const k=d.getFullYear()+'-'+d.getMonth(); if(firstPayday[k]===undefined || e.day<firstPayday[k]) firstPayday[k]=e.day; });
  let cur=new Date(today.getFullYear(), today.getMonth(), 1); const seen={};
  while(cur<=horizon){
    const k=cur.getFullYear()+'-'+cur.getMonth();
    if(!seen[k]){ seen[k]=1;
      let off=firstPayday[k];
      if(off===undefined){ const first=new Date(cur.getFullYear(), cur.getMonth(), 1); off=Math.round((first-today)/86400000); }
      if(off>=0 && off<=days) out.push({day:off, amt:-Math.round(monthly), name:'Planned savings', type:'savings', noShift:true});
    }
    cur=new Date(cur.getFullYear(), cur.getMonth()+1, 1);
  }
  return out;
}
// User overrides for projected income occurrences the model may have gotten wrong. Persisted in
// APP (synced), keyed by 'inc|name|YYYY-MM-DD' so a specific paycheck can be turned off.
function _cfIncomeOff(){ APP.cfIncomeOff=APP.cfIncomeOff||{}; return APP.cfIncomeOff; }
function _incomeOff(key){ return !!(key && _cfIncomeOff()[key]); }
function cfpToggleIncome(key, uid){
  if(!key) return; const m=_cfIncomeOff(); if(m[key]) delete m[key]; else m[key]=1; saveState();
  const w=(typeof _findWidget==='function')?_findWidget(uid):null;
  if(w && typeof cfpMount==='function'){ cfpMount(w); } else { const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
  try{ if(sbRichie)sbRichie.do('nod'); }catch(e){}
}
// "Paid ahead" — mark a SPECIFIC bill occurrence paid so it drops from this cycle's forecast while
// next month's occurrence stays visible & editable. Keyed 'billKey|YYYY-MM-DD', persisted in APP.
function _billPaidOcc(){ APP.billPaidOcc=APP.billPaidOcc||{}; return APP.billPaidOcc; }
function _billOccPaid(okey){ return !!(okey && _billPaidOcc()[okey]); }
function cfpToggleBillPaid(okey, uid){
  if(!okey) return; const m=_billPaidOcc(); if(m[okey]) delete m[okey]; else m[okey]=1; saveState();
  const nowPaid=!!m[okey];
  try{ _memoInvalidate&&_memoInvalidate(); }catch(e){}
  const w=(typeof _findWidget==='function')?_findWidget(uid):null;
  if(w && typeof cfpMount==='function'){ cfpMount(w); } else { const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
  if(nowPaid){ try{ gamiMarkEngaged('billpaid'); }catch(e){} try{ emojiBurst('coin',{particle:'coin',count:8,life:1600}); }catch(e){} }
  try{ if(sbRichie)sbRichie.do('nod'); }catch(e){}
}
function engCashFlowProjection(days, cats){
  const start=engStartCash(cats);
  const today=new Date(); today.setHours(0,0,0,0);
  // Shift each source to real banking days BEFORE combining: deposits land the prior business
  // day, drafts the next. Savings then land on the already-shifted first payday of each month.
  const shiftOff=(e,dir)=>{ const sd=_shiftBusinessDay(_projDate(e.day), dir); let off=Math.round((sd-today)/86400000); if(off<0) off=0; e.day=off; };
  const income=_incomeEvents(days);
  // Stable per-occurrence key (name + scheduled date) so the user can check a projected paycheck
  // off — a phantom/uncertain deposit shouldn't silently inflate the forecast. e.off events stay
  // in the list (shown unchecked) but are excluded from the running balance and totals everywhere.
  income.forEach(e=>{ e.key='inc|'+e.name+'|'+_dk(_projDate(e.day)); e.off=_incomeOff(e.key); });
  income.forEach(e=>shiftOff(e,-1));
  const bills=_billEvents(days); bills.forEach(e=>{ e.off=_billOccPaid(e.okey); shiftOff(e,1); });   // a bill occurrence already paid drops from the forecast (this cycle), next month's stays
  const savings=_savingsEvents(days, income.filter(e=>!e.off));   // skipped income doesn't fund savings
  const events=[...income, ...bills, ...savings];
  // sort by day; within a day: income → savings → bills ("pay yourself first", truer low point)
  const rank=t=>t==='income'?0:t==='savings'?1:2;
  events.sort((a,b)=> a.day-b.day || rank(a.type)-rank(b.type));
  let bal=start; const series=[{day:0, bal:start, label:'Today'}];
  let low={day:0, bal:start}; const byDay={};
  events.forEach(e=>{ byDay[e.day]=byDay[e.day]||[]; byDay[e.day].push(e); });
  for(let d=1; d<=days; d++){
    if(byDay[d]) byDay[d].forEach(e=>{ if(!e.off) bal+=e.amt; });
    series.push({day:d, bal});
    if(bal<low.bal) low={day:d, bal};
  }
  const totalIn=events.filter(e=>e.type==='income'&&!e.off).reduce((s,e)=>s+e.amt,0);
  const totalOut=events.filter(e=>e.type==='bill'&&!e.off).reduce((s,e)=>s+Math.abs(e.amt),0);
  const totalSaved=events.filter(e=>e.type==='savings'&&!e.off).reduce((s,e)=>s+Math.abs(e.amt),0);
  return {start, end:bal, series, events, low, totalIn, totalOut, totalSaved, net:bal-start, byDay, days};
}

/* ═══ BILL CALENDAR ═══
   A month grid of upcoming bills & income by due date, built from the same dated,
   business-day-shifted cash-flow events. Projection only runs forward from today, so
   past days in the current month read as empty (those bills already came due). */
function _dk(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function _dkParse(k){ const p=k.split('-').map(Number); return new Date(p[0],p[1]-1,p[2]); }
function _calAmt(n){ n=Math.abs(n); return n>=1000?(n/1000).toFixed(n>=10000?0:1)+'k':String(Math.round(n)); }
function engBillCalendar(monthOffset){
  monthOffset=monthOffset||0;
  const today=new Date(); today.setHours(0,0,0,0);
  const first=new Date(today.getFullYear(), today.getMonth()+monthOffset, 1);
  const last=new Date(first.getFullYear(), first.getMonth()+1, 0);
  const label=first.toLocaleString('en-US',{month:'long',year:'numeric'});
  const horizon=Math.max(1, Math.round((last-today)/86400000)+2);
  let events=[]; try{ events=(engCashFlowProjection(horizon).events)||[]; }catch(e){}
  const byDate={};
  events.forEach(e=>{ const k=_dk(_projDate(e.day)); (byDate[k]=byDate[k]||[]).push({name:e.name, amt:e.amt, type:e.type}); });
  const gridStart=new Date(first); gridStart.setDate(first.getDate()-first.getDay());   // Sunday on/before the 1st
  const weeks=[]; let cur=new Date(gridStart); let monthIn=0, monthOut=0;
  for(let wk=0; wk<6; wk++){
    const week=[];
    for(let col=0; col<7; col++){
      const k=_dk(cur), evs=byDate[k]||[], inMonth=cur.getMonth()===first.getMonth();
      const net=evs.reduce((s,e)=>s+e.amt,0);
      if(inMonth) evs.forEach(e=>{ if(e.amt>=0) monthIn+=e.amt; else monthOut+=-e.amt; });
      week.push({key:k, dom:cur.getDate(), inMonth, isToday:k===_dk(today), events:evs, net});
      cur=new Date(cur.getFullYear(), cur.getMonth(), cur.getDate()+1);
    }
    weeks.push(week);
    if(cur>last && cur.getMonth()!==first.getMonth() && weeks.length>=5) break;   // don't draw an all-trailing 6th week
  }
  const monthEvents=Object.keys(byDate).filter(k=>{ const d=_dkParse(k); return d.getMonth()===first.getMonth()&&d.getFullYear()===first.getFullYear(); }).sort().map(k=>({key:k, events:byDate[k]}));
  return {monthOffset, label, weeks, monthIn:Math.round(monthIn), monthOut:Math.round(monthOut), monthNet:Math.round(monthIn-monthOut), monthEvents};
}
let _billCal={};
function _billCalDayLabel(k){ return _dkParse(k).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); }
function _billCalList(days){
  return days.map(d=>{
    const rows=d.events.slice().sort((a,b)=>a.amt-b.amt).map(e=>{
      const isBill=e.type==='bill';
      const go=isBill?' bcal-li-go" onclick="event.stopPropagation();billCalGotoBills()" title="Open in Bills':'"';
      return `<div class="bcal-li${go}"><span class="bcal-li-dot ${e.amt>=0?'in':'out'}"></span><span class="bcal-li-nm">${esc(e.name)}${isBill?' <span class="bcal-chev">›</span>':''}</span><b style="color:${e.amt>=0?'var(--pos)':'var(--red)'}">${e.amt>=0?'+':'−'}${fmtK(e.amt)}</b></div>`;
    }).join('');
    return `<div class="bcal-li-day"><div class="bcal-li-date">${_billCalDayLabel(d.key)}</div>${rows}</div>`;
  }).join('');
}
function billCalGotoBills(){ try{ briefGoto('bills_list'); }catch(e){ try{ _ensureWidgetOnPage('bills_list'); }catch(_){} } }
function billCalBody(w){
  const st=_billCal[w.uid]||(_billCal[w.uid]={off:0, sel:null});
  const c=engBillCalendar(st.off);
  const dow=['S','M','T','W','T','F','S'];
  const head=`<div class="bcal-top">
    <button class="bcal-nav" onclick="event.stopPropagation();billCalShift('${w.uid}',-1)"${st.off<=0?' disabled':''} aria-label="Previous month">‹</button>
    <div class="bcal-month">${esc(c.label)}${dataLoaded?'':' · sample'}</div>
    <button class="bcal-nav" onclick="event.stopPropagation();billCalShift('${w.uid}',1)"${st.off>=11?' disabled':''} aria-label="Next month">›</button>
  </div>`;
  const dowRow=`<div class="bcal-dow">${dow.map(d=>`<span>${d}</span>`).join('')}</div>`;
  const grid=c.weeks.map(week=>`<div class="bcal-week">${week.map(cell=>{
    const hasIn=cell.events.some(e=>e.amt>=0), hasOut=cell.events.some(e=>e.amt<0);
    const dots=(hasIn?'<span class="bcal-dot in"></span>':'')+(hasOut?'<span class="bcal-dot out"></span>':'');
    const netTxt=cell.events.length?`<span class="bcal-net" style="color:${cell.net>=0?'var(--pos)':'var(--red)'}">${cell.net>=0?'+':'−'}${_calAmt(cell.net)}</span>`:'';
    const cls=['bcal-cell']; if(!cell.inMonth)cls.push('out'); if(cell.isToday)cls.push('today'); if(cell.events.length)cls.push('has'); if(st.sel===cell.key)cls.push('sel');
    const click=cell.events.length?`onclick="event.stopPropagation();billCalDay('${w.uid}','${cell.key}')"`:'';
    return `<div class="${cls.join(' ')}" ${click}><span class="bcal-dom">${cell.dom}</span><span class="bcal-marks">${dots}</span>${netTxt}</div>`;
  }).join('')}</div>`).join('');
  const summary=`<div class="bcal-summary"><span>In <b style="color:var(--pos)">${fmtK(c.monthIn)}</b></span><span>Out <b style="color:var(--red)">${fmtK(c.monthOut)}</b></span><span>Net <b style="color:${c.monthNet>=0?'var(--pos)':'var(--red)'}">${c.monthNet<0?'−':''}${fmtK(c.monthNet)}</b></span></div>`;
  let list, listHdr;
  if(st.sel){ const day=c.monthEvents.find(e=>e.key===st.sel); list=day?_billCalList([day]):'<div class="ws-hint">Nothing scheduled that day.</div>'; listHdr=`${_billCalDayLabel(st.sel)} · <a onclick="event.stopPropagation();billCalDay('${w.uid}','${st.sel}')" style="cursor:pointer;color:var(--muted)">show whole month</a>`; }
  else { list=c.monthEvents.length?_billCalList(c.monthEvents):'<div class="ws-hint">No bills or income scheduled this month.</div>'; listHdr='This month'; }
  return `<div class="bcal-wrap">${head}${dowRow}<div class="bcal-grid">${grid}</div>${summary}<div class="bcal-listhdr">${listHdr}</div><div class="bcal-list">${list}</div></div>`;
}
function billCalShift(uid,delta){ try{ discoverXp('bill_calendar',10,'the bill calendar'); }catch(e){} const st=_billCal[uid]||(_billCal[uid]={off:0,sel:null}); st.off=Math.max(0,Math.min(11,st.off+delta)); st.sel=null; const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function billCalDay(uid,key){ const st=_billCal[uid]||(_billCal[uid]={off:0,sel:null}); st.sel=st.sel===key?null:key; const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }

/* ── Unified bills/liabilities layer ──
   When Plaid liabilities are loaded, derive bills from real card/mortgage data;
   otherwise fall back to the manually-entered bills[] array. Same shape either way:
   {name, note, pay (monthly), bal (negative), apr, due (day-of-month), cat, source} */
function plaidHasLiab(){ return !!(plaidLiabilities && ((plaidLiabilities.credit_cards||[]).length || (plaidLiabilities.mortgages||[]).length)); }
function _dueDay(dateStr){ if(!dateStr) return 1; const d=new Date(dateStr); return isNaN(d)?1:d.getDate(); }
/* Sum of budget envelopes assigned to each credit card (by display name). */
function _cardEnvelopeTotals(){
  const out={}; try{ _zbBuckets().forEach(b=>{ if(b.card) out[b.card]=(out[b.card]||0)+(b.amt||0); }); }catch(e){}
  return out;
}
/* Spending cards: a card with assigned budget envelopes has an expected monthly payment equal
   to those envelopes (you charge it, then pay it), so it appears in Bills and Cash Flow with
   that outflow even when its current balance/minimum is $0. A manual "You pay" override wins. */
function _applyEnvelopePlan(list){
  const env=_cardEnvelopeTotals(); if(!Object.keys(env).length) return list;
  const ov=_billOverrides();
  list.forEach(b=>{
    if(b.cat!=='CC') return;
    const e=env[b.name]||0; if(e<=0) return;
    const hasPayOv=ov[billKey(b)] && ov[billKey(b)].pay!==undefined;
    if(!hasPayOv && (b.pay||0)<e){ b.pay=e; b.expected=e; b.plannedFromEnvelopes=true; }
  });
  return list;
}
function engBills(){ return _memoFrame('bills', _engBillsRaw); }   // frame-scoped memo — see _memoFrame
function _engBillsRaw(){
  const manual=(APP.manualBills||[]).map(b=>({...b, manual:true, min:b.min!=null?b.min:b.pay}));
  // Not connected → show the example seed so widgets have something to learn from.
  if(!dataLoaded || !(allAccts||[]).length) return _applyEnvelopePlan(_applyCardData(applyBillOverrides(bills.concat(manual))));
  // Connected → drive off the ACTUAL accounts (source of truth for what cards/loans exist),
  // and enrich each with Plaid liabilities detail (APR, min payment, due date) when available.
  // This way a credit card shows even when the institution returns no liabilities data.
  const liabByAcct={}; (plaidLiabilities&&plaidLiabilities.credit_cards||[]).forEach(c=>{ if(c.account_id) liabByAcct[c.account_id]=c; });
  const mortByAcct={}; (plaidLiabilities&&plaidLiabilities.mortgages||[]).forEach(m=>{ if(m.account_id) mortByAcct[m.account_id]=m; });
  // Detail for ANY loan (mortgage + student). Auto/other loans aren't in Plaid's Liabilities
  // product at all, so they simply won't have an entry here — handled with an estimate below.
  const loanByAcct={}; [].concat(plaidLiabilities&&plaidLiabilities.mortgages||[], plaidLiabilities&&plaidLiabilities.student_loans||[]).forEach(x=>{ if(x.account_id) loanByAcct[x.account_id]=x; });
  const out=[];
  const exIds=(typeof _excludedAcctIds==='function')?_excludedAcctIds():new Set();
  (allAccts||[]).forEach(a=>{
    // Exclusion is stored per-account (id), not on the shared name record — so resolve it the
    // same way engAccounts does (by id) rather than the name record, which never carries it.
    if(exIds.has(a.account_id) || _acctExcluded(a.name||a.official_name)) return;   // excluded accounts stay out of debt/bills too
    const cur=(a.balances&&(a.balances.current))??0;
    if(a.type==='credit'){
      const c=liabByAcct[a.account_id]||{};
      const owed=Math.abs(cur||c.current_balance||0);
      // Institutions that return no liabilities detail leave min=0, which used to hide the
      // card from every Bills view (they filter pay>0). Estimate the minimum (~2% of the
      // balance, $25 floor), flag it "est." — the account editor's Minimum payment corrects it.
      const estMin=(c.minimum_payment||0)>0?0:(owed>0?Math.max(25,Math.round(owed*0.02)):0);
      out.push({ name:a.name||c.name||'Credit Card', note:a.institution||'', cat:'CC', account_id:a.account_id,
        bal:-owed, apr:(c.apr!=null?c.apr:0),
        min:(c.minimum_payment||estMin), pay:(c.minimum_payment||estMin), estMin:estMin>0,
        limit:((a.balances&&a.balances.limit!=null)?a.balances.limit:(c.limit!=null?c.limit:0)),  // limit from the account, then liabilities
        due:_dueDay(c.next_payment_due_date), promo:'', promoEnd:'', paid:false, source:'plaid' });
    } else if(a.type==='loan'){
      const m=loanByAcct[a.account_id]||{};
      const sub=(a.subtype||'').toLowerCase();
      const cat=(mortByAcct[a.account_id]||/mortgage|home|heloc|equity/.test(sub))?'HM':(sub==='auto'?'CAR':'LOAN');
      const owed=Math.abs(cur||m.current_balance||0);
      const planPay=(m.minimum_payment||0);
      // Plaid's Liabilities product only details credit/mortgage/student loans. Auto & other
      // loans arrive as accounts WITH a balance but NO payment/APR/due — and a $0 payment used
      // to filter them out of every Bills view entirely. Estimate a payment (~5-yr amortization,
      // $50 floor) so the loan stays VISIBLE with its balance and payoff math; flag it "est." —
      // the account editor's Monthly payment / APR / due-day correct it and persist via cardData.
      const estPay=planPay>0?0:(owed>0?Math.max(50,Math.round(owed/60)):0);
      out.push({ name:a.name||m.name||'Loan', note:a.institution||'', cat, account_id:a.account_id,
        bal:-owed, apr:(m.interest_rate!=null?m.interest_rate:0),
        min:(planPay||estPay), pay:(planPay||estPay), estMin:estPay>0, limit:0,
        due:_dueDay(m.next_payment_due_date), dueEst:!m.next_payment_due_date,
        promo:'', promoEnd:'', paid:false, source:'plaid' });
    }
  });
  return _applyEnvelopePlan(_applyCardData(applyBillOverrides(out.concat(manual))));
}
// Persistent overlay so promo end dates / credit limits the user enters survive even
// when bills are coming live from Plaid (Plaid can't know your 0% promo end date).
function _cardKey(name){ return (name||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
/* ── Per-ACCOUNT identity & metadata ──
   _cardKey is name-only, so several same-named accounts (e.g. four Amex HYSAs) shared one
   record — nicknaming one renamed them all. _acctIdKey adds institution+mask so each account
   has its own identity; _cdFor reads the per-account record first, falling back to the legacy
   name record so existing edits keep working. Writes go to the per-account key (and the legacy
   key, for name-based readers like bills). ── */
function _acctIdKey(a){
  if(!a) return '';
  const nm=a.rawName||a.name||a.official_name||a.type||'';
  return 'id:'+[(a.institution||'').toLowerCase().trim(),(a.mask||''),String(nm).toLowerCase().trim()].join('|');
}
function _cdFor(a){
  const data=APP.cardData||{};
  const legacy=data[_cardKey(a&&(a.rawName||a.name||a.official_name))]||{};
  const byId=data[_acctIdKey(a)]||{};
  return Object.assign({}, legacy, byId);
}
function _applyCardData(list){
  const data=APP.cardData||{};
  return list.map(b=>{
    const d=data[_cardKey(b.name)];
    if(!d) return b;
    const merged={...b};
    if(d.nickname) merged.name=d.nickname;
    if(d.promoEnd) { merged.promoEnd=d.promoEnd; if(!merged.promo) merged.promo='0% APR'; }
    if(d.promoAmt!=null && d.promoAmt>0) merged.promoAmt=d.promoAmt;
    if(d.limit!=null && d.limit>0 && !(merged.limit>0)) merged.limit=d.limit;
    if(d.apr!=null && d.apr>0 && !(merged.apr>0)) merged.apr=d.apr;
    if(d.minPay!=null && d.minPay>0){ const payWasEst=merged.estMin&&merged.pay===merged.min; merged.min=d.minPay; if(!(merged.pay>0)||payWasEst) merged.pay=d.minPay; merged.estMin=false; }
    if(d.dueDay!=null && d.dueDay>0){ merged.due=d.dueDay; merged.dueEst=false; }
    if(d.note) merged.note=d.note;
    return merged;
  });
}
function setCardData(name, fields){
  if(!APP.cardData) APP.cardData={};
  APP.cardData[_cardKey(name)]=Object.assign(APP.cardData[_cardKey(name)]||{}, fields);
  saveState();
}
function engMonthlyBills(){ return engBills().reduce((s,b)=>s+(b.pay||0),0); }
// How much is safe to spend today: liquid cash, minus bills due before the next paycheck,
// minus a prorated slice of goal contributions and a small buffer, spread over the days until pay.
function engSafeToSpend(){
  const cash=engStartCash();
  const proj=engCashFlowProjection(90);   // look a full quarter ahead, not just to next payday
  const inc=(proj.events||[]).filter(e=>e.type==='income' && !e.off).sort((a,b)=>a.day-b.day)[0];   // a paycheck the user checked off shouldn't set the horizon
  const horizon=inc?Math.max(1,inc.day):14;
  const billsDue=(proj.events||[]).filter(e=>e.type==='bill'&&e.day<=horizon).reduce((s,e)=>s+Math.abs(e.amt),0);  // savings handled via goalPortion below — don't double-count
  const goalMonthly=(typeof engSavingsBuckets==='function')?engSavingsBuckets().reduce((s,b)=>s+(b.monthly||0),0):0;
  const goalPortion=goalMonthly*(horizon/30.44);
  const buffer=50;
  const nearPool=Math.max(0,cash-billsDue-goalPortion-buffer);   // spendable before the next paycheck
  // 90-day floor: spending $X today lowers EVERY future balance by $X, so the projected low point
  // caps what's truly safe. If cash flow trends down (or dips below 0), this binds and safe-to-spend
  // shrinks — you shouldn't be told to spend money a coming shortfall will need.
  const low90=proj.low.bal;
  const safe90=Math.max(0, low90-buffer);
  const pool=Math.min(nearPool, safe90);
  const constrainedBy90=safe90<nearPool;   // the quarter-ahead floor is the binding limit, not near-term cash
  const perDay=horizon>0?pool/horizon:pool;
  return {pool,perDay,horizon,cash,billsDue,goalPortion,buffer,nextIncomeDay:inc?inc.day:null,
    low90:Math.round(low90), lowDay:proj.low.day, constrainedBy90, shortfall:low90<0};
}
// Detect recurring charges / subscriptions — groups outflows by merchant, keeps those
// that repeat at a regular cadence with consistent amounts.
// Normalize a raw merchant name → the key rules/recurring group on (used for both live
// transactions and manually-typed rules, so a hand-added rule matches real transactions).
function _merchKeyName(name){
  let s=(name||'').toLowerCase();
  s=s.replace(/\d[\d,.]*/g,' ').replace(/[^a-z ]+/g,' ')
     .replace(/\b(com|inc|llc|co|ltd|www|http|https|pos|purchase|payment|pmt|recurring|autopay|auto|bill|debit|card|ach)\b/g,' ')
     .replace(/\s+/g,' ').trim();
  return s.split(' ').slice(0,2).join(' ').slice(0,26);
}
function _merchKey(t){ return _merchKeyName(t.merchant_name||t.name||''); }
function engRecurring(){
  if(!dataLoaded) return [
    {merchant:'Streaming Service (example)',amount:15.99,cadence:'monthly',count:3,monthly:15.99,category:'Subscriptions'},
    {merchant:'Gym (example)',amount:39.00,cadence:'monthly',count:4,monthly:39.00,category:'Health'},
  ];
  const groups={};
  const _ex=_excludedAcctIds();
  allTxns.filter(t=>t.amount>0 && getTxnTag(t)!=='ignore' && !_ex.has(t.account_id)).forEach(t=>{ const k=_merchKey(t); if(k.length<3)return; (groups[k]=groups[k]||[]).push(t); });
  const out=[];
  Object.keys(groups).forEach(k=>{
    const txns=groups[k]; if(txns.length<2) return;
    txns.sort((a,b)=>new Date(a.date)-new Date(b.date));
    const amts=txns.map(t=>t.amount).slice().sort((a,b)=>a-b);
    const med=amts[Math.floor(amts.length/2)];
    if(txns.filter(t=>Math.abs(t.amount-med)<=med*0.2).length < Math.max(2,Math.ceil(txns.length*0.6))) return;
    const gaps=[]; for(let i=1;i<txns.length;i++) gaps.push((new Date(txns[i].date)-new Date(txns[i-1].date))/86400000);
    gaps.sort((a,b)=>a-b); const g=gaps[Math.floor(gaps.length/2)]||30;
    let cad=null, per=0;
    if(g>=25&&g<=35){cad='monthly';per=30.44;} else if(g>=12&&g<=18){cad='biweekly';per=14;}
    else if(g>=5&&g<=9){cad='weekly';per=7;} else if(g>=80&&g<=100){cad='quarterly';per=91;}
    else if(g>=350&&g<=385){cad='yearly';per=365;}
    if(!cad) return;
    const last=txns[txns.length-1];
    // price-hike detection: most recent charge vs the median of the earlier ones
    const recent=last.amount;
    const priorArr=txns.slice(0,-1).map(t=>t.amount).sort((a,b)=>a-b);
    const prior=priorArr.length?priorArr[Math.floor(priorArr.length/2)]:med;
    const priceUp = recent>prior*1.05 && recent>prior+0.5;
    const nextTs=new Date(last.date+'T12:00:00').getTime()+per*86400000;   // projected next renewal
    out.push({merchant:(last.merchant_name||last.name||k), amount:med, cadence:cad, count:txns.length, lastDate:last.date,
      monthly:med*(30.44/per), perDays:per, nextTs, recent, prior, priceUp,
      category:getTxnCategory(last), key:_txnKey(last), merchKey:k});
  });
  return out.sort((a,b)=>b.monthly-a.monthly);
}
function _cancelSubs(){ APP.cancelSubs=APP.cancelSubs||{}; return APP.cancelSubs; }
let _recRows=[];
function recurringBody(w){
  const rec=engRecurring(); _recRows=rec;
  if(!rec.length) return `<div class="wph"><div class="wph-sub">No recurring charges detected yet.</div><div class="ws-hint" style="margin-top:6px">Once you've got a couple months of transactions, Richie spots subscriptions and recurring bills automatically.</div></div>`;
  const cancel=_cancelSubs();
  const monthlyTot=rec.reduce((s,r)=>s+r.monthly,0);
  const flagged=rec.filter(r=>cancel[r.merchKey]);
  const savings=flagged.reduce((s,r)=>s+r.monthly,0);
  const hikes=rec.filter(r=>r.priceUp).length;
  const cats=getUserCategories().filter(c=>!c.group).map(c=>c.label);
  const billNames=new Set((APP.manualBills||[]).map(b=>(b.name||'').toLowerCase()));
  const today=new Date(); today.setHours(0,0,0,0);
  // renewals soonest-first within each price tier keeps urgent ones visible; keep monthly-desc default
  const rows=rec.slice(0,30).map((r,i)=>{
    const isCancel=!!cancel[r.merchKey];
    const catList=cats.includes(r.category)?cats:[r.category].concat(cats);
    const opts=catList.map(c=>`<option value="${esc(c)}"${c===r.category?' selected':''}>${esc(c)}</option>`).join('');
    const inBills=billNames.has((r.merchant||'').toLowerCase());
    const billBtn=inBills
      ? `<span class="rec-inbills" title="Already in your Bills">✓ Bill</span>`
      : `<button class="rec-billbtn" onclick="event.stopPropagation();recurringToBill(${i})" title="Add to Upcoming Bills">＋ Bill</button>`;
    const dLeft=r.nextTs?Math.round((r.nextTs-today.getTime())/86400000):null;
    const renewLbl = dLeft==null?'' : (()=>{ const d=new Date(r.nextTs).toLocaleDateString('en-US',{month:'short',day:'numeric'});
      return dLeft<0?`📅 renews around ${d}` : dLeft===0?`📅 renews today` : `📅 renews ${d} · in ${dLeft}d`; })();
    const priceBadge = r.priceUp?`<span class="rec-priceup" title="Price increase detected">▲ ${fmtK(r.prior)}→${fmtK(r.recent)}</span>`:'';
    const cancelBadge = isCancel?`<span class="rec-cancel-badge">cancelling</span>`:'';
    return `<div class="rec-row2${isCancel?' rec-flagged':''}">
      <div class="rec-r2-top">
        <div class="rec-nm">${esc(r.merchant)} ${priceBadge}${cancelBadge}</div>
        <div class="rec-side"><div class="rec-amt">${fmtK(r.amount)}</div><div class="rec-mo">${r.cadence} · ${fmtK(r.monthly)}/mo</div></div>
      </div>
      ${renewLbl?`<div class="rec-renew${dLeft!=null&&dLeft>=0&&dLeft<=7?' soon':''}">${renewLbl}</div>`:''}
      <div class="rec-r2-ctrls">
        <select class="txn-cat-sel rec-catsel" onclick="event.stopPropagation()" onchange="recurringSetCat(${i},this.value)" title="Set category (applies to this merchant)" aria-label="Category for ${esc(r.merchant)}">${opts}</select>
        ${billBtn}
        <button class="rec-cancelbtn${isCancel?' on':''}" onclick="event.stopPropagation();subToggleCancel(${i})" title="${isCancel?'Keep this subscription':'Flag to cancel'}" aria-label="${isCancel?'Keep':'Flag to cancel'} ${esc(r.merchant)}">${isCancel?'↺ Keep':'⊘ Cancel'}</button>
      </div>
    </div>`;
  }).join('');
  const savingsChip = savings>0?` · <span style="color:var(--pos)">save ${fmtK(savings)}/mo by cancelling ${flagged.length}</span>`:'';
  const hikeChip = hikes>0?` · <span style="color:var(--amber)">▲ ${hikes} price rise${hikes>1?'s':''}</span>`:'';
  return `<div class="rec-wrap">
    <div class="rec-total"><b>${fmtK(monthlyTot)}</b>/mo · <b>${fmtK(monthlyTot*12)}</b>/yr across ${rec.length}${hikeChip}${savingsChip}</div>
    <div class="ws-hint" style="margin:2px 0 9px">Subscriptions <b>and</b> recurring bills. Flag ones to <b>⊘ Cancel</b>, watch the ▲ price rises, and see when each renews.</div>${rows}</div>`;
}
function subToggleCancel(i){ const r=_recRows[i]; if(!r||!r.merchKey) return; const c=_cancelSubs(); if(c[r.merchKey]) delete c[r.merchKey]; else c[r.merchKey]=true; saveState(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); if(sbRichie)sbRichie.do('nod'); }
function recurringSetCat(i,cat){ const r=_recRows[i]; if(!r||!r.merchKey)return; setCatRule(r.merchKey,cat); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function recurringToBill(i){
  const r=_recRows[i]; if(!r)return;
  APP.manualBills=APP.manualBills||[];
  if(APP.manualBills.some(b=>(b.name||'').toLowerCase()===(r.merchant||'').toLowerCase())){ if(typeof richieSay==='function') richieSay(`${r.merchant} is already in your Bills.`); return; }
  const dueDay=r.lastDate?Math.max(1,Math.min(31,new Date(r.lastDate+'T12:00:00').getDate())):1;
  const amt=Math.round(r.monthly);
  APP.manualBills.push({ name:r.merchant, pay:amt, min:amt, bal:0, apr:0, due:dueDay, cat:(r.category||'OTHER'), promoEnd:'', limit:0, promo:'', note:'manual', paid:false });
  saveState(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod'); if(typeof richieSay==='function') richieSay(`Added ${r.merchant} to your Bills — about ${fmtK(r.monthly)}/mo, due ~day ${dueDay}.`);
}
function safeToSpendBody(w){
  const s=engSafeToSpend();
  const perDay=Math.max(0,Math.round(s.perDay));
  const col=s.pool>0?'var(--pos)':'var(--red)';
  const sub = s.nextIncomeDay!=null
    ? `safe to spend · ≈ ${fmtK(perDay)}/day until payday (${s.horizon}d)`
    : `safe to spend over the next ${s.horizon} days`;
  return `<div class="wph">
    <div class="wph-stat" style="color:${col}">${fmtK(s.pool)}</div>
    <div class="wph-sub">${sub}</div>
    <div class="sts-break">
      <div><span>Cash on hand</span><b>${fmtK(s.cash)}</b></div>
      <div><span>− Bills before payday</span><b style="color:var(--red)">${fmtK(s.billsDue)}</b></div>
      ${s.goalPortion>0.5?`<div><span>− Goal set-aside</span><b style="color:var(--amber)">${fmtK(s.goalPortion)}</b></div>`:''}
      <div><span>− Safety buffer</span><b style="color:var(--muted)">${fmtK(s.buffer)}</b></div>
      ${s.constrainedBy90?`<div><span>${s.shortfall?'⚠️ 90-day shortfall':'Held for 90-day low'}</span><b style="color:${s.shortfall?'var(--red)':'var(--amber)'}">${s.low90<0?'−':''}${fmtK(Math.abs(s.low90))}</b></div>`:''}
    </div>
    ${s.shortfall
      ? `<div class="ws-hint" style="margin-top:8px;color:var(--red)">Heads up — your balance is projected to dip to ${fmtK(s.low90)} ${s.lowDay!=null?`around ${_projDate(s.lowDay).toLocaleDateString('en-US',{month:'short',day:'numeric'})}`:'within 90 days'}. Safe-to-spend is held at ${fmtK(s.pool)} so you don't spend into it — trim a bill or add income.</div>`
      : s.constrainedBy90
        ? `<div class="ws-hint" style="margin-top:8px;color:var(--amber)">Held back to your 90-day low (${fmtK(s.low90)}${s.lowDay!=null?` around ${_projDate(s.lowDay).toLocaleDateString('en-US',{month:'short',day:'numeric'})}`:''}) — spending more risks a crunch later this quarter.</div>`
        : s.pool<=0
          ? `<div class="ws-hint" style="margin-top:8px;color:var(--amber)">Tight until payday — bills &amp; set-asides cover your cash. Ease a goal contribution or move a bill.</div>`
          : ''}
  </div>`;
}
function engBillsDebt(){ return engBills().reduce((s,b)=>s+Math.abs(b.bal||0),0); }

/* ═══════════════ EXCEL EXPORT ═══════════════
   Builds a multi-sheet workbook mirroring the source spreadsheet, using whatever
   data is live (Plaid) or seeded. Uses SheetJS (window.XLSX, loaded via CDN). */
function _xlsxSheet(rows){ return XLSX.utils.aoa_to_sheet(rows); }
async function exportToExcel(){
  if(typeof XLSX==='undefined'){ try{ await _loadScript(XLSX_CDN_SRC); }catch(e){} }
  if(typeof XLSX==='undefined'){ alert('Spreadsheet library failed to load — check your connection and try again.'); return; }
  const wb=XLSX.utils.book_new();
  const today=new Date();
  const money=(n)=>Math.round((n||0)*100)/100;

  // 1) Bills & Debt (with payoff times)
  (()=>{
    const rows=[['Bills & Debt','','','','','','','Generated',today.toLocaleDateString()],
      ['Category','Name','Note','APR %','Balance','Min Pay','You Pay','Due Day','Months to Payoff','Total Interest','Promo Ends']];
    engBills().slice().sort((a,b)=>Math.abs(b.bal||0)-Math.abs(a.bal||0)).forEach(b=>{   // slice: engBills() is memoized/shared — never sort it in place
      const po=payoffMonths(b.bal,b.apr,b.pay||b.min);
      rows.push([b.cat||'',b.name||'',b.note||'',b.apr||0,money(b.bal),money(b.min),money(b.pay),b.due||'',
        po.paidOff?'paid':po.neverPaysOff?'never (pay ≤ interest)':po.months, po.neverPaysOff?'':money(po.interest), b.promoEnd||'']);
    });
    rows.push([]);
    rows.push(['Total debt',engBillsDebt()? -engBillsDebt():0]);
    rows.push(['Monthly bills total',money(engMonthlyBills())]);
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Bills & Debt');
  })();

  // 2) Cash Flow Projection (90-day weekly-ish ledger)
  (()=>{
    const p=engCashFlowProjection(90);
    const rows=[['Cash Flow Projection (next 90 days)'],['Starting cash',money(p.start)],[],
      ['Day','Date','Event','Amount','Running Balance']];
    let bal=p.start;
    const byDay=p.byDay||{};
    for(let d=1; d<=p.days; d++){
      if(byDay[d]){ byDay[d].forEach(e=>{ bal+=e.amt; const dt=new Date(today.getTime()+d*86400000);
        rows.push([d, dt.toLocaleDateString(), e.name, money(e.amt), money(bal)]); }); }
    }
    rows.push([]);
    rows.push(['Income in (90d)',money(p.totalIn)]);
    rows.push(['Bills out (90d)',money(-p.totalOut)]);
    rows.push(['Projected end balance',money(p.end)]);
    rows.push(['Lowest point',money(p.low.bal),'on day',p.low.day]);
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Cash Flow');
  })();

  // 3) Income streams
  (()=>{
    const rows=[['Income Streams'],['Name','Amount','Frequency','Next/Day','Monthly Equivalent']];
    _effectiveIncomeSources().forEach(s=>{
      rows.push([s.name,money(s.amt),s.freq,(s.anchor||s.day||''),money(s.amt*(FREQ_TO_MONTHLY[s.freq]||1))]);
    });
    rows.push([]); rows.push(['Total monthly income',money(engMonthlyIncome())]);
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Income');
  })();

  // 4) Budget vs Actual
  (()=>{
    const d=engBudgetVsActual(30);
    const rows=[['Budget vs Actual (this month)'],['Category','Budgeted','Actual','Difference','% of budget']];
    d.rows.forEach(r=>rows.push([r.name,money(r.budget),money(r.actual),money(r.diff),Math.round(r.pct)+'%']));
    rows.push([]); rows.push(['Totals',money(d.totBudget),money(d.totActual),money(d.totDiff)]);
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Budget vs Actual');
  })();

  // 5) Category Heatmap (category × month grid)
  (()=>{
    const g=engCategoryMonthGrid(12);
    const rows=[['Category Spending by Month'],['Category',...g.months,'Average']];
    g.cats.forEach(c=>rows.push([c.label,...c.vals.map(money),money(c.avg)]));
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Category Heatmap');
  })();

  // 6) Savings Buckets
  (()=>{
    const rows=[['Savings Buckets / Sinking Funds'],['Fund','Balance','Target','% Funded','Remaining','Monthly','Months to Goal']];
    engSavingsBuckets().forEach(b=>rows.push([b.name,money(b.balance),money(b.target),Math.round(b.pct)+'%',money(b.remaining),money(b.monthly),b.done?'funded':(b.monthsToGoal===Infinity?'—':b.monthsToGoal)]));
    rows.push([]); rows.push(['Total saved',money(engSavingsTotal())]);
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Savings Buckets');
  })();

  // 7) Credit & Utilization
  (()=>{
    const u=engCreditUtil(); const dti=engDTI();
    const rows=[['Credit & Utilization'],['Card','Used','Limit','Utilization %']];
    u.cards.forEach(c=>rows.push([c.name,money(c.used),money(c.limit),Math.round(c.pct)+'%']));
    rows.push([]);
    rows.push(['Total used',money(u.used)]);
    rows.push(['Total limit',money(u.limit)]);
    rows.push(['Overall utilization',Math.round(u.pct)+'%']);
    rows.push([]);
    rows.push(['Debt-to-income',Math.round(dti.ratio*100)+'%']);
    rows.push(['Monthly debt payments',money(dti.debtPay)]);
    rows.push(['Monthly income',money(dti.income)]);
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Credit & Utilization');
  })();

  // 8) Promos
  (()=>{
    const rows=[['0% Promo Tracker'],['Card','Promo','Ends','Days Left','Balance','APR After','Monthly Cost After']];
    engPromos().forEach(p=>rows.push([p.name,p.promo,p.end.toLocaleDateString(),p.days,money(p.bal),(p.apr||0)+'%',money(p.monthlyAfter)]));
    if(engPromos().length===0) rows.push(['No active promos','','','','','','']);
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Promos');
  })();

  // 9) Goals
  (()=>{
    const rows=[['Financial Goals'],['Goal','Metric','Current','Target','% Done','Deadline','On Track','Need/Month']];
    _goals().forEach(g=>{ const pr=goalProgress(g);
      rows.push([g.name,g.metric,money(pr.current),money(pr.target),pr.pct+'%',g.deadline||'',
        pr.pace?(pr.pace.onTrack?'yes':'behind'):'', pr.pace?money(pr.pace.perMonthNeeded):'']);
    });
    if(_goals().length===0) rows.push(['No goals set','','','','','','','']);
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Goals');
  })();

  // 10) Net Worth
  (()=>{
    const rows=[['Net Worth'],['ASSETS','','LIABILITIES','']];
    const a=nwAssets.filter(x=>x.value>0), l=nwLiab;
    const n=Math.max(a.length,l.length);
    for(let i=0;i<n;i++){ rows.push([a[i]?a[i].name:'',a[i]?money(a[i].value):'',l[i]?l[i].name:'',l[i]?money(l[i].value):'']); }
    rows.push([]);
    const at=dataLoaded?engNetBalance()+engNWAssets():engNWAssets();
    rows.push(['Total assets',money(at),'Total liabilities',money(engNWLiab())]);
    rows.push(['NET WORTH',money(at-engNWLiab())]);
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Net Worth');
  })();

  const stamp=today.toISOString().slice(0,10);
  XLSX.writeFile(wb, `Richie_Finances_${stamp}.xlsx`);
  if(typeof richieSay==='function') richieSay('📊 Exported your full workbook! Check your downloads — every sheet is in there.');
  if(typeof sbRichie!=='undefined'&&sbRichie) sbRichie.do('tada');
}

/* ═══ MONTHLY REPORT ═══
   An on-screen summary for a single calendar month (income, spend by category,
   income sources, top merchants, net-worth snapshot) with CSV + print-to-PDF export. */
function engMonthlyReport(offset){
  offset=offset||0;
  const base=new Date(), y=base.getFullYear(), m=base.getMonth()+offset;
  const start=new Date(y,m,1), end=new Date(y,m+1,1);
  const label=start.toLocaleString('en-US',{month:'long',year:'numeric'});
  const isCurrent=offset===0;
  const spendByCat={}, incomeBySource={}, merch={};
  let income=0, spend=0, txnCount=0;
  const has=dataLoaded && allTxns && allTxns.length>0;
  if(has){
    allTxns.forEach(t=>{
      const td=new Date(t.date); if(td<start||td>=end) return;
      txnCount++;
      if(_isIncomeTxn(t)){ const v=Math.abs(t.amount); income+=v; const src=getTxnCategory(t); incomeBySource[src]=(incomeBySource[src]||0)+v; }
      else if(t.amount>0 && !_txnExcludedFromSpend(t)){ spend+=t.amount; const c=getTxnCategory(t); spendByCat[c]=(spendByCat[c]||0)+t.amount; const nm=t.merchant_name||t.name||'—'; merch[nm]=(merch[nm]||0)+t.amount; }
    });
  } else {
    Object.assign(spendByCat,{'Groceries':512,'Dining out':286,'Auto':452,'Utilities':320,'Subscription':142,'Shopping':210});
    Object.assign(incomeBySource,{'Paycheck':5400,'Interest':40});
    Object.assign(merch,{'Whole Foods':512,'Amazon':210,'Shell':180,'Netflix':16});
    income=5440; spend=1922; txnCount=42;
  }
  const cats=Object.entries(spendByCat).map(([l,v])=>({label:l,value:Math.round(v),color:getCatColor(l)})).sort((a,b)=>b.value-a.value);
  const incomes=Object.entries(incomeBySource).map(([l,v])=>({label:l,value:Math.round(v)})).sort((a,b)=>b.value-a.value);
  const merchants=Object.entries(merch).map(([l,v])=>({label:l,value:Math.round(v)})).sort((a,b)=>b.value-a.value).slice(0,8);
  const net=Math.round(income-spend), savingsRate=income>0?Math.round((income-spend)/income*100):0;
  const nw=Math.round(engNetBalance()+engNWAssets()-engNWLiab());
  return {offset,label,isCurrent,has,income:Math.round(income),spend:Math.round(spend),net,savingsRate,txnCount,cats,incomes,merchants,netWorth:nw};
}
let _reportOffset=0;
function openReport(){ _reportOffset=0; const m=gg('reportModal'); if(!m) return; m.style.display='flex'; renderReport(); }
function closeReport(){ const m=gg('reportModal'); if(m) m.style.display='none'; }
function reportShift(d){ const n=_reportOffset+d; if(n>0) return; _reportOffset=n; renderReport(); }
// Richie's plain-English take on the month — two sentences derived from the report figures (no AI).
function _reportNarrative(r){
  const bits=[];
  if(r.net>=0) bits.push(`In ${r.label} you brought in ${fmtK(r.income)} and spent ${fmtK(r.spend)}, keeping ${fmtK(r.net)} — about a ${r.savingsRate}% savings rate.`);
  else bits.push(`In ${r.label} you spent ${fmtK(r.spend)} against ${fmtK(r.income)} of income, running ${fmtK(Math.abs(r.net))} short for the month.`);
  const top=r.cats&&r.cats[0];
  if(top){ const pct=r.spend>0?Math.round(top.value/r.spend*100):0;
    const tail = r.net<0 ? ' — easing it a little would flip the month back to positive.'
      : r.savingsRate>=20 ? ' — a strong month, keep it going!'
      : ' — the first place to look if you want to save a bit more.';
    bits.push(`${esc(top.label)} was your biggest category at ${fmtK(top.value)} (${pct}% of spending)${tail}`);
  }
  return bits.join(' ');
}
function renderReport(){
  const el=gg('reportBody'); if(!el) return;
  const r=engMonthlyReport(_reportOffset);
  const partial=r.isCurrent?' <span class="rep-partial">(month in progress)</span>':'';
  const maxCat=Math.max(1,...r.cats.map(c=>c.value));
  const catRows=r.cats.length?r.cats.map(c=>`<div class="rep-row"><span class="rep-dot" style="background:${c.color}"></span><span class="rep-lbl">${esc(c.label)}</span><span class="rep-barwrap"><span class="rep-bar" style="width:${Math.round(c.value/maxCat*100)}%;background:${c.color}"></span></span><span class="rep-pct">${r.spend>0?Math.round(c.value/r.spend*100):0}%</span><b class="rep-amt">${fmtK(c.value)}</b></div>`).join(''):'<div class="ws-hint">No spending recorded this month.</div>';
  const incRows=r.incomes.length?r.incomes.map(s=>`<div class="rep-line"><span>${esc(s.label)}</span><b style="color:var(--green)">${fmtK(s.value)}</b></div>`).join(''):'<div class="ws-hint">No income recorded this month.</div>';
  const merchRows=r.merchants.length?r.merchants.map(s=>`<div class="rep-line"><span>${esc(s.label)}</span><b>${fmtK(s.value)}</b></div>`).join(''):'';
  el.innerHTML=`
    <div class="rep-nav report-noprint">
      <button class="rep-navbtn" onclick="reportShift(-1)" aria-label="Previous month">‹</button>
      <div class="rep-month">${esc(r.label)}${partial}</div>
      <button class="rep-navbtn" onclick="reportShift(1)" aria-label="Next month"${r.offset>=0?' disabled':''}>›</button>
    </div>
    <div class="rep-print" id="repPrint">
      <div class="rep-printhead"><div class="rep-brand">Matt &amp; Dana Finance</div><div class="rep-subtitle">${esc(r.label)} · financial report</div></div>
      <div class="rep-narrative"><span class="rep-narr-ic">💬</span><span>${_reportNarrative(r)}</span></div>
      <div class="rep-sum">
        <div class="rep-sum-card"><div class="rep-sum-lbl">Income</div><div class="rep-sum-num" style="color:var(--green)">${fmtK(r.income)}</div></div>
        <div class="rep-sum-card"><div class="rep-sum-lbl">Spending</div><div class="rep-sum-num" style="color:var(--red)">${fmtK(r.spend)}</div></div>
        <div class="rep-sum-card"><div class="rep-sum-lbl">Net</div><div class="rep-sum-num" style="color:${r.net>=0?'var(--green)':'var(--red)'}">${r.net<0?'−':''}${fmtK(Math.abs(r.net))}</div></div>
        <div class="rep-sum-card"><div class="rep-sum-lbl">Savings rate</div><div class="rep-sum-num">${r.savingsRate}%</div></div>
      </div>
      <div class="rep-sec">Spending by category</div>${catRows}
      <div class="rep-sec">Income by source</div>${incRows}
      ${merchRows?`<div class="rep-sec">Top merchants</div>${merchRows}`:''}
      <div class="rep-sec">Net worth <span style="font-weight:400;color:var(--muted)">· as of today</span></div>
      <div class="rep-line"><span>Total net worth</span><b>${r.netWorth<0?'−':''}${fmtK(Math.abs(r.netWorth))}</b></div>
      <div class="rep-foot">${r.txnCount} transaction${r.txnCount!==1?'s':''} · generated ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}${r.has?'':' · sample data'}</div>
    </div>`;
}
function _downloadText(filename, text, mime){
  try{ const blob=new Blob([text],{type:mime||'text/plain'}); const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click();
    setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); },100);
  }catch(e){ alert('Download failed — '+e.message); }
}
function _csvCell(v){ v=v==null?'':String(v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }
function reportExportCSV(){
  const r=engMonthlyReport(_reportOffset);
  const rows=[];
  rows.push(['Matt & Dana Finance — '+r.label+' report']);
  rows.push([]);
  rows.push(['Summary']); rows.push(['Income',r.income]); rows.push(['Spending',r.spend]); rows.push(['Net',r.net]); rows.push(['Savings rate',r.savingsRate+'%']); rows.push(['Net worth (today)',r.netWorth]);
  rows.push([]); rows.push(['Spending by category','Amount','% of spend']);
  r.cats.forEach(c=>rows.push([c.label,c.value,(r.spend>0?Math.round(c.value/r.spend*100):0)+'%']));
  rows.push([]); rows.push(['Income by source','Amount']);
  r.incomes.forEach(s=>rows.push([s.label,s.value]));
  if(r.merchants.length){ rows.push([]); rows.push(['Top merchants','Amount']); r.merchants.forEach(s=>rows.push([s.label,s.value])); }
  const csv=rows.map(row=>row.map(_csvCell).join(',')).join('\r\n');
  _downloadText(`Richie_Report_${r.label.replace(/\s+/g,'_')}.csv`, csv, 'text/csv;charset=utf-8');
  if(typeof richieSay==='function') richieSay('📄 Report exported as CSV — it\'s in your downloads.');
}
function reportPrint(){ window.print(); }

/* ═══ 0%-PROMO EXPIRATION TRACKING ═══
   Finds bills with a promo end date and computes days remaining + the APR you'd
   start paying once it expires. This is the "rate jump" early-warning system. */
function _parsePromoEnd(s){
  if(!s) return null;
  // accept YYYY-MM-DD or MM/DD/YY(YY)
  let d=null;
  if(/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)){ const [y,m,dd]=s.split('-').map(Number); d=new Date(y,m-1,dd); }
  else if(/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)){ let [m,dd,y]=s.split('/').map(Number); if(y<100)y+=2000; d=new Date(y,m-1,dd); }
  return (d&&!isNaN(d))?d:null;
}
function engPromos(){
  const today=new Date(); today.setHours(0,0,0,0);
  const out=[];
  engBills().forEach(b=>{
    const end=_parsePromoEnd(b.promoEnd);
    if(!end) return;
    const days=Math.round((end-today)/86400000);
    const full=Math.abs(b.bal||0);
    const amt=((b.promoAmt||0)>0)?Math.min(b.promoAmt,full||b.promoAmt):full;   // amount actually under 0% (defaults to full balance)
    out.push({
      name:b.name, note:b.note||'', promo:b.promo||'0% promo',
      end, days, bal:full, promoAmt:(b.promoAmt||0), amt, apr:(b.apr||0),
      // monthly cost once the promo expires, at the standard APR on the amount that was at 0%
      monthlyAfter: amt*((b.apr||0)/100)/12,
      // at current pay, will the promo amount be cleared before the promo ends?
      payoffMonths: (b.pay>0 && amt>0) ? Math.ceil(amt/b.pay) : Infinity,
    });
  });
  return out.sort((a,b)=>a.days-b.days);
}
function engPromoAlerts(withinDays){
  withinDays = withinDays||60;
  return engPromos().filter(p=>p.bal>0.5 && p.days<=withinDays && p.days> -3650);
}

/* ═══ CREDIT UTILIZATION + DEBT-TO-INCOME ═══ */
/* Credit-card debt only — bills categorized CC and credit-type accounts cover the same
   cards from two sources (Plaid liabilities vs balances), so take the larger rather than
   summing both, which would double-count. */
function engCCDebt(){
  const fromBills=engBills().filter(b=>b.cat==='CC').reduce((s,b)=>s+Math.abs(b.bal||0),0);
  const fromAccts=engAccounts().filter(a=>!a.excluded&&a.type==='credit').reduce((s,a)=>s+Math.abs(a.bal||0),0);
  return Math.max(fromBills,fromAccts);
}
/* ═══ DEBT GROUPING & FOCUS ═══
   Total debt lumps credit cards in with the mortgage/auto/HELOC and looks unattainable.
   Split it: "revolving" (credit cards — the high-APR fight worth winning first) vs
   "long-term/installment" (mortgage, auto, HELOC, other loans — the marathon). The user
   can also ⭐ any long-term balance into their Focus set (or un-star a card), so the
   tracked payoff number is the fight they actually chose. Overrides live in
   APP.debtFocus {key:true|false}; absent = default (credit cards in, everything else out). */
function _debtKey(b){ return b && (b.account_id ? 'a:'+b.account_id : 'n:'+String(b.name||'').toLowerCase()); }
function _debtFocusMap(){ if(!APP.debtFocus||typeof APP.debtFocus!=='object') APP.debtFocus={}; return APP.debtFocus; }
function _debtInFocus(b){ const m=_debtFocusMap(), k=_debtKey(b); return (k in m)?!!m[k]:(b&&b.cat==='CC'); }
function engDebtGroups(){
  const debts=engBills().filter(b=>Math.abs(b.bal||0)>0.005);
  const byBal=(a,b)=>Math.abs(b.bal||0)-Math.abs(a.bal||0);
  const revolving=debts.filter(b=>b.cat==='CC').sort(byBal);
  const installment=debts.filter(b=>b.cat!=='CC').sort(byBal);
  const focusItems=debts.filter(_debtInFocus).sort(byBal);
  const rest=debts.filter(b=>!_debtInFocus(b)).sort(byBal);
  const sum=arr=>arr.reduce((s,b)=>s+Math.abs(b.bal||0),0);
  return { revolving, installment, focusItems, rest,
    revTotal:sum(revolving), instTotal:sum(installment), focusTotal:sum(focusItems), restTotal:sum(rest),
    total:sum(debts), count:debts.length };
}
function engFocusDebt(){ return engDebtGroups().focusTotal; }
// Is the current Focus set exactly "all credit cards, nothing else"? If so the tracked goal
// uses the existing ccdebt metric ("Kill credit-card debt"); otherwise a custom focus-debt goal.
function _focusIsCC(g){ g=g||engDebtGroups(); return !!(g.focusItems.length && g.focusItems.length===g.revolving.length && g.rest.every(b=>b.cat!=='CC')); }
function engCreditUtil(){
  const cards=engBills().filter(b=>b.cat==='CC' && (b.limit||0)>0);
  const limit=cards.reduce((s,c)=>s+(c.limit||0),0);
  const used=cards.reduce((s,c)=>s+Math.abs(c.bal||0),0);
  const pct=limit>0?(used/limit*100):0;
  return { limit, used, pct, cards: cards.map(c=>({
    name:c.name, used:Math.abs(c.bal||0), limit:c.limit||0,
    pct:(c.limit>0?Math.abs(c.bal||0)/c.limit*100:0)
  })).sort((a,b)=>b.pct-a.pct) };
}
function engDTI(){
  // monthly debt obligations (minimums on actual debt) vs gross monthly income
  const debtPay=engBills().filter(b=>Math.abs(b.bal||0)>0).reduce((s,b)=>s+(b.min||0),0);
  const income=engMonthlyIncome();
  return { ratio: income>0?(debtPay/income):0, debtPay, income };
}

/* ═══ MONTHS-TO-PAYOFF (with interest) ═══
   Amortizes a balance at the given APR and monthly payment. Returns months and
   total interest. Flags when the payment can't cover interest (never pays off). */
function payoffMonths(balance, apr, pay){
  balance=Math.abs(balance||0); pay=Math.abs(pay||0);
  if(balance<=0) return {months:0, interest:0, neverPaysOff:false, paidOff:true};
  if(pay<=0) return {months:Infinity, interest:0, neverPaysOff:true};
  const r=(apr||0)/100/12;
  if(r<=0){ const m=Math.ceil(balance/pay); return {months:m, interest:0, neverPaysOff:false}; }
  const minPay=balance*r;
  if(pay<=minPay+0.01) return {months:Infinity, interest:Infinity, neverPaysOff:true}; // payment ≤ interest
  // n = -ln(1 - r*B/P) / ln(1+r)
  const n=-Math.log(1 - r*balance/pay)/Math.log(1+r);
  const months=Math.ceil(n);
  const interest=Math.max(0, pay*months - balance);
  return {months, interest:Math.round(interest), neverPaysOff:false};
}
function fmtMonths(m){
  if(m===0) return 'paid off';
  if(!isFinite(m)) return 'never';
  if(m<12) return m+' mo';
  const y=Math.floor(m/12), mo=m%12;
  return mo?`${y}y ${mo}m`:`${y}y`;
}
function _billPayoffLabel(b){
  if(!(Math.abs(b.bal||0)>0 && (b.pay||b.min)>0)) return '';
  const po=payoffMonths(b.bal, b.apr, b.pay||b.min);
  if(po.neverPaysOff) return ' \u00b7 <span style="color:var(--red)">pay \u2264 interest</span>';
  return ' \u00b7 '+fmtMonths(po.months)+' to clear';
}

/* ═══════════════ FINANCIAL GOALS ═══════════════
   Each goal links to a live metric so progress tracks automatically. */
const GOAL_METRICS={
  savings:    {label:'Total savings/cash', icon:'💰', dir:'up',   get:()=>Math.max(engStartCash(), engNWAssets()), unit:'$'},
  networth:   {label:'Net worth',          icon:'📈', dir:'up',   get:()=>dataLoaded?engNetBalance()+engNWAssets()-engNWLiab():engNetWorth(), unit:'$'},
  debt:       {label:'Total debt',         icon:'💳', dir:'down', get:()=>engBillsDebt()||engTotalDebt(), unit:'$'},
  ccdebt:     {label:'Credit-card debt',   icon:'✂️', dir:'down', get:()=>engCCDebt(), unit:'$'},
  focusdebt:  {label:'Focus-debt payoff',  icon:'🎯', dir:'down', get:()=>engFocusDebt(), unit:'$'},
  emergency:  {label:'Emergency fund',     icon:'🛟', dir:'up',   get:()=>engEmergencyFund(), unit:'$'},
  creditutil: {label:'Credit utilization', icon:'📉', dir:'down', get:()=>Math.round(engCreditUtil().pct), unit:'%'},
  creditlimit:{label:'Total credit limit', icon:'💳', dir:'up',   get:()=>Math.round(engCreditUtil().limit), unit:'$'},
  savingsrate:{label:'Monthly savings rate',icon:'📊',dir:'up',   get:()=>{ const inc=engMonthlyIncome(); const sp=dataLoaded?engSpend30():engMonthlyBills(); return inc>0?Math.round((inc-sp)/inc*100):0; }, unit:'%'},
  custom:     {label:'Custom (manual)',    icon:'🎯', dir:'up',   get:()=>null, unit:'$'},
};
// Preset goals the user can activate with one tap
const GOAL_PRESETS=[
  {key:'ccutil30',name:'Lower CC utilization to 30%', metric:'creditutil', target:30, icon:'📉', blurb:'Get every card under 30% — a big credit-score win.'},
  {key:'ccutil10',name:'Lower CC utilization to 10%', metric:'creditutil', target:10, icon:'📉', blurb:'Under 10% is excellent-credit territory.'},
  {key:'cclimit', name:'Increase total credit limit', metric:'creditlimit',target:null,icon:'⬆️', blurb:'Raise your limit — which also lowers utilization.', auto:'limitup'},
  {key:'ef1k',   name:'Starter emergency fund', metric:'emergency', target:1000,  icon:'🛟', blurb:'Your first $1,000 safety net.'},
  {key:'ef3mo',  name:'3-month emergency fund', metric:'emergency', target:null,  icon:'🛟', blurb:'Three months of expenses saved.', auto:'3mo'},
  {key:'debtfree',name:'Become debt-free',      metric:'debt',      target:0,     icon:'🚀', blurb:'Pay every balance down to zero.'},
  {key:'cc0',    name:'Kill credit-card debt',  metric:'ccdebt',    target:0,     icon:'✂️', blurb:'Wipe out high-interest card balances.'},
  {key:'save10k',name:'Save $10,000',           metric:'savings',   target:10000, icon:'💰', blurb:'Build a solid cash cushion.'},
  {key:'nw100k', name:'$100K net worth',        metric:'networth',  target:100000,icon:'💎', blurb:'Cross the six-figure milestone.'},
  {key:'sr20',   name:'Save 20% of income',     metric:'savingsrate',target:20,   icon:'📊', blurb:'Hit a 20% monthly savings rate.'},
  {key:'fire25', name:'Reach Coast FIRE',       metric:'networth',  target:null,  icon:'🔥', blurb:'25× your annual expenses invested.', auto:'fire'},
];
function _goals(){
  if(!APP.goals) APP.goals=[];
  // Migration: "Kill credit-card debt" goals created before the ccdebt metric existed
  // tracked ALL debt. Switch them over; start=null re-baselines from current CC debt.
  APP.goals.forEach(g=>{ if(g&&g.metric==='debt'&&(g.presetKey==='cc0'||/credit.?card/i.test(g.name||''))){ g.metric='ccdebt'; g.start=null; } });
  return APP.goals;
}

/* ═══ GOAL → WIDGETS → PAGE mapping (the goals-first brain) ═══
   Each preset goal knows: which widgets help achieve it, what page to build,
   and how Richie should teach the path. */
const GOAL_PLANS={
  emergency:{ page:{name:'Emergency Fund',icon:'🛟',color:'#38bdf8'},
    widgets:['goals','health_score','safe_spend','savings_buckets','bill_calendar','zero_budget'],
    coach:"An emergency fund is your financial seatbelt. I've set up Savings Buckets so you can grow it as its own sinking fund, a Cash on Hand tracker, your Zero-Based Budget to carve out savings, and the Cash Flow Planner to see what you can set aside each payday. Automate a transfer the day you get paid — pay your future self first.",
    teach:["Set aside a fixed amount every payday — before you spend.","Keep it in a separate savings account so it's out of sight.","Start with $1,000, then build to 3 months of expenses."] },
  debt:{ page:{name:'Debt Freedom',icon:'🚀',color:'#f05c5c'},
    widgets:['goals','health_score','debt_hub','safe_spend','bill_calendar','cashflow_planner'],
    coach:"Let's get you debt-free. I've laid out your Total Debt, your Credit Utilization gauge, a 0%-Promo Tracker so no intro rate sneaks up on you, the Debt Payoff Planner (try avalanche — it kills the highest interest first), your Bills, and the Cash Flow Planner to find extra dollars. Every extra payment is a guaranteed return equal to your interest rate.",
    teach:["Always pay more than the minimum — even $25 extra compounds.","Attack the highest-APR balance first (avalanche method).","Pay off 0% promos before they expire — the rate jump is brutal.","Keep utilization under 30% (under 10% is ideal) to protect your score."] },
  savings:{ page:{name:'Savings Builder',icon:'💰',color:'#2ecc8a'},
    widgets:['goals','health_score','savings_buckets','spending_hub','safe_spend','zero_budget'],
    coach:"Building savings is about widening the gap between what you earn and what you spend. I've set up Savings Buckets to fund your goals, Budget vs Actual to see where you're drifting, your Zero-Based Budget, a Profit & Loss panel, and Top Categories to spot what to trim. Find one expense to cut and redirect it into a bucket.",
    teach:["Automate savings so it happens without willpower.","Review your top spending category monthly and trim 10%.","Treat savings like a non-negotiable bill."] },
  networth:{ page:{name:'Wealth Builder',icon:'💎',color:'#5b8def'},
    widgets:['goals','health_score','net_worth_chart','debt_hub','spending_hub'],
    coach:"Net worth is the real scoreboard — assets minus debts. I've set up your Net Worth snapshot and trend chart so you can watch it climb, plus debt and P&L so you see both levers. Grow assets, shrink debts, and let time + compounding do the heavy lifting.",
    teach:["Net worth = what you own minus what you owe. Grow the gap.","Invest consistently — time in the market beats timing it.","Track the trend monthly; direction matters more than any single number."] },
  savingsrate:{ page:{name:'Savings Rate',icon:'📊',color:'#a78bfa'},
    widgets:['goals','health_score','spending_hub','zero_budget','safe_spend','pl_panel'],
    coach:"Your savings rate is the single best predictor of financial freedom. I've set up your Profit & Loss, Budget vs Actual to catch overspending, the budget to plan it, and Top Categories to find the leaks. Push the rate up a few points at a time — every percent buys you future freedom.",
    teach:["Savings rate = (income − spending) ÷ income. Aim to raise it steadily.","Increasing income helps, but cutting waste is faster to control.","A 20% rate is solid; 30%+ is wealth-building territory."] },
  custom:{ page:{name:'My Goal',icon:'🎯',color:'#2ecc8a'},
    widgets:['goals','health_score','safe_spend','spending_hub','bill_calendar'],
    coach:"Custom goal locked in. I've given you the core tracking tools — your Goals tracker, cash position, budget, and P&L. Update your progress as you go and I'll keep cheering you on.",
    teach:["Break a big goal into monthly milestones.","Track progress regularly so you stay motivated.","Celebrate small wins along the way."] },
};
GOAL_PLANS.ccdebt=GOAL_PLANS.debt;   // CC-only goal uses the same page/widgets/coaching as debt
GOAL_PLANS.focusdebt=GOAL_PLANS.debt;   // hand-picked focus payoff uses the same debt page/coaching
function goalPlanFor(metric){ return GOAL_PLANS[metric]||GOAL_PLANS.custom; }
function goalAutoTarget(kind){
  if(kind==='3mo') return Math.round(engMonthlyBills()*3)||3000;
  if(kind==='fire') return Math.round(engMonthlyBills()*12*25)||500000;
  if(kind==='limitup') return Math.round((engCreditUtil().limit||5000)*1.5)||10000;
  return 0;
}
// Emergency fund = sum of accounts you've tagged as emergency (else the emergency budget bucket).
function engEmergencyFund(){
  const tagged=APP.emergencyAccts||[];
  if(tagged.length){ return engAccounts().filter(a=>!a.excluded && tagged.includes(a.rawName||a.name)).reduce((s,a)=>s+Math.max(0,a.bal||0),0); }
  const b=(APP.zeroBuckets||zeroBuckets).find(x=>/emer/i.test(x.name)); return b?b.amt:0;
}
function goalProgress(g){
  const m=GOAL_METRICS[g.metric]; if(!m) return {pct:0,current:0,target:g.target||0};
  let current = g.metric==='custom' ? (g.current||0) : m.get();
  // Pay-down goals: (re-)anchor the baseline at the high-water mark. Covers migrated goals
  // (start=null) and debt that grew past the original start — progress % stays meaningful.
  if(m.dir==='down' && current>0 && (g.start==null || g.start<current)) g.start=current;
  const start = g.start!=null?g.start:0;
  const target = g.target||0;
  let pct;
  if(m.dir==='down'){ // debt: progress = how much paid off from start toward target
    const total=(start-target)||1; pct=Math.max(0,Math.min(100,Math.round((start-current)/total*100)));
  } else {
    const total=(target-start)||1; pct=Math.max(0,Math.min(100,Math.round((current-start)/total*100)));
  }
  const done = m.dir==='down' ? current<=target : current>=target;
  // Deadline pacing: how much remains, time left, and whether on track
  let pace=null;
  const dl=_parseGoalDeadline(g.deadline);
  if(dl && !done){
    const today=new Date(); today.setHours(0,0,0,0);
    const daysLeft=Math.round((dl-today)/86400000);
    const monthsLeft=Math.max(0, daysLeft/30.44);
    const remaining = m.dir==='down' ? Math.max(0,current-target) : Math.max(0,target-current);
    const perMonthNeeded = monthsLeft>0.1 ? remaining/monthsLeft : remaining;
    // progress expected by now vs actual (are we ahead or behind schedule?)
    const totalSpan = m.dir==='down' ? (start-target) : (target-start);
    const createdD = g.created?new Date(g.created):today;
    const totalDays = Math.max(1,(dl-createdD)/86400000);
    const elapsedFrac = Math.max(0,Math.min(1,(today-createdD)/86400000/totalDays));
    const expectedPct = Math.round(elapsedFrac*100);
    pace={daysLeft, monthsLeft:Math.round(monthsLeft*10)/10, remaining, perMonthNeeded, expectedPct, onTrack: pct>=expectedPct-5, deadline:dl};
  }
  return {pct:done?100:pct, current, target, done, dir:m.dir, unit:m.unit, pace};
}
// parse a goal deadline that may be 'YYYY-MM-DD', 'Dec 2026', 'Dec 2026', or '12/2026'
function _parseGoalDeadline(s){
  if(!s) return null;
  s=String(s).trim();
  if(/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)){ const [y,m,d]=s.split('-').map(Number); const dt=new Date(y,m-1,d); return isNaN(dt)?null:dt; }
  const mons={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const mm=s.toLowerCase().match(/([a-z]{3})[a-z]*\.?\s+(\d{4})/);
  if(mm && mons[mm[1]]!=null){ return new Date(+mm[2], mons[mm[1]]+1, 0); } // end of that month
  const slash=s.match(/^(\d{1,2})\/(\d{4})$/);
  if(slash){ return new Date(+slash[2], +slash[1], 0); }
  const d=new Date(s); return isNaN(d)?null:d;
}
function goalFmt(v,unit){ return unit==='%'?Math.round(v)+'%':fmtK(v); }
function addGoal(g){
  g.id='g'+Date.now()+Math.floor(Math.random()*99);
  const m=GOAL_METRICS[g.metric];
  g.start = g.metric==='custom' ? 0 : (m?m.get():0);
  g.created=Date.now(); g.completed=false;
  _goals().push(g); saveState();
  awardXp(25,'New goal set: '+g.name+'!');
  if(sbRichie)sbRichie.do('bounce');
  setTimeout(()=>richieGoalHint(g),600);
}
function removeGoal(id){ APP.goals=_goals().filter(g=>g.id!==id); saveState(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function checkGoalCompletion(){
  let any=false;
  _goals().forEach(g=>{
    if(g.completed) return;
    const p=goalProgress(g);
    if(p.done){ g.completed=true; g.completedAt=Date.now(); any=true;
      awardXp(50);
      if(sbRichie)sbRichie.do('tada');
      try{ gamiGoalCompleted(g); }catch(e){}
    } else {
      // Milestone cheers on the way up — fire once for the highest newly-crossed of 25/50/75%.
      g._ms=g._ms||{};
      const crossed=[25,50,75].filter(mk=>p.pct>=mk);
      const top=crossed[crossed.length-1];
      if(top && !g._ms[top]){
        crossed.forEach(mk=>{ g._ms[mk]=true; });   // mark all up to the top as seen (no backfill pops)
        any=true;
        try{ awardXp(10); }catch(e){}
        if(sbRichie)sbRichie.do('nod');
        try{ richieCelebrate(`${top}% of the way to your "${g.name||'goal'}" goal — ${top>=75?'so close, keep pushing! 🔥':top>=50?'halfway there! 🎯':'strong start! 💪'}`); }catch(e){}
      }
    }
  });
  if(any) saveState();
}
// Savings-bucket goals: celebrate 🎊 the moment a bucket first reaches its target. Seeds silently
// on first run so already-funded buckets don't all pop at once; re-arms if a bucket drops below.
function bucketCheckGoals(){
  try{
    APP.bucketDone=APP.bucketDone||{};
    const buckets=(typeof engSavingsBuckets==='function')?engSavingsBuckets():[];
    if(!APP._bucketSeeded){ buckets.forEach(b=>{ if(b.done&&b.name) APP.bucketDone[b.name]=1; }); APP._bucketSeeded=1; saveState(); return; }
    let changed=false;
    buckets.forEach(b=>{ const k=b.name; if(!k) return;
      if(b.done && b.target>0){ if(!APP.bucketDone[k]){ APP.bucketDone[k]=1; changed=true;
        try{ emojiBurst('tada',{particle:'stars',count:14}); }catch(e){}
        try{ richieCelebrate(`🎊 ${b.name} is fully funded — ${fmtK(b.target)} saved! Enjoy it, or set the next goal.`); }catch(e){}
        try{ awardXp(20); }catch(e){}
      } }
      else if(APP.bucketDone[k]){ delete APP.bucketDone[k]; changed=true; }   // spent back below target → re-arm
    });
    if(changed) saveState();
  }catch(e){}
}
// Big financial milestones — debt-free 🚀 and emergency-fund 🏆. Seeds silently on first run so an
// already-hit milestone doesn't pop; each fires once on the crossing and re-arms if it slips back.
function financialMilestones(){
  try{
    APP.fmDone=APP.fmDone||{}; let changed=false;
    const seeding=!APP._fmSeeded;
    const fire=(k,ok,fx,msg,xp)=>{
      if(ok){ if(!APP.fmDone[k]){ APP.fmDone[k]=1; changed=true;
        if(!seeding){ try{ emojiBurst(fx,{particle:'stars',count:15}); }catch(e){} try{ richieCelebrate(msg); }catch(e){} try{ awardXp(xp||50); }catch(e){} } } }
      else if(APP.fmDone[k]){ delete APP.fmDone[k]; changed=true; }
    };
    // Emergency fund, measured in months of expenses
    let ef=0, exp=1; try{ ef=engEmergencyFund(); }catch(e){} try{ exp=Math.max(engMonthlyBills(),1); }catch(e){}
    const months=exp>0?ef/exp:0;
    fire('ef3', months>=3, 'trophy', `🏆 Three months of expenses saved — a real safety net. Next stop: six.`, 60);
    fire('ef6', months>=6, 'trophy', `🏆 Six months of expenses banked — fortress-level. Incredible.`, 100);
    // Debt-free — only celebrated once you've actually carried tracked debt
    let totalDebt=0; try{ totalDebt=(typeof engDebtGroups==='function')?(engDebtGroups().total||0):0; }catch(e){}
    if(totalDebt>=1 && !APP._hadDebt){ APP._hadDebt=1; changed=true; }
    fire('debtfree', (totalDebt<1 && !!APP._hadDebt), 'rocket', `🚀 DEBT-FREE! Every tracked balance is at zero. Aim that old payment straight at savings now.`, 120);
    if(seeding){ APP._fmSeeded=1; changed=true; }
    if(changed) saveState();
  }catch(e){}
}
// Cadenced action plans per goal type (mirrors the workbook's Daily/Weekly/Monthly/Quarterly columns)
const GOAL_CADENCE={
  debt:       {daily:'Track today\'s spending — every dollar not spent is a dollar toward debt.', weekly:'Review your highest-APR balance and send any spare cash its way.', monthly:'Make one extra payment above the minimum on your top-APR card.', quarterly:'Aim for one full month under budget and throw the surplus at debt.'},
  emergency:  {daily:'Skip one impulse buy and note it — that\'s your fund growing.', weekly:'Confirm your automatic transfer to savings went through.', monthly:'Move $100 (or more) into the fund the day you get paid.', quarterly:'Check for any surplus and top up the fund.'},
  savings:    {daily:'Log your spending — awareness is half the battle.', weekly:'Spot one category running hot and rein it in.', monthly:'Sweep your leftover cash into savings before it disappears.', quarterly:'Rebalance your budget and bump your savings target.'},
  savingsrate:{daily:'Track expenses so nothing slips through.', weekly:'Pick one category to trim 10% this week.', monthly:'Recompute your rate — did it tick up?', quarterly:'Look for an income bump or a recurring cost to cut.'},
  networth:   {daily:'Avoid new debt — protect the scoreboard.', weekly:'Check your accounts; note any drift.', monthly:'Invest consistently — automate the contribution.', quarterly:'Rebalance and review your asset mix.'},
  custom:     {daily:'Small consistent action beats big sporadic effort.', weekly:'Check your progress and adjust.', monthly:'Make a meaningful contribution toward this goal.', quarterly:'Step back and reassess the plan.'},
};
// Richie coaching: contextual hint per goal, now deadline + pace aware
function richieGoalHint(g){
  if(!g) return;
  const p=goalProgress(g); const m=GOAL_METRICS[g.metric];
  let hint;
  if(p.done){ hint=`"${g.name}" is already in the bag! 🎉`; richieSay(hint); return; }
  // deadline-aware framing first
  if(p.pace){
    const pc=p.pace;
    if(pc.daysLeft<0){ hint=`"${g.name}" is past its deadline, but it's not too late — ${fmtK(pc.remaining)} to go. Want to set a new target date?`; }
    else if(!pc.onTrack){
      const need = m.unit==='%' ? 'pick up the pace' : `you'd need about ${fmtK(pc.perMonthNeeded)}/mo`;
      hint=`Heads up — "${g.name}" is running behind schedule. To hit it by ${pc.deadline.toLocaleDateString('en-US',{month:'short',year:'numeric'})}, ${need}. ${(GOAL_CADENCE[g.metric]||GOAL_CADENCE.custom).monthly}`;
    } else {
      hint=`Nice — "${g.name}" is on track for ${pc.deadline.toLocaleDateString('en-US',{month:'short',year:'numeric'})} (${p.pct}% done). Keep it up: ${(GOAL_CADENCE[g.metric]||GOAL_CADENCE.custom).weekly}`;
    }
    richieSay(hint); return;
  }
  // no deadline — fall back to metric-specific coaching
  if(g.metric==='debt'){ const left=p.current-p.target; hint=`To crush "${g.name}", throw every extra dollar at your highest-APR balance. ${fmtK(left)} to go \u2014 even $50 extra a month moves the needle.`; }
  else if(g.metric==='emergency'){ hint=`Building "${g.name}"? Automate it \u2014 set aside a fixed amount each payday before you can spend it. You're ${p.pct}% there.`; }
  else if(g.metric==='savings'||g.metric==='networth'){ const left=p.target-p.current; hint=`"${g.name}" is ${p.pct}% done \u2014 ${fmtK(left)} to go. Trim one recurring expense and redirect it here; small leaks sink big ships.`; }
  else if(g.metric==='savingsrate'){ hint=`Want a ${p.target}% savings rate? Look at your top spending category and shave 10% off it. You're at ${p.current}% now.`; }
  else { hint=`Keep chipping away at "${g.name}" \u2014 ${p.pct}% there. Update your progress as you go!`; }
  richieSay(hint);
}
// A cadence-specific nudge Richie can give (used by proactive coaching)
function goalCadenceNudge(g, cadence){
  const plan=GOAL_CADENCE[g.metric]||GOAL_CADENCE.custom;
  return plan[cadence]||plan.weekly;
}
function engNWAssets(){ return nwAssets.reduce((s,a)=>s+(a.value||0),0) + (APP.nwManualAssets||[]).reduce((s,a)=>s+(+a.value||0),0) + engPosOnlyAccounts().reduce((s,p)=>s+p.value,0); }
function engNWLiab(){ return nwLiab.reduce((s,l)=>s+(l.value||0),0) + (APP.nwManualLiab||[]).reduce((s,l)=>s+(+l.value||0),0); }
function _nwManA(){
  return (APP.nwManualAssets||[]).filter(x=>+x.value>0).map(x=>({label:x.name||x.cat,value:+x.value,note:x.cat||'manual'}))
    .concat(engPosOnlyAccounts().map(p=>({label:p.name,value:p.value,note:'portfolio positions'})));
}
function _nwManL(){ return (APP.nwManualLiab||[]).filter(x=>+x.value>0).map(x=>({label:x.name||x.cat,value:+x.value,note:x.cat||'manual'})); }
function engNetWorth(){ return engNWAssets()-engNWLiab(); }
function engUpcomingBills(){
  const today=new Date().getDate();
  return engBills().filter(b=>b.pay>0).sort((a,b)=>{
    const da=a.due<today?a.due+31:a.due, db=b.due<today?b.due+31:b.due; return da-db;
  });
}
// Monthly spend series from live transactions, last N months
function engMonthlySeries(months){
  months=months||6; const now=new Date(); const out=[];
  for(let m=months-1;m>=0;m--){
    const d=new Date(now.getFullYear(),now.getMonth()-m,1);
    const next=new Date(now.getFullYear(),now.getMonth()-m+1,1);
    const lbl=d.toLocaleString('en-US',{month:'short'});
    let spend=0,income=0;
    allTxns.forEach(t=>{ const td=new Date(t.date); if(td>=d&&td<next){ if(t.amount>0)spend+=t.amount; else income+=Math.abs(t.amount); } });
    out.push({label:lbl,spend:Math.round(spend),income:Math.round(income)});
  }
  return out;
}

/* ═══ CATEGORY × MONTH HEATMAP ═══
   Returns {months:[labels], cats:[{label, color, vals:[per-month], total, avg}], max}
   Live from txns when available, otherwise a representative sample grid. */
function engCategoryMonthGrid(months){
  months=months||6;
  const now=new Date();
  const monthLabels=[]; const monthBounds=[];
  for(let m=months-1;m>=0;m--){
    const d=new Date(now.getFullYear(),now.getMonth()-m,1);
    const next=new Date(now.getFullYear(),now.getMonth()-m+1,1);
    monthLabels.push(d.toLocaleString('en-US',{month:'short'}));
    monthBounds.push([d,next]);
  }
  const catMap={};  // label -> vals[]
  if(dataLoaded && allTxns.length){
    allTxns.forEach(t=>{
      if(t.amount<=0 || _txnExcludedFromSpend(t)) return; // spending only — CC payments/transfers excluded
      const td=new Date(t.date);
      const mi=monthBounds.findIndex(([a,b])=>td>=a&&td<b);
      if(mi<0) return;
      const c=getTxnCategory(t);
      if(!catMap[c]) catMap[c]=new Array(months).fill(0);
      catMap[c][mi]+=t.amount;
    });
  } else {
    // sample seasonal grid (rows roughly matching real categories)
    const seed={
      'Groceries':[820,393,488,560,420,510],'Dining out':[270,248,886,1070,420,360],
      'Auto':[1025,1040,1048,1068,1018,990],'House':[2905,5538,321,2952,2932,2994],
      'Medical':[680,1078,748,1619,663,540],'Gas':[161,186,249,517,160,240],
      'Subscription':[124,126,343,623,110,98],'Utilities':[319,319,320,320,309,300],
    };
    Object.entries(seed).forEach(([k,v])=>{ catMap[k]=v.slice(-months); });
  }
  let max=0;
  const cats=Object.entries(catMap).map(([label,vals])=>{
    const total=vals.reduce((s,v)=>s+v,0);
    vals.forEach(v=>{ if(v>max)max=v; });
    return {label, color:getCatColor(label), vals:vals.map(v=>Math.round(v)), total:Math.round(total), avg:Math.round(total/months)};
  }).filter(c=>c.total>0).sort((a,b)=>b.total-a.total);
  return {months:monthLabels, cats, max:max||1};
}

/* ═══ SPENDING TRENDS ═══
   Same-period month-over-month: this month so far vs the same span last month
   (through the same day-of-month), so a partial current month compares fairly.
   Also projects the full month and paces the budgeted categories against the budget. */
function engSpendTrends(){
  const now=new Date();
  const y=now.getFullYear(), mo=now.getMonth(), dom=now.getDate();
  const curStart=new Date(y,mo,1);
  const prevStart=new Date(y,mo-1,1);
  const prevDays=new Date(y,mo,0).getDate();                 // days in the previous month
  const prevCut=new Date(y,mo-1,Math.min(dom,prevDays),23,59,59,999);   // fair same-period cutoff
  const daysInMonth=new Date(y,mo+1,0).getDate();
  const elapsed=Math.min(1, dom/daysInMonth);
  const budgetCats=(typeof _budgetCatSet==='function')?_budgetCatSet():new Set();
  const cur={}, prevSame={}, prevFull={}; let curBudget=0;
  const has=dataLoaded && allTxns && allTxns.length>0;
  if(has){
    allTxns.forEach(t=>{
      if(t.amount<=0 || _txnExcludedFromSpend(t)) return;
      const td=new Date(t.date); const c=getTxnCategory(t);
      if(td>=curStart && td<=now){ cur[c]=(cur[c]||0)+t.amount; if(budgetCats.has(c)) curBudget+=t.amount; }
      else if(td>=prevStart && td<curStart){ prevFull[c]=(prevFull[c]||0)+t.amount; if(td<=prevCut) prevSame[c]=(prevSame[c]||0)+t.amount; }
    });
  } else {   // sample: this-month-so-far vs same-span-last-month
    Object.assign(cur,{'Groceries':488,'Dining out':386,'Auto':540,'Subscription':143,'Gas':96});
    Object.assign(prevSame,{'Groceries':346,'Dining out':449,'Auto':540,'Subscription':121,'Gas':120});
    Object.assign(prevFull,{'Groceries':420,'Dining out':560,'Auto':1018,'Subscription':110,'Gas':160});
  }
  const sum=o=>Object.values(o).reduce((s,v)=>s+v,0);
  const curTotal=sum(cur), prevSameTotal=sum(prevSame), prevFullTotal=sum(prevFull);
  const projected=elapsed>0?curTotal/elapsed:curTotal;
  const labels=new Set([...Object.keys(cur),...Object.keys(prevSame)]);
  const movers=[...labels].map(l=>({label:l,color:getCatColor(l),cur:Math.round(cur[l]||0),prev:Math.round(prevSame[l]||0),delta:Math.round((cur[l]||0)-(prevSame[l]||0))}))
    .filter(m=>m.delta!==0).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
  let budget=null;
  const bAmt=(typeof engBudgetLinkedBudget==='function'?engBudgetLinkedBudget():0)||(typeof engDiscretionaryBudget==='function'?engDiscretionaryBudget():0);
  if(bAmt>0){ const projSpend=has?(elapsed>0?curBudget/elapsed:curBudget):Math.round(projected*0.7); budget={amount:Math.round(bAmt),projected:Math.round(projSpend),pace:Math.round(bAmt-projSpend)}; }
  return {has,dom,daysInMonth,elapsed,curTotal:Math.round(curTotal),prevSameTotal:Math.round(prevSameTotal),prevFullTotal:Math.round(prevFullTotal),projected:Math.round(projected),vsLastPeriod:Math.round(curTotal-prevSameTotal),movers,budget};
}
// Tap a category mover → open global search filtered to that category's transactions.
function trendSearchCat(cat){ if(typeof openTxnSearch!=='function') return; try{ _txnSearch.q=cat; if(_txnSearch.chips) Object.keys(_txnSearch.chips).forEach(k=>_txnSearch.chips[k]=false); }catch(e){} openTxnSearch(); }
function spendTrendsBody(w){
  const s=engSpendTrends();
  const up=s.vsLastPeriod>0;   // spending more than the same point last month
  const vsCol=up?'var(--amber)':'var(--green)';
  const vsTxt=`${up?'▲':'▼'} ${fmtK(Math.abs(s.vsLastPeriod))} vs same point last month`;
  const proj=`Projected month: <b>${fmtK(s.projected)}</b>${s.prevFullTotal?` · last month ${fmtK(s.prevFullTotal)}`:''}`;
  let pace='';
  if(s.budget){ const under=s.budget.pace>=0; pace=`<div class="st-pace" style="color:${under?'var(--green)':'var(--red)'}">On pace: <b>${fmtK(Math.abs(s.budget.pace))} ${under?'UNDER':'OVER'}</b> budget this month</div>`; }
  const movers=s.movers.slice(0,5);
  const maxD=Math.max(1,...movers.map(m=>Math.abs(m.delta)));
  const rows=movers.map(m=>{
    const mu=m.delta>0; const c=mu?'var(--amber)':'var(--green)'; const wpct=Math.round(Math.abs(m.delta)/maxD*100);
    const q=String(m.label).replace(/'/g,"\\'");
    return `<div class="st-row st-row-go" onclick="event.stopPropagation();trendSearchCat('${q}')" title="See the transactions behind this"><span class="st-dot" style="background:${m.color}"></span><span class="st-lbl">${esc(m.label)} <span class="st-chev">›</span></span><span class="st-barwrap"><span class="st-bar" style="width:${wpct}%;background:${c}"></span></span><b class="st-delta" style="color:${c}">${mu?'▲':'▼'} ${fmtK(Math.abs(m.delta))}</b></div>`;
  }).join('') || '<div class="ws-hint">Not enough history yet to compare months.</div>';
  return `<div class="st-wrap">
    <div class="st-hero"><div class="st-hero-num">${fmtK(s.curTotal)}</div><div class="st-hero-sub">spent so far this month · day ${s.dom} of ${s.daysInMonth}</div>
    <div class="st-vs" style="color:${vsCol}">${vsTxt}</div></div>
    <div class="st-proj">${proj}</div>${pace}
    <div class="st-movers-h">Biggest movers vs last month</div>
    <div class="st-movers">${rows}</div>
  </div>`;
}

/* ── Chart.js utilities (ported buildChartWidget / buildChartLegend) ── */
const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
function buildChartLegend(containerId, items, opts){
  const el=gg(containerId); if(!el) return; opts=opts||{};
  const total=opts.total||items.reduce((s,i)=>s+(i.value||0),0);
  el.innerHTML=items.map(item=>{
    const pct=item.pct!==undefined?item.pct:(total>0?Math.round((item.value||0)/total*100):0);
    const amt=item.value!==undefined?fmtK(Math.round(item.value)):'';
    return '<div class="cwl-item"><div class="cwl-dot" style="background:'+item.color+'"></div>'
      +'<span class="cwl-label" title="'+esc(item.label)+'">'+esc(item.label)+'</span>'
      +(opts.showAmt!==false&&amt?'<span class="cwl-amt">'+amt+'</span>':'')
      +'<span class="cwl-pct">'+pct+'%</span></div>';
  }).join('');
}
const _charts={}; // canvasId -> Chart instance (destroy-before-recreate)
function buildChartWidget(canvasId, type, labels, values, colors, opts){
  opts=opts||{};
  const el=gg(canvasId); if(!el||typeof Chart==='undefined') return null;
  const surfC=getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()||'#161920';
  const data={labels:labels,datasets:(opts.datasets||[{
    data:values, backgroundColor:colors,
    borderWidth:opts.borderWidth!==undefined?opts.borderWidth:2, borderColor:surfC,
    borderRadius:opts.borderRadius||0, fill:opts.fill||false, tension:opts.tension||0.3, borderSkipped:false,
  }])};
  const options=Object.assign({
    responsive:true, maintainAspectRatio:false, cutout:opts.cutout||'0%',
    plugins:{ legend:{display:!!opts.builtinLegend, labels:{color:'#8b8fa8',font:{size:11}}},
      tooltip:{ backgroundColor:'rgba(13,15,20,0.95)',titleColor:'#e4e6f0',bodyColor:'#b0b4cc',borderColor:'rgba(255,255,255,0.1)',borderWidth:1,padding:10,
        callbacks:{ label:ctx=>' '+esc(ctx.label)+':  '+fmtK(ctx.parsed.r||ctx.parsed.y||ctx.parsed||0) } } },
    scales:opts.noScales?undefined:{ x:{grid:{display:false},ticks:{color:'#8b8fa8',font:{size:10}}}, y:{grid:{color:'rgba(128,128,128,0.07)'},ticks:{color:'#8b8fa8',font:{size:10},callback:v=>fmtM(v)}} }
  }, opts.chartOptions||{});
  // Same live canvas + same type → update in place (no destroy/recreate, no flicker).
  // This is the hot path for slider-driven charts (FIRE calculator) where every input
  // event redraws; a rebuilt canvas (renderCanvas innerHTML) never matches and falls
  // through to the destroy+create path as before.
  const prev=_charts[canvasId];
  let inst;
  if(prev && prev.canvas===el && prev.config && prev.config.type===type){
    prev.data=data; prev.options=options; prev.update('none');
    inst=prev;
  } else {
    if(prev&&prev.destroy) prev.destroy();
    inst=new Chart(el,{ type:type, data:data, options:options });
    _charts[canvasId]=inst;
  }
  if(opts.legendId){ const total=values.reduce((s,v)=>s+v,0); buildChartLegend(opts.legendId, labels.map((l,i)=>({label:l,value:values[i],color:colors[i]})), {total:total,showAmt:opts.showAmt!==false}); }
  return inst;
}


/* ── Plaid connection (ported, adapted) ── */
function authToken(){ return ''; }  // auth rides in an httpOnly cookie the browser sends automatically
let _toastT=null;
function showToast(msg,type){
  let el=gg('appToast');
  if(!el){ el=document.createElement('div'); el.id='appToast'; el.style.cssText='position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:2000;padding:11px 18px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 8px 30px rgba(0,0,0,0.4);transition:opacity .25s;opacity:0;max-width:80vw;text-align:center'; document.body.appendChild(el); }
  el.textContent=msg;
  el.style.background = type==='error'?'#3a1d1d':type==='success'?'#163a28':'#1c1f28';
  el.style.color = type==='error'?'#ff9b9b':type==='success'?'#7be0b4':'#e4e6f0';
  el.style.border = '1px solid '+(type==='error'?'rgba(240,92,92,0.4)':type==='success'?'rgba(46,204,138,0.4)':'rgba(255,255,255,0.1)');
  el.style.opacity='1'; clearTimeout(_toastT); _toastT=setTimeout(()=>{el.style.opacity='0';},3200);
}
/* ═══ UPLOAD & ANALYZE STATEMENTS/BILLS (Richie AI) ═══ */
let _docResult=null, _docSel={};
function docShowModal(){ gg('docModal').style.display='flex'; }
function closeDocModal(){ gg('docModal').style.display='none'; _docResult=null; _docSel={}; }
function docUploadPick(){ const inp=gg('docFileInput'); if(inp){ inp.value=''; inp.click(); } }
function docFileChosen(inp){
  const f=inp.files&&inp.files[0]; if(!f) return;
  if(f.size>12*1024*1024){ alert('That file is large (max ~12MB). Try a smaller image, or split the PDF.'); return; }
  const rd=new FileReader();
  rd.onload=()=>{ const b64=String(rd.result||'').split(',')[1]||''; docAnalyze(b64, f.type||'', f.name||'upload'); };
  rd.onerror=()=>alert('Could not read that file.');
  rd.readAsDataURL(f);
}
async function docAnalyze(b64, mime, name){
  docShowModal();
  gg('docBody').innerHTML=`<div class="doc-loading"><div class="bl-bag">💰</div><div class="bl-spin"></div><div class="bl-msg">Richie is reading ${esc(name)}…</div><div class="ws-hint" style="margin-top:6px">Pulling out transactions, balances, APR and due dates.</div></div>`;
  try{
    const r=await fetch('/api/analyze_document',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:b64,mimeType:mime,filename:name})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d.error||!d.result){ gg('docBody').innerHTML=`<div class="doc-err">${esc((d&&d.error)||'Analysis failed. Try a clearer image or a different file.')}</div><div class="mf-actions"><span></span><button class="btn primary" onclick="closeDocModal()">Close</button></div>`; return; }
    _docResult=d.result; docReviewInit(); docReviewRender();
  }catch(e){ gg('docBody').innerHTML=`<div class="doc-err">Couldn't reach the analyzer. Check your connection and try again.</div><div class="mf-actions"><span></span><button class="btn primary" onclick="closeDocModal()">Close</button></div>`; }
}
function _docDupCheck(t){
  const amt=+t.amount||0, dsc=(t.description||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,10);
  return (allTxns||[]).some(x=>x.date===t.date && Math.abs((x.amount||0)-amt)<0.01 && ((x.name||x.merchant_name||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,10)===dsc));
}
function docReviewInit(){
  const t=(_docResult&&_docResult.transactions)||[]; _docSel={};
  t.forEach((x,i)=>{ x._dup=_docDupCheck(x); _docSel[i]=!x._dup; });   // duplicates default OFF
}
function docReviewRender(){
  const r=_docResult||{}, type=r.docType||'', txns=Array.isArray(r.transactions)?r.transactions:[];
  const hasTxns=txns.length>0;
  const isScore=(type==='credit_score')||(!!r.creditScore&&!hasTxns&&!r.accountValue&&r.amountDue==null&&r.premium==null);
  const isInvest=!isScore&&((type==='investment')||(!!r.accountValue&&!hasTxns));
  const isBill=!isInvest&&!isScore&&!hasTxns;   // insurance / phone / cable / utility / loan / any bill
  const field=(lbl,id,val,ph)=>`<div class="doc-f"><label>${lbl}</label><input id="${id}" value="${val!=null?esc(String(val)):''}" placeholder="${ph||''}"></div>`;
  let header, addOpt='', section='', detailLbl='Account / bill';
  if(isScore){
    detailLbl='Score';
    header=`<div class="doc-hgrid">${field('Source','docInst',r.institution,'Credit Karma / Amex')}${field('Score (300–850)','docScore',r.creditScore,'735')}${field('As of','docScoreDate',r.scoreDate||new Date().toISOString().slice(0,10),'YYYY-MM-DD')}</div>`;
    addOpt=`<label class="doc-addbill"><input type="checkbox" id="docLogScore" checked> Log to the Credit Score monitor${r.scoreModel?' · '+esc(r.scoreModel):''}</label>`;
  } else if(isInvest){
    detailLbl='Account';
    header=`<div class="doc-hgrid">${field('Institution','docInst',r.institution,'E*Trade')}${field('Account','docAcct',r.accountName,'IRA / Brokerage')}${field('Total value ($)','docValue',r.accountValue,'0')}</div>`;
    addOpt=`<label class="doc-addbill"><input type="checkbox" id="docAddAsset" checked> Add to Net Worth as an Investment asset (${fmtK(+r.accountValue||0)})</label>`;
    const hold=Array.isArray(r.holdings)?r.holdings:[];
    if(hold.length){
      addOpt+=`<label class="doc-addbill"><input type="checkbox" id="docImportHoldings" checked> Import ${hold.length} position${hold.length!==1?'s':''} into your Portfolio</label>`;
      section=`<div class="doc-section-h">Holdings \u00b7 ${hold.length}</div><div class="doc-txns">${hold.slice(0,80).map(h=>`<div class="doc-txn"><span class="doc-tx-desc" style="border:none">${esc(h.name||'')}${h.symbol?' \u00b7 '+esc(h.symbol):''}</span><span class="doc-tx-amt" style="border:none;background:none">${fmtK(+h.value||0)}</span></div>`).join('')}</div>`;
    }
  } else if(isBill){
    detailLbl='Bill';
    const due=(r.amountDue!=null?r.amountDue:r.premium);
    const hasPromo=(type==='credit_card')||r.promoEndDate||r.promoAPR!=null;
    header=`<div class="doc-hgrid">${field('Provider','docInst',r.institution,'Company')}${field('Account / policy','docAcct',r.accountName,'Name')}${field('Amount due ($)','docDue',due,'0')}${field('Due date','docDueDate',r.dueDate,'YYYY-MM-DD')}${hasPromo?field('0% promo ends','docPromoEnd',r.promoEndDate,'YYYY-MM-DD')+field('Promo balance ($)','docPromoAmt',r.promoBalance,'blank = full balance'):''}</div>`
      +(r.promoDescription||r.promoAPR!=null?`<div class="ws-hint">🎁 Promo found: ${esc(r.promoDescription||'promotional rate')}${r.promoAPR!=null?` · ${r.promoAPR}% APR`:''}${r.promoEndDate?` · ends ${esc(r.promoEndDate)}`:''} — saved to this account so the 0% Promo tracker can warn you before it expires.</div>`:'');
    addOpt=`<label class="doc-addbill"><input type="checkbox" id="docAddBill" checked> Add as a bill in Upcoming Bills</label>`;
  } else {
    header=`<div class="doc-hgrid">${field('Institution','docInst',r.institution,'Bank')}${field('Account / bill','docAcct',r.accountName,'Name')}${field('Amount due ($)','docDue',r.amountDue,'0')}${field('Due date','docDueDate',r.dueDate,'YYYY-MM-DD')}${field('APR (%)','docApr',r.apr,'0')}${field('Credit limit ($)','docLimit',r.creditLimit,'0')}${field('0% promo ends','docPromoEnd',r.promoEndDate,'YYYY-MM-DD')}${field('Promo balance ($)','docPromoAmt',r.promoBalance,'blank = full balance')}</div>`
      +(r.promoDescription||r.promoAPR!=null?`<div class="ws-hint">🎁 Promo found: ${esc(r.promoDescription||'promotional rate')}${r.promoAPR!=null?` · ${r.promoAPR}% APR`:''}${r.promoEndDate?` · ends ${esc(r.promoEndDate)}`:''} — saved to this card so the 0% Promo tracker can warn you before it expires.</div>`:'');
    if(r.amountDue||r.apr||r.creditLimit) addOpt=`<label class="doc-addbill"><input type="checkbox" id="docAddBill" ${r.amountDue?'checked':''}> Also add this as a bill in Upcoming Bills</label>`;
    const dupCount=txns.filter(t=>t._dup).length, selCount=txns.filter((_,i)=>_docSel[i]).length;
    const rows=txns.map((t,i)=>`<label class="doc-txn${t._dup?' dup':''}">
      <input type="checkbox" ${_docSel[i]?'checked':''} onchange="_docSel[${i}]=this.checked;docUpdateCount()">
      <span class="doc-tx-date">${esc(t.date||'\u2014')}</span>
      <input class="doc-tx-desc" value="${esc(t.description||'')}" onchange="_docResult.transactions[${i}].description=this.value">
      <input class="doc-tx-amt" type="number" step="0.01" value="${t.amount!=null?t.amount:''}" onchange="_docResult.transactions[${i}].amount=parseFloat(this.value)||0">
      ${t._dup?'<span class="doc-dupflag" title="Looks like it is already in your data">dup</span>':''}
    </label>`).join('');
    section=`<div class="doc-section-h">Transactions \u00b7 ${txns.length}${dupCount?` \u00b7 <span style="color:var(--amber)">${dupCount} duplicate${dupCount!==1?'s':''} unchecked</span>`:''}</div>
      <div class="doc-selrow"><button class="btn" onclick="docSelectAll(true)">Select all</button><button class="btn" onclick="docSelectAll(false)">None</button><span class="ws-hint" id="docSelCount" style="margin-left:auto">${selCount} selected</span></div>
      <div class="doc-txns">${rows||'<div class="ws-hint">No transactions found in this document.</div>'}</div>`;
  }
  const kindLbl=isScore?'a credit-score snapshot':isInvest?'an investment statement':isBill?('a '+((type||'bill').replace('_',' '))):('a '+((type||'statement').replace('_',' ')));
  gg('docBody').innerHTML=`
    <div class="doc-sub">Richie found ${esc(kindLbl)}${r.institution?' from '+esc(r.institution):''}. Edit anything, then add it.</div>
    <div class="doc-section-h">${detailLbl} details</div>${header}
    ${addOpt}
    ${section}
    <div class="mf-actions"><button class="btn" onclick="closeDocModal()">Cancel</button><button class="btn primary" onclick="docAddSelected()">\uff0b Add</button></div>`;
}
function docUpdateCount(){ const r=_docResult||{}, txns=r.transactions||[]; const el=gg('docSelCount'); if(el) el.textContent=txns.filter((_,i)=>_docSel[i]).length+' selected'; }
function docSelectAll(v){ const txns=(_docResult&&_docResult.transactions)||[]; txns.forEach((_,i)=>_docSel[i]=v); docReviewRender(); }
function docAddSelected(){
  const r=_docResult||{}, type=r.docType||'', txns=Array.isArray(r.transactions)?r.transactions:[];
  const hasTxns=txns.length>0;
  const inst=((gg('docInst')&&gg('docInst').value)||r.institution||'Statement').trim();
  const nm=((gg('docAcct')&&gg('docAcct').value)||inst||'Statement').trim();
  const impId='up'+Date.now()+Math.floor(Math.random()*999);
  APP.imports=APP.imports||[];
  const finish=(msg)=>{ saveState(); _rebuildTxns(); if(allTxns.length>0) dataLoaded=true; try{ nwHistRecord(); }catch(e){} closeDocModal(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); if(typeof richieSay==='function'&&msg) richieSay(msg); };
  // Credit-score snapshot -> Score monitor (same upsert rule as manual entry: one per date)
  if((type==='credit_score')||(!!r.creditScore&&!hasTxns&&!r.accountValue&&r.amountDue==null&&r.premium==null)){
    if(gg('docLogScore')&&gg('docLogScore').checked){
      const v=Math.round(parseFloat((gg('docScore')&&gg('docScore').value))||(+r.creditScore)||0);
      const d=(((gg('docScoreDate')&&gg('docScoreDate').value)||r.scoreDate||new Date().toISOString().slice(0,10))+'').trim();
      if(v>=300&&v<=850&&/^\d{4}-\d{2}-\d{2}$/.test(d)){
        const list=_ccScores(); const i=list.findIndex(x=>x.d===d);
        if(i>=0) list[i]={d,v}; else list.push({d,v});
        list.sort((a,b)=>a.d<b.d?-1:1);
        APP.imports.push({ id:impId, kind:'score', label:inst||'Credit score', ts:Date.now(), summary:`Credit score · ${v}` });
        return finish(`Logged your credit score — ${v} (${_scoreBand(v).label}). 📊 See the trend in the Debt widget's Score tab.`);
      }
      showToast('Score must be 300–850 with a valid date.','error'); return;
    }
    return finish('');
  }
  // Investment -> Net Worth asset + Portfolio positions
  if((type==='investment')||(!!r.accountValue&&!hasTxns)){
    let msg='', assetId=null, holdingIds=[];
    // Contributions Richie spotted on the statement become the starting "planned contribution"
    // (period total as-is; YTD divided by 12) \u2014 editable later in the Accounts widget.
    const _perC=+r.periodContribution||0, _ytdC=+r.ytdContribution||0;
    const detectedContrib=_perC>0?Math.round(_perC):(_ytdC>0?Math.round(_ytdC/12):0);
    if(gg('docAddAsset')&&gg('docAddAsset').checked){
      const val=parseFloat(gg('docValue').value)||r.accountValue||0;
      if(val>0){ assetId='nw'+Date.now()+Math.floor(Math.random()*999); APP.nwManualAssets=APP.nwManualAssets||[]; APP.nwManualAssets.push({ id:assetId, cat:'Investment', name:nm, value:val, contrib:detectedContrib||0 }); msg=`Added ${nm} (${fmtK(val)}) to your Net Worth. \ud83d\udcc8`; if(detectedContrib) msg+=` I spotted ~${fmtK(detectedContrib)}/mo in contributions \u2014 saved as your planned contribution (edit it anytime in the Accounts widget).`; }
    }
    if(gg('docImportHoldings')&&gg('docImportHoldings').checked && Array.isArray(r.holdings)){
      APP.holdings=APP.holdings||[]; let n=0;
      r.holdings.forEach(h=>{ if(!h||(!h.value&&!h.name))return; const hid='h'+Date.now()+'_'+(n++); holdingIds.push(hid); APP.holdings.push({ id:hid, name:h.name||h.symbol||'Position', symbol:(h.symbol||'').toString().toUpperCase().trim(), shares:(h.shares!=null?h.shares:null), value:+h.value||0, cost:(h.costBasis!=null?+h.costBasis:(h.cost!=null?+h.cost:null)), gain:(h.gain!=null?+h.gain:null), account:nm, addedAt:Date.now() }); });
      if(n) msg=(msg?msg+' ':'')+`Imported ${n} position${n!==1?'s':''} to your Portfolio.`;
    }
    APP.imports.push({ id:impId, kind:'investment', label:nm, ts:Date.now(), assetId, holdingIds, summary:`Investment · ${holdingIds.length} position${holdingIds.length!==1?'s':''}${r.accountValue?' · '+fmtK(r.accountValue):''}` });
    return finish(msg);
  }
  // Promo details (0% intro APR / deferred interest) from the statement stick to the card
  // by name via cardData, so the 0% Promo tracker and payoff math see them even when no
  // bill is added. Values come from the review fields (prefilled by Richie, editable).
  const pe=((gg('docPromoEnd')&&gg('docPromoEnd').value)||'').trim();
  const pa=(gg('docPromoAmt')&&gg('docPromoAmt').value!=='')?(parseFloat(gg('docPromoAmt').value)||0):0;
  if(pe) setCardData(nm, {promoEnd:pe, promoAmt:pa});
  const promoMsg=pe?` I also logged the 0% promo ending ${pe} — the Promo tracker will warn you before the rate jumps.`:'';
  // Any bill (insurance / phone / cable / utility / loan / generic) -> Upcoming Bills
  if(!hasTxns){
    if(gg('docAddBill')&&gg('docAddBill').checked){
      const due=parseFloat(gg('docDue').value)||r.amountDue||r.premium||0;
      const dd=gg('docDueDate').value, dueDay=dd?Math.max(1,Math.min(31,(new Date(dd+'T12:00:00').getDate()||1))):1;
      const catMap={insurance:'Insurance',utility:'Utilities',phone:'Utilities',cable:'Utilities',loan:'Loan Payments',credit_card:'CC'};
      APP.manualBills=APP.manualBills||[];
      if(due>0 && !APP.manualBills.some(b=>(b.name||'').toLowerCase()===nm.toLowerCase())){ APP.manualBills.push({ name:nm, pay:Math.round(due), min:Math.round(due), bal:0, apr:parseFloat((gg('docApr')&&gg('docApr').value))||0, due:dueDay, cat:(catMap[type]||'OTHER'), promoEnd:pe||'', limit:0, promo:pe?'0% APR':'', note:'imported', paid:false }); APP.imports.push({ id:impId, kind:'bill', label:nm, ts:Date.now(), billName:nm, summary:`Bill · ${fmtK(due)}` }); return finish(`Added ${nm} to your Bills \u2014 ${fmtK(due)}.`+promoMsg); }
    }
    return finish(pe?('Saved the promo details from '+nm+'.'+promoMsg):'');
  }
  // Bank / credit-card -> transactions (+ optional bill)
  APP.importedTxns=APP.importedTxns||[]; let added=0;
  const importId=impId, importLabel=inst+' \u00b7 '+new Date().toLocaleDateString();
  txns.forEach((t,i)=>{
    if(!_docSel[i]||!t.date||t.amount==null) return;
    APP.importedTxns.push({ transaction_id:'imp_'+Date.now()+'_'+(added++), account_id:'imported', date:t.date, name:t.description||'Imported', merchant_name:t.description||'', amount:+t.amount, personal_finance_category:{primary:''}, institution:inst, _imported:true, _importId:importId, _importLabel:importLabel });
  });
  let billName=null;
  const addBill=gg('docAddBill')&&gg('docAddBill').checked;
  if(addBill){
    const due=parseFloat(gg('docDue').value)||0;
    APP.manualBills=APP.manualBills||[];
    if(due>0 && !APP.manualBills.some(b=>(b.name||'').toLowerCase()===nm.toLowerCase())){
      const dd=gg('docDueDate').value, dueDay=dd?Math.max(1,Math.min(31,(new Date(dd+'T12:00:00').getDate()||1))):1;
      billName=nm; APP.manualBills.push({ name:nm, pay:Math.round(due), min:Math.round(due), bal:0, apr:parseFloat(gg('docApr').value)||0, due:dueDay, cat:(type==='credit_card'?'CC':'OTHER'), promoEnd:pe||'', limit:parseFloat(gg('docLimit').value)||0, promo:pe?'0% APR':'', note:'imported', paid:false });
    }
  }
  APP.imports.push({ id:impId, kind:'bank', label:importLabel, ts:Date.now(), txnImportId:importId, billName, summary:`${added} transaction${added!==1?'s':''}${billName?' + bill':''}` });
  finish((added?`Added ${added} transaction${added!==1?'s':''}${addBill?' and a bill':''} from your ${((type||'statement').replace('_',' '))}. \ud83d\udcc4`:`Saved the details from your ${((type||'statement').replace('_',' '))}.`)+promoMsg);
}
/* ═══ CSV TRANSACTION IMPORT ═══
   A fully client-side importer (no server/OpenAI): parse a bank/card CSV, map columns,
   dedupe against existing transactions, and push into APP.importedTxns as a removable
   batch — for accounts Plaid can't reach or manual tracking. */
let _csv=null;
function _parseCSV(text){
  const rows=[]; let row=[], field='', inQ=false;
  text=String(text||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  for(let i=0;i<text.length;i++){ const ch=text[i];
    if(inQ){ if(ch==='"'){ if(text[i+1]==='"'){ field+='"'; i++; } else inQ=false; } else field+=ch; }
    else if(ch==='"') inQ=true;
    else if(ch===','){ row.push(field); field=''; }
    else if(ch==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
    else field+=ch;
  }
  if(field!==''||row.length){ row.push(field); rows.push(row); }
  return rows.filter(r=>r.some(c=>String(c).trim()!==''));
}
function _csvMoney(s){ s=String(s==null?'':s).trim(); if(!s) return null; let neg=false;
  if(/^\(.*\)$/.test(s)){ neg=true; s=s.slice(1,-1); }
  s=s.replace(/[$,\s]/g,''); if(s.charAt(0)==='-'){ neg=true; s=s.slice(1); } else if(s.charAt(0)==='+'){ s=s.slice(1); }
  const n=parseFloat(s); if(isNaN(n)) return null; return neg?-n:n;
}
function _csvDate(s){ s=String(s==null?'':s).trim(); if(!s) return null;
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if(m) return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;
  m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); if(m){ let mm=+m[1],dd=+m[2],yy=+m[3]; if(yy<100)yy+=2000; if(mm>12&&dd<=12){ const t=mm; mm=dd; dd=t; } return `${yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`; }
  const d=new Date(s); if(!isNaN(d)) return d.toISOString().slice(0,10); return null;
}
function _guessCol(H, re){ for(let i=0;i<H.length;i++){ if(re.test(H[i]||'')) return i; } return -1; }
function csvFileChosen(inp){
  const f=inp.files&&inp.files[0]; inp.value=''; if(!f) return;
  if(f.size>8*1024*1024){ alert('That CSV is large (max ~8MB). Try splitting it into smaller files.'); return; }
  try{ discoverXp('csv_import',15,'CSV import'); }catch(e){}
  const rd=new FileReader();
  rd.onload=()=>{ try{ _csvInit(String(rd.result||''), f.name||'transactions.csv'); }catch(e){ alert('Could not parse that file — is it a CSV?'); } };
  rd.onerror=()=>alert('Could not read that file.');
  rd.readAsText(f);
}
function _csvInit(text, name){
  const rows=_parseCSV(text);
  if(rows.length<2){ alert('That file has a header but no data rows.'); return; }
  const headers=rows[0].map(h=>String(h||'').trim());
  const H=headers.map(h=>h.toLowerCase());
  const map={ date:_guessCol(H,/date|posted/), amount:_guessCol(H,/amount|amt|value/), desc:_guessCol(H,/desc|payee|memo|merchant|detail|narrat|name/), cat:_guessCol(H,/category|^type$/) };
  if(map.date<0) map.date=0;
  if(map.amount<0) map.amount=Math.min(headers.length-1,1);
  if(map.desc<0) map.desc=Math.min(headers.length-1,2);
  // sign guess: if amounts under this mapping skew negative, negative=out is right (the default)
  _csv={ name, headers, rows, hasHeader:true, map, sign:'negOut' };
  gg('csvModal').style.display='flex';
  csvRenderMap();
}
function csvSetMap(field,val){ if(!_csv) return; _csv.map[field]=parseInt(val,10); csvRenderMap(); }
function csvSetSign(v){ if(!_csv) return; _csv.sign=v; csvRenderMap(); }
function csvSetHeader(on){ if(!_csv) return; _csv.hasHeader=on; csvRenderMap(); }
function _csvBuildTxns(){
  if(!_csv) return [];
  const {rows,map,sign,hasHeader}=_csv;
  const body=rows.slice(hasHeader?1:0);
  const out=[];
  body.forEach(r=>{
    const date=_csvDate(r[map.date]); let amt=_csvMoney(r[map.amount]); if(date==null||amt==null) return;
    if(sign==='negOut') amt=-amt;   // file negative = money out → flip so "out" is positive (Plaid convention)
    const description=(map.desc!=null&&map.desc>=0?String(r[map.desc]||'').trim():'')||'Imported';
    const cat=(map.cat!=null&&map.cat>=0)?String(r[map.cat]||'').trim():'';
    out.push({date, amount:amt, description, cat});
  });
  out.forEach(t=>{ t._dup=_docDupCheck(t); });
  return out;
}
function csvRenderMap(){
  const el=gg('csvBody'); if(!el||!_csv) return;
  const cols=_csv.headers.map((h,i)=>({i, label:_csv.hasHeader?((h||'').trim()||('Column '+(i+1))):('Column '+(i+1))}));
  const sel=(field)=>{ const cur=_csv.map[field]; const none=field==='cat'?`<option value="-1"${cur<0?' selected':''}>— none —</option>`:''; return `<select class="csv-sel" onchange="csvSetMap('${field}',this.value)">${none}${cols.map(c=>`<option value="${c.i}"${c.i===cur?' selected':''}>${esc(c.label)}</option>`).join('')}</select>`; };
  const txns=_csvBuildTxns();
  const toImport=txns.filter(t=>!t._dup);
  const dups=txns.length-toImport.length;
  const preview=txns.slice(0,6).map(t=>{ const pos=t.amount>0; return `<div class="csv-prow${t._dup?' dup':''}"><span class="csv-pdate">${esc(t.date)}</span><span class="csv-pdesc">${esc(t.description)}</span><span class="csv-pamt" style="color:${pos?'var(--red)':'var(--pos)'}">${pos?'-':'+'}${fmtK(t.amount)}</span>${t._dup?'<span class="csv-dupbadge">dup</span>':''}</div>`; }).join('')||'<div class="ws-hint">No valid rows with the current mapping — check the Date and Amount columns.</div>';
  const canImport=toImport.length>0;
  el.innerHTML=`
    <div class="ws-hint" style="margin:0 0 10px">${esc(_csv.name)} · ${_csv.rows.length-(_csv.hasHeader?1:0)} data row${(_csv.rows.length-(_csv.hasHeader?1:0))!==1?'s':''}</div>
    <div class="csv-maps">
      <label class="csv-m"><span>Date *</span>${sel('date')}</label>
      <label class="csv-m"><span>Amount *</span>${sel('amount')}</label>
      <label class="csv-m"><span>Description *</span>${sel('desc')}</label>
      <label class="csv-m"><span>Category</span>${sel('cat')}</label>
    </div>
    <div class="csv-opts">
      <label class="csv-chk"><input type="checkbox" ${_csv.hasHeader?'checked':''} onchange="csvSetHeader(this.checked)"> First row is a header</label>
      <div class="csv-sign"><span>In this file, a</span>
        <label><input type="radio" name="csvsign" ${_csv.sign==='negOut'?'checked':''} onchange="csvSetSign('negOut')"> negative</label>
        <label><input type="radio" name="csvsign" ${_csv.sign==='posOut'?'checked':''} onchange="csvSetSign('posOut')"> positive</label>
        <span>amount = money out</span>
      </div>
    </div>
    <div class="csv-sec">Preview${txns.length>6?` · first 6 of ${txns.length}`:''}</div>
    <div class="csv-preview">${preview}</div>
    <div class="csv-summary"><b>${toImport.length}</b> to import${dups?` · <span style="color:var(--muted)">${dups} duplicate${dups!==1?'s':''} skipped</span>`:''}</div>
    <div class="mf-actions"><button class="btn" onclick="closeCsvModal()">Cancel</button><button class="btn primary" onclick="csvDoImport()"${canImport?'':' disabled'}>Import${toImport.length?' '+toImport.length:''}</button></div>`;
}
function csvDoImport(){
  if(!_csv) return;
  const nm=_csv.name;
  const txns=_csvBuildTxns().filter(t=>!t._dup);
  if(!txns.length) return;
  APP.importedTxns=APP.importedTxns||[]; APP.imports=APP.imports||[];
  const importId='csv'+Date.now()+Math.floor(Math.random()*999);
  const importLabel=String(nm||'CSV import').replace(/\.(csv|txt)$/i,'')+' · '+new Date().toLocaleDateString();
  let added=0;
  txns.forEach(t=>{ APP.importedTxns.push({ transaction_id:'imp_'+Date.now()+'_'+(added++), account_id:'imported', date:t.date, name:t.description||'Imported', merchant_name:t.description||'', amount:+t.amount, personal_finance_category:{primary:t.cat||''}, category:t.cat?[t.cat]:undefined, institution:'CSV import', _imported:true, _importId:importId, _importLabel:importLabel }); });
  APP.imports.push({ id:importId, kind:'bank', label:importLabel, ts:Date.now(), txnImportId:importId, summary:`${added} transaction${added!==1?'s':''} · CSV` });
  saveState(); _rebuildTxns(); if(allTxns.length>0) dataLoaded=true;
  closeCsvModal();
  if(APP._awaitingBuild){ try{ richieBuildApp(); }catch(e){} }   // imported straight from the build gate → build the dashboard
  else { const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
  if(typeof richieSay==='function') richieSay(`📥 Imported ${added} transaction${added!==1?'s':''} from ${nm}. Remove this batch anytime from Settings → connected sources.`);
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(typeof sbRichie!=='undefined'&&sbRichie) sbRichie.do('tada');
  try{ updateReviewBadge(); }catch(e){}
  // Offer to review the imported categories (some auto-guesses may be off); fall back to a plain note.
  const reviewable=(typeof _reviewTxns==='function')?_reviewTxns().length:0;
  if(reviewable && typeof richieShow==='function'){
    setTimeout(()=>{ try{ richieShow(`📥 Imported ${added} transaction${added!==1?'s':''} from ${nm}. A few categories may need a look — want to review them together?`, {emo:'happy', actions:[
      {label:'Review categories', cls:'ra-go', on:openBriefing},
      {label:'Later', on:(typeof richieDismiss==='function'?richieDismiss:function(){})}
    ]}); }catch(e){} }, 700);
  } else if(typeof richieSay==='function') richieSay(`📥 Imported ${added} transaction${added!==1?'s':''} from ${nm}. Remove this batch anytime from Settings → connected sources.`);
}
function closeCsvModal(){ const m=gg('csvModal'); if(m) m.style.display='none'; _csv=null; }

/* ═══ INVESTMENTS / PORTFOLIO (Mogul) — positions from statements + research,
   plus investment accounts & assets linked in from Net Worth ═══ */
function engHoldings(){ return (APP.holdings||[]).slice(); }
function engPortfolioValue(){ return engHoldings().reduce((s,h)=>s+(+h.value||0),0); }
function engInvestAccounts(){ return engAccounts().filter(a=>a.type==='investment' && !a.excluded); }
function engInvestNWAssets(){ return (APP.nwManualAssets||[]).filter(x=>x.cat==='Investment'); }
/* Investment accounts represented ONLY by portfolio positions — no bank link and no
   net-worth asset with the same name. Grouped by the position's account name. These are
   the single source for "position-only" accounts everywhere (All Accounts, net worth,
   invest totals) so the same money is never counted twice or dropped. */
function engPosOnlyAccounts(){
  const counted=new Set();
  engAccounts().forEach(a=>counted.add((a.name||'').toLowerCase().trim()));
  (APP.nwManualAssets||[]).forEach(x=>counted.add((x.name||'').toLowerCase().trim()));
  const groups={};
  engHoldings().forEach(h=>{ const k=(h.account||'').trim(); if(!k||counted.has(k.toLowerCase())) return; groups[k]=(groups[k]||0)+(+h.value||0); });
  return Object.entries(groups).map(([name,value])=>({name, value, contrib:+(((APP.cardData||{})['pos:'+name.toLowerCase()]||{}).contrib)||0}));
}
/* Total of ALL investments: linked/manual investment accounts + statement-imported net-worth
   assets + position-only accounts (deduped by name via engPosOnlyAccounts). */
function engInvestTotal(){
  return engInvestAccounts().reduce((s,a)=>s+(+a.bal||0),0)
    + engInvestNWAssets().reduce((s,x)=>s+(+x.value||0),0)
    + engPosOnlyAccounts().reduce((s,p)=>s+p.value,0);
}
/* Sum of planned monthly contributions across investment accounts (cardData for bank accounts,
   the item itself for manual accounts and statement-imported net-worth assets). */
function engPlannedContrib(){
  let s=0;
  engInvestAccounts().forEach(a=>{ s+=(+a.contrib||0); });   // engAccounts resolves per-account cardData
  engInvestNWAssets().forEach(x=>{ s+=(+x.contrib||0); });
  engPosOnlyAccounts().forEach(p=>{ s+=(+p.contrib||0); });
  return s;
}
/* ═══ EXTRA-FUNDS TRIAGE ═══
   Zero-budget-style waterfall for the monthly surplus, in priority order:
   1) high-interest debt (credit cards + any loan at/above the APR threshold),
   2) savings buckets (this month's funding need), 3) investing (the rest — folds in the
   planned contributions you're already making). Allocations are overridable per row. */
function engHighInterestDebt(threshold){
  threshold=(threshold==null)?8:threshold;
  const g=(typeof engDebtGroups==='function')?engDebtGroups():{revolving:[],installment:[]};
  return [...g.revolving, ...g.installment].filter(b=> b.cat==='CC' || (b.apr||0)>=threshold)
    .reduce((s,b)=>s+Math.abs(b.bal||0),0);
}

/* ═══ FINANCIAL HEALTH SCORE ═══
   A composite 0–100 score from five weighted pillars: savings rate, emergency-fund
   months, debt-to-income, credit utilization, and high-interest debt. Pillars that
   don't apply (no income, no credit lines) drop out and their weight is redistributed. */
function _hsGrade(s){ if(s>=93)return'A'; if(s>=90)return'A−'; if(s>=87)return'B+'; if(s>=83)return'B'; if(s>=80)return'B−'; if(s>=77)return'C+'; if(s>=73)return'C'; if(s>=70)return'C−'; if(s>=67)return'D+'; if(s>=60)return'D'; return'F'; }
function engHealthScore(){
  const clamp=v=>Math.max(0,Math.min(100,Math.round(v)));
  const income=engMonthlyIncome();
  const spend=dataLoaded?engSpend30():engMonthlyBills();
  const monthlyExpenses=Math.max(engMonthlyBills(), dataLoaded?engSpend30():0, 1);
  const comps=[];
  // 1) Savings rate — 20%+ is full marks
  if(income>0){ const rate=(income-spend)/income*100; comps.push({key:'savings_rate',label:'Savings rate',icon:'📊',weight:25,score:clamp(rate/20*100),value:Math.round(rate)+'%',
    tip: rate>=20?'Great rate — keep it steady.':`You're saving ${Math.round(rate)}% — trim one top category to reach 20%.`}); }
  // 2) Emergency fund — 6 months of expenses is full marks
  { const ef=engEmergencyFund(); const months=monthlyExpenses>0?ef/monthlyExpenses:0; comps.push({key:'emergency',label:'Emergency fund',icon:'🛟',weight:25,score:clamp(months/6*100),value:months.toFixed(1)+' mo',
    tip: months>=3?(months>=6?'Fully funded — nicely done.':`${months.toFixed(1)} months saved — aim for 6 for full cover.`):`Only ${months.toFixed(1)} months of expenses saved — build toward 3+.`}); }
  // 3) Debt-to-income — 0% is full marks, 43%+ is zero
  if(income>0){ const dti=engDTI().ratio*100; comps.push({key:'dti',label:'Debt-to-income',icon:'⚖️',weight:20,score:clamp((1-dti/43)*100),value:Math.round(dti)+'%',
    tip: dti<=36?'Healthy debt load.':`${Math.round(dti)}% of income goes to debt payments — under 36% is the goal.`}); }
  // 4) Credit utilization — only if there are credit lines; under 10% is full marks
  { const cu=engCreditUtil(); if(cu.limit>0){ comps.push({key:'util',label:'Credit utilization',icon:'💳',weight:15,score:clamp((1-(cu.pct-10)/40)*100),value:Math.round(cu.pct)+'%',
    tip: cu.pct<=30?(cu.pct<=10?'Excellent utilization.':'Good — keep it under 30%.'):`Using ${Math.round(cu.pct)}% of your limit — paying under 30% helps your score.`}); } }
  // 5) High-interest debt — none is full marks; scaled against annual income
  { const hid=engHighInterestDebt(8); let score, value=hid>0?fmtK(hid):'$0';
    if(hid<=0) score=100; else if(income>0){ score=clamp((1-(hid/(income*12))/0.5)*100); } else score=40;
    comps.push({key:'hi_debt',label:'High-interest debt',icon:'🔥',weight:15,score,value,
      tip: hid<=0?'No high-interest debt — that\'s the sweet spot.':`${fmtK(hid)} in high-interest debt — knocking this down lifts your score fastest.`}); }
  // weighted average over applicable pillars
  const totW=comps.reduce((s,c)=>s+c.weight,0)||1;
  const overall=Math.round(comps.reduce((s,c)=>s+c.score*c.weight,0)/totW);
  comps.forEach(c=>{ c.status=c.score>=75?'good':c.score>=50?'ok':'poor'; });
  const weakest=comps.filter(c=>c.score<75).sort((a,b)=>a.score-b.score)[0]||null;
  return {overall, grade:_hsGrade(overall), comps, weakest, hasData:comps.length>0};
}
function _hsColor(s){ return s>=80?'var(--pos)':s>=60?'var(--amber)':'var(--red)'; }
function _hsRing(score,color,grade){
  const r=42, c=2*Math.PI*r, off=c*(1-score/100);
  return `<svg viewBox="0 0 100 100" width="100" height="100" style="flex:0 0 auto"><circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--surface3)" stroke-width="9"/><circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 50 50)"/><text x="50" y="48" text-anchor="middle" font-size="27" font-weight="800" fill="var(--text)">${score}</text><text x="50" y="65" text-anchor="middle" font-size="12" font-weight="700" fill="${color}">${grade}</text></svg>`;
}
// Each health pillar links to the widget that fixes it — one tap sends Richie there.
const HS_FIX={ savings_rate:'spending_trends', emergency:'savings_buckets', dti:'debt_hub', util:'debt_hub', hi_debt:'debt_hub' };
function healthGoto(type){ if(!type) return; try{ _ensureWidgetOnPage(type); }catch(e){} try{ richieSpotlightAt(Object.assign({widgetType:type}, RICHIE_SPOTS[type]||{})); }catch(e){} }
function healthScoreBody(w){
  const h=engHealthScore();
  if(!h.hasData) return `<div class="wph"><div class="ws-hint">Add your income, bills, and accounts and Richie will score your financial health across five pillars.</div></div>`;
  const col=_hsColor(h.overall);
  const rows=h.comps.map(c=>{ const sc=_hsColor(c.score); const fix=HS_FIX[c.key]; const go=fix?` hs-row-go" onclick="event.stopPropagation();healthGoto('${fix}')" title="Fix this — take me there` : '"'; return `<div class="hs-row${go}"><span class="hs-ico">${c.icon}</span><div class="hs-main"><div class="hs-toprow"><span class="hs-lbl">${esc(c.label)}${fix?' <span class="hs-chev">›</span>':''}</span><span class="hs-val" style="color:${sc}">${esc(c.value)}</span></div><div class="hs-barwrap"><div class="hs-bar" style="width:${c.score}%;background:${sc}"></div></div></div></div>`; }).join('');
  const tip=h.weakest?`<div class="hs-tip"><span>💡</span><span>${esc(h.weakest.tip)}</span></div>`:`<div class="hs-tip"><span>🎉</span><span>Every pillar is in good shape — keep it up!</span></div>`;
  return `<div class="hs-wrap">
    <div class="hs-head">${_hsRing(h.overall,col,h.grade)}<div class="hs-headtxt"><div class="hs-headlbl">Financial health${dataLoaded?'':' · sample'}</div>${(function(){
      const chg=(typeof hsChangeSince==='function')?hsChangeSince(7):null;
      const nx=(typeof _hsToNext==='function')?_hsToNext(h.overall):null;
      const parts=[];
      if(chg && chg.abs!==0){ const up=chg.abs>0; parts.push(`<span style="color:${up?'var(--pos)':'var(--red)'};font-weight:700">${up?'▲':'▼'} ${Math.abs(chg.abs)} pt${Math.abs(chg.abs)!==1?'s':''} this week</span>`); }
      if(nx){ parts.push(`<span style="color:var(--muted)">${nx.pts} to a ${esc(nx.grade)}</span>`); }
      const line=parts.length?parts.join(' · '):`Across ${h.comps.length} pillar${h.comps.length!==1?'s':''} — savings, safety, and debt.`;
      return `<div class="hs-headsub">${line}</div>`;
    })()}</div></div>
    <div class="hs-rows">${rows}</div>
    ${tip}
  </div>`;
}
function _ft(){ APP.fundTriage=APP.fundTriage||{extra:null, alloc:{}}; if(!APP.fundTriage.alloc) APP.fundTriage.alloc={}; return APP.fundTriage; }
function engFundTriage(){
  const income=Math.round(engMonthlyIncome());
  const sc=(typeof engSpendingCards==='function')?engSpendingCards():{coveredPay:0};
  const bills=Math.max(0, Math.round(engMonthlyBills()-(sc.coveredPay||0)));
  const everyday=Math.round(engDiscretionaryBudget());
  const poolAuto=Math.max(0, income-bills-everyday);
  const ft=_ft();
  const pool=(ft.extra!=null && isFinite(ft.extra))?Math.max(0,Math.round(ft.extra)):poolAuto;
  const highIntDebt=Math.round(engHighInterestDebt());
  const savingsNeed=Math.round(engSavingsBuckets().filter(b=>!b.done).reduce((s,b)=>s+(+b.monthly||0),0));
  const plannedInvest=Math.round(engPlannedContrib());
  // priority waterfall (defaults) — debt, then savings, then whatever's left to investing
  const dDef=Math.min(pool, highIntDebt);
  const sDef=Math.min(Math.max(0,pool-dDef), savingsNeed);
  const iDef=Math.max(0, pool-dDef-sDef);
  const a=ft.alloc||{};
  const pick=(v,def)=>(v!=null && isFinite(v))?Math.max(0,Math.round(v)):Math.round(def);
  const debt=pick(a.debt,dDef), savings=pick(a.savings,sDef), invest=pick(a.invest,iDef);
  return {income,bills,everyday,poolAuto,pool,highIntDebt,savingsNeed,plannedInvest,debt,savings,invest,left:Math.round(pool-debt-savings-invest)};
}
function portfolioBody(w){
  const H=engHoldings();
  const IA=engInvestAccounts();
  const NA=engInvestNWAssets();
  if(!H.length && !IA.length && !NA.length) return `<div class="wph"><div class="wph-sub">No positions yet.</div><div class="ws-hint" style="margin-top:6px">Upload a brokerage / IRA / 401k statement and Richie pulls your positions in automatically — or add one by hand. Investment accounts and assets from Net Worth show up here too.</div><button class="nw-add" style="margin-top:11px" onclick="event.stopPropagation();openHoldingEditor()">＋ Add a position</button></div>`;
  const tot=engPortfolioValue();
  const iaTot=IA.reduce((s,a)=>s+(+a.bal||0),0);
  const naTot=NA.reduce((s,x)=>s+(+x.value||0),0);
  const grand=tot+iaTot+naTot;   // "% of total investments" baseline across all three sections
  const totGain=engHoldings().reduce((s,h)=>s+(+h.gain||0),0);
  const hasGain=engHoldings().some(h=>h.gain!=null);
  const byAcct={}; H.forEach(h=>{ const a=h.account||'—'; byAcct[a]=(byAcct[a]||0)+(+h.value||0); });
  const acctChips=Object.keys(byAcct).length>1?`<div class="pf-accts">${Object.entries(byAcct).map(([a,v])=>`<span class="pf-acct">${esc(a)} · ${fmtK(v)}</span>`).join('')}</div>`:'';
  const pctOf=v=>grand>0?Math.round((+v||0)/grand*100):0;
  const rows=H.slice().sort((a,b)=>(+b.value||0)-(+a.value||0)).map(h=>{
    const pct=pctOf(h.value);
    const g=(h.gain!=null)?`<div class="pf-gain" style="color:${moneyCol(h.gain)}">${(+h.gain>=0?'+':'−')}${fmtK(Math.abs(h.gain))}</div>`:`<div class="pf-pct">${pct}%</div>`;
    return `<div class="pf-row" onclick="openResearch('${h.id}')">
      <div class="pf-main"><div class="pf-nm">${esc(h.name||h.symbol||'Position')}${h.symbol?` <span class="pf-sym">${esc(h.symbol)}</span>`:''}</div><div class="pf-sub">${h.shares!=null?esc(String(h.shares))+' sh · ':''}${esc(h.account||'')}</div><div class="pf-bar"><i style="width:${Math.max(2,pct)}%"></i></div></div>
      <div class="pf-side"><div class="pf-val">${fmtK(h.value)}</div>${g}<div class="pf-research">research ›</div></div>
    </div>`;
  }).join('');
  const gainLine=hasGain?` · <span style="color:${moneyCol(totGain)}">${totGain>=0?'+':'−'}${fmtK(Math.abs(totGain))} total ${totGain>=0?'gain':'loss'}</span>`:'';
  const posHeader=`<div class="pf-total"><div class="wph-stat" style="color:${moneyCol(grand)}">${fmtK(grand)}</div><div class="wph-sub">total investments${H.length?` · ${H.length} position${H.length!==1?'s':''}`:''}${gainLine}</div>${acctChips}</div>`;
  const posSection=H.length?`<div class="pf-list">${rows}</div>`:'';

  // Investment-type accounts (Plaid-linked or manually added) — same row format as positions.
  const acctRows=IA.slice().sort((a,b)=>(+b.bal||0)-(+a.bal||0)).map(a=>{
    const kEsc=esc(_acctIdKey(a)).replace(/'/g,"\\'");
    const idx=(APP.manualAccounts||[]).findIndex(x=>x.id===a.id);
    const open=a.manual?`openManualAccount(${idx})`:`openAccountEditor('${kEsc}')`;
    const pct=pctOf(a.bal);
    return `<div class="pf-row" onclick="${open}">
      <div class="pf-main"><div class="pf-nm">${esc(a.name)}</div><div class="pf-sub">${esc(a.institution||(a.manual?'manual':'linked'))}</div><div class="pf-bar"><i style="width:${Math.max(2,pct)}%"></i></div></div>
      <div class="pf-side"><div class="pf-val">${fmtK(a.bal)}</div><div class="pf-pct">${pct}%</div><div class="pf-research">edit ›</div></div>
    </div>`;
  }).join('');
  const acctSection=IA.length?`<div class="doc-section-h">Linked from Net Worth</div><div class="pf-list">${acctRows}</div>`:'';

  // Manually-entered Net Worth assets categorized as Investment — same row format as positions.
  const naRows=NA.slice().sort((a,b)=>(+b.value||0)-(+a.value||0)).map(x=>{
    const pct=pctOf(x.value);
    return `<div class="pf-row" onclick="portfolioEditNWAsset('${x.id}')">
      <div class="pf-main"><div class="pf-nm">${esc(x.name||x.cat)}</div><div class="pf-sub">Net worth asset</div><div class="pf-bar"><i style="width:${Math.max(2,pct)}%"></i></div></div>
      <div class="pf-side"><div class="pf-val">${fmtK(+x.value||0)}</div><div class="pf-pct">${pct}%</div><div class="pf-research">edit ›</div></div>
    </div>`;
  }).join('');
  const naSection=NA.length?`<div class="doc-section-h">Net worth investment assets</div><div class="pf-list">${naRows}</div>`:'';

  return `<div class="pf-wrap">${posHeader}${posSection}${acctSection}${naSection}<button class="nw-add" onclick="event.stopPropagation();openHoldingEditor()">＋ Add a position</button></div>`;
}
function portfolioEditNWAsset(id){
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Home, car & assets';
  gg('manualSub').textContent="Add what a bank can't see — property, vehicles, valuables — plus debts not linked to a bank.";
  nwOpenForm('asset', id);
}
function openResearch(id){
  const h=(APP.holdings||[]).find(x=>x.id===id); if(!h) return;
  const tot=engPortfolioValue(), pct=tot>0?Math.round((+h.value||0)/tot*100):0;
  const sym=(h.symbol||'').trim(), q=encodeURIComponent(sym||h.name||'');
  const yahoo=sym?`https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`:`https://finance.yahoo.com/lookup?s=${q}`;
  const google=`https://www.google.com/search?q=${q}%20stock`;
  const mw=sym?`https://www.marketwatch.com/investing/stock/${encodeURIComponent(sym.toLowerCase())}`:`https://www.marketwatch.com/tools/quotes/lookup.asp?lookup=${q}`;
  gg('rsTitle').textContent=h.name||h.symbol||'Research';
  gg('rsBody').innerHTML=`
    <div class="rs-hero"><div class="rs-sym">${esc(sym||'—')}</div><div class="rs-val">${fmtK(h.value)} · ${pct}% of portfolio${h.shares!=null?' · '+esc(String(h.shares))+' sh':''}</div>${(h.gain!=null||h.cost!=null)?`<div class="rs-gain" style="color:${moneyCol(h.gain||0)}">${h.gain!=null?((+h.gain>=0?'▲ +':'▼ −')+fmtK(Math.abs(h.gain))+' '+(+h.gain>=0?'gain':'loss')):''}${h.cost!=null?` · ${fmtK(h.cost)} cost basis`:''}</div>`:''}</div>
    <div class="doc-section-h">Research links</div>
    <a class="rs-link" href="${yahoo}" target="_blank" rel="noopener">📊 Yahoo Finance ›</a>
    <a class="rs-link" href="${google}" target="_blank" rel="noopener">🔎 Google ›</a>
    <a class="rs-link" href="${mw}" target="_blank" rel="noopener">📰 MarketWatch ›</a>
    <div class="doc-section-h">Ask Richie</div>
    <button class="btn primary" id="rsAskBtn" onclick="researchAsk('${h.id}')">💬 Explain this holding</button>
    <div id="rsAnswer" class="rs-answer"></div>
    <div class="ws-hint" style="margin-top:12px">Educational only — not investment advice. Always do your own research.</div>
    <div class="mf-actions"><button class="btn" onclick="openHoldingEditor('${h.id}')">Edit</button><button class="btn" onclick="closeResearch()">Close</button></div>`;
  gg('researchModal').style.display='flex';
}
function closeResearch(){ gg('researchModal').style.display='none'; }
async function researchAsk(id){
  const h=(APP.holdings||[]).find(x=>x.id===id); if(!h) return;
  const ans=gg('rsAnswer'), btn=gg('rsAskBtn'); if(!ans) return;
  if(btn) btn.disabled=true; ans.innerHTML='<div class="ws-hint">Richie is looking into it…</div>';
  try{
    const r=await fetch('/api/advisor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ messages:[{role:'user', content:`In 3-4 plain sentences, explain what ${h.name}${h.symbol?' ('+h.symbol+')':''} is as an investment: what kind of asset it is, its sector or category, and its general risk profile. Educational only — do NOT give buy/sell/hold advice.`}], mode:'general', persona:APP.persona||'coach', level:APP.level||5 })});
    const d=await r.json().catch(()=>({}));
    if(btn) btn.disabled=false;
    const txt=(d&&(d.reply||d.tip||d.message))||'';
    ans.innerHTML= txt ? `<div class="rs-ans-txt">${esc(txt)}</div>` : '<div class="ws-hint">Couldn’t get a summary right now — try the research links above.</div>';
  }catch(e){ if(btn) btn.disabled=false; ans.innerHTML='<div class="ws-hint">Couldn’t reach Richie — try the research links above.</div>'; }
}
let _holdEdit=null;
function openHoldingEditor(id){
  closeResearch();
  const h=id?(APP.holdings||[]).find(x=>x.id===id):null; _holdEdit=id||null;
  gg('holdTitle').textContent=h?'Edit position':'Add position';
  gg('holdBody').innerHTML=`
    <label class="mf-label">Name</label><input class="mf-in" id="hldName" placeholder="e.g. Apple Inc / S&P 500 Index" value="${h?esc(h.name||''):''}">
    <div class="doc-hgrid" style="margin-top:10px">
      <div class="doc-f"><label>Ticker (optional)</label><input id="hldSym" value="${h?esc(h.symbol||''):''}" placeholder="AAPL"></div>
      <div class="doc-f"><label>Shares (optional)</label><input id="hldShares" type="number" step="any" value="${h&&h.shares!=null?esc(String(h.shares)):''}" placeholder="0"></div>
      <div class="doc-f"><label>Value ($)</label><input id="hldValue" type="number" step="0.01" value="${h?esc(String(h.value!=null?h.value:'')):''}" placeholder="0"></div>
      <div class="doc-f"><label>Cost basis ($)</label><input id="hldCost" type="number" step="0.01" value="${h&&h.cost!=null?esc(String(h.cost)):''}" placeholder="optional"></div>
      <div class="doc-f"><label>Account</label><input id="hldAcct" value="${h?esc(h.account||''):''}" placeholder="Brokerage / IRA"></div>
    </div>
    <div class="mf-actions">${h?`<button class="btn" style="color:var(--red)" onclick="holdingDelete('${h.id}')">Delete</button>`:'<span></span>'}<button class="btn primary" onclick="holdingSave()">Save</button></div>`;
  gg('holdModal').style.display='flex';
}
function closeHold(){ gg('holdModal').style.display='none'; _holdEdit=null; }
function holdingSave(){
  const name=(gg('hldName').value||'').trim(); const value=parseFloat(gg('hldValue').value)||0;
  if(!name && !value){ closeHold(); return; }
  const cost=(gg('hldCost')&&gg('hldCost').value!=='')?parseFloat(gg('hldCost').value):null;
  const rec={ id:_holdEdit||('h'+Date.now()+Math.floor(Math.random()*999)), name:name||'Position', symbol:(gg('hldSym').value||'').toUpperCase().trim(), shares:(gg('hldShares').value!==''?parseFloat(gg('hldShares').value):null), value, cost:(cost!=null&&!isNaN(cost))?cost:null, gain:(cost!=null&&!isNaN(cost))?(value-cost):null, account:(gg('hldAcct').value||'').trim(), addedAt:Date.now() };
  APP.holdings=APP.holdings||[];
  const i=_holdEdit?APP.holdings.findIndex(x=>x.id===_holdEdit):-1;
  if(i>=0) APP.holdings[i]=rec; else APP.holdings.push(rec);
  saveState(); closeHold();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}
function holdingDelete(id){
  APP.holdings=(APP.holdings||[]).filter(x=>x.id!==id);
  saveState(); closeHold();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}

async function openLinkHandler(relinkItemId){
  if(typeof Plaid==='undefined'){ try{ await _loadScript(PLAID_LINK_CDN_SRC); }catch(e){} }
  if(typeof Plaid==='undefined'){ showToast('Plaid not loaded — check your connection.','error'); return; }
  try{
    const linkRes=await fetch('/api/create_link_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(relinkItemId?{item_id:relinkItemId}:{})});
    if(!linkRes.ok){ const err=await linkRes.json().catch(()=>({})); showToast('Link token failed ('+linkRes.status+'): '+(err.error||'unknown'),'error'); return; }
    const linkData=await linkRes.json();
    const link_token=linkData.link_token;
    if(!link_token){ showToast('No link token returned','error'); return; }
    if(relinkItemId){
      // Update mode: same bank item, fresh credentials — no token exchange needed after.
      const handler=Plaid.create({ token:link_token, onSuccess:async()=>{
        showToast('Bank reconnected! Refreshing data…','success');
        await loadEngineData();
        const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
        if(sbRichie)sbRichie.do('tada');
      }});
      handler.open();
      return;
    }
    const handler=Plaid.create({ token:link_token,
      onSuccess:async(pub,meta)=>{
        const inst=(meta&&meta.institution&&meta.institution.name)||'Bank';
        try{
          const tok=authToken();
          const xRes=await fetch('/api/exchange_token',{ method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok}, body:JSON.stringify({public_token:pub,institution_name:inst}) });
          const res=await xRes.json();
          if(res.error){ showToast('Exchange failed: '+res.error,'error'); return; }
          showToast(inst+' connected! Loading data...','success');
          await loadEngineData();
          APP.plaidConnected=true; saveState();
          updateConnectBtn();
          if(sbRichie)sbRichie.do('tada');
          if(APP._awaitingBuild){ awardXp(15); richieBuildApp(); }   // FIRST WIN → Richie builds the dashboard
          else { awardXp(15,'Bank connected!'); if(APP.activePage&&APP.activePage!=='__settings__'){ const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg) renderCanvas(pg); } }
        }catch(ex){ showToast('Exchange error: '+ex.message,'error'); }
      },
      onExit:(err)=>{ if(err) showToast('Plaid Link: '+(err.error_message||'closed'),'error'); }
    });
    handler.open();
  }catch(e){ showToast('Failed to open Plaid Link: '+e.message,'error'); }
}
function updateConnectBtn(){
  const b=gg('sbConnectBtn'); if(!b) return;
  // Count distinct connected institutions from loaded accounts
  let n=0;
  try{ if(dataLoaded && allAccts && allAccts.length){ n=new Set(allAccts.map(a=>a.institution||a.item_id||a.name)).size; } }catch(e){}
  if(n>0){
    b.innerHTML='\u2795 Connect another'+`<span class="sb-connect-count">${n} linked</span>`;
    b.style.opacity='1';
  } else {
    b.innerHTML='\u2795 Connect a bank';
    b.style.opacity='1';
  }
}



/* ═══════════════ RICHIE EMOJI CONTROLLER ═══════════════ */
const ONESHOTS=['bounce','flip','spin','turn','wiggle','tada','pulse','pop','nod','heart','shake','sad'];
const EMOTION_MAP={happy:'bounce',excited:'tada',celebrate:'flip',proud:'pulse',curious:'wiggle',surprised:'pop',love:'heart',sad:'sad',no:'shake',idle:null};
class RichieEmoji{
  constructor(el,zzzEl){ this.el=el; this.zzz=zzzEl||null; this.talking=false; this.sleeping=false; this._t=null; if(el) this.idleMode(); }
  _clear(){ if(!this.el)return; ONESHOTS.forEach(a=>this.el.classList.remove('e-'+a)); this.el.classList.remove('e-idle','e-talking','e-sleeping'); }
  idleMode(){ if(!this.el)return; this._clear(); this.sleeping=false; this.talking=false; this._setZzz(false); this.el.classList.add('e-idle'); }
  do(anim){ if(!this.el||this.sleeping||!anim)return; this._clear(); void this.el.offsetWidth; this.el.classList.add('e-'+anim);
    clearTimeout(this._t); this._t=setTimeout(()=>{ if(this.sleeping||!this.el)return; this._clear(); this.el.classList.add(this.talking?'e-talking':'e-idle'); }, anim==='turn'?1600:1000); }
  emotion(name){ if(EMOTION_MAP[name]!==undefined){ this.do(EMOTION_MAP[name]); } else if(ONESHOTS.includes(name)){ this.do(name); } else { this.do('bounce'); } }
  express(name){ this.emotion(name); }
  turnAround(){ this.do('turn'); }
  wave(){ this.do('wiggle'); }
  talk(on){ this.talking=on; if(this.sleeping||!this.el)return; this._clear(); this.el.classList.add(on?'e-talking':'e-idle'); }
  sleep(on){ this.sleeping=on; this.talking=false; if(!this.el)return; this._clear(); this.el.classList.add(on?'e-sleeping':'e-idle'); this._setZzz(on); }
  setWalking(on){ if(!this.el)return; this.el.classList.toggle('e-hopping',on); if(!on&&!this.sleeping) this.idleMode(); }
  face(){} look(){}
  _setZzz(on){ if(!this.zzz)return; this.zzz.innerHTML=on?'<span class="r-zzz" style="animation:zzz 2.4s ease-out infinite">z</span><span class="r-zzz" style="font-size:15px;animation:zzz 2.4s ease-out .8s infinite">z</span><span class="r-zzz" style="font-size:11px;animation:zzz 2.4s ease-out 1.6s infinite">z</span>':''; }
}

/* ═══════════════ RIVE-POWERED RICHIE (optional, drop-in for RichieEmoji) ═══════════════
   HOW TO TURN ON:
   1. In Rive (rive.app), build/obtain a Richie artboard with a State Machine, then export a
      .riv and drop it in /public as  richie.riv .
   2. Give the State Machine these INPUTS (exact names — case-sensitive):
        talking   (boolean)  — mouth/idle-talk loop while Richie speaks
        sleeping  (boolean)  — sleepy idle (the onboarding "zzz" state)
        walking   (boolean)  — optional hop/walk loop
        mood      (number)   — 0 idle · 1 happy/positive · 2 sad/negative
        celebrate (trigger)  — big one-shot (tada/flip/spin/pulse/heart/pop, "excited")
        nod       (trigger)  — small acknowledgement (nod/bounce)
        wave      (trigger)  — wave/turn/wiggle
        no        (trigger)  — shake / disappointed
      (Missing inputs are ignored safely — start with talking + mood + nod and add the rest later.)
   3. Set RIVE_RICHIE.enabled = true (and `machine` to your State Machine's exact name).
   If the runtime or file fails to load, every Richie silently falls back to the emoji version,
   so nothing breaks. Runtime + wasm load from jsdelivr (already allowed by the app's CSP). */
const RIVE_RICHIE = {
  enabled: false,                         // ← flip to true once richie.riv is in /public
  src: 'richie.riv',                      // same-origin file in /public
  artboard: undefined,                    // optional — omit to use the .riv's default artboard
  machine: 'State Machine 1',             // ← must match the State Machine name in your .riv
  script: 'https://cdn.jsdelivr.net/npm/@rive-app/[email protected]',
  wasm:   'https://cdn.jsdelivr.net/npm/@rive-app/[email protected]/rive.wasm',   // keep this version == script's
};
let _rivePromise = null;
function ensureRive(){
  if(typeof window!=='undefined' && window.rive) return Promise.resolve(window.rive);
  if(_rivePromise) return _rivePromise;
  _rivePromise = new Promise((resolve, reject)=>{
    const s=document.createElement('script'); s.src=RIVE_RICHIE.script; s.async=true;
    s.onload=()=>{ try{ if(RIVE_RICHIE.wasm && window.rive && window.rive.RuntimeLoader) window.rive.RuntimeLoader.setWasmUrl(RIVE_RICHIE.wasm); }catch(e){} window.rive?resolve(window.rive):reject(new Error('rive missing')); };
    s.onerror=()=>reject(new Error('rive runtime failed to load'));
    document.head.appendChild(s);
  });
  return _rivePromise;
}
/* Mirrors the RichieEmoji API 1:1 so every existing richie.do()/emotion()/talk() call just works. */
class RichieRive{
  constructor(el, zzzEl){
    this.el=el; this.zzz=zzzEl||null; this.talking=false; this.sleeping=false; this._inputs={}; this._fallback=null;
    if(!el) return;
    const cv=document.createElement('canvas'); cv.style.width='100%'; cv.style.height='100%'; cv.style.display='block';
    el.innerHTML=''; el.appendChild(cv); this.canvas=cv;
    ensureRive().then(rive=>{
      this.r=new rive.Rive({ src:RIVE_RICHIE.src, canvas:cv, autoplay:true,
        artboard:RIVE_RICHIE.artboard, stateMachines:RIVE_RICHIE.machine,
        onLoad:()=>{ try{ this.r.resizeDrawingSurfaceToCanvas(); }catch(e){}
          (this.r.stateMachineInputs(RIVE_RICHIE.machine)||[]).forEach(i=>{ this._inputs[i.name]=i; });
          // re-apply any state set before load finished
          this._bool('talking',this.talking); this._bool('sleeping',this.sleeping); } });
      if(window.ResizeObserver){ this._ro=new ResizeObserver(()=>{ try{ this.r&&this.r.resizeDrawingSurfaceToCanvas(); }catch(e){} }); this._ro.observe(el); }
    }).catch(()=>{ try{ el.innerHTML=''; this._fallback=new RichieEmoji(el, zzzEl); }catch(e){} });
  }
  _bool(n,v){ const i=this._inputs[n]; if(i) i.value=!!v; }
  _num(n,v){ const i=this._inputs[n]; if(i) i.value=+v; }
  _fire(n){ const i=this._inputs[n]; if(i&&i.fire) i.fire(); }
  do(anim){ if(this._fallback) return this._fallback.do(anim); if(!anim) return;
    if(['tada','flip','spin','pulse','heart','pop'].includes(anim)) this._fire('celebrate');
    else if(['shake','sad'].includes(anim)) this._fire('no');
    else if(anim==='turn'||anim==='wiggle') this._fire('wave');
    else this._fire('nod'); }
  emotion(name){ if(this._fallback) return this._fallback.emotion(name);
    const mood={idle:0,happy:1,excited:1,proud:1,celebrate:1,curious:1,love:1,surprised:1,sad:2,no:2}[name];
    if(mood!==undefined) this._num('mood', mood);
    if(['celebrate','excited','proud','love','surprised'].includes(name)) this._fire('celebrate');
    else if(name==='sad'||name==='no') this._fire('no'); }
  express(name){ this.emotion(name); }
  talk(on){ this.talking=on; if(this._fallback) return this._fallback.talk(on); this._bool('talking', on); }
  sleep(on){ this.sleeping=on; this.talking=false; if(this._fallback) return this._fallback.sleep(on); this._bool('sleeping', on); }
  setWalking(on){ if(this._fallback) return this._fallback.setWalking(on); this._bool('walking', on); }
  turnAround(){ this.do('turn'); }
  wave(){ if(this._fallback) return this._fallback.wave(); this._fire('wave'); }
  idleMode(){ if(this._fallback) return this._fallback.idleMode(); this._num('mood',0); this._bool('talking',false); this._bool('sleeping',false); }
  face(){} look(){}
}
/* Every Richie mount goes through here: Rive when enabled + working, else the emoji Richie. */
function spawnRichie(el, zzz){
  if(RIVE_RICHIE.enabled){ try{ return new RichieRive(el, zzz); }catch(e){} }
  return new RichieEmoji(el, zzz);
}

/* ═══════════════ PERSONAS & LEVELS ═══════════════ */
const RICHIE_PERSONAS={
  coach:{name:"Friendly Coach",icon:"🤝",accent:"#2ecc8a",blurb:"Warm & encouraging. Celebrates every win.",introLine:"A coach! Love it. We're a team now — I'll cheer you on every step. No shame, just progress. Let's GO!",quips:["Hey, you showed up today — that's the habit working. Proud of you!","Small wins count. Paid one bill early? Victory lap.","Your savings rate is climbing. Keep stacking those choices!","Progress over perfection, always.","Let's set one tiny money goal this week. I believe in you."]},
  crusher:{name:"Debt Crusher",icon:"🔥",accent:"#f05c5c",blurb:"Tough-love. Debt is the enemy. No excuses.",introLine:"DEBT CRUSHER MODE. Good. Debt is stealing your future — we attack it with everything we've got. No excuses.",quips:["That debt isn't your friend. It's a thief. Let's evict it.","Cut up the cards. Cash only. Feel the difference.","Every dollar toward debt is a punch in the enemy's face.","Beans and rice until that balance hits ZERO.","You don't have a money problem — you have a debt problem."]},
  accountant:{name:"Strict Accountant",icon:"🧮",accent:"#5b8def",blurb:"Precise & dry. Every cent tracked.",introLine:"An accountant. Sensible. I will track every cent and reconcile without mercy. The numbers do not lie.",quips:["Your dining-out line item exceeds budget by 14%. Noted.","Reconciliation complete. Three transactions uncategorized.","Interest accrued this month: avoidable. Disappointing.","A budget is a forecast. Yours does not match actuals. Yet.","Every receipt tells a story. Most are cautionary tales."]},
  mascot:{name:"Cartoon Mascot",icon:"🎉",accent:"#a78bfa",blurb:"Hyper & goofy. Money as a game.",introLine:"WOOHOO!! 🎉 MASCOT MODE! Money is a GAME and you're about to get the HIGH SCORE, baby! LET'S GOOO!",quips:["DING DING DING! You logged in! +10 money points!! 🎉","WHOA you saved money?! ACHIEVEMENT UNLOCKED!","Budgeting is a video game where YOU'RE the hero!","Level up!! Net worth went UP this month! 🚀","Boring? NEVER. Money is FUN when I'm around!"]},
  retired:{name:"Retired Millionaire",icon:"🏖️",accent:"#f0a540",blurb:"Relaxed & big-picture. Enjoy, but stay smart.",introLine:"Ahh, good choice. *sips drink* I made my money, now I share what I learned. Stick with me — we'll get you here too.",quips:["Relax. Money's a long game. I learned that eventually.","Spend on what you love, cut what you don't. That's the secret.","Time in the market beats timing the market.","Build it once, let it work forever. Then? Beach.","Don't sweat the small stuff. Sweat the big stuff, then relax."]},
  investor:{name:"Value Investor",icon:"📈",accent:"#38bdf8",blurb:"Patient & folksy. Long-term compounding.",introLine:"A wise pick. My philosophy: be patient, buy quality, let compounding do the heavy lifting. Shall we?",quips:["Compounding is the eighth wonder of the world. Let it run.","Price is what you pay; value is what you get.","The market transfers money from the impatient to the patient.","Be fearful when others are greedy. Especially on payday.","Our favorite holding period? Forever."]},
};
const PERSONA_ORDER=['coach','crusher','accountant','mascot','retired','investor'];
const LEVELS=[
  {n:1,key:'penny',icon:'🪙',name:'Penny',desc:"New to managing money — I'll explain everything."},
  {n:2,key:'saver',icon:'💵',name:'Saver',desc:"You know the basics. Light guidance."},
  {n:3,key:'budgeter',icon:'💳',name:'Budgeter',desc:"You've got a system. Advanced tools."},
  {n:4,key:'investor',icon:'📈',name:'Investor',desc:"Growing wealth. Minimal hand-holding."},
  {n:5,key:'mogul',icon:'🏦',name:'Mogul',desc:"Power user. Everything on, pro mode."},
];
// Exponential XP ladder — cumulative XP needed to REACH each level (Mogul at 5,000)
const LEVEL_XP=[0, 500, 1250, 2500, 5000];
function xpToLevel(xp){ let lv=1; for(let i=0;i<LEVEL_XP.length;i++){ if((xp||0)>=LEVEL_XP[i]) lv=i+1; } return Math.min(5,lv); }
function levelProgress(){
  const lv=APP.level||xpToLevel(APP.xp||0);
  const cur=LEVEL_XP[lv-1]||0; const next=(LEVEL_XP[lv]!=null)?LEVEL_XP[lv]:null;
  const into=Math.max(0,(APP.xp||0)-cur); const span=(next!=null)?(next-cur):1;
  const pct=(next!=null)?Math.max(0,Math.min(100,Math.round(into/span*100))):100;
  const toNext=(next!=null)?Math.max(0,next-(APP.xp||0)):0;
  return {lv,cur,next,into,span,pct,toNext};
}
// Quiz Richie uses to DETERMINE the starting level (no self-selection).
// Each option carries points 1–5; the average maps to a level.
const LEVEL_QUIZ=[
  { q:"How do you keep track of your money right now?", opts:[
    {label:"I don't really — it just kind of happens", pts:1, coach:'mascot'},
    {label:"I peek at my bank app now and then", pts:2, coach:'coach'},
    {label:"I keep a budget I mostly stick to", pts:3, coach:'accountant'},
    {label:"I track budgets, savings, and net worth", pts:4, coach:'accountant'},
    {label:"Spreadsheets, accounts, the whole system", pts:5, coach:'accountant'},
  ]},
  { q:"If a surprise $1,000 bill hit tomorrow, you'd…", opts:[
    {label:"Be in real trouble", pts:1, coach:'coach'},
    {label:"Scramble, but figure it out", pts:2, coach:'coach'},
    {label:"Cover it from a small cushion", pts:3, coach:'coach'},
    {label:"Pay it from my emergency fund, no sweat", pts:4, coach:'retired'},
    {label:"Not even blink", pts:5, coach:'retired'},
  ]},
  { q:"How do you feel about investing?", opts:[
    {label:"Honestly? No idea where to start", pts:1, coach:'mascot'},
    {label:"Curious but a little nervous", pts:2, coach:'coach'},
    {label:"I put money in retirement accounts", pts:3, coach:'investor'},
    {label:"I invest regularly and rebalance", pts:4, coach:'investor'},
    {label:"I run a diversified portfolio I manage", pts:5, coach:'investor'},
  ]},
  { q:"Your debt situation is best described as…", opts:[
    {label:"Stressful — I'm not sure what I owe", pts:1, coach:'crusher'},
    {label:"I make the minimum payments", pts:2, coach:'crusher'},
    {label:"I have a payoff plan I'm working", pts:3, coach:'crusher'},
    {label:"Low or no debt, all intentional", pts:4, coach:'investor'},
    {label:"Debt's just a tool I optimize", pts:5, coach:'accountant'},
  ]},
  // ── coaching-style questions (no level points; they steer which coach Richie becomes) ──
  { q:"When money gets stressful, what helps you most?", opts:[
    {label:"A cheerleader in my corner", coach:'coach'},
    {label:"Someone to light a fire under me", coach:'crusher'},
    {label:"Cold, hard numbers and a plan", coach:'accountant'},
    {label:"Keeping it light and a little silly", coach:'mascot'},
    {label:"Big-picture perspective from someone who's made it", coach:'retired'},
  ]},
  { q:"How do you want me to talk to you?", opts:[
    {label:"Warm and encouraging", coach:'coach'},
    {label:"Blunt and intense — no excuses", coach:'crusher'},
    {label:"Precise and matter-of-fact", coach:'accountant'},
    {label:"Goofy and hyped up", coach:'mascot'},
    {label:"Calm, wise, and folksy", coach:'investor'},
  ]},
];
function levelFromQuiz(score, count){ return Math.max(1, Math.min(5, Math.round(score/Math.max(count,1)))); }
// Voice inflection per persona (rate & pitch shape Richie's delivery)
// Persona inflection = RELATIVE modifier on top of the chosen base voice
// r = rate multiplier, p = pitch offset
const PERSONA_VOICE={
  coach:{r:1.0,p:0.04}, crusher:{r:1.08,p:-0.12}, accountant:{r:0.96,p:-0.02},
  mascot:{r:1.14,p:0.20}, retired:{r:0.9,p:-0.06}, investor:{r:0.98,p:0.0},
};
// Selectable base voices (male/female + styles). Each prefers matching device
// voices, and falls back to pitch/rate shaping so they stay distinct anywhere.
const VOICE_PRESETS=[
  {id:'guy',  label:'Guy',   emoji:'🧔', gender:'male',   rate:1.06, pitch:0.84, oai:'cedar',  style:'a warm, upbeat, friendly adult male voice — energetic and encouraging, but easy to listen to', match:/(daniel|alex|aaron|tom|fred|nathan|oliver|david|mark|reed|eddy|\bmale\b)/, sample:"Hey, I'm Richie. Let's grow your money."},
  {id:'gal',  label:'Gal',   emoji:'👩', gender:'female', rate:1.0,  pitch:1.16, oai:'marin',  style:'a friendly, natural adult female voice', match:/(samantha|karen|victoria|moira|tessa|fiona|serena|allison|ava|susan|nora|kate|google us english|\bfemale\b)/, sample:"Hi, I'm Richie. Let's grow your money."},
  {id:'hype', label:'Hype',  emoji:'🔥', gender:'any',    rate:1.16, pitch:1.22, oai:'fable',  style:'fast, high-energy and excited', match:/(samantha|google|natural|neural)/, sample:"WOO! I'm Richie and we are gonna CRUSH this!"},
  {id:'calm', label:'Calm',  emoji:'🧊', gender:'any',    rate:0.9,  pitch:0.96, oai:'sage',   style:'slow, calm and soothing', match:/(daniel|serena|natural|neural)/, sample:"Take a breath. I'm Richie. We'll do this together."},
  {id:'deep', label:'Deep',  emoji:'🎙️', gender:'male',   rate:0.94, pitch:0.68, oai:'onyx',   style:'a deep, slow, resonant male voice', match:/(daniel|alex|david|fred|reed|\bmale\b)/, sample:"I'm Richie. Let's talk about your money."},
];
// Per-persona delivery style sent to OpenAI TTS (gpt-4o-mini-tts "instructions")
const PERSONA_TTS_STYLE={
  coach:"Warm, encouraging and supportive — like a friendly coach cheering someone on.",
  crusher:"Intense, punchy tough-love — forceful and motivating, no-nonsense.",
  accountant:"Precise, measured and matter-of-fact. Calm and a little dry.",
  mascot:"Hyper, goofy and excited — a high-energy cartoon mascot.",
  retired:"Relaxed, mellow and easygoing — wise and unhurried.",
  investor:"Calm, thoughtful, patient and folksy — reassuring and steady.",
};
// Decide which coach Richie becomes, from quiz affinities + goals + level
function determinePersona(coachTally){
  const t={}; PERSONA_ORDER.forEach(k=>t[k]=coachTally&&coachTally[k]||0);
  (setupConfig.chosenGoals||[]).forEach(g=>{
    const m=((g.metric||'')+' '+(g.key||'')+' '+(g.name||'')).toLowerCase();
    if(/debt|credit/.test(m)) t.crusher+=2;
    else if(/emergency|saving|save/.test(m)) t.coach+=1.5;
    else if(/net.?worth|fire|invest|retire|coast/.test(m)){ t.investor+=1.5; t.retired+=1; }
  });
  const lv=setupConfig.level||3;
  if(lv>=4){ t.investor+=1; t.accountant+=1; }
  else if(lv<=2){ t.coach+=1; t.mascot+=0.5; }
  let best='coach', bv=-Infinity;
  PERSONA_ORDER.forEach(k=>{ if(t[k]>bv){ bv=t[k]; best=k; } });
  return best;
}

/* ═══════════════ BUNDLES → starter pages ═══════════════ */
const BUNDLE_PAGES={
  overview:[
    ['Dashboard','💰','#2ecc8a',['net_worth_summary','cash_summary','spending_month','income_month','top_categories','budget_doughnut']],
    ['Budget','🎯','#f0a540',['budget_doughnut','top_categories','spending_month','zero_budget']],
    ['Net Worth','📈','#5b8def',['net_worth_summary','net_worth_chart','debt_summary']],
    ['Cash Flow','🌊','#38bdf8',['cashflow_chart','sankey','income_month','spending_month']],
  ],
  budget:[
    ['Budget & Bills','🎯','#f0a540',['budget_doughnut','bills_list','spending_month','top_categories']],
    ['Zero Budget','🧮','#a78bfa',['zero_budget','income_month','top_categories']],
    ['Income','💵','#2ecc8a',['income_month','cashflow_chart','sankey']],
  ],
  wealth:[
    ['Net Worth','📈','#5b8def',['net_worth_summary','net_worth_chart','debt_summary','cash_summary']],
    ['FIRE','🔥','#f05c5c',['fire_progress','fire_calc']],
    ['Retirement','🏖️','#f0a540',['retirement_proj','fire_calc']],
  ],
  debt:[
    ['Bills','📋','#f0a540',['bills_list','debt_summary','spending_month']],
    ['Debt Payoff','🚨','#f05c5c',['debt_payoff','debt_summary','bills_list']],
    ['Fire Drill','🧯','#38bdf8',['fire_progress','zero_budget','spending_month']],
  ],
  fire:[
    ['FIRE','🔥','#f05c5c',['fire_progress','fire_calc']],
    ['Retirement','🏖️','#f0a540',['retirement_proj','fire_calc']],
    ['Net Worth','📈','#5b8def',['net_worth_summary','net_worth_chart']],
  ],
  playground:[
    ['Playground','🎮','#a78bfa',['fire_drill','debt_planner']],
    ['Net Worth','📈','#5b8def',['net_worth_summary','net_worth_chart','debt_summary']],
  ],
  blank:[['Home','🏠','#2ecc8a',[]]],
};
let _uidSeq=0;
// Old widget types that were folded into the tabbed hubs — remap so they never render as "? Widget".
const WIDGET_MIGRATE={debt_summary:'debt_hub',debt_payoff:'debt_hub',credit_util:'debt_hub',promo_tracker:'debt_hub',fire_progress:'fire_hub',retirement_proj:'fire_hub',fire_calc:'fire_hub',safe_to_spend:'cash_summary',budget_actual:'zero_budget',fire_drill:'fire_hub',debt_planner:'debt_hub',cashflow_chart:'cashflow_planner',top_categories:'spending_hub',spending_trends:'spending_hub',category_heatmap:'spending_hub'};
function makeWidget(type){ type=WIDGET_MIGRATE[type]||type; return {uid:'w'+Date.now()+'_'+(_uidSeq++),type:type,span:(WIDGET_BY_ID[type]&&WIDGET_BY_ID[type].span)||1}; }
// Build widgets from a type list, silently dropping any type not registered in the current
// catalog — so a starter set can name widgets that live behind an as-yet-unmerged feature
// without producing a blank tile until that feature lands.
function _regWidgets(list){ return (list||[]).filter(t=>{ const rt=WIDGET_MIGRATE[t]||t; return WIDGET_BY_ID[rt]; }).map(makeWidget); }
// Heal existing/seeded pages: remap folded widget types to hubs, drop unknown/removed types, and
// collapse duplicate hubs (e.g. a page that had 4 separate debt widgets becomes one Debt hub).
function migratePages(pages){
  if(!Array.isArray(pages)) return pages;
  const DEDUPE=new Set(['debt_hub','fire_hub']);
  pages.forEach(pg=>{
    if(!Array.isArray(pg.widgets)) return;
    const seen=new Set();
    pg.widgets=pg.widgets.map(w=>{
      if(typeof w==='string') return WIDGET_MIGRATE[w]||w;
      if(w&&w.type&&WIDGET_MIGRATE[w.type]) return {...w, type:WIDGET_MIGRATE[w.type]};
      return w;
    }).filter(w=>{
      const t=(typeof w==='string')?w:(w&&w.type);
      if(!t || !WIDGET_BY_ID[t]) return false;               // drop removed/unknown types
      if(DEDUPE.has(t)){ if(seen.has(t)) return false; seen.add(t); }
      return true;
    });
  });
  return pages;
}
/* Default config for a widget — merged with whatever the widget has stored. */
function widgetConfig(w){
  const c=(w&&w.config)||{};
  return {
    title: c.title||'',                          // '' = use catalog name
    subtitle: c.subtitle||'',                    // custom subtitle override
    source: c.source||'auto',                    // auto | live | manual | sample
    tf: w&&w.tf || c.tf || '30d',
    topN: c.topN||6,                             // for category lists/doughnuts
    months: c.months||null,
    query: c.query||{ categories:[], accounts:[], minAmt:null, maxAmt:null },
    legend: c.legend!==undefined?c.legend:true,
    legendPos: c.legendPos||'bottom',            // right | left | bottom | top | none
    chartStyle: c.chartStyle||'auto',            // auto | doughnut | bar | list | pie
    numFormat: c.numFormat||'k',                 // full | k | pct | hidden
    accent: c.accent||'',                        // '' = category default
    palette: c.palette||'category',              // category | mono | warm | cool | rainbow
    align: c.align||'center',                    // left | center | right
    height: c.height||'auto',                    // auto | tall | short
    density: c.density||'normal',                // compact | normal | roomy
    showValues: c.showValues!==undefined?c.showValues:true,   // show $ amounts
    showPct: c.showPct!==undefined?c.showPct:false,           // show % alongside
    sortBy: c.sortBy||'value',                   // value | name | none
    sortDir: c.sortDir||'desc',                  // desc | asc
    donutThickness: c.donutThickness||'thick',   // thin | thick | full(pie)
    cardStyle: c.cardStyle||'default',           // default | flat | bordered | gradient
    icon: c.icon||'',                            // '' = catalog icon override
    goal: c.goal!=null?c.goal:null,              // optional goal line / target
    decimals: c.decimals!=null?c.decimals:0,     // decimal places for full format
  };
}
// number formatter honoring per-widget preference
function fmtCfg(n, cfg, total){
  if(cfg&&cfg.numFormat==='hidden') return '';
  if(cfg&&cfg.numFormat==='full'){ const d=cfg.decimals||0; return '$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}); }
  if(cfg&&cfg.numFormat==='pct'&&total) return Math.round(Math.abs(n)/total*100)+'%';
  return fmtK(n);
}
// palette generator for non-category coloring
function palColor(palette, i, n, fallback){
  if(palette==='category'||!palette) return fallback;
  const sets={
    mono:['#2ecc8a','#27b377','#219c66','#1d8556','#186e47','#145838'],
    warm:['#f0a540','#f08c40','#f06c40','#f04c4c','#d83a6a','#b02a7a'],
    cool:['#5b8def','#5b6def','#6b5bef','#8b5bef','#22d3ee','#3dda91'],
    rainbow:['#f04c4c','#f0a540','#3dda91','#22d3ee','#5b8def','#b09afa'],
  };
  const arr=sets[palette]||sets.mono;
  return arr[i%arr.length];
}
function seedPages(bundleKey){
  const bp=BUNDLE_PAGES[bundleKey]||BUNDLE_PAGES.overview;
  return bp.map((p,i)=>({ id:'p'+Date.now()+'_'+i, name:p[0], icon:p[1], color:p[2], widgets:_regWidgets(p[3]||[]) }));
}
/* Build the whole app around chosen goals: a Goals home page + one focused
   page per goal, each carrying the widgets that help achieve it. */
function seedPagesFromGoals(chosenGoals){
  const pages=[];
  const ts=Date.now();
  // 1) Goals home page — the command center
  pages.push({ id:'p'+ts+'_home', name:'My Goals', icon:'🎯', color:'#2ecc8a',
    widgets:_regWidgets(['goals','health_score','safe_spend','net_worth_chart']) });
  // 2) one focused page per goal (dedup by metric so 2 debt goals share one page)
  const seenMetric={};
  chosenGoals.forEach((g,gi)=>{
    const plan=goalPlanFor(g.metric);
    if(seenMetric[g.metric]) return;  // already built a page for this metric
    seenMetric[g.metric]=true;
    pages.push({ id:'p'+ts+'_g'+gi, name:plan.page.name, icon:plan.page.icon, color:plan.page.color,
      goalMetric:g.metric,   // tag the page so Richie can coach it
      widgets:_regWidgets(plan.widgets) });
  });
  return pages;
}
function goalWidgetsUnion(chosenGoals){
  const set=new Set(['goals']);
  chosenGoals.forEach(g=>goalPlanFor(g.metric).widgets.forEach(w=>set.add(w)));
  return [...set];
}

/* ═══════════════ STATE ═══════════════ */
let APP={ household:'My Finance World', profiles:[{name:'Me',avatar:'💰'}], persona:'coach', level:1, xp:0, proMode:false, pages:[], activePage:null };
let sbRichie=null, fabChar=null, rpChar=null;
const ICON_CHOICES=['💰','🎯','📈','🌊','🧮','🔥','🏖️','🚨','📋','🧯','🏠','💵','💳','🏦','📊','🪙','💡','⭐','🎨','🛒'];
const COLOR_CHOICES=['#2ecc8a','#f0a540','#5b8def','#38bdf8','#a78bfa','#f05c5c','#e8584f','#7be0b4'];

function loadState(){
  try{
    const setup=JSON.parse(LS.getItem('richie_setup')||'null');
    let saved=JSON.parse(LS.getItem('richie_app')||'null');
    // Heal a poisoned blank blob: a saved app with NO pages anywhere (main or per-profile
    // layouts) that isn't awaiting its first-win build, while real onboarding data exists,
    // is a default-state artifact (e.g. pushed by a pre-login wizard session and adopted by
    // sync). Prefer the onboarding data; carry the blob's XP/level forward as a floor.
    if(saved && setup && setup.householdName){
      const anyPages=(saved.pages&&saved.pages.length)
        || (saved.layouts && Object.keys(saved.layouts).some(k=>{ const l=saved.layouts[k]; return l&&l.pages&&l.pages.length; }));
      if(!anyPages && !saved._awaitingBuild){
        setup.xp=Math.max(+setup.xp||0, +saved.xp||0);
        setup.level=Math.max(+setup.level||1, +saved.level||1);
        saved=null;
      }
    }
    if(saved){
      APP=Object.assign(APP,saved);
      if(_stateHasWidgets(APP)) _sawWidgets=true;   // real dashboard loaded → arm the no-blank-push guard
      try{ migratePages(APP.pages); }catch(e){}   // heal folded/removed widget types
      // Migration: heal worlds saved before widgets were seeded into bundle pages.
      const hasAnyWidget=(APP.pages||[]).some(p=>p.widgets&&p.widgets.length>0);
      if((APP.pages||[]).length && !hasAnyWidget){
        const bundleKey=(setup&&setup.bundle)||'overview';
        const fresh=seedPages(bundleKey);
        // keep the user's page names/icons/colors, but fill widgets from the matching fresh page by index
        APP.pages=APP.pages.map((p,i)=>({ ...p, widgets:(fresh[i]&&fresh[i].widgets)?fresh[i].widgets:(p.widgets||[]) }));
        // if page count differs (user added/removed pages), top up any still-empty pages with overview defaults
        if(!APP.pages.some(p=>p.widgets.length>0)){
          APP.pages=seedPages(bundleKey);
          APP.activePage=APP.pages[0]?APP.pages[0].id:APP.activePage;
        }
        saveState();
      }
    }
    else if(setup){
      APP.household=setup.householdName||APP.household;
      APP.profiles=setup.profiles&&setup.profiles.length?setup.profiles:APP.profiles;
      APP.persona=setup.persona||'coach';
      APP.level=setup.level||1;
      APP.xp=setup.xp||0;
      APP.proMode=!!setup.proMode;
      if(setup.chosenGoals && setup.chosenGoals.length){
        // create the goal objects now; the PAGES get built when a bank connects (first win)
        APP.goals=[];
        setup.chosenGoals.forEach(cg=>{
          const m=GOAL_METRICS[cg.metric];
          const target=cg.target!=null?cg.target:(cg.auto?goalAutoTarget(cg.auto):0);
          APP.goals.push({ id:'g'+Date.now()+Math.floor(Math.random()*9999), name:cg.name, metric:cg.metric,
            target, icon:cg.icon, start:(cg.metric!=='custom'&&m)?m.get():0, current:0, created:Date.now(), completed:false, presetKey:cg.key });
        });
      }
      // START BLANK — Richie builds the real dashboard the moment a bank connects.
      APP._awaitingBuild=true;
      APP.pages=[{ id:'welcome', name:'Welcome', icon:'👋', color:'#2ecc8a', widgets:[] }];
      APP.activePage='welcome';
      // IN-MEMORY ONLY — do NOT persist or push this blank gate. Reaching here means local
      // richie_app was missing; a returning user whose browser cleared storage still has the
      // real dashboard on the server. Persisting the gate would make it stick (blocking the
      // enterApp server-restore next reopen) and pushing it would OVERWRITE the server — the
      // exact "reverts to Richie build" bug. Leaving richie_app empty lets enterApp restore.
    } else {
      // no setup yet — seed a default world
      APP.pages=seedPages('overview');
      APP.activePage=APP.pages[0].id;
    }
    _initProfiles();   // set up / load per-profile layouts
  }catch(e){ console.warn('state load failed',e); }
}
/* saveState: the localStorage write serializes the whole APP blob (~100KB+), and some
   handlers call saveState per keystroke. The write is debounced 250ms and flushed on
   tab hide/close; sync is unaffected (syncCollect reads the live APP, not localStorage). */
let _lsWriteTimer=null, _lsDirty=false;
function _writeStateNow(){ _lsDirty=false; clearTimeout(_lsWriteTimer); try{ _saveActiveLayout(); LS.setItem('richie_app',JSON.stringify(APP)); }catch(e){} }
function _cancelPendingStateWrite(){ _lsDirty=false; clearTimeout(_lsWriteTimer); }   // when richie_app is about to be replaced/wiped deliberately
// SYNCHRONOUS on purpose: _saveActiveLayout() must fold live pages into APP.layouts BEFORE
// any push captures APP — the restore path reads the dashboard from layouts, and syncCollect
// pushes layouts. Deferring this (a past "debounce the localStorage write" optimization)
// let immediate/flush/heartbeat pushes ship stale empty layouts, which restored as the blank
// "Richie build" gate. Correctness beats the micro-optimization here.
function saveState(){ try{ _memoInvalidate(); _saveActiveLayout(); LS.setItem('richie_app',JSON.stringify(APP)); syncPush(); }catch(e){} }
window.addEventListener('pagehide', ()=>{ if(_lsDirty) _writeStateNow(); });
window.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden' && _lsDirty) _writeStateNow(); });
// Deferred persist for derived/reconciled state (e.g. envelope reconciliation) so a getter
// called during render doesn't serialize the whole APP blob mid-render. Coalesces to one write.
let _persistTimer=null;
function _persistSoon(){ clearTimeout(_persistTimer); _persistTimer=setTimeout(()=>{ try{ saveState(); }catch(e){} }, 400); }
/* ── Cross-device state sync: push edits to the server, pull newer edits from other devices ── */
const SYNC_KEYS=['mdf_categories','mdf_cat_overrides','mdf_cat_rules','mdf_txn_notes','mdf_txn_tags','mdf_txn_confirmed','mdf_acct_cats','mdf_nw_history','mdf_health_history','mdf_health_grade','mdf_fire','mdf_gami','richie_setup','richie_lastvisit','richie_proactive','richie_audio','richie_voice'];
function syncCollect(){ try{ _saveActiveLayout(); }catch(e){}   /* fold live pages into layouts before EVERY push (immediate/flush/heartbeat), else a push can ship stale layouts */
  const stores={}; SYNC_KEYS.forEach(k=>{ const v=LS.getItem(k); if(v!=null) stores[k]=v; }); return { app:APP, stores, _ts:Date.now() }; }
function _widgetCount(pages){ return (pages||[]).reduce((s,p)=>s+((p&&p.widgets||[]).length),0); }
/* A sync must NEVER shrink a built dashboard. Like XP, widgets only ratchet up: if the
   incoming (another device / older session) state has fewer widgets for the working pages
   or any profile layout, keep the local, more-populated version. Prevents a blank phone or
   a stale session from wiping a full desktop dashboard on the next reload. */
function _mergeLayoutsPreferPopulated(incoming, local){
  if(!incoming||!local) return;
  if(_widgetCount(local.pages) > _widgetCount(incoming.pages)){ incoming.pages=local.pages; incoming.activePage=local.activePage; }
  incoming.layouts=incoming.layouts||{}; const ll=local.layouts||{};
  Object.keys(ll).forEach(k=>{
    const li=incoming.layouts[k];
    if(!li || _widgetCount((li||{}).pages) < _widgetCount((ll[k]||{}).pages)) incoming.layouts[k]=ll[k];
  });
}
function syncApplyToLS(blob){ try{
  _cancelPendingStateWrite();   // the adopted blob must not be clobbered by a stale debounced write
  const localApp=JSON.parse(LS.getItem('richie_app')||'{}');
  if(blob&&blob.app){
    blob.app.xp=Math.max(+blob.app.xp||0, +localApp.xp||0);        // XP/level never go backwards
    blob.app.level=Math.max(+blob.app.level||0, +localApp.level||0);
    _mergeLayoutsPreferPopulated(blob.app, localApp);              // and neither does the dashboard
    LS.setItem('richie_app', JSON.stringify(blob.app));
  }
  if(blob&&blob.stores) Object.keys(blob.stores).forEach(k=>{ if(blob.stores[k]!=null) LS.setItem(k, blob.stores[k]); });
  if(blob&&blob.app&&_stateHasWidgets(blob.app)) _sawWidgets=true;   // restored a real dashboard → arm the no-blank-push guard
  _memoInvalidate();   // another device's state landed → drop memoized derivations
}catch(e){} }
let _syncTimer=null;
// No pushes until the app has actually ENTERED (post-login, state loaded). During the
// onboarding wizard, XP awards call saveState → without this gate, the default APP blob
// ("My Finance World", no pages) got pushed to a freshly-reset server and then adopted
// over the real onboarding result at the post-login sync — undoing the user's setup.
let _appEntered=false;
let _syncDirty=false, _syncRetryTimer=null;
async function _syncPushNow(){
  // GUARD: never push a widget-less/gate state once this session has seen a real dashboard.
  // A storage clear + the gate seed can blank APP; pushing that blanked its server copy too
  // (proven by diagnostics: server went 3 pages/13 widgets → 1 page/0 widgets on reopen).
  if(_stateHasWidgets(APP)) _sawWidgets=true;
  else if(_sawWidgets){ _syncDirty=false; return; }   // refuse — the good dashboard stays on the server
  // One real upload attempt. mdf_sync_ts is stamped ONLY on success — stamping before the
  // POST made a failed push (cold server, network blip, closed tab) look synced forever,
  // leaving the server copy stale; a device that lost local storage then restored nothing.
  try{
    const blob=syncCollect();
    const r=await fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:blob})});
    if(!r.ok) throw new Error('push '+r.status);
    serverAvailable=true;   // a landed push proves the server is reachable again
    const jd=await r.json().catch(()=>null);
    // The server reports which copy its merge kept. If it discarded ours, this push did
    // NOT save — surface it loudly instead of showing "Saved to cloud" over lost data.
    if(jd && jd.kept==='existing'){
      _syncDirty=false;   // re-pushing the same blob would lose again — stop and surface
      _syncSetStatus('conflict', jd);
      console.warn('sync: server kept its stored copy over this push', jd);
      return;
    }
    _syncDirty=false;
    _syncSetStatus('ok');
    LS.setItem('mdf_sync_ts', String(blob._ts));
    if(jd && ((+jd.xp||0)>(+APP.xp||0) || (+jd.level||0)>(+APP.level||0))){   // server had higher XP/level → adopt it
      APP.xp=Math.max(+APP.xp||0,+jd.xp||0); APP.level=Math.max(+APP.level||0,+jd.level||0);
      LS.setItem('richie_app', JSON.stringify(APP));
      try{ const el=gg('sbXp'); if(el) el.textContent=APP.xp+' XP'; const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg) renderCanvas(pg); }catch(e){}
    }
  }catch(e){
    // Still dirty — retry soon (cold Render servers take ~30s to wake, so keep trying).
    _syncSetStatus('retry');
    clearTimeout(_syncRetryTimer);
    _syncRetryTimer=setTimeout(()=>{ if(_syncDirty) _syncPushNow(); }, 15000);
  }
}
function syncPush(){
  if(!_appEntered) return;
  // NOTE: deliberately NOT gated on serverAvailable — that flag latches false on a single
  // cold-start 502 and would silently disable every push for the session (stale server copy
  // = lost world for storage-clearing browsers). _syncPushNow retries until one lands.
  _syncDirty=true;
  _syncSetStatus('saving');
  clearTimeout(_syncTimer);
  _syncTimer=setTimeout(_syncPushNow, 1800);
}
// Sidebar sync indicator — makes "is it safe to close?" visible instead of forensic.
function _syncSetStatus(s, info){
  const el=gg('syncStatus'); if(!el) return;
  if(s==='ok'){ el.textContent='☁️ Saved to cloud'; el.style.color='var(--muted)'; }
  else if(s==='saving'){ el.textContent='↻ Saving to cloud…'; el.style.color='var(--amber)'; }
  else if(s==='retry'){ el.textContent='⚠️ Cloud unreachable — retrying (don’t close yet)'; el.style.color='var(--red)'; }
  else if(s==='conflict'){ el.textContent=`⚠️ Cloud kept another copy (${(info&&info.incomingWidgets)??'?'} vs ${(info&&info.existingWidgets)??'?'} widgets) — not saved`; el.style.color='var(--red)'; }
}
// Heartbeat: as long as anything is unsynced, keep trying — belt-and-braces over the
// one-shot retry timer, and it survives any missed re-arm.
setInterval(()=>{ try{ if(_appEntered && _syncDirty) _syncPushNow(); }catch(e){} }, 20000);
// If closing would lose unsynced changes (this matters for browsers that clear site data
// on exit), ask first. No prompt when everything is saved.
window.addEventListener('beforeunload', (e)=>{ if(_appEntered && _syncDirty){ e.preventDefault(); e.returnValue=''; } });
// Exit flush: closing/hiding the tab inside the debounce window used to drop the last
// edits. keepalive lets the request outlive the page; sendBeacon is the fallback.
function _syncFlush(){
  if(!_appEntered || !_syncDirty) return;
  if(_sawWidgets && !_stateHasWidgets(APP)) return;   // never flush a blank over the real dashboard
  try{
    clearTimeout(_syncTimer);
    const body=JSON.stringify({state:syncCollect()});
    let sent=false;
    try{ fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true}).catch(()=>{}); sent=true; }catch(e){}
    if(!sent && navigator.sendBeacon){ try{ navigator.sendBeacon('/api/state', new Blob([body],{type:'application/json'})); }catch(e){} }
    // NOTE: _syncDirty stays true — the flush can't confirm delivery (a cold server eats
    // it silently). If the page survives (tab switch), the heartbeat keeps retrying; if
    // the page dies, the flag dies with it and nothing is worse off.
  }catch(e){}
}
window.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden') _syncFlush(); });
window.addEventListener('pagehide', _syncFlush);
async function syncPull(){
  if(typeof serverAvailable!=='undefined' && !serverAvailable) return false;
  try{
    const d=await _fetchJSON('/api/state');
    if(d && d.state && d.state._ts){
      const localTs=+(LS.getItem('mdf_sync_ts')||0);
      if(d.state._ts > localTs){          // another device has newer edits → adopt them
        syncApplyToLS(d.state);
        LS.setItem('mdf_sync_ts', String(d.state._ts));
        // Apply in place — NO location.reload(). A reload on a storage-clearing browser wipes
        // richie_app again and restarts the clear→gate→restore cycle (the "rebuild every
        // reload"). If we've entered, re-render from the adopted state; if not, enterApp's
        // loadState (which runs next) already reads the freshly-written richie_app.
        try{ if(_appEntered){ loadState(); renderShell(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg) renderCanvas(pg); } }catch(e){}
        return true;
      }
    } else {
      syncPush();                          // no server copy yet → push this device up as the baseline
    }
  }catch(e){}
  return false;
}
/* ── Per-profile layouts: each profile (Matt, Dana…) has its own pages/widgets; ALL
   financial data (accounts, transactions, goals, budget, categories, net worth) is shared. ── */
function _activeProfile(){ return (APP.profiles||[]).find(p=>p.id===APP.activeProfile) || (APP.profiles&&APP.profiles[0]) || {name:'Me',avatar:'💰'}; }
function _initProfiles(){
  if(!Array.isArray(APP.profiles)||!APP.profiles.length) APP.profiles=[{name:'Me',avatar:'💰'}];
  APP.profiles.forEach((p,i)=>{ if(!p.id) p.id='prof'+i+'_'+String(p.name||'me').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,10); if(!p.avatar) p.avatar='💰'; });
  if(!APP.layouts||typeof APP.layouts!=='object') APP.layouts={};
  const keys=APP.profiles.map(p=>p.id);
  if(!APP.activeProfile||keys.indexOf(APP.activeProfile)<0) APP.activeProfile=keys[0];
  // First run under the profile system: adopt the current dashboard as the active profile's layout.
  if(!APP.layouts[APP.activeProfile] && (APP.pages||[]).length){
    APP.layouts[APP.activeProfile]={ pages:APP.pages, activePage:APP.activePage };
  }
  // Load the active profile's layout into the working copy — but never let a widget-less
  // layout replace saved pages that DO have widgets (that would silently wipe the dashboard).
  const lay=APP.layouts[APP.activeProfile];
  if(lay && Array.isArray(lay.pages) && lay.pages.length){
    if(_widgetCount(lay.pages) >= _widgetCount(APP.pages) || !_widgetCount(APP.pages)){
      APP.pages=lay.pages; APP.activePage=lay.activePage||(lay.pages[0]&&lay.pages[0].id);
    } else {
      APP.layouts[APP.activeProfile]={ pages:APP.pages, activePage:APP.activePage };   // saved pages richer → adopt into the layout
    }
  }
}
function _saveActiveLayout(){
  if(!APP.layouts) APP.layouts={};
  if(!APP.activeProfile) return;
  APP.layouts[APP.activeProfile]={ pages:APP.pages, activePage:(APP.activePage==='__settings__'?(APP.pages[0]&&APP.pages[0].id):APP.activePage) };
}
function _cloneLayout(){
  const pages=(APP.pages||[]).map(p=>({ ...p, id:'p'+Date.now()+'_'+Math.floor(Math.random()*99999), widgets:(p.widgets||[]).map(w=>({...w, uid:'w'+Date.now()+'_'+(_uidSeq++)})) }));
  return { pages, activePage: pages[0]?pages[0].id:null };
}
function switchProfile(key){
  try{ closeUserMenu(); }catch(e){}
  if(key===APP.activeProfile) return;
  const p=(APP.profiles||[]).find(x=>x.id===key); if(!p) return;
  _saveActiveLayout();
  APP.activeProfile=key;
  let lay=APP.layouts[key];
  if(!lay || !Array.isArray(lay.pages) || !lay.pages.length){ lay=_cloneLayout(); APP.layouts[key]=lay; }   // new profile starts from a copy they can customize
  APP.pages=lay.pages; APP.activePage=lay.activePage;
  saveState();
  renderShell();
  if(APP.activePage && APP.activePage!=='__settings__') switchPage(APP.activePage);
  else if(APP.pages[0]) switchPage(APP.pages[0].id);
  try{ if(typeof richieSay==='function') richieSay(`Now showing ${p.name}'s dashboard. The money data's shared — only the layout changes.`); }catch(e){}
}
function addProfile(){
  const name=(prompt('New profile name (e.g. Dana):')||'').trim();
  if(!name) return;
  const id='prof'+(APP.profiles.length)+'_'+name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,10)+Math.floor(Math.random()*99);
  APP.profiles.push({ id, name, avatar:'🧑' });
  saveState();
  switchProfile(id);   // jump into the new profile (starts as a copy of the current layout)
}

/* ═══════════════ RENDER SHELL ═══════════════ */
/* ═══ APPEARANCE / THEME (per profile) ═══ */
/* Optional decorative background patterns (layered over --bg via --bg-pattern). Kept subtle —
   widgets sit on opaque --surface, so patterns only show in the background gutters. */
const _PAT={
  stars:'radial-gradient(1px 1px at 12% 20%,rgba(255,255,255,.7),transparent),radial-gradient(1px 1px at 78% 32%,rgba(180,220,255,.6),transparent),radial-gradient(1.5px 1.5px at 42% 72%,rgba(255,255,255,.55),transparent),radial-gradient(1px 1px at 88% 66%,rgba(255,255,255,.5),transparent),radial-gradient(1px 1px at 26% 84%,rgba(200,220,255,.5),transparent),radial-gradient(1.5px 1.5px at 62% 14%,rgba(255,255,255,.45),transparent),radial-gradient(1px 1px at 8% 54%,rgba(255,255,255,.4),transparent),radial-gradient(1px 1px at 54% 44%,rgba(255,255,255,.35),transparent),radial-gradient(1px 1px at 34% 8%,rgba(255,255,255,.4),transparent)',
  stripes:'repeating-linear-gradient(45deg,rgba(154,230,48,.06) 0 12px,transparent 12px 26px)',
  grid:'repeating-linear-gradient(0deg,rgba(255,255,255,.035) 0 1px,transparent 1px 38px),repeating-linear-gradient(90deg,rgba(255,255,255,.035) 0 1px,transparent 1px 38px)',
  neon:'repeating-linear-gradient(0deg,rgba(255,79,216,.06) 0 1px,transparent 1px 40px),repeating-linear-gradient(90deg,rgba(79,225,255,.05) 0 1px,transparent 1px 40px)',
  sparkle:'radial-gradient(2px 2px at 16% 22%,rgba(230,160,40,.55),transparent),radial-gradient(1.5px 1.5px at 64% 66%,rgba(236,79,170,.4),transparent),radial-gradient(2px 2px at 84% 30%,rgba(230,160,40,.5),transparent),radial-gradient(1.5px 1.5px at 32% 80%,rgba(236,79,170,.38),transparent),radial-gradient(1.5px 1.5px at 74% 86%,rgba(230,160,40,.45),transparent),radial-gradient(1.5px 1.5px at 46% 42%,rgba(236,79,170,.3),transparent)',
  weave:'repeating-linear-gradient(45deg,rgba(140,110,70,.05) 0 7px,transparent 7px 14px),repeating-linear-gradient(-45deg,rgba(140,110,70,.04) 0 7px,transparent 7px 14px)',
};
const THEME_PRESETS=[
  // ── Dark (deep, tinted charcoals — not pure black) ──
  {id:'midnight',name:'Midnight',bg:'#191c24',sidebar:'#1e222c',surface:'#242833',surface2:'#2b303d',surface3:'#353b4a',text:'#e4e6f0',muted:'#9297b0',border:'rgba(255,255,255,0.07)',border2:'rgba(255,255,255,0.12)',accent:'#2ecc8a'},
  {id:'ocean',name:'Ocean',bg:'#111e2b',sidebar:'#152535',surface:'#1c2f43',surface2:'#243b53',surface3:'#2f4864',text:'#e2ecf5',muted:'#88a0b6',border:'rgba(120,180,255,0.09)',border2:'rgba(120,180,255,0.16)',accent:'#38bdf8'},
  {id:'forest',name:'Forest',bg:'#141f19',sidebar:'#192921',surface:'#1f3329',surface2:'#274133',surface3:'#32523f',text:'#e0f0e6',muted:'#87ab97',border:'rgba(120,255,180,0.08)',border2:'rgba(120,255,180,0.15)',accent:'#4ade80'},
  {id:'grape',name:'Grape',bg:'#1b1628',sidebar:'#211a33',surface:'#29203f',surface2:'#33294e',surface3:'#403460',text:'#ece2f5',muted:'#a091b3',border:'rgba(180,120,255,0.09)',border2:'rgba(180,120,255,0.16)',accent:'#a78bfa'},
  {id:'sunset',name:'Sunset',bg:'#241820',sidebar:'#2d1e28',surface:'#372531',surface2:'#462f3d',surface3:'#583a4a',text:'#f5e2e8',muted:'#b48f9a',border:'rgba(255,120,150,0.09)',border2:'rgba(255,120,150,0.16)',accent:'#fb7185'},
  {id:'gold',name:'Midas',bg:'#1f1b12',sidebar:'#262117',surface:'#302819',surface2:'#3c3322',surface3:'#4a3f2b',text:'#f5efe0',muted:'#b3a488',border:'rgba(255,210,120,0.09)',border2:'rgba(255,210,120,0.16)',accent:'#f0c040'},
  {id:'mono',name:'Carbon',bg:'#1a1a1a',sidebar:'#202020',surface:'#262626',surface2:'#2e2e2e',surface3:'#383838',text:'#e8e8e8',muted:'#9a9a9a',border:'rgba(255,255,255,0.07)',border2:'rgba(255,255,255,0.12)',accent:'#e4e4e7'},
  // Fun / character (original palettes inspired by the vibe — no logos/artwork)
  {id:'galaxy',name:'Galaxy',bg:'#12152a',sidebar:'#171c38',surface:'#1d2342',surface2:'#262d52',surface3:'#333c68',text:'#e6e9f7',muted:'#9096bd',border:'rgba(130,160,255,0.10)',border2:'rgba(130,160,255,0.18)',accent:'#37e0a0',pattern:_PAT.stars},   // a galaxy far, far away — starfield + saber-green
  {id:'afterlife',name:'Afterlife',bg:'#141a0f',sidebar:'#192113',surface:'#202b16',surface2:'#29371c',surface3:'#354627',text:'#eaf6d8',muted:'#93a97b',border:'rgba(154,230,48,0.12)',border2:'rgba(154,230,48,0.20)',accent:'#9ae62e',pattern:_PAT.stripes},   // ghost-with-the-most black & venom green
  {id:'neon',name:'Neon City',bg:'#150f26',sidebar:'#1a1330',surface:'#21193c',surface2:'#2a2149',surface3:'#372c5c',text:'#f3e9ff',muted:'#9d8dbd',border:'rgba(255,79,216,0.12)',border2:'rgba(79,225,255,0.20)',accent:'#ff2bd6',pattern:_PAT.neon},   // teen cyberpunk
  {id:'slime',name:'Slime',bg:'#151a10',sidebar:'#1a2115',surface:'#212b18',surface2:'#2a361f',surface3:'#37472a',text:'#e9f5df',muted:'#92a884',border:'rgba(163,255,18,0.11)',border2:'rgba(163,255,18,0.18)',accent:'#a3ff12',pattern:_PAT.grid},   // teen gamer neon
  {id:'espresso',name:'Espresso',bg:'#211a13',sidebar:'#28201a',surface:'#312820',surface2:'#3d3228',surface3:'#4b3e30',text:'#f2e8dc',muted:'#b09d86',border:'rgba(201,162,103,0.10)',border2:'rgba(201,162,103,0.18)',accent:'#c9a267'},   // mature, warm & refined
  {id:'merlot',name:'Merlot',bg:'#241419',sidebar:'#2c1921',surface:'#361f28',surface2:'#442833',surface3:'#553341',text:'#f2e3e8',muted:'#b08b97',border:'rgba(200,90,120,0.10)',border2:'rgba(200,90,120,0.18)',accent:'#c04d6a'},   // mature, deep wine
  // ── Bright ──
  {id:'daylight',name:'Daylight',light:true,bg:'#f4f6fb',sidebar:'#e9edf5',surface:'#ffffff',surface2:'#f0f3f9',surface3:'#e4e9f2',text:'#1a1d29',muted:'#697089',border:'rgba(0,0,0,0.08)',border2:'rgba(0,0,0,0.13)',accent:'#0c855d'},
  {id:'princess',name:'Princess',light:true,bg:'#fff4fa',sidebar:'#ffe9f4',surface:'#ffffff',surface2:'#fff0f7',surface3:'#ffe3f0',text:'#4a2036',muted:'#90627a',border:'rgba(236,79,170,0.14)',border2:'rgba(236,79,170,0.24)',accent:'#c6428f',pattern:_PAT.sparkle},   // pink & gold sparkle
  {id:'bubblegum',name:'Bubblegum',light:true,bg:'#fdf0f8',sidebar:'#fbe4f1',surface:'#ffffff',surface2:'#fbeaf4',surface3:'#f7dcec',text:'#3a1a2e',muted:'#8e6279',border:'rgba(244,63,142,0.13)',border2:'rgba(60,180,240,0.20)',accent:'#d2367a'},   // teen bright pop
  {id:'mint',name:'Mint',light:true,bg:'#f0faf4',sidebar:'#e4f4ea',surface:'#ffffff',surface2:'#eefaf2',surface3:'#e0f2e7',text:'#12352a',muted:'#547968',border:'rgba(16,185,129,0.12)',border2:'rgba(16,185,129,0.20)',accent:'#0c855d'},
  {id:'sky',name:'Sky',light:true,bg:'#eff6ff',sidebar:'#e3eefc',surface:'#ffffff',surface2:'#eef5ff',surface3:'#e0ecfb',text:'#12233a',muted:'#5b7291',border:'rgba(59,130,246,0.12)',border2:'rgba(59,130,246,0.20)',accent:'#3472d8'},
  {id:'sunrise',name:'Sunrise',light:true,bg:'#fff5ee',sidebar:'#ffe9db',surface:'#ffffff',surface2:'#fff0e6',surface3:'#ffe1cf',text:'#3a2317',muted:'#896b57',border:'rgba(251,146,60,0.13)',border2:'rgba(251,146,60,0.22)',accent:'#ba5a2c'},
  {id:'linen',name:'Linen',light:true,bg:'#f7f3ec',sidebar:'#efe9df',surface:'#fffdf9',surface2:'#f4efe6',surface3:'#eae3d6',text:'#332b20',muted:'#796d5a',border:'rgba(140,110,70,0.12)',border2:'rgba(140,110,70,0.20)',accent:'#916e44',pattern:_PAT.weave},   // mature, elegant
  {id:'paper',name:'Paper',light:true,bg:'#faf9f6',sidebar:'#f0efeb',surface:'#ffffff',surface2:'#f4f3ef',surface3:'#e9e8e3',text:'#1a1a1a',muted:'#6b6b6b',border:'rgba(0,0,0,0.08)',border2:'rgba(0,0,0,0.14)',accent:'#111827'},   // mature, minimalist
];
const THEME_BY_ID={}; THEME_PRESETS.forEach(t=>THEME_BY_ID[t.id]=t);
const FONT_OPTS=[
  {id:'dm',name:'DM Sans',css:"'DM Sans',sans-serif"},
  {id:'inter',name:'Inter',css:"'Inter',sans-serif"},
  {id:'jakarta',name:'Jakarta',css:"'Plus Jakarta Sans',sans-serif"},
  {id:'outfit',name:'Outfit',css:"'Outfit',sans-serif"},
  {id:'nunito',name:'Nunito',css:"'Nunito',sans-serif"},
  {id:'manrope',name:'Manrope',css:"'Manrope',sans-serif"},
  {id:'roboto',name:'Roboto',css:"'Roboto',sans-serif"},
  {id:'mono',name:'JetBrains Mono',css:"'JetBrains Mono',monospace"},
  {id:'system',name:'System',css:"system-ui,-apple-system,sans-serif"},
];
const FONT_BY_ID={}; FONT_OPTS.forEach(f=>FONT_BY_ID[f.id]=f);
function _hexToRgba(hex,al){ hex=String(hex||'').replace('#',''); if(hex.length===3)hex=hex.split('').map(c=>c+c).join(''); const n=parseInt(hex,16); if(isNaN(n))return 'rgba(46,204,138,'+al+')'; return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${al})`; }
function _toHexColor(v){ v=String(v||''); return /^#[0-9a-fA-F]{6}$/.test(v)?v:(/^#[0-9a-fA-F]{3}$/.test(v)?v:'#2ecc8a'); }
function _appearance(){ return (APP.appearances&&APP.appearances[APP.activeProfile])||{}; }
function _setAppearance(patch){ APP.appearances=APP.appearances||{}; APP.appearances[APP.activeProfile]=Object.assign({}, _appearance(), patch); }
function applyAppearance(){
  const a=_appearance();
  const preset=THEME_BY_ID[a.preset||'midnight']||THEME_PRESETS[0];
  const r=document.documentElement.style, set=(k,v)=>r.setProperty(k,v);
  set('--bg', a.bg||preset.bg); set('--sidebar', preset.sidebar);
  set('--bg-pattern', preset.pattern||'none');   // decorative backdrop for fun themes (else none)
  set('--surface', a.surface||preset.surface); set('--surface2', preset.surface2); set('--surface3', preset.surface3);
  set('--text', a.text||preset.text); set('--muted', preset.muted);
  set('--border', preset.border); set('--border2', preset.border2);
  const persona=RICHIE_PERSONAS[APP.persona];
  const accent=a.accent||(persona&&persona.accent)||preset.accent;   // custom > persona > preset
  set('--green', accent); set('--green-dim', _hexToRgba(accent,0.12)); set('--green-glow', _hexToRgba(accent,0.2)); set('--richie-green', accent); set('--accent', accent);
  // money colors go darker on light themes so +/− amounts hit WCAG AA (4.5:1) on white surfaces
  const posDef = preset.light ? '#1d8358' : '#2ecc8a';
  const redDef = preset.light ? '#c54b4b' : '#f05c5c';
  set('--pos', a.pos||posDef); set('--pos-dim', _hexToRgba(a.pos||posDef,0.12));   // money-in stays its own color
  set('--red', a.neg||redDef); set('--red-dim', _hexToRgba(a.neg||redDef,0.1));
  const font=FONT_BY_ID[a.font||'dm']||FONT_OPTS[0]; set('--font', font.css);
  try{ applyThemeFx(preset.id); }catch(e){}   // themed ambient animations (opt-out, reduced-motion aware)
}
function applyAccent(){ applyAppearance(); }   // persona/appearance both flow through here

/* ── Theme ambient animations (fun, optional, per profile) ──
   A body-level, pointer-events-none overlay drifts a few themed emoji across the screen;
   some themes also enable per-widget CSS effects via a body.fx-<id> class (e.g. slime drip).
   Off automatically under prefers-reduced-motion; toggle in Settings → Appearance. */
const THEME_FX={
  galaxy:   {emojis:['🚀','🛸','🌟','✨'], anim:'drift', count:7, size:[13,24], op:0.55, dur:[16,34]},
  slime:    {emojis:['🫧','💚','🟢'],       anim:'float', count:5, size:[13,22], op:0.40, dur:[8,15]},
  princess: {emojis:['👑','💖','✨','🌸'], anim:'float', count:8, size:[14,24], op:0.60, dur:[9,18]},
  forest:   {emojis:['🍃','🍂','🌿'],       anim:'fall',  count:9, size:[14,22], op:0.70, dur:[8,16]},
  ocean:    {emojis:['🫧','🐠','🐚'],       anim:'rise',  count:8, size:[12,22], op:0.50, dur:[9,18]},
  afterlife:{emojis:['👻','🪲','🕸️'],       anim:'float', count:6, size:[15,26], op:0.45, dur:[10,20]},
  neon:     {emojis:['✦','💫','⚡'],         anim:'float', count:7, size:[12,20], op:0.50, dur:[8,16]},
  sunset:   {emojis:['🌸','🍑','☀️'],       anim:'fall',  count:7, size:[14,22], op:0.50, dur:[9,17]},
  gold:     {emojis:['🪙','✨','💰'],       anim:'fall',  count:6, size:[14,22], op:0.50, dur:[9,16]},
  grape:    {emojis:['🍇','🔮','✨'],       anim:'float', count:6, size:[14,22], op:0.45, dur:[10,18]},
  merlot:   {emojis:['🍷','🍇'],             anim:'float', count:5, size:[15,24], op:0.40, dur:[12,22]},
};
let _fxLayer=null;
function _ensureFxLayer(){
  if(_fxLayer && document.body && document.body.contains(_fxLayer)) return _fxLayer;
  _fxLayer=document.getElementById('themeFx');
  if(!_fxLayer){ _fxLayer=document.createElement('div'); _fxLayer.id='themeFx'; if(document.body) document.body.appendChild(_fxLayer); }
  return _fxLayer;
}
function applyThemeFx(presetId){
  if(typeof document==='undefined' || !document.body) return;
  const layer=_ensureFxLayer(); if(!layer) return;
  [...document.body.classList].forEach(c=>{ if(c.indexOf('fx-')===0) document.body.classList.remove(c); });
  layer.className=''; layer.innerHTML='';
  const a=_appearance();
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fx=THEME_FX[presetId];
  if(a.fx===false || reduce || !fx) return;
  document.body.classList.add('fx-'+presetId);      // enables per-widget CSS effects (slime drip, etc.)
  layer.className='fx-'+fx.anim;
  const rnd=(lo,hi)=>lo+Math.random()*(hi-lo);
  let html='';
  for(let i=0;i<fx.count;i++){
    const em=fx.emojis[i%fx.emojis.length];
    const dur=rnd(fx.dur[0],fx.dur[1]);
    html+=`<span class="fx-bit" style="--x:${rnd(3,95).toFixed(1)}%;--y:${rnd(4,92).toFixed(1)}%;--sz:${rnd(fx.size[0],fx.size[1]).toFixed(0)}px;--dur:${dur.toFixed(1)}s;--delay:${(-rnd(0,dur)).toFixed(1)}s;--op:${(fx.op*rnd(0.7,1)).toFixed(2)};--drift:${rnd(-45,45).toFixed(0)}px">${em}</span>`;
  }
  layer.innerHTML=html;
}
function setThemeAnim(on){ _setAppearance({fx:!!on}); applyThemeFx(_appearance().preset||'midnight'); saveState(); renderAppearance(); }

function renderShell(){
  applyAccent();
  try{ _a11yObserve(); }catch(e){}   // start the accessibility name sweep once the shell exists
  try{ _applyReduceMotion(); }catch(e){}
  gg('sbHousehold').textContent=APP.household;
  const lv=LEVELS.find(l=>l.n===APP.level)||LEVELS[0];
  gg('sbLevelLabel').textContent=lv.icon+' Level '+lv.n+' · '+lv.name;
  const prof=_activeProfile();
  gg('sbAvatar').textContent=prof.avatar||'💰';
  gg('sbUserName').textContent=prof.name||'Me';
  gg('sbXp').textContent=APP.xp+' XP';
  const p=RICHIE_PERSONAS[APP.persona];
  if(p) gg('rpName').textContent='Richie · '+p.name;
  renderNav();
  newSbTip();
}

function renderNav(){
  const nav=gg('sbNav');
  nav.innerHTML=APP.pages.map(pg=>`
    <div class="page-nav-btn${pg.id===APP.activePage?' active':''}" style="--page-color:${pg.color}" onclick="switchPage('${pg.id}')" role="button" tabindex="0">
      <span class="pnb-icon" style="${pg.id===APP.activePage?'background:'+pg.color:''}">${pg.icon}</span>
      <span class="pnb-label">${esc(pg.name)}</span>
      <span class="pnb-actions">
        <span class="pnb-act" onclick="event.stopPropagation();openPageEditor('${pg.id}')" title="Edit" role="button">✎</span>
        <span class="pnb-act" onclick="event.stopPropagation();deletePage('${pg.id}')" title="Delete" role="button">🗑</span>
      </span>
    </div>`).join('') || '<div style="padding:14px;color:var(--hint);font-size:12px;text-align:center">No pages yet. Tap + to add one.</div>';
}

function closeSidebarMobileLegacy_REMOVED(){}
function switchPage(id){
  closeSidebarMobile();
  if(typeof _raSelfNav!=='undefined' && !_raSelfNav){ try{ richieStopForNav(); }catch(e){} }  // hand off: stop this page's Richie
  if(id==='__settings__'){ renderSettings(); APP.activePage='__settings__'; renderNav(); return; }
  let pg=APP.pages.find(p=>p.id===id);
  if(!pg){ pg=APP.pages[0]; }   // stale/invalid id → fall back to first page
  if(!pg){ renderNav(); return; } // genuinely no pages
  APP.activePage=pg.id; saveState(); renderNav();
  gg('tbIcon').textContent=pg.icon;
  gg('tbTitle').textContent=pg.name;
  renderPage(pg);
  try{ updateReviewBadge(); }catch(e){}
  try{ renderReconnectBanner(); }catch(e){}
  if(window.innerWidth<=900) closeSidebar();
}

function renderPage(pg){
  renderCanvas(pg);
  // Proactive coaching (frequency-capped): off-track nudge or first-visit tip
  if(!_tourQueue.length && !APP._goalsFirst){ richieMaybeProactive(pg); }
}
let _lastCoachPage=null, _lastCoachTime=0;
function maybeCoachPage(pg){
  const now=Date.now();
  // don't nag: skip if we coached this same page in the last 90s
  if(_lastCoachPage===pg.id && (now-_lastCoachTime)<90000) return;
  _lastCoachPage=pg.id; _lastCoachTime=now;
  const goal=_goals().find(g=>g.metric===pg.goalMetric && !g.completed);
  setTimeout(()=>{
    if(goal){ const p=goalProgress(goal);
      if(p.pct>=100){ richieSay(`"${goal.name}" looks complete — nice work! 🎉`); }
      else {
        // Pop a short NOTE first, then let the user decide to see the plan (Richie flies to the goal).
        const behind = !!(p.pace && !p.pace.onTrack);
        const note = behind
          ? `"${goal.name}" is ${p.pct}% done but running behind pace — want the catch-up plan?`
          : `You're ${p.pct}% toward "${goal.name}". Want your next move?`;
        const cad = behind ? 'monthly' : ['daily','weekly','monthly','quarterly'][Math.floor(Math.random()*4)];
        const detail = behind
          ? `Behind pace for ${p.pace.deadline.toLocaleDateString('en-US',{month:'short',year:'numeric'})}. ${goalCadenceNudge(goal,'monthly')}`
          : `${cad.charAt(0).toUpperCase()+cad.slice(1)} move: ${goalCadenceNudge(goal,cad)}`;
        richieShow(note, {emo: behind?'curious':'happy', actions:[
          {label:'📋 Show me →', cls:'ra-go', on:()=>richieSpotlightAt({widgetType:'goals', message:detail, emo:(behind?'curious':'happy')})},
          {label:'Not now', on:richieDismiss}
        ]});
      }
      if(sbRichie)sbRichie.do('wiggle');
    }
  }, 900);
}

/* ═══════════════ WIDGET LIBRARY ═══════════════
   Phase 2: catalog + placeholder renderers. Real engine renderers
   (Plaid data, charts, calculations) get wired in Phase 3.
   minLevel gates a widget behind a knowledge level (Pro Mode unlocks all). */
const WIDGET_CATALOG=[
  {id:'net_worth_summary',name:'Net Worth',icon:'💎',cat:'Overview',span:1,minLevel:1,desc:'Total assets minus liabilities.'},
  {id:'journey',name:'Your Journey',icon:'🏆',cat:'Overview',span:2,minLevel:1,desc:'Your level, streak, badges, and milestone progress — real-money goals, gamified.'},
  {id:'cash_summary',name:'Cash on Hand',icon:'💵',cat:'Overview',span:1,minLevel:1,desc:'Liquid balances across your cash & savings accounts.'},
  {id:'safe_spend',name:'Safe to Spend',icon:'👛',cat:'Overview',span:1,minLevel:1,desc:'The big one — how much you can safely spend today after upcoming bills, goal set-asides & a buffer.'},
  {id:'spending_month',name:"Current Spending",icon:'🛒',cat:'Overview',span:1,minLevel:1,desc:'Discretionary spending vs budget — your quick "how are we doing" marker (bills & savings excluded).'},
  {id:'income_month',name:"This Month's Income",icon:'💰',cat:'Overview',span:1,minLevel:1,desc:'Money in this month.'},
  {id:'budget_doughnut',name:'Budget by Category',icon:'🍩',cat:'Budget',span:2,minLevel:1,desc:'Two donuts side by side — spending by group and by category (stacked on mobile).'},
  {id:'bills_list',name:'Upcoming Bills',icon:'📋',cat:'Budget',span:1,minLevel:1,desc:"What's due and when."},
  {id:'bill_calendar',name:'Bill Calendar',icon:'🗓️',cat:'Budget',span:2,minLevel:1,desc:'A month view of upcoming bills & income by due date — spot heavy weeks, tap a day for detail.'},
  {id:'zero_budget',name:'Every-Dollar Budget',icon:'🧮',cat:'Budget',span:2,minLevel:2,desc:'Give every dollar a job — with live actual-vs-budgeted spending per envelope (zero-based budgeting).'},
  {id:'savings_buckets',name:'Savings Buckets',icon:'🪣',cat:'Overview',span:2,minLevel:1,desc:'Sinking funds — Reserve, Home, Family, Medical — each with its own goal and progress.'},
  // Cash Flow (read-only chart) folded into the Cash Flow Planner — same projection line, plus
  // editing. Kept out of the catalog; existing widgets migrate via WIDGET_MIGRATE above.
  {id:'pl_panel',name:'Profit & Loss',icon:'💹',cat:'Cash Flow',span:2,minLevel:1,desc:'Income, spending, net & savings rate by day/week/month.'},
  {id:'cashflow_planner',name:'Cash Flow',icon:'📅',cat:'Cash Flow',span:2,minLevel:1,desc:'Your projected running balance — see your low point before it hits, and edit bills to fix it.'},
  {id:'fund_triage',name:'Where Extra Money Goes',icon:'💸',cat:'Cash Flow',span:2,minLevel:1,desc:'Delegate your monthly surplus by priority — high-interest debt, then savings, then investing.'},
  {id:'goals',name:'Financial Goals',icon:'🎯',cat:'Overview',span:2,minLevel:1,desc:'Set goals, track progress automatically, and let Richie coach you to the finish.'},
  {id:'health_score',name:'Financial Health Score',icon:'🩺',cat:'Overview',span:2,minLevel:1,desc:'A single 0–100 score across savings rate, emergency fund, debt-to-income, credit use & high-interest debt — with Richie\'s top fix.'},
  {id:'accounts_list',name:'All Accounts',icon:'🏦',cat:'Overview',span:2,minLevel:1,desc:'Every account with balances — tap to see transactions.'},
  {id:'all_transactions',name:'All Transactions',icon:'🧾',cat:'Cash Flow',span:2,minLevel:1,desc:'Every transaction — search, categorize, and tag (paycheck, transfer, business…).'},
  {id:'recurring',name:'Subscriptions & Renewals',icon:'🔁',cat:'Cash Flow',span:2,minLevel:1,desc:'Auto-detected subscriptions & recurring bills — next renewal, price-hike alerts, flag any to cancel, monthly & yearly totals.'},
  {id:'sankey',name:'Money Flow',icon:'🔀',cat:'Cash Flow',span:2,minLevel:2,desc:'Income → category group → category, flowing left to right through your category tree.'},
  {id:'spending_hub',name:'Spending',icon:'🛍️',cat:'Cash Flow',span:2,minLevel:1,desc:'All your spending in one place — this month vs budget, the trend, top categories, and seasonal patterns, in tabs.'},
  // Top Categories, Spending Trends and Seasonal Spending are now tabs inside the Spending hub
  // (SPEND_TABS). Kept out of the catalog; existing standalone widgets migrate to spending_hub
  // above. Their render cases stay — the hub renders each tab through renderWidgetBody.
  {id:'net_worth_chart',name:'Net Worth Trend',icon:'📈',cat:'Wealth',span:2,minLevel:2,desc:'Net worth over months.'},
  {id:'investments',name:'Investments',icon:'💼',cat:'Wealth',span:2,minLevel:5,desc:'Your portfolio — positions pulled from statements, allocation, and one-tap research. (Mogul)'},
  {id:'fire_hub',name:'Wealth & FIRE',icon:'🔥',cat:'Wealth',span:2,minLevel:3,desc:'Financial-independence progress, long-term projection, and an interactive calculator — in tabs.'},
  {id:'debt_hub',name:'Debt',icon:'💳',cat:'Debt',span:2,minLevel:1,desc:'Everything you owe in one place — balances, payoff timeline, credit utilization, credit-score monitor, and 0% promos, in tabs.'},
  // Fire Drill (stress test) and Debt Payoff Lab now live as tabs inside Wealth & FIRE and Debt
  // respectively — see FIRE_TABS / DEBT_TABS. Kept out of the catalog; existing widgets migrate below.
];
const WIDGET_BY_ID=Object.fromEntries(WIDGET_CATALOG.map(w=>[w.id,w]));
function widgetUnlocked(w){ return APP.proMode || w.minLevel<=APP.level; }

/* ── Widget Wizard (step-by-step add/edit) ── */
let _ww={step:1, cat:null, widgetId:null, span:null, editUid:null};
function openWidgetDrawer(){
  _ww={step:1, cat:null, widgetId:null, span:null, editUid:null};
  gg('widgetDrawer').classList.add('open'); gg('drawerScrim').classList.add('open');
  wwRender();
}
function closeWidgetDrawer(){ gg('widgetDrawer').classList.remove('open'); gg('drawerScrim').classList.remove('open'); }
// Entry point for EDITING an existing widget (size change) — jumps straight to the size step
function openWidgetEditor(uid){
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(!pg) return;
  const w=pg.widgets.find(x=>x.uid===uid); if(!w) return;
  openStudio(w.type, uid);
}
function wwSteps(){ return ['Pick a category','Pick a widget']; }
function wwRender(){
  const steps=wwSteps(); const total=steps.length;
  const dotsWrap=gg('wwSteps');
  dotsWrap.innerHTML=steps.map((_,i)=>`<div class="ww-step-dot${(i+1)===_ww.step?' active':(i+1)<_ww.step?' done':''}"></div>`).join('');
  gg('wwBack').style.display=(_ww.step>1)?'flex':'none';
  gg('wdSubtitle').textContent=`Step ${_ww.step} of ${total} · ${steps[_ww.step-1]}`;
  gg('wwTitle').textContent='Add a widget';
  const list=gg('wdList');
  if(_ww.step===1) list.innerHTML=wwCategoryStep();
  else if(_ww.step===2) list.innerHTML=wwWidgetStep();
}
function wwCategoryStep(){
  const cats={};
  WIDGET_CATALOG.forEach(w=>{ (cats[w.cat]=cats[w.cat]||[]).push(w); });
  const icons={'Overview':'📊','Budget':'🎯','Cash Flow':'🌊','Wealth':'📈','Debt':'🚨','Playground':'🎮'};
  const intents={'Overview':'See where you stand','Budget':'Plan your spending','Cash Flow':'Look ahead & find extra','Wealth':'Grow your net worth','Debt':'Pay down what you owe','Playground':'Stress-test scenarios'};
  return Object.keys(cats).map(cat=>{
    const items=cats[cat]; const unlocked=items.filter(w=>widgetUnlocked(w)).length;
    const intent=intents[cat]?`${intents[cat]} · `:'';
    return `<div class="ww-card" onclick="wwPickCat('${cat.replace(/'/g,"\\'")}')">
      <div class="ww-card-icon">${icons[cat]||'🧩'}</div>
      <div style="flex:1;min-width:0"><div class="ww-card-name">${cat}</div>
      <div class="ww-card-desc">${intent}${items.length} widget${items.length!==1?'s':''}${unlocked<items.length?` · ${unlocked} unlocked`:''}</div></div>
      <div class="ww-card-arrow">→</div></div>`;
  }).join('');
}
function wwPickCat(cat){ _ww.cat=cat; _ww.step=2; wwRender(); }
function wwWidgetStep(){
  const items=WIDGET_CATALOG.filter(w=>w.cat===_ww.cat);
  return items.map(w=>{
    const locked=!widgetUnlocked(w);
    return `<div class="ww-card${locked?' locked':''}" onclick="${locked?`wwLocked(${w.minLevel})`:`wwPickWidget('${w.id}')`}">
      <div class="ww-card-icon">${w.icon}</div>
      <div style="flex:1;min-width:0"><div class="ww-card-name">${w.name}${locked?' 🔒':''}</div>
      <div class="ww-card-desc">${locked?'Unlocks at level '+w.minLevel+' (or Pro Mode)':w.desc}</div></div>
      <div class="ww-card-arrow">${locked?'🔒':'→'}</div></div>`;
  }).join('');
}
function wwLocked(lvl){ richieSay(`That one unlocks at level ${lvl}. Keep hitting goals \u2014 or flip on Pro Mode in Settings.`); }
function wwPickWidget(wid){
  // hand off to the full Widget Studio for detailed config
  closeWidgetDrawer();
  openStudio(wid, null);
}
function wwPrev(){ if(_ww.step>1){ _ww.step--; wwRender(); } }

/* ═══════════════════════════════════════════════════════════════
   WIDGET STUDIO — full customization (data query, display, layout)
═══════════════════════════════════════════════════════════════ */
let _ws=null;
const WS_STEPS=['Data & query','Display','Size & layout','Confirm'];
function openStudio(type, editUid){
  const def=WIDGET_BY_ID[type]; if(!def) return;
  let base;
  if(editUid){ const pg=APP.pages.find(p=>p.id===APP.activePage); const w=pg&&pg.widgets.find(x=>x.uid===editUid); base=w?JSON.parse(JSON.stringify(w)):null; }
  if(!base){ base={uid:editUid||('w'+Date.now()+Math.floor(Math.random()*999)), type:type, span:def.span||1, tf:'30d', config:{}}; }
  if(!base.config) base.config={};
  _ws={ step:1, type:type, editUid:editUid, w:base };
  gg('widgetStudio').style.display='flex';
  wsRender();
}
function closeStudio(){ gg('widgetStudio').style.display='none'; _ws=null; }
function wsApplicableSteps(){
  // Some widgets (interactive ones) only get title/size — skip data/display query
  const dataCapable=['spending_month','income_month','top_categories','budget_doughnut','sankey','net_worth_chart','debt_summary','debt_payoff','bills_list','cash_summary','net_worth_summary','zero_budget','fire_progress'].includes(_ws.type);
  return dataCapable?WS_STEPS:['Display','Size & layout','Confirm'];
}
function wsRender(){
  const steps=wsApplicableSteps(); const cur=_ws.step;
  gg('wsRail').innerHTML=steps.map((s,i)=>`<div class="ws-railitem${(i+1)===cur?' active':(i+1)<cur?' done':''}"><span class="ws-railnum">${i+1}</span>${s}</div>`).join('');
  gg('wsTitle').textContent=(_ws.editUid?'Edit: ':'New: ')+(WIDGET_BY_ID[_ws.type].name);
  gg('wsSub').textContent=`Step ${cur} of ${steps.length} · ${steps[cur-1]}`;
  gg('wsPrevBtn').style.visibility=cur>1?'visible':'hidden';
  gg('wsNextBtn').textContent=(cur===steps.length)?(_ws.editUid?'Save changes ✓':'Add to page ✓'):'Next →';
  const panel=gg('wsPanel'); const stepName=steps[cur-1];
  if(stepName==='Data & query') panel.innerHTML=wsDataStep();
  else if(stepName==='Display') panel.innerHTML=wsDisplayStep();
  else if(stepName==='Size & layout') panel.innerHTML=wsLayoutStep();
  else if(stepName==='Confirm') panel.innerHTML=wsConfirmStep();
  wsRenderPreview();
}
function wsCfg(){ _ws.w.config=_ws.w.config||{}; return _ws.w.config; }
function wsSet(key,val){ wsCfg()[key]=val; wsRenderPreview(); }
function wsSetTf(key){ _ws.w.tf=key; wsCfg().tf=key; wsRender(); }
function wsRenderPreview(){
  const stage=gg('wsPreview'); if(!stage) return;
  const def=WIDGET_BY_ID[_ws.type];
  let body; try{ body=renderWidgetBody(_ws.w); }catch(e){ body='<div class="wph"><div class="wph-sub">preview error</div></div>'; }
  const cfg=widgetConfig(_ws.w);
  stage.innerHTML=`<div class="canvas-widget-card ${_ws.w.span===2?'span-2':''}" style="max-width:${_ws.w.span===2?'100%':'280px'};margin:0 auto">
    <div class="canvas-widget-header"><div class="cwh-left"><span>${def.icon}</span><span class="cwh-title">${esc(cfg.title||def.name)}</span></div></div>
    <div class="canvas-widget-body" style="${cfg.height==='tall'?'min-height:220px':''}">${body}</div>
  </div>`;
  // mount chart-type previews
  setTimeout(()=>{ try{ if(['net_worth_chart','retirement_proj','sankey','fire_calc'].includes(_ws.type)) buildWidgetChart(_ws.w,'cv_'+_ws.w.uid); }catch(e){} },30);
}
// ── Step: Data & query ──
function wsDataStep(){
  const c=widgetConfig(_ws.w);
  const tfChips=TIMEFRAMES.map(t=>`<button class="ws-chip${(_ws.w.tf||'30d')===t.key?' active':''}" onclick="wsSetTf('${t.key}')">${t.label}</button>`).join('');
  const srcOpts=[['auto','Auto','Live data if connected, else sample'],['live','Live (Plaid)','Only your connected accounts'],['manual','Manual','Your entered bills & income'],['sample','Sample','Demo numbers']];
  const srcHtml=srcOpts.map(o=>`<div class="ws-opt${c.source===o[0]?' selected':''}" onclick="wsSet('source','${o[0]}');wsRender()"><div class="ws-opt-name">${o[1]}</div><div class="ws-opt-desc">${o[2]}</div></div>`).join('');
  // query builder — categories (for spend/category widgets) and accounts
  const isCat=['spending_month','top_categories','budget_doughnut','sankey'].includes(_ws.type);
  let queryHtml='';
  if(isCat){
    const labels=allCategoryLabels(); const sel=(c.query.categories||[]);
    queryHtml=`<div class="ws-section-label">Include categories <span class="ws-hint">(none = all)</span></div>
      <div class="ws-chipwrap">${labels.map(l=>`<button class="ws-chip${sel.includes(l)?' active':''}" onclick="wsToggleQuery('categories','${l.replace(/'/g,"\\'")}')">${l}</button>`).join('')}</div>
      <div class="ws-section-label">Amount filter</div>
      <div class="ws-inline"><label>Min $<input type="number" value="${c.query.minAmt||''}" oninput="wsQueryNum('minAmt',this.value)"></label>
      <label>Max $<input type="number" value="${c.query.maxAmt||''}" oninput="wsQueryNum('maxAmt',this.value)"></label></div>`;
  } else {
    const accts=allAccountNames(); const sel=(c.query.accounts||[]);
    queryHtml=`<div class="ws-section-label">Include accounts <span class="ws-hint">(none = all)</span></div>
      <div class="ws-chipwrap">${accts.map(a=>`<button class="ws-chip${sel.includes(a)?' active':''}" onclick="wsToggleQuery('accounts','${a.replace(/'/g,"\\'")}')">${a}</button>`).join('')}</div>`;
  }
  const topN=['top_categories','budget_doughnut','sankey'].includes(_ws.type)?`<div class="ws-section-label">Show top <b>${c.topN}</b> items</div><input type="range" min="2" max="12" value="${c.topN}" style="width:100%;accent-color:var(--green)" oninput="wsSet('topN',+this.value);gg('wsTopnLbl')&&(gg('wsTopnLbl').textContent=this.value)">`:'';
  return `<div class="ws-section-label">Date range</div><div class="ws-chipwrap">${tfChips}</div>
    <div class="ws-section-label">Data source</div>${srcHtml}
    ${topN}
    ${queryHtml}`;
}
function wsToggleQuery(kind,val){
  const q=wsCfg().query=wsCfg().query||{categories:[],accounts:[]};
  q[kind]=q[kind]||[];
  const i=q[kind].indexOf(val);
  if(i>=0) q[kind].splice(i,1); else q[kind].push(val);
  wsRender();
}
function wsQueryNum(key,val){ const q=wsCfg().query=wsCfg().query||{}; q[key]=val===''?null:+val; wsRenderPreview(); }
// ── Step: Display ──
function wsDisplayStep(){
  const c=widgetConfig(_ws.w);
  const styles=[['auto','Auto'],['list','List'],['bar','Bars'],['doughnut','Doughnut'],['pie','Pie']];
  const isCat=['top_categories','budget_doughnut'].includes(_ws.type);
  const isChart=['top_categories','budget_doughnut','spending_month','income_month','cash_summary','debt_summary','net_worth_summary'].includes(_ws.type);
  const accents=['','#2ecc8a','#5b8def','#f0a540','#f05c5c','#a78bfa','#38bdf8','#f472b6','#fbbf24','#34d399'];
  const seg=(label,key,opts,fn)=>`<div class="ws-section-label">${label}</div><div class="ws-seg">${opts.map(o=>`<button class="ws-segbtn${(fn?fn(c):c[key])===o[0]?' active':''}" onclick="wsSet('${key}','${o[0]}');wsRender()">${o[1]}</button>`).join('')}</div>`;
  let html=`<div class="ws-section-label">Custom title <span class="ws-hint">(blank = default)</span></div>
    <input type="text" class="ws-input" value="${esc(c.title||'')}" placeholder="${WIDGET_BY_ID[_ws.type].name}" oninput="wsSet('title',this.value)">
    <div class="ws-section-label">Subtitle <span class="ws-hint">(blank = default)</span></div>
    <input type="text" class="ws-input" value="${(c.subtitle||'').replace(/"/g,'&quot;')}" placeholder="optional caption" oninput="wsSet('subtitle',this.value)">
    <div class="ws-section-label">Icon <span class="ws-hint">(paste an emoji, blank = default)</span></div>
    <input type="text" class="ws-input" value="${(c.icon||'').replace(/"/g,'&quot;')}" placeholder="${WIDGET_BY_ID[_ws.type].icon}" maxlength="2" oninput="wsSet('icon',this.value)">`;
  // number format + decimals
  html+=seg('Number format','numFormat',[['k','$1.2K'],['full','$1,234'],['pct','%'],['hidden','Hide']]);
  if(c.numFormat==='full') html+=seg('Decimal places','decimals',[['0','0'],['1','1'],['2','2']],(cc)=>String(cc.decimals));
  if(isCat){
    html+=seg('Chart style','chartStyle',styles);
    if(c.chartStyle==='doughnut') html+=seg('Donut thickness','donutThickness',[['thin','Thin'],['thick','Thick'],['full','Full (pie)']]);
    html+=seg('Color palette','palette',[['category','Category'],['mono','Mono'],['warm','Warm'],['cool','Cool'],['rainbow','Rainbow']]);
    html+=`<div class="ws-section-label">Show on each item</div>
      <div class="ws-checkrow">
        <button class="ws-check${c.showValues?' on':''}" onclick="wsToggle('showValues');wsRender()">${c.showValues?'✓':''} Amounts</button>
        <button class="ws-check${c.showPct?' on':''}" onclick="wsToggle('showPct');wsRender()">${c.showPct?'✓':''} Percent</button>
      </div>`;
    html+=seg('Sort by','sortBy',[['value','Value'],['name','Name'],['none','As-is']]);
    if(c.sortBy!=='none') html+=seg('Direction','sortDir',[['desc','High→Low'],['asc','Low→High']]);
    // legend with all positions
    html+=`<div class="ws-section-label">Legend</div>
      <div class="ws-seg">${[['bottom','Bottom'],['top','Top'],['left','Left'],['right','Right'],['none','Off']].map(p=>`<button class="ws-segbtn${(c.legend===false?'none':c.legendPos)===p[0]?' active':''}" onclick="wsSetLegend('${p[0]}');wsRender()">${p[1]}</button>`).join('')}</div>`;
  }
  html+=`<div class="ws-section-label">Accent color</div>
    <div class="ws-swatches">${accents.map(a=>`<button class="ws-swatch${(c.accent||'')===a?' active':''}" style="background:${a||'transparent'};${a?'':'border:1px dashed var(--border2)'}" onclick="wsSet('accent','${a}');wsRender()" title="${a||'Default'}">${a?'':'A'}</button>`).join('')}</div>`;
  return html;
}
function wsToggle(key){ const c=wsCfg(); c[key]=!c[key]; wsRenderPreview(); }
function wsSetLegend(pos){ const c=wsCfg(); if(pos==='none'){ c.legend=false; } else { c.legend=true; c.legendPos=pos; } wsRenderPreview(); }
// ── Step: Size & layout ──
function wsLayoutStep(){
  const c=widgetConfig(_ws.w);
  const seg=(label,key,opts)=>`<div class="ws-section-label">${label}</div><div class="ws-seg">${opts.map(o=>`<button class="ws-segbtn${c[key]===o[0]?' active':''}" onclick="wsSet('${key}','${o[0]}');wsRender()">${o[1]}</button>`).join('')}</div>`;
  return `<div class="ws-section-label">Width</div>
    <div class="ww-size-grid">
      <div class="ww-size-opt${_ws.w.span===1?' selected':''}" onclick="wsSetSpan(1)"><div class="ww-size-vis"><div class="ww-size-box half"></div></div><div class="ww-size-name">Half width</div></div>
      <div class="ww-size-opt${_ws.w.span===2?' selected':''}" onclick="wsSetSpan(2)"><div class="ww-size-vis"><div class="ww-size-box full"></div></div><div class="ww-size-name">Full width</div></div>
    </div>
    ${seg('Height','height',[['short','Short'],['auto','Auto'],['tall','Tall']])}
    ${seg('Row density','density',[['compact','Compact'],['normal','Normal'],['roomy','Roomy']])}
    ${seg('Content alignment','align',[['left','Left'],['center','Center'],['right','Right']])}
    ${seg('Card style','cardStyle',[['default','Default'],['flat','Flat'],['bordered','Bordered'],['gradient','Gradient']])}`;
}
function wsSetSpan(s){ _ws.w.span=s; wsRender(); }
// ── Step: Confirm ──
function wsConfirmStep(){
  const c=widgetConfig(_ws.w); const def=WIDGET_BY_ID[_ws.type];
  const rows=[
    ['Widget',def.name],['Title',c.title||'(default)'],['Date range',tfLabel(_ws.w.tf||'30d')],
    ['Source',c.source],['Top N',['top_categories','budget_doughnut','sankey'].includes(_ws.type)?c.topN:'—'],
    ['Categories',(c.query.categories&&c.query.categories.length)?c.query.categories.join(', '):'all'],
    ['Accounts',(c.query.accounts&&c.query.accounts.length)?c.query.accounts.join(', '):'all'],
    ['Number format',c.numFormat],['Chart style',c.chartStyle],['Legend',c.legend===false?'off':c.legendPos],
    ['Accent',c.accent||'default'],['Width',_ws.w.span===2?'full':'half'],['Height',c.height],['Align',c.align],
  ];
  return `<div class="ws-section-label">Review your widget</div>
    <div class="ws-summary">${rows.map(r=>`<div class="ws-sumrow"><span>${r[0]}</span><b>${esc(String(r[1]))}</b></div>`).join('')}</div>
    <p class="ww-card-desc" style="margin-top:12px">Looks good? ${_ws.editUid?'Save your changes':'Add it to the page'} with the button below.</p>`;
}
function wsPrev(){ if(_ws.step>1){ _ws.step--; wsRender(); } }
function wsNext(){
  const steps=wsApplicableSteps();
  if(_ws.step<steps.length){ _ws.step++; wsRender(); return; }
  wsCommit();
}
function wsCommit(){
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(!pg){ closeStudio(); return; }
  const typeName=WIDGET_BY_ID[_ws.type]?WIDGET_BY_ID[_ws.type].name:'Widget';
  if(_ws.editUid){
    const idx=pg.widgets.findIndex(x=>x.uid===_ws.editUid);
    if(idx>=0) pg.widgets[idx]=_ws.w;
    saveState(); renderCanvas(pg); closeStudio();
    if(sbRichie)sbRichie.do('nod');
    richieSay(`Updated ${typeName}! Your changes are live.`);
    return;
  }
  pg.widgets.push(_ws.w);
  saveState(); renderCanvas(pg);
  awardXp(3,'Widget added!');
  closeStudio();
  if(sbRichie)sbRichie.do('bounce');
  richieSay(`Added ${typeName}! Tap the ✎ icon on any widget to customize it again.`);
}
function removeWidget(uid){
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(!pg) return;
  const w=pg.widgets.find(x=>x.uid===uid); const def=w?WIDGET_BY_ID[w.type]:null;
  if(def && !confirm(`Remove "${def.name}" from this page?`)) return;
  pg.widgets=pg.widgets.filter(w=>w.uid!==uid); saveState(); renderCanvas(pg);
}
function toggleWidgetSpan(uid){ openWidgetEditor(uid); }
// Time-relevant widgets that flex with the selected window
const WIDGET_HAS_TF=['spending_month','income_month','top_categories','budget_doughnut','sankey'];
function widgetHasTimeframe(type){ return WIDGET_HAS_TF.includes(type); }
function setWidgetTf(uid,key){
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(!pg) return;
  const w=pg.widgets.find(x=>x.uid===uid); if(!w) return;
  w.tf=key; saveState();
  // re-render just this card's chips + body for snappy feedback
  renderCanvas(pg);
}
// Resolve a widget's window in days (default 30)
function wDays(w){ return tfDays(w&&w.tf||'30d'); }

// ── Blank start → Richie builds your app when a bank connects (first accomplishment) ──
function buildGateHTML(){
  const ic=(RICHIE_PERSONAS[APP.persona]&&RICHIE_PERSONAS[APP.persona].icon)||'💰';
  const goals=(APP.goals||[]).map(g=>g.icon+' '+g.name).join('  ·  ');
  // Returning user (banks already linked or a dashboard exists on the server) should NOT see
  // the "Connect my bank" first-run prompt while their dashboard restores — show a loading
  // screen instead. richieBuildApp keeps retrying the restore underneath it.
  const returning=(dataLoaded && (allAccts||[]).length>0) || !!APP.plaidConnected || _sawWidgets;
  if(returning){
    return `<div class="canvas-page"><div class="bgate">
      <div class="bgate-bag" style="animation:richie-float 3s ease-in-out infinite">${ic}</div>
      <div class="bgate-title">Loading your dashboard…</div>
      <div class="bgate-sub">Fetching your latest saved layout. This only takes a moment.</div>
      <div class="xp-bar" style="max-width:220px;margin:18px auto 0"><div class="xp-fill" style="width:60%;animation:richie-pulse-fab 1.4s ease-in-out infinite"></div></div>
    </div></div>`;
  }
  return `<div class="canvas-page"><div class="bgate">
    <div class="bgate-bag">${ic}</div>
    <div class="bgate-title">Let's build your app</div>
    <div class="bgate-sub">Connect your bank and I'll build your whole dashboard around your real money${goals?' and your goals':''} — that's your first win. 🎉</div>
    ${goals?`<div class="bgate-goals">${esc(goals)}</div>`:''}
    <button class="bgate-cta" onclick="openLinkHandler()">🔗 Connect my bank</button>
    <button class="bgate-alt" onclick="docUploadPick()">📄 Or upload a statement / bill</button>
    <button class="bgate-alt" onclick="gg('csvFileInput').click()">📥 No bank? Import a transactions CSV</button>
    <button class="bgate-skip" onclick="richieBuildApp({sample:true})">Explore with sample data first</button>
    <div class="bgate-note">🔒 Bank-level encryption · read-only · disconnect anytime</div>
  </div></div>`;
}
function _stateHasWidgets(app){
  if(!app) return false;
  const has=pp=>(pp||[]).some(p=>p&&p.widgets&&p.widgets.length>0);
  if(has(app.pages)) return true;
  const lays=app.layouts||{}; return Object.keys(lays).some(k=>has((lays[k]||{}).pages));
}
async function richieBuildApp(opts){
  opts=opts||{};
  // A rebuild RESEEDS pages — it must NEVER clobber a dashboard that already exists. This
  // fires whenever _awaitingBuild is true, which happens after a COLD-SERVER restore failed
  // (gate seeded locally) even though the real dashboard is safe on the server. Guard both:
  if(_stateHasWidgets(APP)){ APP._awaitingBuild=false; saveState(); return; }   // local already built
  if(!opts.sample){
    let sd=null;
    try{ sd=await _fetchJSON('/api/state'); }catch(e){ sd=null; }   // retry the restore now the server may be warm
    if(sd && sd.state && _stateHasWidgets(sd.state.app)){
      syncApplyToLS(sd.state); if(sd.state._ts) LS.setItem('mdf_sync_ts', String(sd.state._ts));
      loadState(); renderShell(); if(APP.activePage&&APP.activePage!=='__settings__') switchPage(APP.activePage); else if(APP.pages[0]) switchPage(APP.pages[0].id);
      return;   // restored the real dashboard — do NOT reseed over it
    }
    // CRITICAL: sd===null means the server was UNREACHABLE (cold/asleep), NOT that it's empty
    // (an empty server returns {state:null}, which is not null). Reseeding here would build a
    // fresh default and push its 13 widgets over the real dashboard the server still holds —
    // the "edits don't cache" bug. Wait and retry the restore instead of clobbering.
    if(sd===null){
      _syncSetStatus('retry');
      setTimeout(()=>{ try{ if(APP._awaitingBuild) richieBuildApp(); }catch(e){} }, 8000);
      return;
    }
  }
  let setup=null; try{ setup=JSON.parse(LS.getItem('richie_setup')||'null'); }catch(e){} setup=setup||{};
  const cg=(setup.chosenGoals&&setup.chosenGoals.length)?setup.chosenGoals:((setupConfig&&setupConfig.chosenGoals)||[]);
  if(!APP.goals||!APP.goals.length){
    APP.goals=[];
    cg.forEach(c=>{ const m=GOAL_METRICS[c.metric]; const target=c.target!=null?c.target:(c.auto?goalAutoTarget(c.auto):0);
      APP.goals.push({ id:'g'+Date.now()+Math.floor(Math.random()*9999), name:c.name, metric:c.metric, target, icon:c.icon, start:(c.metric!=='custom'&&m)?m.get():0, current:0, created:Date.now(), completed:false, presetKey:c.key }); });
  }
  if(cg.length){ APP.pages=seedPagesFromGoals(cg); APP._goalsFirst=true; APP._coachQueue=APP.pages.filter(p=>p.goalMetric).map(p=>p.id); }
  else { APP.pages=seedPages((setup.bundle)||'overview'); }
  APP._awaitingBuild=false;
  try{ migratePages(APP.pages); }catch(e){}   // fold seeded debt/FIRE widgets into hubs + dedupe
  APP.activePage=APP.pages[0]?APP.pages[0].id:null;
  saveState();
  // The freshly built world is the most losable state in the app (a storage-clearing
  // browser + a nap-prone server ate it repeatedly) — push it NOW, not in 1.8s.
  try{ _syncPushNow(); }catch(e){}
  try{ gamiInit(); }catch(e){}                 // drops in the Journey widget + checks first achievements
  renderShell();
  if(APP.activePage) switchPage(APP.activePage);
  setTimeout(()=>{ try{ gamiCelebrate({icon:'🏗️', title:'Your first win! 🎉', name:'Richie built your app', desc:'Your dashboard is now wired to your real money and your goals. Let\u2019s get after it.', share:'Richie just built my whole finance dashboard around my goals! 💰'}); }catch(e){} }, 480);
  if(APP._goalsFirst){ setTimeout(()=>{ try{ startGoalWalkthrough(); }catch(e){} }, 2600); }
}
function renderCanvas(pg){
  gg('tbIcon').textContent=pg.icon; gg('tbTitle').textContent=pg.name;
  const content=gg('page-content');
  if(APP._awaitingBuild){ content.innerHTML=buildGateHTML(); return; }
  if(!pg.widgets||pg.widgets.length===0){
    content.innerHTML=`<div class="canvas-page"><div class="canvas-grid"><div class="canvas-empty">
      <div class="canvas-empty-icon" style="background:${pg.color}22;color:${pg.color}">${pg.icon}</div>
      <h2 style="margin:14px 0 6px;font-size:20px">${esc(pg.name)}</h2>
      <p style="color:var(--muted);font-size:13.5px;max-width:380px;margin:0 auto 18px;line-height:1.6">This page is empty. Add widgets from the library to build it out.</p>
      <button class="add-widget-fab" onclick="openWidgetDrawer()">+ Add a widget</button>
    </div></div></div>`;
    return;
  }
  const cards=pg.widgets.map((w,idx)=>{
    const def=WIDGET_BY_ID[w.type]||{name:'Widget',icon:'\u2753'};
    let body;
    try{ body=renderWidgetBody(w); }
    catch(e){ console.warn('widget '+w.type+' failed:',e.message); body='<div class="wph"><div class="wph-sub">Couldn\'t load this widget.</div></div>'; }
    const hasDetail=widgetHasDetail(w.type) && widgetUnlocked(def);
    const dDays=widgetHasTimeframe(w.type)?wDays(w):30;
    const detailBtn=hasDetail?`<button class="cwh-btn cwh-info" onclick="event.stopPropagation();openWidgetDetail('${w.type}',${dDays})" title="View details">\u24D8</button>`:'';
    const bodyClick='';  // drill-down opens ONLY from the ⓘ info icon, never the body
    const hasTf=widgetHasTimeframe(w.type) && widgetUnlocked(def);
    const tfCur=w.tf||'30d';
    const tfRow=hasTf?`<div class="cwt-row">${TIMEFRAMES.map(t=>`<button class="cwt-chip${tfCur===t.key?' active':''}" onclick="event.stopPropagation();setWidgetTf('${w.uid}','${t.key}')">${t.label}</button>`).join('')}</div>`:'';
    const _cfg=widgetConfig(w);
    const _icon=_cfg.icon||def.icon;
    const _subtitle=_cfg.subtitle?`<div class="cwh-subtitle">${esc(_cfg.subtitle)}</div>`:'';
    const _cardCls=_cfg.cardStyle&&_cfg.cardStyle!=='default'?' cs-'+_cfg.cardStyle:'';
    const _bodyCls=_cfg.height==='tall'?' cwb-tall':_cfg.height==='short'?' cwb-short':'';
    return `<div class="canvas-widget-card${w.span===2?' span-2':''}${hasDetail?' has-detail':''}${_cardCls}" data-uid="${w.uid}" data-idx="${idx}">
      <div class="canvas-widget-header">
        <div class="cwh-left"><span class="cwh-drag" title="Drag to move this widget">\u283F</span><span>${_icon}</span><div><span class="cwh-title">${esc((w.config&&w.config.title)||def.name)}</span>${_subtitle}</div></div>
        <div class="cwh-actions">
          ${detailBtn}
          <button class="cwh-btn" onclick="event.stopPropagation();toggleWidgetSpan('${w.uid}')" title="Edit widget">\u270E</button>
          <button class="cwh-btn danger" onclick="event.stopPropagation();removeWidget('${w.uid}')" title="Remove">\u2715</button>
        </div>
      </div>
      ${tfRow}
      <div class="canvas-widget-body${_bodyCls}"${bodyClick}>${body}</div>
    </div>`;
  }).join('');
  content.innerHTML=`<div class="canvas-page">
    <div class="canvas-grid" id="canvasGrid">${cards}</div>
    <div style="display:flex;justify-content:center;margin-top:18px">
      <button class="add-widget-fab" onclick="openWidgetDrawer()">+ Add widget</button>
    </div>
  </div>`;
  try{ wireDragDrop(); }catch(e){ console.warn('wireDragDrop:',e.message); }
  try{ mountWidgetCharts(pg); }catch(e){ console.warn('mountWidgetCharts:',e.message); }
}

/* After the canvas HTML is in the DOM, instantiate any Chart.js widgets. */
function mountWidgetCharts(pg){
  // Initialize interactive (non-Chart) widgets first
  (pg.widgets||[]).forEach(w=>{
    try{
      if(w.type==='fire_drill'){ fdSetScenario(_fd.scenario||'job'); }
      if(w.type==='debt_planner'){ dpRecalc(); dpRenderOrder(); }
      if(w.type==='pl_panel'){ plMount(w); }
      if(w.type==='cashflow_planner'){ cfpMount(w); }
      if(w.type==='cashflow_chart'){ cfcMount(w); }
      if(w.type==='accounts_list'){ acctMount(w); }
      if(w.type==='all_transactions'){ txnFeedMount(w); }
      if(w.type==='debt_hub'){ debtHubMount(w); }
      if(w.type==='fire_hub'){ fireHubMount(w); }
      if(w.type==='spending_hub'){ spendHubMount(w); }
    }catch(e){ /* ignore */ }
  });
  if(typeof Chart==='undefined') return;
  (pg.widgets||[]).forEach(w=>{
    const cid='cv_'+w.uid;
    if(!gg(cid)) return;
    try{ buildWidgetChart(w, cid); }catch(e){ /* ignore individual chart errors */ }
  });
}
function buildWidgetChart(w, cid){
  const live=dataLoaded;
  if(w.type==='sankey'){ buildSankey(cid, wDays(w)); return; }
  if(w.type==='fire_calc'){ fireRefresh(); return; }
  if(w.type==='net_worth_chart'){
    // Real history if we have it; otherwise a gentle ramp toward current net worth
    let labels, vals;
    const hist=(typeof nwHistMonthly==='function')?nwHistMonthly(12):[];
    if(hist && hist.length>=2){ labels=hist.map(h=>h.label); vals=hist.map(h=>Math.round(h.v)); }
    else { const cur=live?engNetBalance()+engNWAssets()-engNWLiab():engNetWorth(); const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; labels=months; vals=months.map((_,i)=>Math.round(cur*(0.86+0.14*(i/(months.length-1))))); }
    buildChartWidget(cid,'line',labels,vals,'#5b8def',{fill:true,tension:0.35,
      datasets:[{data:vals,borderColor:'#5b8def',backgroundColor:'rgba(91,141,239,0.12)',fill:true,tension:0.35,pointRadius:0,borderWidth:2}]});
  } else if(w.type==='retirement_proj'){
    // Same live-linked model as the calculator tab — saved/contrib track real data while linked.
    const proj=fireProject(fireEffective());
    buildChartWidget(cid,'line',proj.labels,proj.bals,'#f0a540',{datasets:[{data:proj.bals,borderColor:'#f0a540',backgroundColor:'rgba(240,165,64,0.12)',fill:true,tension:0.3,pointRadius:0,borderWidth:2}]});
  }
}

/* Sankey money-flow (ported, per-widget canvas) */
/* ── Category editor (ported, simplified for sandbox) ── */
function saveUserCategories(cats){ try{ LS.setItem('mdf_categories',JSON.stringify(cats)); }catch(e){} }
let _catEdit=null;
function openCatEditor(){
  _catEdit=getUserCategories().map(c=>({...c}));
  gg('catEditorModal').style.display='flex';
  renderCatEditor();
}
function closeCatEditor(){ gg('catEditorModal').style.display='none'; }
function renderCatEditor(){
  const body=gg('catEditorBody'); if(!body) return;
  const groups=_catEdit.filter(c=>c.group);
  const ungrouped=_catEdit.filter(c=>!c.group&&!c.parent);
  let html='';
  const rowHtml=(c,kind)=>{ // kind: 'group' | 'child' | 'free'
    const i=_catEdit.indexOf(c);
    const draggable = kind!=='group';
    return `<div class="ce-row${kind==='group'?' ce-grouprow':''}${kind==='child'?' ce-child':''}" data-i="${i}" data-id="${esc(c.id)}" data-grp="${kind==='group'?1:0}"${draggable?' draggable="true"':''}>
      ${draggable?'<span class="ce-grip" title="Drag to move">\u283F</span>':'<span class="ce-grip ce-grip-folder">\uD83D\uDCC1</span>'}
      <input type="color" value="${c.color||'#888888'}" onchange="catEditField(${i},'color',this.value)" class="ce-color">
      ${kind==='group'?'<span class="ce-grp">GROUP</span>':''}
      <input type="text" value="${esc(c.label)}" onchange="catEditField(${i},'label',this.value)" class="ce-label">
      <button class="ce-del" onclick="catEditDelete(${i})" title="Delete">\u2715</button>
    </div>`;
  };
  groups.forEach(g=>{
    html+=rowHtml(g,'group');
    html+=`<div class="ce-groupzone" data-id="${esc(g.id)}">`;
    const kids=_catEdit.filter(ch=>ch.parent===g.id);
    html+= kids.length?kids.map(ch=>rowHtml(ch,'child')).join(''):'<div class="ce-empty">drop a category here</div>';
    html+=`</div>`;
  });
  html+=`<div class="ce-roothead">No group (top level)</div><div class="ce-groupzone ce-rootzone" data-root="1">`;
  html+= ungrouped.length?ungrouped.map(c=>rowHtml(c,'free')).join(''):'<div class="ce-empty">drop here to remove from a group</div>';
  html+=`</div>`;
  body.innerHTML=html;
  wireCatDrag();
}
let _catDragId=null;
function wireCatDrag(){
  const body=gg('catEditorBody'); if(!body) return;
  body.querySelectorAll('.ce-row[draggable="true"]').forEach(row=>{
    row.addEventListener('dragstart',e=>{ _catDragId=row.dataset.id; row.classList.add('ce-dragging'); e.dataTransfer.effectAllowed='move'; e.stopPropagation(); });
    row.addEventListener('dragend',()=>{ _catDragId=null; body.querySelectorAll('.ce-dragging,.ce-dropok').forEach(x=>x.classList.remove('ce-dragging','ce-dropok')); });
  });
  // group zones (and the root zone) accept drops
  body.querySelectorAll('.ce-groupzone').forEach(zone=>{
    zone.addEventListener('dragover',e=>{ if(!_catDragId)return; e.preventDefault(); zone.classList.add('ce-dropok'); });
    zone.addEventListener('dragleave',()=>zone.classList.remove('ce-dropok'));
    zone.addEventListener('drop',e=>{ if(!_catDragId)return; e.preventDefault(); zone.classList.remove('ce-dropok');
      const cat=_catEdit.find(c=>c.id===_catDragId); if(!cat||cat.group) return;
      if(zone.dataset.root){ delete cat.parent; }
      else { const gid=zone.dataset.id; if(cat.id!==gid){ cat.parent=gid; delete cat.group; } }
      renderCatEditor();
    });
  });
}
function catEditField(i,field,val){ if(_catEdit[i]){ _catEdit[i][field]=val; } }
function catEditDelete(i){ if(_catEdit[i]&&!confirm('Delete "'+_catEdit[i].label+'"?'))return;
  const removed=_catEdit[i]; if(removed&&removed.group){ _catEdit.forEach(c=>{ if(c.parent===removed.id) delete c.parent; }); }
  _catEdit.splice(i,1); renderCatEditor(); }
function catEditAdd(){ _catEdit.push({id:'custom_'+Date.now(),label:'New Category',color:'#'+Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'),plaid:[]}); renderCatEditor(); }
function catEditAddGroup(){ _catEdit.push({id:'grp_'+Date.now(),label:'New Group',color:'#'+Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'),group:true}); renderCatEditor(); }
function catEditSave(){
  saveUserCategories(_catEdit);
  closeCatEditor();
  showToast('Categories saved','success');
  // re-render active page so category colors/labels update everywhere
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg&&APP.activePage!=='__settings__') renderCanvas(pg);
  if(sbRichie)sbRichie.do('bounce');
}
function catEditReset(){ if(!confirm('Reset all categories to defaults?'))return; _catEdit=DEFAULT_CATEGORIES.map(c=>({...c})); renderCatEditor(); }

/* ── FIRE / retirement model + interactive calculator widget ── */
const FIRE_DEFAULTS={age:42,ret:65,saved:45000,contrib:1200,rate:7,inf:3};
let _fireState=null;
function fireState(){
  if(_fireState) return _fireState;
  try{ const s=JSON.parse(LS.getItem('mdf_fire')); if(s){ _fireState=s; return s; } }catch(e){}
  _fireState=Object.assign({}, FIRE_DEFAULTS);
  // seed current savings from real data if available
  if(dataLoaded){ const inv=engNWAssets(); if(inv>0) _fireState.saved=Math.max(inv,FIRE_DEFAULTS.saved); }
  return _fireState;
}
function fireSaveState(){ try{ LS.setItem('mdf_fire',JSON.stringify(_fireState)); }catch(e){} }
/* Live-linked calculator inputs: while linked, "Saved now" tracks the total of all investments
   and "Monthly add" tracks planned contributions. Dragging a slider unlinks it (flag=false);
   the 🔗 chip relinks. Links only engage when there's real data to link to. */
function fireEffective(){
  const U=fireState();
  const inv=engInvestTotal(), pc=engPlannedContrib();
  const savedLinked=(U.savedLinked!==false)&&inv>0;
  const contribLinked=(U.contribLinked!==false)&&pc>0;
  return Object.assign({}, U, {
    saved: savedLinked?Math.round(inv):U.saved,
    contrib: contribLinked?Math.round(pc):U.contrib,
    savedLinked, contribLinked,
  });
}
function fireToggleLink(which){
  const U=fireState();
  if(which==='saved') U.savedLinked=(U.savedLinked===false);
  else U.contribLinked=(U.contribLinked===false);
  fireSaveState();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}
// Core projection: compound growth with monthly contributions (ported calcGrowth logic)
function fireProject(U){
  const yrs=Math.max(U.ret-U.age,1), rate=U.rate/100, contrib=U.contrib*12;
  const labels=[],bals=[]; let bal=U.saved;
  for(let y=0;y<=yrs;y++){ labels.push(U.age+y); bals.push(Math.round(bal)); bal=bal*(1+rate)+contrib; }
  const fb=bals[bals.length-1];
  const real=fb/Math.pow(1+U.inf/100,yrs);
  const monthly=fb*0.04/12; // 4% safe withdrawal rule
  return {labels,bals,finalBal:fb,real,monthly,yrs};
}
function fireSlider(id,label,min,max,step,val,fmt){
  return `<div class="fc-slider"><div class="fc-slider-hdr"><span>${label}</span><strong id="fcv_${id}">${fmt(val)}</strong></div>
    <input type="range" id="fc_${id}" min="${min}" max="${max}" step="${step}" value="${val}" oninput="fireOnInput('${id}',this.value)"></div>`;
}
/* ═══ WEALTH / FIRE: extracted bodies + consolidated hub ═══ */
function fireProgressBody(w){
  const target=engMonthlyBills()*12*25;
  const cur=dataLoaded?Math.max(engNWAssets(),engNetBalance(),engInvestTotal()):Math.max(engNWAssets(),engInvestTotal());
  const pct=target>0?Math.min(100,Math.round(cur/target*100)):0;
  return `<div class="wph"><div class="wph-stat">${pct}%</div><div class="wph-sub">to FI (${fmtM(target)} target)</div><div class="xp-bar" style="margin-top:8px"><div class="xp-fill" style="width:${pct}%"></div></div></div>`;
}
function retirementProjBody(w){
  return `<div class="wph"><div class="wph-sub" style="margin-bottom:6px">Projected growth</div><div style="height:140px"><canvas id="cv_${w.uid}"></canvas></div></div>`;
}
// One "Wealth" widget with tabs — replaces FIRE Progress / Retirement Projection / FIRE Calculator.
const FIRE_TABS=[{id:'fi',label:'FI Progress',fn:'fireProgressBody'},{id:'proj',label:'Projection',fn:'retirementProjBody',chart:'retirement_proj'},{id:'calc',label:'Calculator',fn:'fireWidgetBody',chart:'fire_calc'},{id:'stress',label:'Stress test',fn:'fdWidgetBody',mount:'fire_drill'}];
let _fireHub={};
function fireHubBody(w){
  const cur=_fireHub[w.uid]||'fi';
  const tabs=FIRE_TABS.map(t=>`<button class="hub-tab${cur===t.id?' on':''}" onclick="event.stopPropagation();fireHubTab('${w.uid}','${t.id}')">${esc(t.label)}</button>`).join('');
  return `<div class="hub-wrap"><div class="hub-tabs">${tabs}</div><div class="hub-body" id="fhub_${w.uid}"></div></div>`;
}
function fireHubTab(uid,tab){ _fireHub[uid]=tab; const w=_findWidget(uid); if(w) fireHubMount(w); }
function fireHubMount(w){
  const cur=_fireHub[w.uid]||'fi';
  const wrap=gg('fhub_'+w.uid); if(!wrap) return;
  const t=FIRE_TABS.find(x=>x.id===cur)||FIRE_TABS[0];
  try{ wrap.innerHTML=window[t.fn](w); }catch(e){ wrap.innerHTML='<div class="acct-empty">—</div>'; }
  const btns=wrap.parentElement.querySelectorAll('.hub-tab');
  FIRE_TABS.forEach((x,i)=>{ if(btns[i]) btns[i].classList.toggle('on', x.id===cur); });
  // draw the tab's chart if it has one (canvas is cv_<uid>, shared with fireRefresh/buildWidgetChart)
  if(t.chart==='fire_calc'){ try{ fireRefresh(); }catch(e){} }
  else if(t.chart==='retirement_proj'){ try{ buildWidgetChart({...w, type:'retirement_proj'}, 'cv_'+w.uid); }catch(e){} }
  else if(t.mount==='fire_drill'){ try{ fdSetScenario(_fd.scenario||'job'); }catch(e){} }
}

function fireWidgetBody(w){
  const U=fireEffective();
  const linkChip=(which,on,title)=>`<button class="txf-chip${on?' on':''}" style="margin:-4px 0 8px;font-size:10.5px" onclick="event.stopPropagation();fireToggleLink('${which}')" title="${title}">🔗 ${on?'linked to '+(which==='saved'?'investments':'planned contributions'):'link to '+(which==='saved'?'investments':'planned contributions')}</button>`;
  return `<div class="fc-wrap">
    <div class="fc-sliders">
      ${fireSlider('age','Current age',18,70,1,U.age,v=>v)}
      ${fireSlider('ret','Retire at',40,80,1,U.ret,v=>v)}
      ${fireSlider('saved','Saved now',0,2000000,1000,U.saved,v=>fmtK(v))}
      ${linkChip('saved',U.savedLinked,'While linked, tracks the live total of your investment accounts, statement imports, and positions')}
      ${fireSlider('contrib','Monthly add',0,10000,50,U.contrib,v=>fmtK(v))}
      ${linkChip('contrib',U.contribLinked,'While linked, tracks the planned contributions you set on investment accounts')}
      ${fireSlider('rate','Return %',1,12,0.5,U.rate,v=>v+'%')}
    </div>
    <div class="fc-results">
      <div class="fc-stat"><div class="fc-stat-val" id="fc_final">—</div><div class="fc-stat-lbl">at retirement</div></div>
      <div class="fc-stat"><div class="fc-stat-val" id="fc_monthly" style="color:var(--green)">—</div><div class="fc-stat-lbl">/mo income (4% rule)</div></div>
      <div style="height:120px;margin-top:6px"><canvas id="cv_${w.uid}"></canvas></div>
      <div class="fc-note" id="fc_note"></div>
    </div>
  </div>`;
}
function fireOnInput(id,value){
  const U=fireState(); U[id]= (id==='rate')? parseFloat(value): parseInt(value,10);
  if(id==='saved') U.savedLinked=false;         // dragging the slider takes manual control
  if(id==='contrib') U.contribLinked=false;
  const fmtMap={age:v=>v,ret:v=>v,saved:v=>fmtK(v),contrib:v=>fmtK(v),rate:v=>v+'%'};
  const lbl=gg('fcv_'+id); if(lbl) lbl.textContent=fmtMap[id](U[id]);
  fireSaveState();
  fireRefresh();
}
function fireRefresh(){
  // find the active fire_calc widget canvas
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(!pg) return;
  const w=(pg.widgets||[]).find(x=>x.type==='fire_calc' || x.type==='fire_hub'); if(!w) return;
  const U=fireEffective(), proj=fireProject(U);
  const fEl=gg('fc_final'); if(fEl) fEl.textContent=fmtM(proj.finalBal);
  const mEl=gg('fc_monthly'); if(mEl) mEl.textContent=fmtK(proj.monthly)+'/mo';
  const nEl=gg('fc_note'); if(nEl) nEl.innerHTML=`${fmtM(proj.real)} in today's dollars over ${proj.yrs} years.`;
  buildChartWidget('cv_'+w.uid,'line',proj.labels,proj.bals,'#f0a540',{
    datasets:[{data:proj.bals,borderColor:'#f0a540',backgroundColor:'rgba(240,165,64,0.12)',fill:true,tension:0.3,pointRadius:0,borderWidth:2}],
    chartOptions:{scales:{x:{ticks:{color:'#8b8fa8',font:{size:9},maxTicksLimit:7},grid:{display:false}},y:{ticks:{color:'#8b8fa8',font:{size:9},callback:v=>fmtM(v)},grid:{color:'rgba(128,128,128,0.07)'}}}}
  });
}

/* ── FIRE Drill: "what-if disaster" survival simulator (ported from Playground F1) ── */
const FD_SCENARIOS={
  job:{name:'Job Loss',icon:'💼',sub:'One or both incomes gone',banner:'Model losing income. Slide sources toward zero for full or partial job loss.',incomeScale:{0:0,2:0,3:0},extraCosts:[{name:'Job search / resume',amt:100},{name:'Health insurance (COBRA)',amt:600}],severity:'danger'},
  hurricane:{name:'Hurricane',icon:'🌀',sub:'Displacement & repairs',banner:'Temporary displacement, hotel stays, repairs, and deductibles. FL: assume 2–4 weeks minimum.',incomeScale:{},extraCosts:[{name:'Temporary housing',amt:3000},{name:'Food & supplies',amt:800},{name:'Insurance deductible',amt:500},{name:'Uncovered repairs',amt:1000}],severity:'warn'},
  illness:{name:'Illness / Injury',icon:'🏥',sub:'Medical costs & lost work',banner:'Medical bills, reduced work capacity, and out-of-pocket costs.',incomeScale:{0:0.5},extraCosts:[{name:'Medical bills / copays',amt:500},{name:'Prescriptions',amt:200},{name:'Home care / transport',amt:300}],severity:'warn'},
  divorce:{name:'Separation',icon:'⚖️',sub:'Split finances, legal costs',banner:'Split finances — one income, legal fees, single-household costs.',incomeScale:{1:0,2:0.5},extraCosts:[{name:'Legal fees',amt:1500},{name:'Second housing',amt:1200}],severity:'warn'},
  market:{name:'Market Crash',icon:'📉',sub:'Portfolio & home value drop',banner:'30–50% portfolio drop. Income remains — focus on stopping discretionary spend.',incomeScale:{},extraCosts:[{name:'Increased premiums',amt:150}],severity:'info'},
  custom:{name:'Custom',icon:'⚙️',sub:'Build your own',banner:'Build your own scenario. Adjust income and add costs to model any emergency.',incomeScale:{},extraCosts:[],severity:'info'},
};
let _fd={scenario:'job', incomeOverrides:{}, extraCosts:[]};
function fdScenarioIncome(){
  return incomeSources.reduce((s,src,i)=>{
    if(_fd.incomeOverrides[i]!==undefined) return s+_fd.incomeOverrides[i];
    return s+src.amt*(FREQ_TO_MONTHLY[src.freq]||1);
  },0);
}
function fdMonthlyBills(){ return engMonthlyBills(); }
function fdExtraTotal(){ return _fd.extraCosts.reduce((s,c)=>s+(c.amt||0),0); }
function fdCashAvailable(){ return _liquidCash(); }   // cash & bank, excluding hidden accounts
function fdRunway(){
  const net=fdScenarioIncome()-fdMonthlyBills()-fdExtraTotal();
  const cash=fdCashAvailable();
  if(net>=0) return {months:999,net:net,cash:cash};
  let bal=cash, months=0;
  while(bal>0 && months<120){ bal+=net; months++; }
  return {months:months,net:net,cash:cash};
}
function fdSetScenario(id){
  _fd.scenario=id; const sc=FD_SCENARIOS[id];
  _fd.incomeOverrides={};
  Object.entries(sc.incomeScale||{}).forEach(([idx,scale])=>{
    const i=+idx; if(incomeSources[i]){ _fd.incomeOverrides[i]=Math.round(incomeSources[i].amt*(FREQ_TO_MONTHLY[incomeSources[i].freq]||1)*scale); }
  });
  _fd.extraCosts=sc.extraCosts.map(e=>({...e}));
  document.querySelectorAll('.fd-scen').forEach(el=>{ el.classList.toggle('active', el.getAttribute('onclick')&&el.getAttribute('onclick').includes("'"+id+"'")); });
  fdRefresh();
}

/* ═══ ZERO-BASED BUDGET WIDGET (interactive sliders) ═══ */
// Budgetable categories = tier-2 (children) + Other, excluding Income
function _zbBudgetableCats(){
  // Every spendable category the user actually has — leaf categories, custom top-level
  // categories, and "Other". Excludes group headers (group:true) and Income.
  return getUserCategories().filter(c=>!c.group && c.id!=='income');
}
function _zbBuckets(){
  if(!APP.zeroBuckets){ APP.zeroBuckets=zeroBuckets.map(b=>({...b})); }
  const cats=_zbBudgetableCats();
  const byId={}; cats.forEach(c=>byId[c.id]=c);
  const other=byId['other']||cats[cats.length-1]||{id:'other',label:'Other'};
  const matchName=(nm)=>{ nm=(nm||'').toLowerCase().trim(); if(!nm) return null;
    return cats.find(c=>c.label.toLowerCase()===nm)
        || cats.find(c=>{ const l=c.label.toLowerCase(); return l && (l.includes(nm)||nm.includes(l)); }) || null; };
  // Reconcile EVERY render against the CURRENT tree: a valid catId always adopts the
  // category's current label (so renames propagate); a stale/missing catId is re-matched
  // by name, else sent to Other. Legacy plain-name envelopes get linked here too.
  const reconciled=APP.zeroBuckets.map(b=>{
    const cat=(b.catId && byId[b.catId]) || matchName(b.name) || other;
    return {catId:cat.id, name:cat.label, amt:Math.max(0, b.amt||0), card:b.card||''};   // card = which credit card this envelope is spent on
  });
  // Dedupe by category (sum amounts if two envelopes resolve to the same category)
  const out={}; reconciled.forEach(b=>{ if(out[b.catId]){ out[b.catId].amt+=b.amt; if(!out[b.catId].card&&b.card) out[b.catId].card=b.card; } else out[b.catId]={...b}; });
  const next=Object.values(out);
  // Update in memory so callers see reconciled data; persist is deferred (this runs during
  // render via engBills → _cardEnvelopeTotals, and must not saveState mid-render). Idempotent:
  // once reconciled, later calls compare equal and skip.
  if(JSON.stringify(next)!==JSON.stringify(APP.zeroBuckets)){ APP.zeroBuckets=next; APP._zbCatLinked=true; _persistSoon(); }
  return APP.zeroBuckets;
}
/* ── Spending cards: cards assigned to budget envelopes. Their payment is money the
   envelopes already budget (you spend on the card, then pay it from checking), so the
   covered portion leaves Bills(fixed) — only paydown beyond the envelopes stays fixed. ── */
function engSpendingCards(){
  const byCard=_cardEnvelopeTotals();
  const names=new Set(Object.keys(byCard));
  let coveredPay=0, extraPaydown=0;
  if(names.size) engBills().forEach(bill=>{
    if(!names.has(bill.name)) return;
    const env=byCard[bill.name]||0, pay=bill.pay||0;
    coveredPay+=Math.min(pay,env); extraPaydown+=Math.max(0,pay-env);
  });
  return {names, byCard, coveredPay, extraPaydown};
}
// 30-day purchases on one card account (payments/transfers excluded)
function _cardSpend30(accountId){
  if(!accountId||!dataLoaded) return null;
  const cut=new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  return allTxns.filter(t=>t.account_id===accountId&&t.date>=cut&&t.amount>0&&!_txnExcludedFromSpend(t)).reduce((s,t)=>s+t.amount,0);
}
function zbWidgetBody(w){
  const income=engMonthlyIncome();
  const sc=engSpendingCards();
  const bills=engMonthlyBills()-sc.coveredPay;   // spending-card payments live in the envelopes; extra paydown stays fixed
  const buckets=_zbBuckets();
  const ccNames=Array.from(new Set(engBills().filter(b=>b.cat==='CC').map(b=>b.name)));
  const zbActual={}; if(dataLoaded){ try{ engCategoryBreakdown(30).forEach(r=>{ zbActual[r.label]=r.value; }); }catch(e){} }
  const spentTotal=buckets.reduce((s,b)=>s+(zbActual[b.name]||0),0);
  const envTotal=buckets.reduce((s,z)=>s+z.amt,0);
  const assigned=envTotal+bills;
  const left=income-assigned;
  const afterBills=Math.max(0, income-bills);
  const leftColor=Math.abs(left)<1?'var(--green)':left>0?'var(--amber)':'var(--red)';
  const sliderMax=(amt)=>Math.max(1500, Math.ceil(afterBills/100)*100, Math.ceil(amt/100)*100);
  const balanceRow = Math.abs(left)<1
    ? `<div class="zb-balanced">✓ Every dollar is assigned — your budget is balanced.</div>`
    : left>0
      ? `<div class="zb-tozero"><span>${fmtK(left)} still unassigned</span><button onclick="event.stopPropagation();zbBalance('${w.uid}')">Assign to Savings →</button></div>`
      : `<div class="zb-tozero over"><span>${fmtK(-left)} over budget</span><button onclick="event.stopPropagation();zbBalance('${w.uid}')">Trim to balance →</button></div>`;
  // unselected tier-2 categories available to add
  const selectedIds=new Set(buckets.map(b=>b.catId));
  const avail=_zbBudgetableCats().filter(c=>!selectedIds.has(c.id));
  const addSection = avail.length ? `<div class="zb-addcats">
      <div class="ws-hint" style="margin:0 0 7px">Add a category to budget:</div>
      <div class="zb-chips">${avail.map(c=>`<button class="zb-chip" onclick="event.stopPropagation();zbAddCat('${c.id}','${w.uid}')"><span class="zb-dot" style="background:${c.color}"></span>${esc(c.label)}</button>`).join('')}</div>
    </div>` : '';
  return `<div class="zb-wrap">
    <div class="zb-head">
      <div class="zb-hstat"><span>Monthly income</span><b>${fmtK(income)}</b></div>
      <div class="zb-hstat"><span>Bills (fixed)</span><b style="color:var(--red)">${fmtK(bills)}</b></div>
      <div class="zb-hstat"><span>Assigned to envelopes</span><b>${fmtK(envTotal)}</b></div>
      <div class="zb-hstat zb-tobudget"><span>To budget</span><b style="color:${leftColor}">${left>=0?'':'-'}${fmtK(Math.abs(left))} ${Math.abs(left)<1?'✓ balanced':left>0?'left':'over'}</b></div>
    </div>
    <div class="zb-bar"><div class="zb-bar-fill" style="width:${Math.min(100,Math.round(assigned/Math.max(income,1)*100))}%;background:${left<0?'var(--red)':'var(--pos)'}"></div></div>
    ${sc.coveredPay>0?`<div class="ws-hint" style="margin:0 0 8px">💳 ${fmtK(sc.coveredPay)} of card payments is covered by envelopes and excluded from fixed bills${sc.extraPaydown>0?` · ${fmtK(sc.extraPaydown)} extra paydown stays in fixed`:''}.</div>`:''}
    ${balanceRow}
    <div class="zb-tpl-cta"><button onclick="event.stopPropagation();openBudgetTemplates('${w.uid}')">✨ Start from a template</button></div>
    <div class="zb-section-label">Category envelopes <span class="ws-hint" style="margin:0">budget vs actual · ${fmtK(spentTotal)} spent of ${fmtK(envTotal)}</span></div>
    <div class="zb-buckets">
      ${buckets.map((b,i)=>{
        const spent=zbActual[b.name]||0;
        const pct=b.amt>0?Math.min(100,Math.round(spent/b.amt*100)):(spent>0?100:0);
        const over=b.amt>0&&spent>b.amt;
        const barColor=over?'var(--red)':pct>=85?'var(--amber)':'var(--green)';
        const actualLbl=`${fmtK(spent)} spent`+(b.amt>0?` · `+(over?`<b style="color:var(--red)">${fmtK(spent-b.amt)} over</b>`:`${fmtK(Math.max(0,b.amt-spent))} left`):' · no budget');
        const ccOpts=ccNames.map(n=>`<option value="${esc(n)}"${b.card===n?' selected':''}>\ud83d\udcb3 ${esc(n)}</option>`).join('');
        return `<div class="zb-bucket">
        <div class="zb-bk-top">
          <span class="zb-dot" style="background:${getCatColor(b.name)}"></span>
          <span class="zb-bk-nm">${esc(b.name)}</span>
          ${ccNames.length?`<select class="txn-cat-sel" title="Which card pays for this category" onclick="event.stopPropagation()" onchange="zbSetCard(${i},this.value,'${w.uid}')"><option value="">\ud83d\udcb3 card\u2026</option>${ccOpts}</select>`:''}
          <div class="zb-bk-edit"><span>$</span><input class="zb-bk-input" type="number" min="0" step="10" value="${b.amt}" onclick="event.stopPropagation()" oninput="zbSetVal(${i},this.value,'${w.uid}','input')" onchange="zbCommit('${w.uid}')" aria-label="Budget for ${esc(b.name)}"></div>
          <button class="zb-bk-del" onclick="event.stopPropagation();zbDelBucket(${i},'${w.uid}')" title="Remove ${esc(b.name)} from budget">\u2715</button>
        </div>
        <input type="range" class="zb-slider" min="0" max="${sliderMax(b.amt)}" step="10" value="${b.amt}" onclick="event.stopPropagation()" oninput="zbSetVal(${i},this.value,'${w.uid}','slider')" onchange="zbCommit('${w.uid}')">
        <div class="zb-actual"><div class="zb-actual-bar"><div class="zb-actual-fill" style="width:${pct}%;background:${barColor}"></div></div><div class="zb-actual-lbl">${actualLbl}</div></div>
      </div>`;}).join('') || '<div class="ws-hint">No categories budgeted yet — add some below.</div>'}
    </div>
    ${addSection}
  </div>`;
}
function zbAddCat(catId,uid){
  const c=_zbBudgetableCats().find(x=>x.id===catId); if(!c) return;
  const b=_zbBuckets(); if(b.some(x=>x.catId===catId)) return;
  b.push({catId:c.id, name:c.label, amt:0}); saveState();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod');
}
function zbSetVal(i,val,uid,from){
  const b=_zbBuckets(); b[i].amt=Math.max(0,parseInt(val)||0);
  const card=document.querySelector(`[data-uid="${uid}"]`)||document;
  const sliders=card.querySelectorAll('.zb-slider'), inputs=card.querySelectorAll('.zb-bk-input');
  if(from!=='slider' && sliders[i]){ if(parseInt(sliders[i].max)<b[i].amt) sliders[i].max=Math.ceil(b[i].amt/100)*100; sliders[i].value=b[i].amt; }
  if(from!=='input' && inputs[i] && document.activeElement!==inputs[i]) inputs[i].value=b[i].amt;
  const income=engMonthlyIncome(), bills=engMonthlyBills()-engSpendingCards().coveredPay;
  const assigned=b.reduce((s,z)=>s+z.amt,0)+bills; const left=income-assigned;
  const envEl=card.querySelector('.zb-head .zb-hstat:nth-child(3) b'); if(envEl) envEl.textContent=fmtK(b.reduce((s,z)=>s+z.amt,0));
  const tb=card.querySelector('.zb-tobudget b');
  if(tb){ tb.textContent=(left>=0?'':'-')+fmtK(Math.abs(left))+' '+(Math.abs(left)<1?'✓ balanced':left>0?'left':'over'); tb.style.color=Math.abs(left)<1?'var(--green)':left>0?'var(--amber)':'var(--red)'; }
  const bar=card.querySelector('.zb-bar-fill');
  if(bar){ bar.style.width=Math.min(100,Math.round(assigned/Math.max(income,1)*100))+'%'; bar.style.background=left<0?'var(--red)':'var(--pos)'; }
}
function zbSetCard(i,val,uid){ const b=_zbBuckets(); if(!b[i]) return; b[i].card=val||''; saveState(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function zbCommit(uid){ saveState(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function zbDelBucket(i,uid){ const b=_zbBuckets(); b.splice(i,1); saveState(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function zbBalance(uid){
  const b=_zbBuckets(); const income=engMonthlyIncome(), bills=engMonthlyBills();
  const left=income - (b.reduce((s,z)=>s+z.amt,0)+bills);
  if(Math.abs(left)<1) return;
  if(left>0){
    let sav=b.find(z=>/sav/i.test(z.name));
    if(!sav){ const c=_zbBudgetableCats().find(x=>/sav/i.test(x.label)); sav={catId:c?c.id:'savings', name:c?c.label:'Savings & Invest', amt:0}; b.push(sav); }
    sav.amt+=Math.round(left);
  } else {
    const big=b.slice().sort((x,y)=>y.amt-x.amt)[0]; if(big) big.amt=Math.max(0, big.amt-Math.round(-left));
  }
  saveState(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod');
  try{ emojiBurst('stars',{count:9,life:1500}); }catch(e){}   // every dollar assigned ✨
}
function zbAddBucket(uid){
  const name=prompt('Envelope name (e.g. Hobbies, Pet, Gifts):'); if(!name) return;
  _zbBuckets().push({name:name.trim(), amt:0}); saveState();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}

/* ═══ BUDGET TEMPLATES ═══
   One-tap starting budgets. Percentage templates split income across needs/wants/savings
   (fixed bills already cover part of "needs", so they're netted out); zero-based assigns
   everything. Within a group, amounts are split by recent spending, else evenly. */
const BUDGET_TEMPLATES=[
  {id:'50-30-20', name:'50 / 30 / 20',   icon:'⚖️', needs:.50, wants:.30, savings:.20, blurb:'The classic balance — needs, wants, and savings.'},
  {id:'70-20-10', name:'70 / 20 / 10',   icon:'🌱', needs:.70, wants:.20, savings:.10, blurb:'Easing in — more room for essentials, a starter savings habit.'},
  {id:'60-20-20', name:'60 / 20 / 20',   icon:'🏠', needs:.60, wants:.20, savings:.20, blurb:'Higher fixed costs, steady 20% savings.'},
  {id:'50-20-30', name:'Aggressive save',icon:'🚀', needs:.50, wants:.20, savings:.30, blurb:'Turbo mode — 30% straight to savings & investing.'},
  {id:'zero',     name:'Zero-based',      icon:'🎯', zero:true,                          blurb:'Assign every dollar — seeded from your recent spending.'},
];
function _tplRole(cat){
  const s=((cat.label||'')+' '+(cat.id||'')).toLowerCase();
  if(/sav|emergency|invest|retire|401|ira|wealth/.test(s)) return 'savings';
  if(/grocer|gas|fuel|auto|transport|transit|\bcar\b|utilit|insur|health|medical|rent|hous|mortgage|phone|internet|child|kid|educat|tuition|debt|loan|tax|pharmac/.test(s)) return 'needs';
  return 'wants';
}
function engBudgetTemplate(tplId){
  const tpl=BUDGET_TEMPLATES.find(t=>t.id===tplId)||BUDGET_TEMPLATES[0];
  const income=Math.round(engMonthlyIncome());
  const fixedBills=Math.round(engMonthlyBills());
  const cats=_zbBudgetableCats();
  const byId={}; cats.forEach(c=>byId[c.id]=c);
  const weights={};   // recent 3-mo avg spend per category, for splitting within a group
  try{ const g=engCategoryMonthGrid(3); g.cats.forEach(c=>{ const m=cats.find(x=>x.label===c.label); if(m) weights[m.id]=(weights[m.id]||0)+c.avg; }); }catch(e){}
  const byRole={needs:[],wants:[],savings:[]}; cats.forEach(c=>byRole[_tplRole(c)].push(c));
  const env={};
  const distribute=(list,pool)=>{
    if(pool<=0||!list.length) return;
    const tw=list.reduce((s,c)=>s+(weights[c.id]||0),0);
    if(tw>0) list.forEach(c=>{ env[c.id]=(env[c.id]||0)+Math.round(pool*(weights[c.id]||0)/tw); });
    else { const each=Math.round(pool/list.length); list.forEach(c=>{ env[c.id]=(env[c.id]||0)+each; }); }
  };
  const savList=byRole.savings.length?byRole.savings:cats.filter(c=>/sav|invest/i.test(c.label));
  let groups=null;
  if(tpl.zero){
    const pool=Math.max(0, income-fixedBills);
    distribute(cats.filter(c=>_tplRole(c)!=='savings'), Math.round(pool*0.85));
    distribute(savList, Math.round(pool*0.15));
  } else {
    const savings=Math.round(income*tpl.savings);
    const wants=Math.round(income*tpl.wants);
    const needsTarget=Math.round(income*tpl.needs);
    const needsEnv=Math.max(0, needsTarget-fixedBills);   // fixed bills already cover part of needs
    distribute(byRole.needs, needsEnv);
    distribute(byRole.wants, wants);
    distribute(savList, savings);
    groups={needsTarget,needsEnv,wants,savings};
  }
  const envelopes=Object.entries(env).filter(([id,amt])=>amt>0).map(([id,amt])=>({catId:id, name:(byId[id]?byId[id].label:id), amt})).sort((a,b)=>b.amt-a.amt);
  const envTotal=envelopes.reduce((s,e)=>s+e.amt,0);
  return {tpl,income,fixedBills,envelopes,envTotal,leftover:income-fixedBills-envTotal,groups};
}
let _budTpl={uid:null, tpl:'50-30-20'};
function openBudgetTemplates(uid){ try{ discoverXp('budget_templates',10,'budget templates'); }catch(e){} _budTpl.uid=uid||null; if(!BUDGET_TEMPLATES.find(t=>t.id===_budTpl.tpl)) _budTpl.tpl='50-30-20'; const m=gg('budgetTplModal'); if(!m) return; m.style.display='flex'; renderBudgetTemplates(); }
function closeBudgetTemplates(){ const m=gg('budgetTplModal'); if(m) m.style.display='none'; }
function btPick(id){ _budTpl.tpl=id; renderBudgetTemplates(); }
function renderBudgetTemplates(){
  const el=gg('budgetTplBody'); if(!el) return;
  const r=engBudgetTemplate(_budTpl.tpl);
  const cards=BUDGET_TEMPLATES.map(t=>`<button class="bt-card${t.id===_budTpl.tpl?' on':''}" onclick="btPick('${t.id}')"><span class="bt-ico">${t.icon}</span><span class="bt-nm">${esc(t.name)}</span><span class="bt-blurb">${esc(t.blurb)}</span></button>`).join('');
  const maxE=Math.max(1,...r.envelopes.map(e=>e.amt));
  const envRows=r.envelopes.length?r.envelopes.map(e=>`<div class="bt-row"><span class="bt-dot" style="background:${getCatColor(e.name)}"></span><span class="bt-lbl">${esc(e.name)}</span><span class="bt-barwrap"><span class="bt-bar" style="width:${Math.round(e.amt/maxE*100)}%;background:${getCatColor(e.name)}"></span></span><b class="bt-amt">${fmtK(e.amt)}</b></div>`).join(''):'<div class="ws-hint">Add your income first — templates size envelopes from your monthly income.</div>';
  const balCol=Math.abs(r.leftover)<1?'var(--green)':r.leftover>0?'var(--amber)':'var(--red)';
  const balTxt=Math.abs(r.leftover)<1?'✓ every dollar assigned':r.leftover>0?fmtK(r.leftover)+' left':fmtK(-r.leftover)+' over';
  const curCount=(APP.zeroBuckets||[]).length;
  el.innerHTML=`
    <div class="bt-cards">${cards}</div>
    <div class="bt-summary">
      <div><span>Monthly income</span><b>${fmtK(r.income)}</b></div>
      <div><span>Fixed bills</span><b style="color:var(--red)">${fmtK(r.fixedBills)}</b></div>
      <div><span>Into envelopes</span><b>${fmtK(r.envTotal)}</b></div>
      <div><span>Balance</span><b style="color:${balCol}">${balTxt}</b></div>
    </div>
    <div class="bt-sec">Proposed envelopes</div>
    <div class="bt-list">${envRows}</div>
    <div class="ws-hint" style="margin-top:10px">${curCount?`This replaces your current ${curCount} envelope${curCount!==1?'s':''}. `:''}Every amount stays editable afterward.</div>
    <div class="mf-actions"><button class="btn" onclick="closeBudgetTemplates()">Cancel</button><button class="btn primary" onclick="applyBudgetTemplate()"${r.envelopes.length?'':' disabled'}>Apply template</button></div>`;
}
function applyBudgetTemplate(){
  const r=engBudgetTemplate(_budTpl.tpl);
  if(!r.envelopes.length){ alert('Add your income first so Richie can size the budget.'); return; }
  try{ gamiMarkEngaged('template'); }catch(e){}
  APP.zeroBuckets=r.envelopes.map(e=>({catId:e.catId, name:e.name, amt:e.amt}));
  saveState();
  closeBudgetTemplates();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(typeof richieSay==='function') richieSay(`✨ Applied the ${r.tpl.name} budget — I sized your envelopes from your income and recent spending. Tweak any of them anytime.`);
  if(typeof sbRichie!=='undefined'&&sbRichie) sbRichie.do('tada');
}

/* ═══ BILLS WIDGET (all bills, timeframe selector) ═══ */
let _billsTf={};  // per-widget: 'month' | 'week' | 'day'
const BILLS_TABS=[['month','Monthly'],['week','Weekly'],['day','Daily'],['cards','💳 Cards']];
function _billsTabStrip(w,tf){ return BILLS_TABS.map(t=>`<button class="bills-tf-btn${tf===t[0]?' active':''}" onclick="event.stopPropagation();setBillsTf('${w.uid}','${t[0]}')">${t[1]}</button>`).join(''); }
/* Card plan: your Excel workflow — each card shows the envelopes assigned to it (Zero-Based
   Budget 💳 selector), live 30-day purchases on that card, and its planned payment. */
function billsCardsPlanBody(w){
  const sc=engSpendingCards();
  const cards=engBills().filter(b=>b.cat==='CC');
  if(!cards.length) return `<div class="wph"><div class="wph-sub">No credit cards yet — connect a bank or add a card manually.</div></div>`;
  const totalPay=cards.reduce((s,b)=>s+(b.pay||0),0);
  const fixedBills=engMonthlyBills()-totalPay;
  const rows=cards.map(b=>{
    const env=sc.byCard[b.name]||0;
    const spent=_cardSpend30(b.account_id);
    const pct=env>0?Math.min(100,Math.round((spent||0)/env*100)):0;
    const over=env>0&&(spent||0)>env;
    const cats=_zbBuckets().filter(x=>x.card===b.name).map(x=>x.name);
    return `<div class="zb-bucket">
      <div class="zb-bk-top"><span>💳</span><span class="zb-bk-nm">${esc(b.name)}</span><b style="margin-left:auto;font-size:12.5px">${env?fmtK(env)+' budgeted':''}</b></div>
      <div class="ws-hint" style="margin:2px 0 5px">${cats.length?esc(cats.join(' · ')):'No envelopes assigned — pick this card on categories in the Zero-Based Budget'}${(b.pay||0)>0?` · pays ${fmtK(b.pay)}/mo${sc.names.has(b.name)?' (covered by envelopes)':' (fixed bill)'}`:''}</div>
      ${env>0?`<div class="zb-actual"><div class="zb-actual-bar"><div class="zb-actual-fill" style="width:${pct}%;background:${over?'var(--red)':pct>=85?'var(--amber)':'var(--green)'}"></div></div><div class="zb-actual-lbl">${spent!=null?fmtK(spent)+' spent (30d)':'no live spend data'} · ${over?`<b style="color:var(--red)">${fmtK((spent||0)-env)} over</b>`:fmtK(Math.max(0,env-(spent||0)))+' left'}</div></div>`:''}
    </div>`;
  }).join('');
  return `<div class="ws-hint" style="margin:4px 0 9px">Leaving checking monthly: ${fmtK(fixedBills)} bills + ${fmtK(totalPay)} card payments = <b>${fmtK(fixedBills+totalPay)}</b></div>${rows}`;
}
function billsWidgetBody(w){
  const tf=_billsTf[w.uid]||'month';
  if(tf==='cards') return `<div class="bills-mgr"><div class="bills-tf">${_billsTabStrip(w,tf)}</div>${billsCardsPlanBody(w)}</div>`;
  const factor={month:1, week:12/52, day:1/30.44}[tf];
  const unit={month:'/mo', week:'/wk', day:'/day'}[tf];
  // Show anything payable: a set payment, a bill you added by hand (even at $0 so you can set
  // it), or a card/loan carrying a balance (so paid-in-full store cards still appear and can
  // be given a payment). Cash-flow projection still only counts bills with pay>0.
  const all=engBills().filter(b=>b.pay>0 || b.manual || Math.abs(b.bal||0)>0);
  if(!all.length) return `<div class="wph"><div class="wph-sub">No bills yet.</div><button class="manual-add-btn" onclick="event.stopPropagation();openManualBill()">\u2795 Add a bill</button></div>`;
  const ord=(d)=>d+(d%10===1&&d!==11?'st':d%10===2&&d!==12?'nd':d%10===3&&d!==13?'rd':'th');
  const live=plaidHasLiab();
  const today=new Date().getDate();
  // stable sort: unpaid first (by due date), then paid (by due date) — paid stay visible, sink to bottom
  const sorted=[...all].sort((a,b)=>{
    if(!!a.paid!==!!b.paid) return a.paid?1:-1;
    const da=a.due<today?a.due+31:a.due, db=b.due<today?b.due+31:b.due; return da-db;
  });
  const totMin=all.filter(b=>!b.paid).reduce((s,b)=>s+(b.min||0),0)*factor;
  const totPay=all.filter(b=>!b.paid).reduce((s,b)=>s+(b.pay||0),0)*factor;
  const rows=sorted.map(b=>{ const key=billKey(b).replace(/'/g,"\\'"); const paid=b.paid; const diff=(b.pay||0)-(b.min||0);
    const dispPay=tf==='month'?Math.round(b.pay):(b.pay*factor).toFixed(tf==='day'?2:0);
    // Auto/other loans arrive from Plaid with a balance but no APR/payment/due — prompt to fill
    // them in (once entered via the account editor, they persist and this disappears).
    const isLoan=['HM','CAR','LOAN'].includes(b.cat);
    const miss=[]; if(isLoan && !b.manual){ if(!(b.apr>0)) miss.push('APR'); if(b.estMin) miss.push('payment'); if(b.dueEst) miss.push('due date'); }
    const fillPrompt=miss.length?`<button class="bill-fill" onclick="event.stopPropagation();openAccountEditor('${esc(b.name).replace(/'/g,"\\'")}')" title="Plaid doesn't send these for this loan — add them once and they stick everywhere">＋ Add ${miss.join(' · ')}</button>`:'';
    return `<div class="bill-row${paid?' paid':''}">
      <button class="bill-check" onclick="event.stopPropagation();toggleBillPaid('${key}')" title="${paid?'Mark unpaid':'Mark paid'}">${paid?'\u2713':''}</button>
      <div class="bill-info">
        <div class="bill-nm">${esc(b.name)}${b.manual?`<span class="bill-edit" role="button" onclick="event.stopPropagation();openManualBill(${(APP.manualBills||[]).findIndex(x=>x.name===b.name&&x.cat===b.cat)})" title="Edit">\u270E</span>`:`<span class="bill-edit" role="button" onclick="event.stopPropagation();openAccountEditor('${esc(b.name).replace(/'/g,"\\'")}')" title="Edit min payment / due day / promo">\u270E</span>`}</div>
        <div class="bill-sub">${b.dueEst?'<span style="color:var(--muted)">due date not set</span>':'due '+ord(b.due)}${b.apr?` \u00b7 ${b.apr.toFixed(1)}%`:''}${b.promo?` \u00b7 ${esc(b.promo)}`:''}${_billPayoffLabel(b)}</div>
        <div class="bill-amts">
          <span class="bill-min">Min <b>${fmtK(b.min)}</b>${b.estMin?' \u00b7 <span style="color:var(--amber)" title="No minimum reported by the bank \u2014 estimated at ~2% of balance. Tap \u270e to set the real one.">est.</span>':(live&&!b.manual?' \u00b7 Plaid':'')}</span>
          ${Math.abs(diff)>=1?`<span class="bill-diff" style="color:${diff>0?'var(--amber)':'var(--green)'}">${diff>0?'+':''}${fmtK(diff)} vs min</span>`:''}
        </div>
        ${fillPrompt}
      </div>
      <div class="bill-paywrap">
        <label class="bill-paylabel">You pay${tf!=='month'?' '+unit:''}</label>
        ${tf==='month'
          ? `<div class="bill-pay"><span>$</span><input type="number" value="${dispPay}" min="0" step="10" onclick="event.stopPropagation()" oninput="setBillPay('${key}',this.value)" onblur="setBillPayCommit()"></div>`
          : `<div class="bill-pay-static">${fmtK(b.pay*factor)}</div>`}
      </div>
    </div>`; }).join('');
  return `<div class="bills-mgr">
    <div class="bills-tf">
      ${_billsTabStrip(w,tf)}
    </div>
    <div class="bills-hint">Tap the box on the left to mark a bill paid</div>
    ${rows}
    <div class="bills-foot">
      <span>${all.filter(b=>!b.paid).length} unpaid \u00b7 ${all.filter(b=>b.paid).length} paid</span>
      <span class="bills-foot-amts">${live?`<span class="bills-foot-min">min ${fmtK(totMin)}</span>`:''}<b>${fmtK(totPay)}${unit} you pay</b></span>
    </div>
    <button class="manual-add-btn" onclick="event.stopPropagation();openManualBill()">\u2795 Add a bill</button>
  </div>`;
}
function setBillsTf(uid,tf){ _billsTf[uid]=tf; const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }

/* ═══ 0% PROMO TRACKER WIDGET ═══ */
function promoTrackerBody(w){
  const promos=engPromos().filter(p=>p.bal>0.5);
  const fmtDate=(d)=>d.toLocaleDateString('en-US',{month:'short',year:'numeric'});
  let rows='';
  if(promos.length){
    rows=promos.map(p=>{
      const tier = p.days<0?'expired' : p.days<=45?'urgent' : p.days<=120?'soon' : 'ok';
      const color = tier==='expired'?'var(--red)' : tier==='urgent'?'var(--red)' : tier==='soon'?'var(--amber)' : 'var(--green)';
      const willClear = p.payoffMonths*30 <= p.days;
      const daysLabel = p.days<0?`expired ${Math.abs(p.days)}d ago` : p.days===0?'expires today' : `${p.days} days left`;
      return `<div class="promo-row">
        <div class="promo-main">
          <div class="promo-nm">${esc(p.name)} <span class="promo-tag">${esc(p.promo)}</span></div>
          <div class="promo-sub">ends ${fmtDate(p.end)} \u00b7 ${p.promoAmt>0?fmtK(p.promoAmt)+' at 0%':fmtK(p.bal)+' balance'} \u00b7 jumps to <b style="color:var(--amber)">${p.apr.toFixed(2)}%</b></div>
          <div class="promo-bar"><div class="promo-bar-fill" style="width:${Math.max(3,Math.min(100,100-(p.days/365*100)))}%;background:${color}"></div></div>
        </div>
        <div class="promo-side">
          <div class="promo-days" style="color:${color}">${daysLabel}</div>
          ${p.bal>0?`<div class="promo-warn">${willClear?'<span style="color:var(--green)">on track ✓</span>':'+'+fmtK(p.monthlyAfter)+'/mo if not paid'}</div>`:''}
          <button class="promo-edit" onclick="event.stopPropagation();openPromoEditor('${esc(p.name).replace(/'/g,"\\\\'")}')">edit</button>
        </div>
      </div>`;
    }).join('');
  }
  const urgent=promos.filter(p=>p.days<=45&&p.days>-3650&&p.bal>0.5);
  const head = urgent.length?`<div class="promo-alert">⚠️ ${urgent.length} promo${urgent.length>1?'s':''} expiring within 45 days — pay these down first.</div>`:'';
  // Cards WITHOUT a promo date — let the user attach one (works for live Plaid cards too)
  const noPromo=engBills().filter(b=>b.cat==='CC' && Math.abs(b.bal||0)>0.5 && !b.promoEnd);
  const chips=noPromo.map(b=>`<button class="promo-add-chip" onclick="event.stopPropagation();openPromoEditor('${esc(b.name).replace(/'/g,"\\\\'")}')">+ ${esc(b.name)}</button>`).join('');
  const addBtn=`<button class="promo-add-chip" style="background:var(--surface3);border-color:var(--border);color:var(--muted)" onclick="event.stopPropagation();openManualCard()">➕ Add a card</button>`;
  const addHint = noPromo.length
    ? `Attach a 0% promo end date to a card${plaidHasLiab()?' (works for your live cards too)':''}:`
    : `Have a card on a 0% intro offer? Add it and I'll count down to the day the rate jumps:`;
  const addSection=`<div class="promo-add-wrap"><div class="ws-hint" style="margin:0 0 6px">${addHint}</div><div class="promo-add-chips">${chips}${addBtn}</div></div>`;
  const empty = !promos.length ? `<div class="wph"><div class="wph-sub">No active 0%/intro-rate promos with a balance yet. 🎉</div></div>` : '';
  return `<div class="promo-wrap">${head}${rows}${empty}${addSection}</div>`;
}
// Editor to attach/clear a promo end date, credit limit, and standard APR on any card
function openPromoEditor(name){ return openAccountEditor(name); }   // alias — the editor now covers limit/APR/promo/etc.
/* ═══ NET WORTH — manual assets (home, car, valuables) + debts, with Richie estimate ═══ */
let _nwForm=null;
const NW_ASSET_CATS=[{id:'Real Estate',icon:'🏠',est:'home'},{id:'Vehicle',icon:'🚗',est:'vehicle'},{id:'Investment',icon:'📈'},{id:'Valuables',icon:'💎'},{id:'Other',icon:'📦'}];
const NW_DEBT_CATS=[{id:'Loan',icon:'💵'},{id:'Mortgage',icon:'🏦'},{id:'Other',icon:'📄'}];
function _nwIcon(cat,isDebt){ const c=(isDebt?NW_DEBT_CATS:NW_ASSET_CATS).find(x=>x.id===cat); return c?c.icon:(isDebt?'📄':'📦'); }
function openNetWorthEditor(){
  APP.nwManualAssets=APP.nwManualAssets||[]; APP.nwManualLiab=APP.nwManualLiab||[]; _nwForm=null;
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Home, car & assets';
  gg('manualSub').textContent="Add what a bank can't see — property, vehicles, valuables — plus debts not linked to a bank.";
  nwEditorRender();
}
function nwEditorRender(){
  if(_nwForm) return nwFormRender();
  const A=APP.nwManualAssets||[], L=APP.nwManualLiab||[];
  const row=(x,isDebt)=>`<div class="nw-row"><span class="nw-ic">${_nwIcon(x.cat,isDebt)}</span><span class="nw-nm">${esc(x.name||x.cat)}<span class="nw-cat">${esc(x.cat)}</span></span><span class="nw-val"${isDebt?' style="color:var(--red)"':''}>${fmtK(+x.value||0)}</span><button class="nw-ed" onclick="nwOpenForm('${isDebt?'debt':'asset'}','${x.id}')" title="Edit">✎</button><button class="nw-ed" onclick="nwDel('${isDebt?'debt':'asset'}','${x.id}')" title="Delete">🗑</button></div>`;
  gg('manualBody').innerHTML=
    `<div class="nw-sec-h"><span>💚 Assets</span><b style="color:var(--green)">${fmtK(A.reduce((s,x)=>s+(+x.value||0),0))}</b></div>`
    +`<div class="nw-list">${A.length?A.map(x=>row(x,false)).join(''):'<div class="ws-hint">No manual assets yet — add your home, car, etc.</div>'}</div>`
    +`<button class="nw-add" onclick="nwOpenForm('asset')">＋ Add asset</button>`
    +`<div class="nw-sec-h" style="margin-top:16px"><span>❤️ Debts (not linked to a bank)</span><b style="color:var(--red)">${fmtK(L.reduce((s,x)=>s+(+x.value||0),0))}</b></div>`
    +`<div class="nw-list">${L.length?L.map(x=>row(x,true)).join(''):'<div class="ws-hint">No manual debts yet.</div>'}</div>`
    +`<button class="nw-add" onclick="nwOpenForm('debt')">＋ Add debt</button>`
    +`<div class="mf-actions"><span></span><button class="btn primary" onclick="closeManual()">Done</button></div>`;
}
function nwOpenForm(kind,id){
  const arr=kind==='asset'?APP.nwManualAssets:APP.nwManualLiab; const item=id?(arr||[]).find(x=>x.id===id):null;
  _nwForm={ kind, id:id||null, cat:item?item.cat:(kind==='asset'?'Real Estate':'Loan'), name:item?item.name:'', value:item&&item.value!=null?item.value:'', vin:(item&&item.vin)||'', address:(item&&item.address)||'', contrib:(item&&item.contrib)||'' };
  nwEditorRender();
}
function nwFormRender(){
  const f=_nwForm, cats=f.kind==='asset'?NW_ASSET_CATS:NW_DEBT_CATS;
  const chips=cats.map(c=>`<button class="nw-chip${f.cat===c.id?' on':''}" onclick="nwSetCat('${c.id}')">${c.icon} ${esc(c.id)}</button>`).join('');
  const estCat=NW_ASSET_CATS.find(c=>c.id===f.cat&&c.est);
  let estHTML='';
  if(f.kind==='asset'&&estCat){
    estHTML = estCat.est==='vehicle'
      ? `<label class="mf-label">Estimate from VIN <span class="ws-hint" style="display:inline">· optional</span></label><div class="nw-est"><input class="mf-in" id="nwVin" placeholder="17-character VIN" value="${esc(f.vin||'')}"><button class="btn" id="nwEstBtn" onclick="nwEstimate('vehicle')">✨ Decode</button></div>`
      : `<label class="mf-label">Estimate from address <span class="ws-hint" style="display:inline">· optional</span></label><div class="nw-est"><input class="mf-in" id="nwAddr" placeholder="123 Main St, City ST 12345" value="${esc(f.address||'')}"><button class="btn" id="nwEstBtn" onclick="nwEstimate('home')">✨ Estimate</button></div>`;
  }
  gg('manualBody').innerHTML=
    `<button class="ace-back" onclick="nwBackToList()">‹ Back</button>`
    +`<label class="mf-label">Type</label><div class="nw-chips">${chips}</div>`
    +`<label class="mf-label">Name</label><input class="mf-in" id="nwName" placeholder="${f.kind==='asset'?'e.g. Our home / 2019 Honda CR-V':'e.g. Family loan'}" value="${esc(f.name||'')}">`
    +estHTML
    +`<div id="nwEstNote" class="ws-hint" style="margin-top:3px"></div>`
    +`<label class="mf-label">Value</label><input class="mf-in" id="nwValue" type="number" inputmode="decimal" placeholder="0" value="${f.value!=null?f.value:''}">`
    +(f.kind==='asset'&&f.cat==='Investment'?`<label class="mf-label">Planned contribution / mo</label><input class="mf-in" id="nwContrib" type="number" inputmode="decimal" placeholder="e.g. 500 — feeds the retirement calculator" value="${f.contrib!==''&&f.contrib!=null?f.contrib:''}">`:'')
    +`<div class="mf-actions">${f.id?`<button class="btn" style="color:var(--red)" onclick="_nwForm=null;nwDel('${f.kind}','${f.id}')">Delete</button>`:''}<button class="btn" onclick="nwBackToList()">Cancel</button><button class="btn primary" onclick="nwSaveForm()">Save</button></div>`;
}
function nwSetCat(cat){ if(gg('nwName'))_nwForm.name=gg('nwName').value; if(gg('nwValue'))_nwForm.value=gg('nwValue').value; if(gg('nwVin'))_nwForm.vin=gg('nwVin').value; if(gg('nwAddr'))_nwForm.address=gg('nwAddr').value; if(gg('nwContrib'))_nwForm.contrib=gg('nwContrib').value; _nwForm.cat=cat; nwEditorRender(); }
function nwBackToList(){ _nwForm=null; nwEditorRender(); }
function nwSaveForm(){
  const f=_nwForm, name=((gg('nwName').value||'').trim())||f.cat, value=_num('nwValue');
  const arr = f.kind==='asset'?(APP.nwManualAssets=APP.nwManualAssets||[]):(APP.nwManualLiab=APP.nwManualLiab||[]);
  const rec={ id:f.id||('nw'+Date.now()+Math.floor(Math.random()*999)), cat:f.cat, name, value };
  if(gg('nwVin'))rec.vin=gg('nwVin').value.trim(); if(gg('nwAddr'))rec.address=gg('nwAddr').value.trim();
  if(gg('nwContrib'))rec.contrib=_num('nwContrib');
  const i=f.id?arr.findIndex(x=>x.id===f.id):-1; if(i>=0)arr[i]=rec; else arr.push(rec);
  saveState(); _nwForm=null; nwEditorRender();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}
function nwDel(kind,id){
  const arr=kind==='asset'?APP.nwManualAssets:APP.nwManualLiab; if(!arr)return;
  const i=arr.findIndex(x=>x.id===id); if(i>=0)arr.splice(i,1);
  saveState(); nwEditorRender();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}
async function nwEstimate(type){
  const btn=gg('nwEstBtn'), note=gg('nwEstNote'); if(!btn)return;
  const body = type==='vehicle' ? {type,vin:(gg('nwVin').value||'').trim()} : {type,address:(gg('nwAddr').value||'').trim()};
  btn.disabled=true; const old=btn.textContent; btn.textContent='…'; if(note)note.textContent='Asking Richie…';
  try{
    const r=await fetch('/api/estimate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    btn.disabled=false; btn.textContent=old;
    if(!r.ok||d.error){ if(note)note.textContent=d.error||"Couldn't estimate — enter the value manually."; return; }
    if(d.label && gg('nwName') && !gg('nwName').value) gg('nwName').value=d.label;
    if(d.value && gg('nwValue')) gg('nwValue').value=d.value;
    if(note)note.textContent=(d.value?('≈ '+fmtK(d.value)+' · '):'')+(d.note||'Estimate — adjust as needed.');
  }catch(e){ btn.disabled=false; btn.textContent=old; if(note)note.textContent="Couldn't reach the estimator — enter the value manually."; }
}
function openAccountEditor(ref){
  // ref is a per-account id key ('id:institution|mask|name') or, from legacy callers, a name.
  const accts=engAccounts();
  let acct=String(ref).indexOf('id:')===0?accts.find(a=>_acctIdKey(a)===ref):null;
  if(!acct) acct=accts.find(a=>a.name===ref || a.rawName===ref || a.name===((APP.cardData||{})[_cardKey(ref)]||{}).nickname);
  const name=acct?(acct.rawName||acct.name):String(ref).replace(/^id:.*\|/,'');
  _aeKey=acct?_acctIdKey(acct):_cardKey(name);   // per-account storage key for this editing session
  const bill=engBills().find(b=>b.name===name)||{};
  const cd=acct?_cdFor(acct):((APP.cardData||{})[_cardKey(name)]||{});
  const type=(acct&&acct.type)||'';
  const isCredit = type==='credit' || bill.cat==='CC';
  const isLoan   = type==='loan'   || ['HM','CAR','LOAN'].includes(bill.cat);
  const isInvest = !isCredit && !isLoan;   // savings/HYSA/investment — all can carry a planned contribution
  const nEsc=esc(name).replace(/'/g,"\\'");
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Edit account';
  gg('manualSub').textContent=esc(cd.nickname||name)+(acct&&acct.mask?' ···'+acct.mask:'');
  let f=`<label class="mf-label">Nickname</label><input class="mf-in" id="aeNick" value="${esc(cd.nickname||'')}" placeholder="${esc(name)}">`;
  if(isCredit){
    f+=`<div class="mf-row"><div><label class="mf-label">Credit limit</label><input class="mf-in" id="aeLimit" type="number" inputmode="decimal" value="${cd.limit||bill.limit||''}" placeholder="e.g. 5000"></div>`
      +`<div><label class="mf-label">APR %</label><input class="mf-in" id="aeApr" type="number" inputmode="decimal" value="${cd.apr||bill.apr||''}" placeholder="e.g. 24.99"></div></div>`;
    f+=`<div class="mf-row"><div><label class="mf-label">0% promo ends</label><input class="mf-in" id="aePromoEnd" type="date" value="${cd.promoEnd||bill.promoEnd||''}"></div>`
      +`<div><label class="mf-label">Amount at 0%</label><input class="mf-in" id="aePromoAmt" type="number" inputmode="decimal" value="${cd.promoAmt||''}" placeholder="blank = full balance"></div></div>`;
    f+=`<label class="mf-label">Minimum payment</label><input class="mf-in" id="aeMinPay" type="number" inputmode="decimal" value="${cd.minPay||bill.min||''}" placeholder="monthly minimum">`;
  } else if(isLoan){
    f+=`<div class="mf-row"><div><label class="mf-label">Interest rate (APR) %</label><input class="mf-in" id="aeApr" type="number" inputmode="decimal" value="${cd.apr||bill.apr||''}" placeholder="e.g. 6.5"></div>`
      +`<div><label class="mf-label">Monthly payment</label><input class="mf-in" id="aeMinPay" type="number" inputmode="decimal" value="${cd.minPay||bill.min||''}" placeholder="e.g. 450"></div></div>`;
  }
  if(isCredit||isLoan) f+=`<label class="mf-label">Statement due day (1–31)</label><input class="mf-in" id="aeDue" type="number" inputmode="numeric" min="1" max="31" value="${cd.dueDay||bill.due||''}" placeholder="e.g. 15">`;
  if(isInvest) f+=`<label class="mf-label">Planned contribution / mo</label><input class="mf-in" id="aeContrib" type="number" inputmode="decimal" value="${cd.contrib||''}" placeholder="e.g. 500 — feeds the retirement calculator">`;
  f+=`<label class="mf-label">Note</label><input class="mf-in" id="aeNote" value="${esc(cd.note||'')}" placeholder="optional">`;
  f+=`<label class="ae-toggle"><input type="checkbox" id="aeExcl" ${cd.excluded?'checked':''}><span>Exclude from everything — net worth, cash, spending &amp; bills <span style="color:var(--muted);font-weight:400">(great for a work card that gets reimbursed)</span></span></label>`;
  if(!isCredit && !isLoan) f+=`<label class="ae-toggle"><input type="checkbox" id="aeEmergency" ${(APP.emergencyAccts||[]).includes(name)?'checked':''}><span>🛟 Count toward Emergency Fund <span style="color:var(--muted);font-weight:400">(links this account to your emergency-fund goal)</span></span></label>`;
  gg('manualBody').innerHTML=f
    +`<div class="ws-hint">These stay attached to this account even when balances refresh live from your bank — perfect for anything Plaid doesn't send (credit line, APR, 0% promos).</div>`
    +`<div class="mf-actions"><button class="btn danger-btn" onclick="clearAccountEdits('${nEsc}')">Clear</button><button class="btn primary" onclick="saveAccountEditor('${nEsc}')">Save</button></div>`;
}
function saveAccountEditor(name){
  const g=id=>gg(id), f={};
  if(g('aeNick'))     f.nickname=g('aeNick').value.trim();
  if(g('aeLimit'))    f.limit=_num('aeLimit');
  if(g('aeApr'))      f.apr=_num('aeApr');
  if(g('aePromoEnd')) f.promoEnd=g('aePromoEnd').value||'';
  if(g('aePromoAmt')) f.promoAmt=_num('aePromoAmt');
  if(g('aeMinPay'))   f.minPay=_num('aeMinPay');
  if(g('aeDue'))      f.dueDay=_num('aeDue');
  if(g('aeContrib'))  f.contrib=_num('aeContrib');
  if(g('aeNote'))     f.note=g('aeNote').value.trim();
  f.excluded = !!(g('aeExcl') && g('aeExcl').checked);
  if(_aeKey && _aeKey.indexOf('id:')===0){
    // Per-account record gets everything. The legacy name record only gets the bill-facing
    // fields (limit/APR/promo/due) that name-based readers like engBills use — never
    // nickname/excluded/contrib, which would leak onto other same-named accounts.
    APP.cardData=APP.cardData||{};
    APP.cardData[_aeKey]=Object.assign({}, APP.cardData[_aeKey]||{}, f);
    const shared={}; ['limit','apr','promoEnd','promoAmt','minPay','dueDay'].forEach(k=>{ if(f[k]!==undefined) shared[k]=f[k]; });
    setCardData(name, shared);
  } else {
    setCardData(name, f);
  }
  if(g('aeEmergency')){
    APP.emergencyAccts=APP.emergencyAccts||[];
    const on=g('aeEmergency').checked;
    if(on && !APP.emergencyAccts.includes(name)) APP.emergencyAccts.push(name);
    else if(!on) APP.emergencyAccts=APP.emergencyAccts.filter(x=>x!==name);
    saveState();
  }
  closeManual();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod');
}
function clearAccountEdits(name){ if(APP.cardData){ delete APP.cardData[_cardKey(name)]; if(_aeKey) delete APP.cardData[_aeKey]; } saveState(); closeManual(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
/* ── Editor for position-only investment accounts (grouped from portfolio holdings).
   Renaming rewrites the account field on every position in the group; the planned
   contribution lives in cardData under 'pos:<name>' and feeds engPlannedContrib. ── */
function openPosAcctEditor(name){
  const cd=(APP.cardData||{})['pos:'+String(name).toLowerCase()]||{};
  const nEsc=esc(name).replace(/'/g,"\\'");
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Edit investment account';
  gg('manualSub').textContent='Grouped from your portfolio positions.';
  gg('manualBody').innerHTML=`
    <label class="mf-label">Account name</label><input class="mf-in" id="paName" value="${esc(name)}">
    <label class="mf-label">Planned contribution / mo</label><input class="mf-in" id="paContrib" type="number" inputmode="decimal" value="${cd.contrib||''}" placeholder="e.g. 500 — feeds the retirement calculator">
    <div class="ws-hint">Renaming updates every position in this account. Its value is the live sum of those positions.</div>
    <div class="mf-actions"><span></span><button class="btn primary" onclick="savePosAcctEditor('${nEsc}')">Save</button></div>`;
}
function savePosAcctEditor(oldName){
  const nn=(gg('paName').value||'').trim()||oldName;
  const contrib=_num('paContrib');
  const oldKey='pos:'+String(oldName).toLowerCase(), newKey='pos:'+nn.toLowerCase();
  APP.cardData=APP.cardData||{};
  if(newKey!==oldKey) delete APP.cardData[oldKey];
  APP.cardData[newKey]=Object.assign({}, APP.cardData[newKey]||{}, {contrib});
  if(nn!==oldName) (APP.holdings||[]).forEach(h=>{ if((h.account||'').trim()===oldName) h.account=nn; });
  saveState(); closeManual();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod');
}
function _openPromoEditorLegacy(name){
  const bill=engBills().find(b=>b.name===name) || {name, promoEnd:'', limit:0, apr:0};
  const cd=(APP.cardData||{})[_cardKey(name)]||{};
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Card promo & limit';
  gg('manualSub').textContent=esc(name);
  gg('manualBody').innerHTML=`
    <label class="mf-label">0% promo ends</label>
    <input class="mf-in" id="prEnd" type="date" value="${cd.promoEnd||bill.promoEnd||''}">
    <div class="mf-row">
      <div><label class="mf-label">Credit limit</label><input class="mf-in" id="prLimit" type="number" value="${cd.limit||bill.limit||''}" placeholder="for utilization"></div>
      <div><label class="mf-label">Standard APR after promo %</label><input class="mf-in" id="prApr" type="number" value="${cd.apr||bill.apr||''}" placeholder="e.g. 28.99"></div>
    </div>
    <div class="ws-hint">These stay attached to this card even when balances refresh live from your bank.</div>
    <div class="mf-actions">
      <button class="btn danger-btn" onclick="clearPromo('${esc(name).replace(/'/g,"\\\\'")}')">Clear promo</button>
      <button class="btn primary" onclick="savePromo('${esc(name).replace(/'/g,"\\\\'")}')">Save</button>
    </div>`;
}
function savePromo(name){
  const fields={ promoEnd:gg('prEnd').value||'', limit:_num('prLimit'), apr:_num('prApr') };
  setCardData(name, fields);
  closeManual();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod');
}
function clearPromo(name){
  setCardData(name, {promoEnd:''});
  closeManual();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}

/* Richie proactively warns when a 0% promo is expiring soon (once per session per promo). */
let _promoWarned=false;
function maybeWarnPromos(){
  if(_promoWarned) return;
  const alerts=engPromoAlerts(45).filter(p=>p.bal>0.5);
  if(!alerts.length) return;
  _promoWarned=true;
  const soonest=alerts[0];
  const more=alerts.length>1?` (and ${alerts.length-1} more)`:'';
  const when = soonest.days<0?'has already expired':soonest.days===0?'expires today':`expires in ${soonest.days} days`;
  setTimeout(()=>{
    if(typeof richieSay==='function'){
      richieSay(`⏳ Heads up — your ${soonest.name} 0% promo ${when}${more}. There's ${fmtK(soonest.bal)} on it that would start accruing ${soonest.apr.toFixed(1)}% APR. Want to prioritize paying it down before then?`);
      if(typeof sbRichie!=='undefined'&&sbRichie)sbRichie.do('alert');
    }
  }, 1600);
}

/* ═══ CASH ON HAND — now filters by ACCOUNT CATEGORY (user-selectable) ═══ */
function cashSummaryBody(w){
  const cats=(w.acctCats&&w.acctCats.length)?w.acctCats:['cash','savings'];
  const accts=engAccounts().filter(a=>!a.excluded && cats.includes(getAccountCategory(a)));
  const total=accts.reduce((s,a)=>s+(a.bal||0),0);
  const top=accts.slice().sort((x,y)=>Math.abs(y.bal)-Math.abs(x.bal)).slice(0,3);
  const mx=Math.max(...top.map(a=>Math.abs(a.bal||0)),1);
  const label=cats.map(c=>acctCatDef(c).label).join(' + ')||'account';
  const gear=`<button class="cash-pick" onclick="event.stopPropagation();openAcctCatPicker('${w.uid}')" title="Choose account types">⚙︎</button>`;
  if(!accts.length) return `<div class="wph"><div class="wph-sub">No ${esc(label)} accounts.</div><div style="text-align:center;margin-top:10px"><button class="manual-add-btn" style="width:auto;display:inline-block" onclick="event.stopPropagation();openAcctCatPicker('${w.uid}')">⚙︎ Choose account types</button></div></div>`;
  const rows=top.map(a=>`<div class="cash-row"><span class="cash-nm">${esc(a.name||'Account')}</span><span class="cash-track"><i style="width:${Math.max(5,Math.round(Math.abs(a.bal||0)/mx*100))}%"></i></span><b>${fmtK(a.bal)}</b></div>`).join('');
  const pend=accts.reduce((o,a)=>{const p=engAcctPending(a);o.count+=p.count;o.sum+=p.sum;return o;},{count:0,sum:0});
  const pendLine=pend.count?`<div class="wph-sub" style="color:var(--amber)">⏳ ${pend.count} pending → ${fmtK(total-pend.sum)} expected</div>`:'';
  return `<div class="wph"><div class="wph-stat" style="color:${moneyCol(total)}">${fmtK(total)}</div><div class="wph-sub">cash on hand · ${accts.length} ${esc(label)} account${accts.length!==1?'s':''}${dataLoaded?'':' · sample'} ${gear}</div>${pendLine}<div class="cash-list">${rows}</div></div>`;
}
/* Per-widget picker: which ACCOUNT CATEGORIES this widget counts */
let _acctPick={uid:null, sel:[]};
// Current Spending: choose which categories to include (e.g. exclude Work)
function openSpendCatPicker(uid){
  const w=_findWidget(uid); if(!w) return;
  const days=wDays(w);
  const bcats=_budgetCatSet(); const linked=bcats.size>0;
  let unfiltered;
  if(dataLoaded){ unfiltered=(linked?engCategoryBreakdown(days).filter(r=>bcats.has(r.label)):engDiscretionaryBreakdown(days)); }
  else { const g=engCategoryMonthGrid(6), li=g.months.length-1; unfiltered=g.cats.filter(c=>linked?bcats.has(c.label):isDiscretionary(c.label)).map(c=>({label:c.label,value:Math.round((c.vals[li]||0)*(days/30))})).filter(r=>r.value>0); }
  const labels=Array.from(new Set([ ...unfiltered.map(r=>r.label), ...(linked?Array.from(bcats):[]), ...(w.hiddenCats||[]) ])).sort();
  const hidden=new Set(w.hiddenCats||[]);
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Show categories';
  gg('manualSub').textContent='Uncheck any category to leave it out of Current Spending (e.g. Work).';
  gg('manualBody').innerHTML = (labels.length?labels.map(l=>{
    const v=(unfiltered.find(r=>r.label===l)||{}).value||0;
    const le=esc(l).replace(/'/g,"\\'");
    return `<label class="scp-row"><input type="checkbox" ${hidden.has(l)?'':'checked'} onchange="spendCatToggle('${uid}','${le}',this.checked)"><span class="scp-nm">${esc(l)}</span><span class="scp-v">${fmtK(v)}</span></label>`;
  }).join(''):'<div class="ws-hint">No spending categories yet.</div>') + `<div class="mf-actions"><span></span><button class="btn primary" onclick="closeManual()">Done</button></div>`;
}
function spendCatToggle(uid,label,show){
  const w=_findWidget(uid); if(!w) return;
  w.hiddenCats=w.hiddenCats||[];
  if(show) w.hiddenCats=w.hiddenCats.filter(x=>x!==label);
  else if(!w.hiddenCats.includes(label)) w.hiddenCats.push(label);
  saveState();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}
function openAcctCatPicker(uid){
  const w=_findWidget(uid); if(!w) return;
  _acctPick={uid, sel:(w.acctCats&&w.acctCats.length?w.acctCats.slice():['cash','savings'])};
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Account types to include';
  gg('manualSub').textContent='Pick which kinds of accounts this widget counts.';
  acctPickRender();
}
function acctPickRender(){
  const counts={}; engAccounts().forEach(a=>{ const c=getAccountCategory(a); counts[c]=(counts[c]||0)+1; });
  const rows=ACCOUNT_CATEGORIES.map(c=>{
    const on=_acctPick.sel.includes(c.id), n=counts[c.id]||0;
    return `<label class="acp-row${on?' on':''}"><input type="checkbox" ${on?'checked':''} onchange="acctPickToggle('${c.id}')"><span class="acp-ic">${c.icon}</span><span class="acp-nm">${esc(c.label)}<span class="acp-kind">${c.kind}</span></span><span class="acp-ct">${n}</span></label>`;
  }).join('');
  gg('manualBody').innerHTML=`<div class="acp-list">${rows}</div><div class="ws-hint" style="margin-top:9px">Numbers show how many of your accounts fall in each type. Change an account's type in Settings → Account categories.</div><div class="mf-actions"><span></span><button class="btn primary" onclick="acctPickSave()">Done</button></div>`;
}
function acctPickToggle(id){ const i=_acctPick.sel.indexOf(id); if(i<0)_acctPick.sel.push(id); else _acctPick.sel.splice(i,1); acctPickRender(); }
function acctPickSave(){ const w=_findWidget(_acctPick.uid); if(w){ w.acctCats=_acctPick.sel.slice(); saveState(); } closeManual(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }

/* Settings: assign each account to a category (auto-detected unless overridden) */
let _acePick=null;   // {key,name} when choosing a category for one account
function openAcctCatEditor(){
  _acePick=null;
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Account categories';
  gg('manualSub').textContent='Assign each account to a category. Auto-detected unless you change it.';
  acctCatEditorRender();
}
function acctCatEditorRender(){
  if(_acePick){ return acctCatPickerRender(); }
  const accts=engAccounts();
  const ov=_acctCatOverrides();
  const byCat={}; accts.forEach(a=>{ const c=getAccountCategory(a); (byCat[c]=byCat[c]||[]).push(a); });
  const groups=ACCOUNT_CATEGORIES.filter(c=>byCat[c.id]&&byCat[c.id].length).map(c=>{
    const rows=byCat[c.id].map(a=>{
      const k=_acctKey(a), auto=!ov[k];
      const kEsc=esc(k).replace(/'/g,"\\'"), nEsc=esc(a.name||'Account').replace(/'/g,"\\'");
      return `<button type="button" class="ace-row ace-tap" onclick="acctCatPick('${kEsc}','${nEsc}')">
        <span class="ace-meta"><span class="ace-nm">${esc(a.name||'Account')}</span><span class="ace-sub">${esc(a.institution||a.subtype||a.type||'')}${auto?' · auto-detected':' · custom'}</span></span>
        <span class="ace-bal">${fmtK(a.bal)}</span>
        <span class="ace-chevron">›</span>
      </button>`;
    }).join('');
    return `<div class="ace-group"><div class="ace-gh"><span>${c.icon} ${esc(c.label)}</span><span class="ace-kind ${c.kind}">${c.kind}</span></div>${rows}</div>`;
  }).join('');
  gg('manualBody').innerHTML=`<div class="ace-hint">Tap any account to move it to a different category.</div><div class="ace-wrap">${groups||'<div class="ws-hint">No accounts yet. Connect a bank or add a manual account first.</div>'}</div><div class="mf-actions"><button class="btn" onclick="acctCatResetAll()">Reset to auto</button><button class="btn primary" onclick="closeManual()">Done</button></div>`;
}
function acctCatPickerRender(){
  const cur=getAccountCategory({id:_acePick.key, name:_acePick.name});   // key drives override lookup
  const curOv=_acctCatOverrides()[_acePick.key];
  const curId=curOv||cur;
  const opts=ACCOUNT_CATEGORIES.map(c=>{
    const on=c.id===curId;
    return `<button type="button" class="ace-opt${on?' on':''}" onclick="acctCatChoose('${c.id}')">
      <span class="ace-opt-ic">${c.icon}</span>
      <span class="ace-opt-lbl">${esc(c.label)}<span class="ace-opt-kind ${c.kind}">${c.kind}</span></span>
      ${on?'<span class="ace-opt-check">✓</span>':''}
    </button>`;
  }).join('');
  gg('manualBody').innerHTML=`<div class="ace-pick-head"><button type="button" class="ace-back" onclick="acctCatBack()">‹ Back</button><div class="ace-pick-name">${esc(_acePick.name)}</div></div><div class="ace-hint" style="margin-bottom:9px">Choose a category for this account.</div><div class="ace-opts">${opts}</div><div class="mf-actions"><span></span><button class="btn primary" onclick="acctCatBack()">Done</button></div>`;
}
function acctCatPick(key,name){ _acePick={key,name}; acctCatEditorRender(); }
function acctCatBack(){ _acePick=null; acctCatEditorRender(); }
function acctCatChoose(catId){ if(_acePick){ setAccountCategory(_acePick.key, catId); } _acePick=null; acctCatEditorRender(); }
function acctCatResetAll(){ try{ LS.removeItem('mdf_acct_cats'); }catch(e){} _acePick=null; acctCatEditorRender(); }

/* ═══ CREDIT UTILIZATION + DTI WIDGET ═══ */
/* ═══ DEBT: extracted bodies + consolidated hub ═══ */
function _debtCatIcon(b){ return b.cat==='CC'?'💳':b.cat==='HM'?'🏡':b.cat==='CAR'?'🚗':'📄'; }
function debtSummaryBody(w){
  const g=engDebtGroups();
  if(!g.count) return `<div class="wph"><div class="wph-stat" style="color:var(--green)">${fmtK(0)}</div><div class="wph-sub">No debt tracked — nice.</div></div>`;
  const focusIsCC=_focusIsCC(g);
  const metric=focusIsCC?'ccdebt':'focusdebt';
  const goal=_goals().find(x=>x&&x.metric===metric&&!x.completed);
  const hi=g.focusItems.slice().sort((a,b)=>(b.apr||0)-(a.apr||0))[0];
  const focusLabel=focusIsCC?'Credit-card payoff':'Focus payoff';
  const row=(b)=>{ const inF=_debtInFocus(b); const k=String(_debtKey(b)).replace(/'/g,"\\'");
    return `<div class="dbt-row"><button class="dbt-star${inF?' on':''}" title="${inF?'In your focus payoff — tap to drop':'Tap to add to your focus payoff'}" onclick="event.stopPropagation();toggleDebtFocus('${w.uid}','${k}')">${inF?'★':'☆'}</button>`
      +`<span class="dbt-ic">${_debtCatIcon(b)}</span>`
      +`<span class="dbt-nm">${esc(b.name)}${b.apr?`<i class="dbt-apr">${b.apr.toFixed(1)}% APR</i>`:''}</span>`
      +`<span class="dbt-val">${fmtK(Math.abs(b.bal||0))}</span></div>`; };
  const focusRows=g.focusItems.length?g.focusItems.map(row).join(''):`<div class="dbt-empty">Nothing in focus yet — ☆ star a balance below to build your payoff.</div>`;
  const restRows=g.rest.map(row).join('');
  const goalBtn = g.focusTotal<=0 ? '' : (goal
    ? `<div class="dbt-goal on">🎯 Tracking as a goal · ${goalProgress(goal).pct}% paid off</div>`
    : `<button class="dbt-goal" onclick="event.stopPropagation();debtTrackGoal('${w.uid}')">🎯 Track this ${focusIsCC?'card':'focus'} payoff as my goal</button>`);
  return `<div class="dbt-wrap">
    <div class="wph" style="padding-bottom:4px">
      <div class="wph-sub">${focusLabel} · your priority</div>
      <div class="wph-stat" style="color:var(--red)">${fmtK(g.focusTotal)}</div>
      <div class="wph-sub">across ${g.focusItems.length} balance${g.focusItems.length!==1?'s':''}${hi&&hi.apr?` · top APR ${hi.apr.toFixed(1)}%`:''}</div>
    </div>
    <div class="dbt-list">${focusRows}</div>
    ${goalBtn}
    ${g.rest.length?`<div class="dbt-longhead"><span>Long-term · ${fmtK(g.restTotal)}</span><i>mortgage · auto · HELOC — the marathon</i></div><div class="dbt-list dbt-dim">${restRows}</div>`:''}
    <div class="dbt-foot">All debt combined · ${fmtK(g.total)}</div>
  </div>`;
}
function toggleDebtFocus(uid,key){
  const b=engBills().find(x=>String(_debtKey(x))===String(key)); if(!b) return;
  const m=_debtFocusMap(); const now=!_debtInFocus(b);
  if(now===(b.cat==='CC')) delete m[String(key)];   // back to the default → drop the override, keep state tidy
  else m[String(key)]=now;
  saveState();
  const w=_findWidget(uid); if(w) debtHubMount(w);
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg) renderCanvas(pg);
}
function debtTrackGoal(uid){
  const g=engDebtGroups(); if(g.focusTotal<=0) return;
  const focusIsCC=_focusIsCC(g);
  const metric=focusIsCC?'ccdebt':'focusdebt';
  let goal=_goals().find(x=>x&&x.metric===metric&&!x.completed);
  if(goal){ goal.start=null; saveState(); }   // already tracking → re-anchor baseline to today's balance
  else addGoal({ name: focusIsCC?'Kill credit-card debt':'Pay off my focus debts', metric, target:0, presetKey: focusIsCC?'cc0':undefined });
  const w=_findWidget(uid); if(w) debtHubMount(w);
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg) renderCanvas(pg);
}
function debtPayoffBody(w){
  const g=engDebtGroups();
  if(!g.focusItems.length){
    return `<div class="wph"><div class="wph-stat" style="color:var(--green)">🎉</div><div class="wph-sub">No focus debt to pay off — ☆ star a balance in the Owed tab to plan its payoff.</div></div>`;
  }
  const focusIsCC=_focusIsCC(g);
  const label=focusIsCC?'Credit cards':'Your focus debts';
  const P=g.focusTotal;
  const pay=g.focusItems.reduce((s,b)=>s+(b.pay||b.min||0),0);   // what you're actually putting toward the focus set
  const bals=g.focusItems.reduce((s,b)=>s+Math.abs(b.bal||0),0);
  const wApr=bals>0?g.focusItems.reduce((s,b)=>s+Math.abs(b.bal||0)*(b.apr||0),0)/bals:0;   // balance-weighted APR
  const r=wApr/100/12;
  const monthsAt=(pmt)=>{ if(pmt<=0) return 999; if(r<=0) return Math.ceil(P/pmt); return (pmt>P*r)?Math.ceil(Math.log(pmt/(pmt-P*r))/Math.log(1+r)):999; };
  const months=monthsAt(pay);
  const yrs=Math.floor(months/12), mo=months%12;
  const timeStr=months>=999?'—':(yrs?yrs+' yr ':'')+mo+' mo';
  // Motivating nudge: what monthly payment clears the focus set inside 24 months?
  const pmtFor=(n)=>r<=0?P/n:P*r/(1-Math.pow(1+r,-n));
  const extra=Math.max(0, Math.ceil(pmtFor(24))-pay);
  const nudge=(months>24 && P>0)
    ? `<div class="wph-inline"><span>Add ~${fmtK(extra)}/mo${pay>0?' more':''}</span><b style="color:var(--green)">→ done in 2 yr</b></div>`
    : '';
  return `<div class="wph">
    <div class="wph-sub">${label} paid off in${plaidHasLiab()?' · live':''}</div>
    <div class="wph-stat">${timeStr}</div>
    <div class="wph-sub">${fmtM(P)} at ${wApr.toFixed(1)}% avg APR · paying ${fmtK(pay)}/mo</div>
    ${nudge}
  </div>`;
}
// One "Debt" widget with tabs — replaces the separate Total Debt / Payoff / Credit / Promo cards.
const DEBT_TABS=[{id:'owed',label:'Owed',fn:'debtSummaryBody'},{id:'payoff',label:'Payoff',fn:'debtPayoffBody'},{id:'lab',label:'Lab',fn:'dpWidgetBody',mount:'debt_planner'},{id:'credit',label:'Credit',fn:'creditUtilBody'},{id:'score',label:'Score',fn:'creditScoreBody'},{id:'promo',label:'0% Promo',fn:'promoTrackerBody'}];
let _debtHub={};
function debtHubBody(w){
  const cur=_debtHub[w.uid]||'owed';
  const tabs=DEBT_TABS.map(t=>`<button class="hub-tab${cur===t.id?' on':''}" onclick="event.stopPropagation();debtHubTab('${w.uid}','${t.id}')">${esc(t.label)}</button>`).join('');
  return `<div class="hub-wrap"><div class="hub-tabs">${tabs}</div><div class="hub-body" id="dhub_${w.uid}"></div></div>`;
}
function debtHubTab(uid,tab){ _debtHub[uid]=tab; const w=_findWidget(uid); if(w) debtHubMount(w); }
function debtHubMount(w){
  const cur=_debtHub[w.uid]||'owed';
  // reflect active tab (in case body was re-rendered)
  const wrap=gg('dhub_'+w.uid); if(!wrap) return;
  const t=DEBT_TABS.find(x=>x.id===cur)||DEBT_TABS[0];
  try{ wrap.innerHTML=window[t.fn](w); }catch(e){ wrap.innerHTML='<div class="acct-empty">—</div>'; }
  // sync tab button states
  const btns=wrap.parentElement.querySelectorAll('.hub-tab');
  DEBT_TABS.forEach((x,i)=>{ if(btns[i]) btns[i].classList.toggle('on', x.id===cur); });
  if(t.mount==='debt_planner'){ try{ dpRecalc(); dpRenderOrder(); }catch(e){} }
}

/* ═══ CREDIT SCORE MONITOR (Debt hub tab) ═══
   Plaid doesn't supply credit scores, so entries are logged manually (card issuers and
   Credit Karma give them free). History lives in APP.creditScores [{d:'YYYY-MM-DD',v:735}]
   and syncs across devices with the rest of APP state. Utilization is shown live alongside
   since it's the biggest score factor we can actually compute. */
function _ccScores(){ APP.creditScores=APP.creditScores||[]; return APP.creditScores; }
function _scoreBand(v){
  if(v>=800) return {label:'Exceptional', color:'var(--green)'};
  if(v>=740) return {label:'Very good',   color:'var(--green)'};
  if(v>=670) return {label:'Good',        color:'var(--blue)'};
  if(v>=580) return {label:'Fair',        color:'var(--amber)'};
  return {label:'Poor', color:'var(--red)'};
}
function creditScoreBody(w){
  const hist=_ccScores().slice().sort((a,b)=>a.d<b.d?-1:1);
  const logBtn=`<button class="nw-add" onclick="event.stopPropagation();openScoreEditor()">＋ Log my score</button>`;
  if(!hist.length){
    return `<div class="wph"><div class="wph-sub">No score logged yet.</div>
      <div class="ws-hint" style="margin-top:6px">Banks don't share scores with the app, so log it yourself — your card issuer's app or Credit Karma shows it free. Log it monthly and I'll track the trend.</div>
      ${logBtn}</div>`;
  }
  const cur=hist[hist.length-1], prev=hist.length>1?hist[hist.length-2]:null;
  const band=_scoreBand(cur.v);
  const delta=prev?cur.v-prev.v:null;
  const deltaStr=delta===null?'':` <span style="font-size:13px;font-weight:700;color:${delta>=0?'var(--green)':'var(--red)'}">${delta>=0?'▲ +':'▼ '}${delta}</span>`;
  const pct=Math.max(0,Math.min(100,(cur.v-300)/5.5));
  const vals=hist.slice(-12).map(h=>h.v);
  const spark=vals.length>1?_sparkline(vals, band.color, 110, 26):'';
  const u=engCreditUtil();
  const utilRow=u.limit>0?`<div class="wph-inline" style="margin-top:9px"><span>Utilization ${Math.round(u.pct)}% ${u.pct<10?'— excellent':u.pct<30?'— good':'— aim under 30%'}</span><b style="color:${u.pct<30?'var(--green)':u.pct<=50?'var(--amber)':'var(--red)'}">${fmtK(u.used)} / ${fmtK(u.limit)}</b></div>`:'';
  return `<div class="wph">
    <div class="wph-stat" style="color:${band.color}">${cur.v}${deltaStr}</div>
    <div class="wph-sub">${band.label} · logged ${new Date(cur.d+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})}${hist.length>1?` · ${hist.length} entries`:''}</div>
    <div style="position:relative;height:8px;border-radius:4px;margin:12px 2px 3px;background:linear-gradient(90deg,var(--red),var(--amber),var(--green))">
      <div style="position:absolute;left:calc(${pct.toFixed(1)}% - 5px);top:-3px;width:10px;height:14px;border-radius:3px;background:var(--text);border:2px solid var(--surface)"></div>
    </div>
    <div class="wph-inline" style="font-size:10.5px;color:var(--muted)"><span>300</span><span>850</span></div>
    ${spark?`<div style="margin-top:9px">${spark}</div>`:''}
    ${utilRow}
    ${logBtn}</div>`;
}
function openScoreEditor(){
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Credit score';
  gg('manualSub').textContent='Log your score from your card issuer or Credit Karma — free and no score impact.';
  scoreEditorRender();
}
function scoreEditorRender(){
  const hist=_ccScores().slice().sort((a,b)=>a.d<b.d?1:-1);
  const rows=hist.map((h,i)=>`<div class="nw-row"><span class="nw-ic">📊</span><span class="nw-nm">${h.v}<span class="nw-cat">${esc(h.d)}</span></span><span class="nw-val" style="color:${_scoreBand(h.v).color}">${esc(_scoreBand(h.v).label)}</span><button class="nw-ed" onclick="deleteScoreEntry(${i})" title="Delete">🗑</button></div>`).join('');
  gg('manualBody').innerHTML=
    `<div class="mf-row">
      <div><label class="mf-label">Score (300–850)</label><input class="mf-in" id="csVal" type="number" inputmode="numeric" min="300" max="850" placeholder="e.g. 735"></div>
      <div><label class="mf-label">Date</label><input class="mf-in" id="csDate" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
    </div>
    <div class="mf-actions"><span></span><button class="btn primary" onclick="saveScoreEntry()">Add entry</button></div>`
    +(hist.length?`<div class="nw-sec-h" style="margin-top:14px"><span>History</span></div><div class="nw-list">${rows}</div>`:'')
    +`<div class="mf-actions"><span></span><button class="btn" onclick="closeManual()">Done</button></div>`;
}
function saveScoreEntry(){
  const v=Math.round(_num('csVal')); const d=(gg('csDate').value||'').trim();
  if(!(v>=300&&v<=850)){ gg('csVal').focus(); return; }
  try{ gamiMarkEngaged('score'); }catch(e){}
  if(!d) return;
  const list=_ccScores();
  const i=list.findIndex(x=>x.d===d);
  if(i>=0) list[i]={d,v}; else list.push({d,v});   // one entry per date — re-logging a day updates it
  list.sort((a,b)=>a.d<b.d?-1:1);
  saveState(); scoreEditorRender();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod');
}
function deleteScoreEntry(i){
  const hist=_ccScores().slice().sort((a,b)=>a.d<b.d?1:-1);
  const target=hist[i]; if(!target) return;
  APP.creditScores=_ccScores().filter(x=>!(x.d===target.d&&x.v===target.v));
  saveState(); scoreEditorRender();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}
function creditUtilBody(w){
  const u=engCreditUtil();
  const dti=engDTI();
  if(u.limit<=0){
    const noLimit=engBills().filter(b=>b.cat==='CC' && Math.abs(b.bal||0)>0 && !(b.limit>0));
    if(noLimit.length){
      const btns=noLimit.map(b=>`<button class="cu-setlimit" onclick="event.stopPropagation();openPromoEditor('${esc(b.name).replace(/'/g,"\\\\'")}')">${esc(b.name)} · Set limit ›</button>`).join('');
      return `<div class="wph"><div class="wph-sub">Found ${noLimit.length} card${noLimit.length>1?'s':''}, but your bank didn't report the credit limit${noLimit.length>1?'s':''}.</div><div class="ws-hint" style="margin-top:6px">Many issuers (Amex especially) don't send limits to Plaid. Enter yours and I'll track utilization:</div><div class="cu-nolimit" style="margin-top:11px">${btns}</div></div>`;
    }
    return `<div class="wph"><div class="wph-sub">No credit cards with a limit yet.</div><div class="ws-hint" style="margin-top:6px">Add a card with its limit${plaidHasLiab()?' (or set limits on your live cards)':''} and I'll show utilization + DTI here.</div><div style="text-align:center;margin-top:11px"><button class="manual-add-btn" style="width:auto;display:inline-block" onclick="event.stopPropagation();openManualCard()">➕ Add a card</button></div></div>`;
  }
  // utilization color: <10% green, <30% amber-green, <50% amber, else red
  const uPct=u.pct;
  const uColor = uPct<10?'var(--green)' : uPct<30?'#7bc96f' : uPct<50?'var(--amber)' : 'var(--red)';
  const uLabel = uPct<10?'Excellent' : uPct<30?'Good' : uPct<50?'Fair — aim under 30%' : 'High — pay down to under 30%';
  // semicircular-ish gauge via conic gradient
  const gauge=`<div class="cu-gauge">
    <div class="cu-gauge-ring" style="background:conic-gradient(${uColor} 0% ${Math.min(100,uPct)}%, var(--surface3) ${Math.min(100,uPct)}% 100%)">
      <div class="cu-gauge-hole"><div class="cu-gauge-pct" style="color:${uColor}">${uPct.toFixed(1)}%</div><div class="cu-gauge-cap">utilization</div></div>
    </div>
  </div>`;
  // 30% reference marker line in the per-card bars
  const cardBars=u.cards.map(c=>{
    const cc = c.pct<30?'var(--green)':c.pct<50?'var(--amber)':'var(--red)';
    return `<div class="cu-card">
      <div class="cu-card-top"><span>${esc(c.name)}</span><span style="color:${cc}">${c.pct.toFixed(0)}%</span></div>
      <div class="cu-card-bar"><div class="cu-card-fill" style="width:${Math.min(100,c.pct)}%;background:${cc}"></div><div class="cu-card-mark" title="30% threshold"></div></div>
      <div class="cu-card-sub">${fmtK(c.used)} of ${fmtK(c.limit)}</div>
    </div>`;
  }).join('');
  const dtiPct=dti.ratio*100;
  const dtiColor = dtiPct<36?'var(--green)' : dtiPct<43?'var(--amber)' : 'var(--red)';
  const dtiLabel = dtiPct<36?'Healthy' : dtiPct<43?'Manageable' : 'High';
  return `<div class="cu-wrap">
    <div class="cu-top">
      ${gauge}
      <div class="cu-summary">
        <div class="cu-line"><span>Used</span><b>${fmtK(u.used)}</b></div>
        <div class="cu-line"><span>Total limit</span><b>${fmtK(u.limit)}</b></div>
        <div class="cu-line"><span>Status</span><b style="color:${uColor}">${uLabel}</b></div>
        <div class="cu-dti">
          <div class="cu-dti-top"><span>Debt-to-income</span><b style="color:${dtiColor}">${dtiPct.toFixed(0)}% \u00b7 ${dtiLabel}</b></div>
          <div class="cu-dti-bar"><div class="cu-dti-fill" style="width:${Math.min(100,dtiPct)}%;background:${dtiColor}"></div><div class="cu-dti-mark" title="36% guideline"></div></div>
          <div class="cu-card-sub">${fmtK(dti.debtPay)}/mo debt payments vs ${fmtK(dti.income)}/mo income</div>
        </div>
      </div>
    </div>
    <div class="cu-cards-label">Per-card utilization <span class="ws-hint" style="margin:0">(dotted line = 30%)</span></div>
    <div class="cu-cards">${cardBars}</div>
    ${(()=>{ const nl=engBills().filter(b=>b.cat==='CC'&&Math.abs(b.bal||0)>0&&!(b.limit>0)); return nl.length?`<div class="cu-nolimit" style="margin-top:10px">${nl.map(b=>`<button class="cu-setlimit" onclick="event.stopPropagation();openPromoEditor('${esc(b.name).replace(/'/g,"\\\\'")}')">${esc(b.name)} · Set limit ›</button>`).join('')}</div>`:''; })()}
    <div style="text-align:center;margin-top:11px"><button class="manual-add-btn" style="width:auto;display:inline-block" onclick="event.stopPropagation();openManualCard()">➕ Add a card</button></div>
  </div>`;
}

/* ═══ SAVINGS BUCKETS / SINKING FUNDS WIDGET ═══ */
function savingsBucketsBody(w){
  const buckets=engSavingsBuckets();
  const total=engSavingsTotal();
  const linkBtn=`<button class="sb-link-btn" onclick="event.stopPropagation();openBucketAccounts('${w.uid}')">🔗 Accounts</button>`;
  if(!buckets.length) return `<div class="wph"><div class="wph-sub">No savings buckets yet.</div><div style="display:flex;gap:8px;justify-content:center;margin-top:8px">${linkBtn}<button class="manual-add-btn" style="width:auto" onclick="event.stopPropagation();editBucket(-1)">➕ Add a bucket</button></div></div>`;
  const rows=buckets.map((b,i)=>{
    const color=b.done?'var(--green)':b.pct>=66?'var(--green)':b.pct>=33?'var(--amber)':'var(--blue)';
    const sub = b.done ? 'Funded! 🎉'
      : b.target>0 ? `${fmtK(b.remaining)} to go${b.monthly>0&&b.monthsToGoal!==Infinity?` · ~${b.monthsToGoal} mo at ${fmtK(b.monthly)}/mo`:''}`
      : (b.linked?'live balance':'No target set');
    return `<div class="sb-bucket">
      <div class="sb-top">
        <span class="sb-icon">${b.icon||'🪣'}</span>
        <div class="sb-meta"><div class="sb-nm">${esc(b.name)}${b.linked?'<span class="sb-live">🔗 live</span>':''}</div><div class="sb-sub">${sub}</div></div>
        <div class="sb-amt"><div class="sb-bal">${fmtK(b.balance)}</div>${b.target>0?`<div class="sb-tgt">of ${fmtK(b.target)}</div>`:''}</div>
        <div class="sb-actions"><button class="goal-mini" onclick="event.stopPropagation();editBucket(${i})" title="Edit">✎</button></div>
      </div>
      ${b.target>0?`<div class="sb-bar"><div class="sb-bar-fill" style="width:${b.pct}%;background:${color}"></div></div>`:''}
    </div>`;
  }).join('');
  return `<div class="sb-wrap">
    <div class="sb-header"><span>${buckets.length} fund${buckets.length!==1?'s':''}</span><b style="color:var(--green)">${fmtK(total)} saved</b></div>
    ${rows}
    <div class="sb-foot-actions">${linkBtn}<button class="manual-add-btn" style="width:auto;flex:1" onclick="event.stopPropagation();editBucket(-1)">➕ Add a bucket</button></div>
  </div>`;
}
// Picker: choose which Plaid (or manual) accounts appear as linked buckets
function openBucketAccounts(uid){
  const accts=engAccounts().filter(a=>a.type!=='credit');
  const linked=new Set(_savingsBuckets().filter(b=>b.acctId).map(b=>b.acctId));
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Select accounts';
  gg('manualSub').textContent=dataLoaded?'Pick accounts to show as buckets — balances stay live from Plaid.':'Connect a bank for live balances. (Showing sample accounts.)';
  gg('manualBody').innerHTML=`
    <div class="sb-acct-list">${accts.map(a=>`
      <label class="sb-acct-row">
        <input type="checkbox" ${linked.has(a.id)?'checked':''} onchange="toggleBucketAccount('${a.id}','${uid}')">
        <span class="sb-acct-ic">${_savingsIconFor(a)}</span>
        <span class="sb-acct-meta"><span class="sb-acct-nm">${esc(a.name)}</span><span class="sb-acct-sub">${esc(a.institution||a.subtype||a.type)}${a.mask?' ···'+esc(a.mask):''}</span></span>
        <span class="sb-acct-bal">${fmtK(a.bal)}</span>
      </label>`).join('')||'<div class="ws-hint">No deposit/investment accounts found.</div>'}</div>
    <div class="mf-actions"><span></span><button class="btn primary" onclick="closeManual()">Done</button></div>`;
}
function _savingsIconFor(a){ const s=(a.subtype||'')+' '+(a.type||''); if(/invest|401|ira|brokerage/i.test(s))return '📈'; if(/saving/i.test(s))return '🛟'; if(/check/i.test(s))return '💵'; return '🏦'; }
function toggleBucketAccount(acctId,uid){
  const list=_savingsBuckets();
  const idx=list.findIndex(b=>b.acctId===acctId);
  if(idx>=0){ list.splice(idx,1); }
  else { const a=engAccounts().find(x=>x.id===acctId); if(a) list.push({name:a.name, icon:_savingsIconFor(a), acctId:acctId, balance:0, target:0, monthly:0, note:'linked'}); }
  saveState();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}
let _bucketEdit=null;
function editBucket(i){
  _bucketEdit=i;
  const list=_savingsBuckets();
  const b = i>=0 ? list[i] : {name:'',icon:'🪣',balance:'',target:'',monthly:'',note:'',acctId:''};
  const icons=['🪣','🛟','🔨','🎉','🏥','✈️','🚗','🏠','🎓','💍','🎁','🐾'];
  const accts=engAccounts().filter(a=>a.type!=='credit');
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent = i>=0?'Edit bucket':'Add savings bucket';
  gg('manualSub').textContent='A sinking fund with its own balance and goal.';
  gg('manualBody').innerHTML=`
    <label class="mf-label">Name</label>
    <input class="mf-in" id="bkName" value="${esc(b.name||'')}" placeholder="e.g. Reserve / Opportunity">
    <label class="mf-label">Icon</label>
    <div class="goal-icon-grid">${icons.map(ic=>`<button class="goal-icon-opt${b.icon===ic?' sel':''}" onclick="document.querySelectorAll('.goal-icon-opt').forEach(e=>e.classList.remove('sel'));this.classList.add('sel');window._bkIcon='${ic}'">${ic}</button>`).join('')}</div>
    <label class="mf-label">Balance source</label>
    <select class="mf-in" id="bkAcct" onchange="bkAcctChange()">
      <option value="">— Manual balance —</option>
      ${accts.map(a=>`<option value="${a.id}"${b.acctId===a.id?' selected':''}>🔗 ${esc(a.name)} (${fmtK(a.bal)})</option>`).join('')}
    </select>
    <div class="mf-row">
      <div id="bkBalWrap"><label class="mf-label">Current balance</label><input class="mf-in" id="bkBal" type="number" value="${b.balance||''}" placeholder="0"></div>
      <div><label class="mf-label">Goal target</label><input class="mf-in" id="bkTgt" type="number" value="${b.target||''}" placeholder="0"></div>
    </div>
    <label class="mf-label">Monthly contribution (optional)</label>
    <input class="mf-in" id="bkMo" type="number" value="${b.monthly||''}" placeholder="0">
    <div class="mf-actions">
      ${i>=0?`<button class="btn danger-btn" onclick="deleteBucket(${i})">Delete</button>`:'<span></span>'}
      <button class="btn primary" onclick="saveBucket()">${i>=0?'Save':'Add'}</button>
    </div>`;
  window._bkIcon=b.icon||'🪣';
  bkAcctChange();
}
function bkAcctChange(){
  const sel=gg('bkAcct'); const wrap=gg('bkBalWrap'); if(!sel||!wrap) return;
  const linked=!!sel.value;
  wrap.style.display=linked?'none':'block';
  if(linked){ const a=engAccounts().find(x=>x.id===sel.value); const nm=gg('bkName'); if(a && nm && !nm.value.trim()) nm.value=a.name; }
}
function saveBucket(){
  const name=(gg('bkName').value||'').trim(); if(!name){ gg('bkName').focus(); return; }
  try{ gamiMarkEngaged('bucket'); }catch(e){}
  const acctId=gg('bkAcct')?gg('bkAcct').value:'';
  const item={name, icon:window._bkIcon||'🪣', acctId:acctId||'', balance: acctId?0:_num('bkBal'), target:_num('bkTgt'), monthly:_num('bkMo'), note:acctId?'linked':''};
  const list=_savingsBuckets();
  if(_bucketEdit>=0) list[_bucketEdit]=item; else list.push(item);
  saveState(); closeManual();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
  if(sbRichie)sbRichie.do('nod');
  try{ bucketCheckGoals(); }catch(e){}   // just funded one to its target? 🎊
}
function deleteBucket(i){ if(!confirm('Delete this bucket?'))return; _savingsBuckets().splice(i,1); saveState(); closeManual(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }

/* ═══ BUDGET BY CATEGORY — two-tier donuts (groups + categories) ═══ */
function budgetTiersBody(w){
  const days=wDays(w);
  let kids = dataLoaded ? engCategoryBreakdown(days) : [
    {label:'Housing',value:2640},{label:'Loan Payments',value:780},{label:'Dining Out',value:612},
    {label:'Food & Groceries',value:498},{label:'Auto Payments',value:452},{label:'Utilities',value:320},
    {label:'Insurance',value:266},{label:'Shopping',value:240},{label:'Gas & Fuel',value:233},
    {label:'Medical',value:178},{label:'Subscriptions',value:142},{label:'Entertainment',value:121}
  ].map(c=>({...c,color:getCatColor(c.label)}));
  kids=kids.filter(c=>c.value>0).sort((a,b)=>b.value-a.value);
  if(!kids.length) return `<div class="wph"><div class="wph-sub">No spending to chart yet.</div></div>`;
  const total=kids.reduce((s,c)=>s+c.value,0);
  // Tier 1 — roll up into parent groups
  const gmap={};
  kids.forEach(c=>{ const p=getCatParent(c.label); if(!gmap[p.id])gmap[p.id]={label:p.label,color:p.color,value:0}; gmap[p.id].value+=c.value; });
  const groups=Object.values(gmap).sort((a,b)=>b.value-a.value);
  // Tier 2 — top 8 categories + Other
  let cats2=kids.slice();
  if(cats2.length>8){ const top=cats2.slice(0,8); const rest=cats2.slice(8).reduce((s,c)=>s+c.value,0); top.push({label:'Other',value:rest,color:'#94a3b8'}); cats2=top; }
  const legend=(items)=>items.map(it=>`<div class="bd2-leg-item"><span class="bd2-dot" style="background:${it.color}"></span><span class="bd2-leg-l">${esc(it.label)}</span><span class="bd2-leg-v">${fmtK(it.value)} · ${Math.round(it.value/total*100)}%</span></div>`).join('');
  return `<div class="bd2-wrap">
    <div class="bd2-col">
      <div class="bd2-title">By group</div>
      <div class="bd2-chart">${_donutSVG(groups,128,fmtK(total),'total')}</div>
      <div class="bd2-legend">${legend(groups)}</div>
    </div>
    <div class="bd2-col">
      <div class="bd2-title">By category</div>
      <div class="bd2-chart">${_donutSVG(cats2,128,String(kids.length),'categories')}</div>
      <div class="bd2-legend">${legend(cats2)}</div>
    </div>
  </div>${dataLoaded?'':'<div class="ws-hint" style="margin-top:8px;text-align:center">sample data — connect a bank for live spending</div>'}`;
}

/* ═══ SPENDING HUB — one widget, four lenses ═══
   Consolidates the spending views into tabs (this month vs budget · trend · top
   categories · seasonal). Each tab reuses its existing widget body verbatim; all four
   are pure-innerHTML (no chart canvas), so no per-tab mount is needed. */
const SPEND_TABS=[
  {id:'now',    label:'Now',        type:'spending_month'},
  {id:'trend',  label:'Trend',      type:'spending_trends'},
  {id:'cats',   label:'Categories', type:'top_categories'},
  {id:'season', label:'Seasonal',   type:'category_heatmap'},
];
let _spendHub={};
function spendingHubBody(w){
  const cur=_spendHub[w.uid]||'now';
  const tabs=SPEND_TABS.map(t=>`<button class="hub-tab${cur===t.id?' on':''}" onclick="event.stopPropagation();spendHubTab('${w.uid}','${t.id}')">${esc(t.label)}</button>`).join('');
  return `<div class="hub-wrap"><div class="hub-tabs">${tabs}</div><div class="hub-body" id="shub_${w.uid}"></div></div>`;
}
function spendHubTab(uid,tab){ _spendHub[uid]=tab; const w=_findWidget(uid); if(w) spendHubMount(w); }
function spendHubMount(w){
  const cur=_spendHub[w.uid]||'now';
  const wrap=gg('shub_'+w.uid); if(!wrap) return;
  const t=SPEND_TABS.find(x=>x.id===cur)||SPEND_TABS[0];
  try{ wrap.innerHTML=renderWidgetBody({...w, type:t.type}); }catch(e){ wrap.innerHTML='<div class="acct-empty">—</div>'; }
  const btns=wrap.parentElement.querySelectorAll('.hub-tab');
  SPEND_TABS.forEach((x,i)=>{ if(btns[i]) btns[i].classList.toggle('on', x.id===cur); });
}

/* ═══ CURRENT (DISCRETIONARY) SPENDING WIDGET ═══ */
function discretionarySpendBody(w){
  const days=wDays(w);
  // Linked to the Zero-Based Budget: the focus number counts ONLY categories that have a
  // budget envelope; total spending (all categories) shows alongside. With no budget set
  // up yet, fall back to the legacy discretionary view.
  const bcats=_budgetCatSet();
  const linked=bcats.size>0;
  let all;
  if(dataLoaded){
    all=engCategoryBreakdown(days);
  } else {
    // sample mode: derive from the latest month of the category grid, scaled to window
    const g=engCategoryMonthGrid(6);
    const li=g.months.length-1;
    all=g.cats.map(c=>({label:c.label,value:Math.round((c.vals[li]||0)*(days/30)),color:c.color})).filter(r=>r.value>0).sort((a,b)=>b.value-a.value);
  }
  const totalSpend=all.reduce((s,r)=>s+r.value,0);
  let disc=linked?all.filter(r=>bcats.has(r.label)):all.filter(r=>isDiscretionary(r.label));
  const hidden=(w.hiddenCats||[]);
  if(hidden.length) disc=disc.filter(r=>!hidden.includes(r.label));
  const spend=disc.reduce((s,r)=>s+r.value,0);
  const top=disc[0];
  const budget=(linked?engBudgetLinkedBudget():engDiscretionaryBudget())*(days/30);
  const pct = budget>0 ? spend/budget*100 : 0;
  const over = spend>budget;
  const color = pct<85?'var(--green)' : pct<=100?'var(--amber)' : 'var(--red)';
  const remaining = budget-spend;
  const series=engDiscretionaryMonthly(6, linked?bcats:null);
  const vals=series.map(s=>s.value);
  const prev=vals.length>1?vals[vals.length-2]:0;
  const cur=vals[vals.length-1]||spend;
  const trendUp = cur>prev;
  const trendPct = prev>0?Math.round((cur-prev)/prev*100):0;
  const trendColor = trendUp?'var(--red)':'var(--pos)';  // spending up = bad
  const scope = linked?'in budget':'discretionary';
  const sub = (w.tf==='30d'||!w.tf) ? scope+' · last 30 days' : `${scope} · ${tfLabel(w.tf)}`;
  const filterBtn=`<button class="cash-pick" onclick="event.stopPropagation();openSpendCatPicker('${w.uid}')" title="Choose which categories to include">⚙︎</button>`;
  return `<div class="wph">
    <div class="wph-stat" style="color:${(budget>0&&spend>budget)?'var(--red)':'var(--pos)'}">${fmtK(spend)}</div>
    <div class="wph-sub">${sub}${dataLoaded?'':' · sample'}${hidden.length?` · ${hidden.length} hidden`:''} ${filterBtn}</div>
    <div class="ds-budget">
      <div class="ds-budget-top">
        <span style="color:${color};font-weight:700">${Math.round(pct)}% of ${fmtK(budget)} budget</span>
        <span style="color:${over?'var(--red)':'var(--muted)'}">${over?fmtK(-remaining)+' over':fmtK(remaining)+' left'}</span>
      </div>
      <div class="ds-bar"><div class="ds-bar-fill" style="width:${Math.min(100,pct)}%;background:${color}"></div></div>
      <div class="ds-budget-top" style="margin-top:7px">
        <span style="color:var(--muted)">Total spending · all categories</span>
        <span style="font-weight:700">${fmtK(totalSpend)}</span>
      </div>
    </div>
    <div class="ds-foot">
      <div class="ds-trend">${_sparkline(vals, trendColor, 92, 26)}</div>
      <div class="ds-trend-meta">
        <div class="ds-trend-label" style="color:${trendColor}">${trendUp?'▲':'▼'} ${Math.abs(trendPct)}% vs last mo</div>
        ${top?`<div class="ds-top"><span class="wph-dot" style="background:${top.color}"></span>Top: ${esc(top.label)} ${fmtK(top.value)}</div>`:''}
      </div>
    </div>
  </div>`;
}

/* ═══ BUDGET vs ACTUAL WIDGET ═══ */
let _baTf={};
function budgetActualBody(w){
  const tf=_baTf[w.uid]||30;
  const d=engBudgetVsActual(tf);
  if(!d.rows.length) return `<div class="wph"><div class="wph-sub">Set up your Zero-Based Budget first, then this compares it to actual spending.</div></div>`;
  const tfLbl={7:'1 wk',30:'This month',90:'3 mo'};
  const rows=d.rows.map(r=>{
    const barColor = r.over?'var(--red)':r.pct>=85?'var(--amber)':'var(--green)';
    const diffColor = r.diff>=0?'var(--pos)':'var(--red)';
    return `<div class="ba-row">
      <div class="ba-top"><span class="ba-nm"><span class="ba-dot" style="background:${r.color}"></span>${esc(r.name)}${r.unbudgeted?'<span class="ba-unbud">unbudgeted</span>':''}</span><span class="ba-diff" style="color:${diffColor}">${r.diff>=0?'+':'-'}${fmtK(Math.abs(r.diff))}</span></div>
      <div class="ba-bar"><div class="ba-bar-fill" style="width:${Math.min(100,r.pct)}%;background:${barColor}"></div>${r.budget>0?'<div class="ba-bar-mark" title="budget"></div>':''}</div>
      <div class="ba-sub">${fmtK(r.actual)} spent ${r.budget>0?'of '+fmtK(r.budget)+(r.over?' · <b style="color:var(--red)">over</b>':' budget'):'· <b style="color:var(--amber)">no budget set</b>'}</div>
    </div>`;
  }).join('');
  const totColor=d.totDiff>=0?'var(--pos)':'var(--red)';
  return `<div class="ba-wrap">
    <div class="ba-toolbar">
      <div class="pl-toggle">${[7,30,90].map(k=>`<button class="pl-gbtn${tf===k?' active':''}" onclick="setBaTf('${w.uid}',${k})">${tfLbl[k]}</button>`).join('')}</div>
      <button class="wx-export" onclick="event.stopPropagation();exportWidget('budget_actual')" title="Export to Excel">⬇ Excel</button>
    </div>
    <div class="ba-summary">
      <div class="ba-sumcell"><div class="ba-suml">Budgeted</div><div class="ba-sumv">${fmtK(d.totBudget)}</div></div>
      <div class="ba-sumcell"><div class="ba-suml">Actual</div><div class="ba-sumv">${fmtK(d.totActual)}</div></div>
      <div class="ba-sumcell"><div class="ba-suml">Difference</div><div class="ba-sumv" style="color:${totColor}">${d.totDiff>=0?'+':'-'}${fmtK(Math.abs(d.totDiff))}</div></div>
    </div>
    ${dataLoaded?'':'<div class="ws-hint" style="margin:0 0 10px">Sample actuals — connect a bank for real spending.</div>'}
    ${rows}
  </div>`;
}
function setBaTf(uid,k){ _baTf[uid]=k; const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }

/* ═══ CATEGORY HEATMAP WIDGET ═══ */
let _hmMonths={};
function categoryHeatmapBody(w){
  const months=_hmMonths[w.uid]||6;
  const g=engCategoryMonthGrid(months);
  if(!g.cats.length) return `<div class="wph"><div class="wph-sub">No spending data yet to chart.</div></div>`;
  const cats=g.cats.slice(0,10); // top 10 by total
  // heat color: scale 0..max → light to intense green/amber/red
  const heat=(v)=>{
    if(v<=0) return 'var(--surface3)';
    const t=Math.min(1, v/g.max);
    // interpolate: low=cool teal, mid=amber, high=red
    if(t<0.5){ const k=t/0.5; return `rgba(46,204,138,${0.15+k*0.55})`; }
    const k=(t-0.5)/0.5; return `rgba(${Math.round(240)}, ${Math.round(165-k*73)}, ${Math.round(64)}, ${0.55+k*0.4})`;
  };
  const head=`<div class="hm-row hm-head"><div class="hm-cat"></div>${g.months.map(mo=>`<div class="hm-cell hm-mlabel">${mo}</div>`).join('')}<div class="hm-cell hm-avg-h">avg</div></div>`;
  const rows=cats.map(c=>{
    const cells=c.vals.map(v=>`<div class="hm-cell" style="background:${heat(v)}" title="${esc(c.label)}: ${fmtK(v)}">${v>0?`<span class="hm-v">${v>=1000?(v/1000).toFixed(1)+'k':Math.round(v)}</span>`:''}</div>`).join('');
    return `<div class="hm-row"><div class="hm-cat" title="${esc(c.label)}"><span class="hm-dot" style="background:${c.color}"></span>${esc(c.label)}</div>${cells}<div class="hm-cell hm-avg">${fmtK(c.avg)}</div></div>`;
  }).join('');
  return `<div class="hm-wrap">
    <div class="hm-toolbar"><div class="pl-toggle">${[3,6,12].map(k=>`<button class="pl-gbtn${months===k?' active':''}" onclick="setHmMonths('${w.uid}',${k})">${k} mo</button>`).join('')}</div><div style="display:flex;align-items:center;gap:8px">${dataLoaded?'':'<span class="ws-hint" style="margin:0">sample data</span>'}<button class="wx-export" onclick="event.stopPropagation();exportWidget('category_heatmap')" title="Export to Excel">⬇ Excel</button></div></div>
    <div class="hm-grid">${head}${rows}</div>
  </div>`;
}
function setHmMonths(uid,k){ _hmMonths[uid]=k; const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }

/* Export a single widget's data to its own one-sheet workbook */
async function exportWidget(kind){
  if(typeof XLSX==='undefined'){ try{ await _loadScript(XLSX_CDN_SRC); }catch(e){} }
  if(typeof XLSX==='undefined'){ alert('Spreadsheet library failed to load — check your connection and try again.'); return; }
  const wb=XLSX.utils.book_new(); const today=new Date(); const money=(n)=>Math.round((n||0)*100)/100;
  let name='Export';
  if(kind==='budget_actual'){
    const d=engBudgetVsActual(30); name='Budget_vs_Actual';
    const rows=[['Category','Budgeted','Actual','Difference','% of budget']];
    d.rows.forEach(r=>rows.push([r.name,money(r.budget),money(r.actual),money(r.diff),Math.round(r.pct)+'%']));
    rows.push(['Totals',money(d.totBudget),money(d.totActual),money(d.totDiff)]);
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Budget vs Actual');
  } else if(kind==='category_heatmap'){
    const g=engCategoryMonthGrid(12); name='Category_Heatmap';
    const rows=[['Category',...g.months,'Average']];
    g.cats.forEach(c=>rows.push([c.label,...c.vals.map(money),money(c.avg)]));
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Heatmap');
  } else if(kind==='cashflow_planner'){
    const p=engCashFlowProjection(90); name='Cash_Flow'; const rows=[['Day','Date','Event','Amount','Running Balance']];
    let bal=p.start; const byDay=p.byDay||{};
    for(let d=1; d<=p.days; d++){ if(byDay[d]){ byDay[d].forEach(e=>{ bal+=e.amt; const dt=new Date(today.getTime()+d*86400000); rows.push([d,dt.toLocaleDateString(),e.name,money(e.amt),money(bal)]); }); } }
    XLSX.utils.book_append_sheet(wb,_xlsxSheet(rows),'Cash Flow');
  } else { exportToExcel(); return; }
  XLSX.writeFile(wb, `Richie_${name}_${today.toISOString().slice(0,10)}.xlsx`);
  if(typeof sbRichie!=='undefined'&&sbRichie) sbRichie.do('nod');
}

/* ═══ FINANCIAL GOALS WIDGET ═══ */
function goalsWidgetBody(w){
  checkGoalCompletion();
  const goals=_goals();
  const active=goals.filter(g=>!g.completed);
  const done=goals.filter(g=>g.completed);
  let html='<div class="goals-wrap">';
  if(!goals.length){
    html+=`<div class="goals-empty">
      <div class="goals-empty-icon">🎯</div>
      <div class="goals-empty-title">No goals yet</div>
      <div class="goals-empty-sub">Pick a preset or build your own — Richie will track your progress and cheer you on.</div>
    </div>`;
  } else {
    html+=active.map(g=>goalCard(g)).join('');
    if(done.length){
      html+=`<div class="goals-done-label">✓ Completed (${done.length})</div>`;
      html+=done.map(g=>goalCard(g)).join('');
    }
  }
  html+=`<div class="goals-actions">
    <button class="manual-add-btn" onclick="event.stopPropagation();openGoalWizard()">\u2795 Add a goal</button>
    <button class="goals-preset-btn" onclick="event.stopPropagation();openGoalPresets()">⚡ Quick goals</button>
  </div>`;
  html+='</div>';
  return html;
}
function goalCard(g){
  const p=goalProgress(g); const m=GOAL_METRICS[g.metric]||{};
  const icon=g.icon||m.icon||'🎯';
  const barColor=p.done?'var(--green)':p.pct>=66?'var(--green)':p.pct>=33?'var(--amber)':'var(--blue)';
  const curStr=goalFmt(p.current,p.unit), tgtStr=goalFmt(p.target,p.unit);
  // deadline pacing chip
  let paceRow='';
  if(p.pace && !p.done){
    const pc=p.pace;
    const trackColor=pc.onTrack?'var(--green)':'var(--amber)';
    const trackTxt=pc.onTrack?'on track':'behind pace';
    const dlStr=pc.deadline.toLocaleDateString('en-US',{month:'short',year:'numeric'});
    const need = p.unit==='%' ? '' : ` · need ${fmtK(pc.perMonthNeeded)}/mo`;
    const timeLeft = pc.daysLeft<0?'overdue' : pc.monthsLeft<1.5?`${pc.daysLeft}d left` : `${Math.round(pc.monthsLeft)} mo left`;
    paceRow=`<div class="goal-pace"><span class="goal-pace-dot" style="background:${trackColor}"></span><span style="color:${trackColor}">${trackTxt}</span> · by ${dlStr} · ${timeLeft}${need}</div>`;
  }
  return `<div class="goal-card${p.done?' done':''}">
    <div class="goal-top">
      <span class="goal-icon">${icon}</span>
      <div class="goal-meta"><div class="goal-name">${esc(g.name)}</div><div class="goal-sub">${m.label||'Custom'}${g.deadline?` · by ${esc(g.deadline)}`:''}</div></div>
      <div class="goal-actions">
        ${p.done?'<span class="goal-badge">Done 🎉</span>':`<button class="goal-mini" onclick="event.stopPropagation();richieGoalHint(_goalById('${g.id}'))" title="Get a hint">💡</button>`}
        ${g.metric==='custom'&&!p.done?`<button class="goal-mini" onclick="event.stopPropagation();goalUpdateCustom('${g.id}')" title="Update progress">✎</button>`:''}
        <button class="goal-mini danger" onclick="event.stopPropagation();removeGoal('${g.id}')" title="Remove">\u2715</button>
      </div>
    </div>
    <div class="goal-bar"><div class="goal-bar-fill" style="width:${p.pct}%;background:${barColor}"></div></div>
    <div class="goal-foot"><span>${curStr} ${p.dir==='down'?'remaining':'saved'}</span><span class="goal-pct">${p.pct}%</span><span>target ${tgtStr}</span></div>
    ${paceRow}
  </div>`;
}
function _goalById(id){ return _goals().find(g=>g.id===id); }
function goalUpdateCustom(id){
  const g=_goalById(id); if(!g) return;
  const v=prompt(`Update progress for "${g.name}" (current amount):`, g.current||0);
  if(v===null) return; const n=parseFloat(v); if(!isNaN(n)){ g.current=n; saveState(); checkGoalCompletion(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
}

/* ── Goal presets (one-tap activation) ── */
function openGoalPresets(){
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Quick goals';
  gg('manualSub').textContent='Tap one to activate it instantly — Richie tracks the rest.';
  const existing=_goals().map(g=>g.presetKey);
  gg('manualBody').innerHTML=`<div class="goal-preset-grid">${GOAL_PRESETS.map(p=>{
    const added=existing.includes(p.key);
    return `<button class="goal-preset-card${added?' added':''}" ${added?'disabled':''} onclick="activatePreset('${p.key}')">
      <span class="gpc-icon">${p.icon}</span>
      <span class="gpc-name">${p.name}</span>
      <span class="gpc-blurb">${p.blurb}</span>
      ${added?'<span class="gpc-added">✓ Active</span>':'<span class="gpc-add">+ Activate</span>'}
    </button>`;
  }).join('')}</div>`;
}
function activatePreset(key){
  const p=GOAL_PRESETS.find(x=>x.key===key); if(!p) return;
  const target = p.target!=null ? p.target : goalAutoTarget(p.auto);
  addGoal({name:p.name, metric:p.metric, target, icon:p.icon, presetKey:p.key});
  closeManual();
  const pg=APP.pages.find(pp=>pp.id===APP.activePage); if(pg)renderCanvas(pg);
}

/* ── Goal wizard (custom goal, 3 steps) ── */
let _goalWiz={step:1, data:{}};
function openGoalWizard(){
  _goalWiz={step:1, data:{metric:'savings', name:'', target:'', icon:'🎯', deadline:''}};
  gg('manualModal').style.display='flex';
  goalWizRender();
}
function goalWizRender(){
  const d=_goalWiz.data; const step=_goalWiz.step;
  gg('manualTitle').textContent='New goal';
  gg('manualSub').textContent=`Step ${step} of 3`;
  const body=gg('manualBody');
  if(step===1){
    body.innerHTML=`<div class="mf-label">What kind of goal?</div>
      <div class="goal-metric-grid">${Object.entries(GOAL_METRICS).map(([k,m])=>`<button class="goal-metric-opt${d.metric===k?' sel':''}" onclick="goalWizSet('metric','${k}')"><span style="font-size:22px">${m.icon}</span><span>${m.label}</span></button>`).join('')}</div>
      <div class="mf-actions"><span></span><button class="btn primary" onclick="goalWizNext()">Next →</button></div>`;
  } else if(step===2){
    const m=GOAL_METRICS[d.metric];
    const suggest = d.metric==='emergency'?goalAutoTarget('3mo'):d.metric==='networth'?100000:d.metric==='savings'?10000:d.metric==='savingsrate'?20:d.metric==='debt'?0:1000;
    body.innerHTML=`<div class="mf-label">Name your goal</div>
      <input class="mf-in" id="gwName" value="${esc(d.name||m.label)}" placeholder="e.g. ${m.label}">
      <div class="mf-label">Target ${m.unit==='%'?'(%)':'amount ($)'}</div>
      <input class="mf-in" id="gwTarget" type="number" value="${d.target||suggest}" placeholder="${suggest}">
      <div class="mf-label">Target date (optional)</div>
      <input class="mf-in" id="gwDeadline" type="date" value="${esc(d.deadline||'')}">
      ${m.dir==='down'?`<div class="ws-hint">Tracks downward from your current ${m.label.toLowerCase()} (${goalFmt(m.get(),m.unit)}) to your target.</div>`:`<div class="ws-hint">Tracks from your current ${m.label.toLowerCase()} (${goalFmt(m.get()||0,m.unit)}) up to your target.</div>`}
      <div class="mf-actions"><button class="btn" onclick="goalWizBack()">← Back</button><button class="btn primary" onclick="goalWizNext()">Next →</button></div>`;
  } else {
    const m=GOAL_METRICS[d.metric];
    const icons=['🎯','💰','🛟','🚀','💎','🔥','✂️','🏖️','📈','🏠','🚗','🎓','💍','✈️'];
    body.innerHTML=`<div class="mf-label">Pick an icon</div>
      <div class="goal-icon-grid">${icons.map(ic=>`<button class="goal-icon-opt${d.icon===ic?' sel':''}" onclick="goalWizSet('icon','${ic}')">${ic}</button>`).join('')}</div>
      <div class="goal-wiz-review">
        <div class="grow"><span>Goal</span><b>${esc(d.name||m.label)}</b></div>
        <div class="grow"><span>Tracks</span><b>${m.label}</b></div>
        <div class="grow"><span>Target</span><b>${goalFmt(parseFloat(d.target)||0,m.unit)}</b></div>
        ${d.deadline?`<div class="grow"><span>By</span><b>${esc(d.deadline)}</b></div>`:''}
      </div>
      <div class="ws-hint">Creating a goal earns +25 XP. Completing it earns +50 XP. 🎉</div>
      <div class="mf-actions"><button class="btn" onclick="goalWizBack()">← Back</button><button class="btn primary" onclick="goalWizFinish()">Create goal ✓</button></div>`;
  }
}
function goalWizSet(k,v){ _goalWiz.data[k]=v; goalWizRender(); }
function goalWizNext(){
  if(_goalWiz.step===2){
    _goalWiz.data.name=(gg('gwName').value||'').trim()||GOAL_METRICS[_goalWiz.data.metric].label;
    _goalWiz.data.target=gg('gwTarget').value;
    _goalWiz.data.deadline=(gg('gwDeadline').value||'').trim();
  }
  _goalWiz.step=Math.min(3,_goalWiz.step+1); goalWizRender();
}
function goalWizBack(){ _goalWiz.step=Math.max(1,_goalWiz.step-1); goalWizRender(); }
function goalWizFinish(){
  const d=_goalWiz.data;
  addGoal({name:d.name, metric:d.metric, target:parseFloat(d.target)||0, icon:d.icon, deadline:d.deadline});
  closeManual();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}

/* ═══ CASH FLOW PLANNER WIDGET ═══ */
let _cfpRange={};  // per-widget projection window in days
const CFP_RANGES=[{k:7,l:'1 wk'},{k:30,l:'30 days'},{k:60,l:'60 days'},{k:90,l:'90 days'}];
/* Shared running-balance line chart (used by both the Planner and the Cash Flow widget) */
function cfpLineSVG(p, idSuffix, W, H){
  W=W||300; H=H||80; const pad=4;
  const s=p.series||[]; if(!s.length) return '';
  const min=Math.min(...s.map(x=>x.bal),0), max=Math.max(...s.map(x=>x.bal),1);
  const rng=(max-min)||1;
  const X=d=>pad+(d/p.days)*(W-pad*2);
  const Y=b=>H-pad-((b-min)/rng)*(H-pad*2);
  const zeroY=Y(0);
  const pts=s.map(x=>`${X(x.day).toFixed(1)},${Y(x.bal).toFixed(1)}`).join(' ');
  const area=`${pad},${H-pad} ${pts} ${X(p.days).toFixed(1)},${H-pad}`;
  const lowX=X(p.low.day), lowY=Y(p.low.bal);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
    <defs><linearGradient id="cfpg_${idSuffix}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--green)" stop-opacity="0.3"/><stop offset="100%" stop-color="var(--green)" stop-opacity="0"/></linearGradient></defs>
    ${min<0?`<line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" stroke="var(--red)" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>`:''}
    <polygon points="${area}" fill="url(#cfpg_${idSuffix})"/>
    <polyline points="${pts}" fill="none" stroke="var(--green)" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${lowX.toFixed(1)}" cy="${lowY.toFixed(1)}" r="3.5" fill="${p.low.bal<0?'var(--red)':'var(--amber)'}"/>
  </svg>`;
}

/* ═══ CASH FLOW widget — same running-balance line as the Planner, same engine ═══ */
function cashflowChartBody(w){
  const range=_cfpRange['cfc'+w.uid]||30;
  return `<div class="cfp-wrap">
    <div class="cfp-toolbar">
      <span class="pl-grp-label">Project</span>
      <div class="pl-toggle">${CFP_RANGES.map(r=>`<button class="pl-gbtn${range===r.k?' active':''}" onclick="setCfcRange('${w.uid}',${r.k})">${r.l}</button>`).join('')}</div>
    </div>
    <div class="cfp-summary" id="cfcsum_${w.uid}"></div>
    <div class="cfp-chart" id="cfcchart_${w.uid}"></div>
    <div class="cfp-lowflag" id="cfclow_${w.uid}"></div>
  </div>`;
}
function setCfcRange(uid,k){ _cfpRange['cfc'+uid]=k; const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function cfcMount(w){
  const range=_cfpRange['cfc'+w.uid]||30;
  const p=engCashFlowProjection(range);
  const sum=gg('cfcsum_'+w.uid);
  if(sum){ sum.innerHTML=`
    <div class="cfp-stat"><div class="cfp-stat-l">Starting cash</div><div class="cfp-stat-v">${fmtK(p.start)}</div></div>
    <div class="cfp-stat"><div class="cfp-stat-l">Income in</div><div class="cfp-stat-v" style="color:var(--green)">+${fmtK(p.totalIn)}</div></div>
    <div class="cfp-stat"><div class="cfp-stat-l">Bills out</div><div class="cfp-stat-v" style="color:var(--red)">-${fmtK(p.totalOut)}</div></div>
    ${p.totalSaved>0?`<div class="cfp-stat"><div class="cfp-stat-l">Set aside</div><div class="cfp-stat-v" style="color:var(--blue)">-${fmtK(p.totalSaved)}</div></div>`:''}
    <div class="cfp-stat"><div class="cfp-stat-l">End balance</div><div class="cfp-stat-v" style="color:${p.end>=0?'var(--pos)':'var(--red)'}">${fmtK(p.end)}</div></div>`;
  }
  const chart=gg('cfcchart_'+w.uid);
  if(chart){ chart.innerHTML=cfpLineSVG(p, 'cfc'+w.uid, 300, 80); }
  const low=gg('cfclow_'+w.uid);
  if(low){
    const lowWhen=p.low.day===0?'today':_projDate(p.low.day).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    if(p.low.bal<0){ low.className='cfp-lowflag danger'; low.innerHTML=`⚠️ Dips to <b>${fmtK(p.low.bal)}</b> on <b>${lowWhen}</b>. Open the Planner to adjust.`; }
    else if(p.low.bal<200){ low.className='cfp-lowflag warn'; low.innerHTML=`⚡ Tight — low point <b>${fmtK(p.low.bal)}</b> around <b>${lowWhen}</b>.`; }
    else { low.className='cfp-lowflag ok'; low.innerHTML=`✅ Stays above <b>${fmtK(p.low.bal)}</b> (low point <b>${lowWhen}</b>).`; }
  }
}

function cfpWidgetBody(w){
  const range=_cfpRange[w.uid]||30;
  return `<div class="cfp-wrap">
    <div class="cfp-toolbar">
      <span class="pl-grp-label">Project</span>
      <div class="pl-toggle">${CFP_RANGES.map(r=>`<button class="pl-gbtn${range===r.k?' active':''}" onclick="setCfpRange('${w.uid}',${r.k})">${r.l}</button>`).join('')}</div>
      <button class="cfp-income-btn" onclick="event.stopPropagation();openIncomeEditor()">💵 Income</button>
      <button class="cfp-income-btn" onclick="event.stopPropagation();openAcctCatPicker('${w.uid}')" title="Choose which accounts pay your bills">🏦 Accounts</button>
      <button class="wx-export" onclick="event.stopPropagation();exportWidget('cashflow_planner')" title="Export to Excel">⬇ Excel</button>
    </div>
    <div class="cfp-scope" id="cfpscope_${w.uid}"></div>
    <div class="cfp-summary" id="cfpsum_${w.uid}"></div>
    <div class="cfp-chart" id="cfpchart_${w.uid}"></div>
    <div class="cfp-lowflag" id="cfplow_${w.uid}"></div>
    <div class="cfp-section-label">Upcoming events <span class="ws-hint" style="margin:0">tap a bill to edit what you'll pay</span></div>
    <div class="cfp-events" id="cfpev_${w.uid}"></div>
  </div>`;
}
function setCfpRange(uid,k){ _cfpRange[uid]=k; const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function cfpMount(w){
  const range=_cfpRange[w.uid]||30;
  const cats=(w.acctCats&&w.acctCats.length)?w.acctCats:['cash','savings'];
  const p=engCashFlowProjection(range, cats);
  const scope=gg('cfpscope_'+w.uid);
  if(scope){ scope.innerHTML=`💳 Paying bills from: <b>${cats.map(c=>acctCatDef(c).label).join(' + ')||'—'}</b> <button class="cfp-scope-edit" onclick="event.stopPropagation();openAcctCatPicker('${w.uid}')">change</button>`; }
  // summary stats
  const sum=gg('cfpsum_'+w.uid);
  if(sum){ sum.innerHTML=`
    <div class="cfp-stat"><div class="cfp-stat-l">Starting cash</div><div class="cfp-stat-v">${fmtK(p.start)}</div></div>
    <div class="cfp-stat"><div class="cfp-stat-l">Income in</div><div class="cfp-stat-v" style="color:var(--green)">+${fmtK(p.totalIn)}</div></div>
    <div class="cfp-stat"><div class="cfp-stat-l">Bills out</div><div class="cfp-stat-v" style="color:var(--red)">-${fmtK(p.totalOut)}</div></div>
    ${p.totalSaved>0?`<div class="cfp-stat"><div class="cfp-stat-l">Set aside</div><div class="cfp-stat-v" style="color:var(--blue)">-${fmtK(p.totalSaved)}</div></div>`:''}
    <div class="cfp-stat"><div class="cfp-stat-l">End balance</div><div class="cfp-stat-v" style="color:${p.end>=0?'var(--pos)':'var(--red)'}">${fmtK(p.end)}</div></div>`;
  }
  // running balance line (mini SVG sparkline so it works everywhere, no Chart.js dependency)
  const chart=gg('cfpchart_'+w.uid);
  if(chart){ chart.innerHTML=cfpLineSVG(p, w.uid, 300, 80); }
  // low-point flag
  const low=gg('cfplow_'+w.uid);
  if(low){
    const lowWhen=p.low.day===0?'today':_projDate(p.low.day).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    if(p.low.bal<0){ low.className='cfp-lowflag danger'; low.innerHTML=`⚠️ Projected shortfall: balance dips to <b>${fmtK(p.low.bal)}</b> on <b>${lowWhen}</b>. Adjust a bill below or move income.`; }
    else if(p.low.bal<200){ low.className='cfp-lowflag warn'; low.innerHTML=`⚡ Tight: lowest balance is <b>${fmtK(p.low.bal)}</b> around <b>${lowWhen}</b>.`; }
    else { low.className='cfp-lowflag ok'; low.innerHTML=`✅ Safe: your balance stays above <b>${fmtK(p.low.bal)}</b> (low point <b>${lowWhen}</b>).`; }
  }
  // editable upcoming events (bills editable, income shown)
  const ev=gg('cfpev_'+w.uid);
  if(ev){
    const sorted=[...p.events].sort((a,b)=> a.day-b.day || (a.type==='income'?-1:b.type==='income'?1:0)).slice(0,80);
    // group events under a date header with the day's net (calendar-register style)
    const groups=[]; sorted.forEach(e=>{ let g=groups[groups.length-1]; if(!g||g.day!==e.day){ g={day:e.day, items:[]}; groups.push(g); } g.items.push(e); });
    let run=p.start;
    const body=groups.map(g=>{
      const dt=_projDate(g.day);
      const dateLbl=g.day===0?'Today':dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
      const dow=g.day===0?'':dt.toLocaleDateString('en-US',{weekday:'short'});
      let dayNet=0;
      const items=g.items.map(e=>{
        const isOff=!!e.off;
        if(!isOff){ run+=e.amt; dayNet+=e.amt; }  // running balance after this event (skipped income doesn't count)
        const runColor=run<0?'var(--red)':run<200?'var(--amber)':'var(--text)';
        const runBadge=`<span class="cfp-ev-run" style="color:${runColor}">${run<0?'-':''}${fmtK(Math.abs(run))}</span>`;
        if(e.type==='income'){
          const ik=String(e.key||'').replace(/'/g,"\\'");
          return `<div class="cfp-ev income${isOff?' cfp-ev-off':''}"><input type="checkbox" class="cfp-ev-chk" ${isOff?'':'checked'} onclick="event.stopPropagation();cfpToggleIncome('${ik}','${w.uid}')" title="Uncheck if this deposit won't actually land — it drops out of every projection"><span class="cfp-ev-nm">${esc(e.name)}</span><span class="cfp-ev-amt" style="color:${isOff?'var(--muted)':'var(--green)'}">${isOff?'skipped':'+'+fmtK(e.amt)}</span>${runBadge}</div>`;
        }
        if(e.type==='savings'){
          return `<div class="cfp-ev savings"><span class="cfp-ev-ind"></span><span class="cfp-ev-nm">💰 ${esc(e.name)}</span><span class="cfp-ev-amt" style="color:var(--blue)">-${fmtK(Math.abs(e.amt))}</span>${runBadge}</div>`;
        }
        const key=(e.key||'').replace(/'/g,"\\'");
        const okey=String(e.okey||'').replace(/'/g,"\\'");
        const chk=`<input type="checkbox" class="cfp-ev-chk" ${isOff?'checked':''} onclick="event.stopPropagation();cfpToggleBillPaid('${okey}','${w.uid}')" title="${isOff?'Paid — drops from this cycle; next month stays':'Mark this one paid ahead'}">`;
        const right=isOff
          ? `<span class="cfp-ev-amt" style="color:var(--muted)">paid</span>`
          : `<div class="cfp-ev-edit"><span>$</span><input type="number" value="${Math.round(Math.abs(e.amt))}" min="0" step="10" onclick="event.stopPropagation()" oninput="setBillPay('${key}',this.value)" onblur="cfpRefresh('${w.uid}')"></div>`;
        return `<div class="cfp-ev bill${isOff?' cfp-ev-off':''}">${chk}<span class="cfp-ev-nm">${esc(e.name)}</span>${right}${runBadge}</div>`;
      }).join('');
      const netColor=dayNet>=0?'var(--pos)':'var(--red)';
      const header=`<div class="cfp-day"><span class="cfp-day-date">${dateLbl}</span><span class="cfp-day-dow">${dow}</span><span class="cfp-day-net" style="color:${netColor}">${dayNet>=0?'+':'-'}${fmtK(Math.abs(dayNet))}</span></div>`;
      return header+items;
    }).join('');
    ev.innerHTML=body
      ? `<div class="cfp-ev-header"><span class="cfp-ev-ind"></span><span class="cfp-ev-nm">Transaction</span><span class="cfp-ev-amt-h">Amount</span><span class="cfp-ev-run-h">Balance</span></div>
         <div class="cfp-ev-start"><span class="cfp-ev-ind"></span><span class="cfp-ev-nm">Starting balance</span><span></span><span class="cfp-ev-run">${fmtK(p.start)}</span></div>
         ${body}`
      : '<div class="ws-hint">No upcoming events in this window.</div>';
  }
}
function cfpRefresh(uid){ const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }

/* ═══ EXTRA FUNDS TRIAGE WIDGET ═══ */
function fundTriageBody(w){
  const t=engFundTriage();
  const barPct=v=>t.pool>0?Math.min(100,Math.round(v/t.pool*100)):0;
  const row=(icon,name,desc,val,key,color,goto)=>`
    <div class="ft-row">
      <div class="ft-row-top">
        <span class="ft-ic">${icon}</span>
        <div class="ft-meta"><div class="ft-nm">${name}${goto?` <span class="ft-go" onclick="event.stopPropagation();briefGoto('${goto}')" title="Open this widget">›</span>`:''}</div><div class="ft-desc">${desc}</div></div>
        <div class="ft-edit"><span>$</span><input type="number" min="0" step="10" value="${val}" onclick="event.stopPropagation()" oninput="ftSetAlloc('${key}',this.value)" onblur="ftCommit('${w.uid}')" aria-label="${esc(name)} allocation"></div>
      </div>
      <div class="ft-bar"><div class="ft-bar-fill" style="width:${barPct(val)}%;background:${color}"></div></div>
    </div>`;
  const debtDesc = t.highIntDebt>0?`${fmtK(t.highIntDebt)} high-interest balance to attack`:'No high-interest debt — skip ✓';
  const savDesc  = t.savingsNeed>0?`${fmtK(t.savingsNeed)}/mo to fully fund your buckets`:'Buckets funded — top up anytime';
  const invDesc  = t.plannedInvest>0?`Includes your ${fmtK(t.plannedInvest)}/mo planned contributions`:'Long-term growth — the last stop';
  const balanceRow = Math.abs(t.left)<1
    ? `<div class="zb-balanced">✓ Every extra dollar has a job.</div>`
    : t.left>0
      ? `<div class="zb-tozero"><span>${fmtK(t.left)} still to delegate</span><button onclick="event.stopPropagation();ftAuto('${w.uid}')">Auto-split by priority →</button></div>`
      : `<div class="zb-tozero over"><span>${fmtK(-t.left)} over your extra</span><button onclick="event.stopPropagation();ftAuto('${w.uid}')">Reset split →</button></div>`;
  let note='';
  if(t.highIntDebt>0 && t.plannedInvest>0){
    note=`<div class="ws-hint" style="margin-top:9px">🔥 You're investing ${fmtK(t.plannedInvest)}/mo while carrying ${fmtK(t.highIntDebt)} in high-interest debt. Paying that down is a guaranteed return equal to its APR — priority says send it there first.</div>`;
  } else if(t.plannedInvest>0 && t.invest<t.plannedInvest){
    note=`<div class="ws-hint" style="margin-top:9px">⚠️ After debt & savings, this leaves less than your ${fmtK(t.plannedInvest)}/mo planned investing — trim a bucket or ease a contribution.</div>`;
  } else if(t.plannedInvest>0 && t.invest>=t.plannedInvest){
    note=`<div class="ws-hint" style="margin-top:9px">✅ Covers your ${fmtK(t.plannedInvest)}/mo planned contributions plus ${fmtK(t.invest-t.plannedInvest)} extra.</div>`;
  }
  return `<div class="ft-wrap">
    <div class="zb-head">
      <div class="zb-hstat"><span>Monthly income</span><b>${fmtK(t.income)}</b></div>
      <div class="zb-hstat"><span>Bills (fixed)</span><b style="color:var(--red)">${fmtK(t.bills)}</b></div>
      <div class="zb-hstat"><span>Everyday spending</span><b style="color:var(--red)">${fmtK(t.everyday)}</b></div>
      <div class="zb-hstat zb-tobudget"><span>Available extra</span><b style="color:var(--green)">${fmtK(t.pool)}</b></div>
    </div>
    <div class="ft-extra-edit"><span>Extra to delegate</span><div class="ft-edit"><span>$</span><input type="number" min="0" step="10" value="${t.pool}" onclick="event.stopPropagation()" oninput="ftSetExtra(this.value)" onblur="ftCommit('${w.uid}')" aria-label="Extra funds to delegate"></div><button class="ft-auto" onclick="event.stopPropagation();ftReset('${w.uid}')" title="Reset to computed surplus & priority split">↺ Auto</button></div>
    ${balanceRow}
    <div class="zb-section-label">Priority order <span class="ws-hint" style="margin:0">high-interest debt → savings → investing</span></div>
    ${row('🔥','1 · Kill high-interest debt', debtDesc, t.debt, 'debt', 'var(--red)', 'debt_hub')}
    ${row('🪣','2 · Fund savings buckets', savDesc, t.savings, 'savings', 'var(--blue)', 'savings_buckets')}
    ${row('📈','3 · Invest the rest', invDesc, t.invest, 'invest', 'var(--green)', 'investments')}
    ${note}
  </div>`;
}
function ftSetExtra(v){ const ft=_ft(); const n=parseFloat(v); ft.extra=isNaN(n)?null:Math.max(0,n); ft.alloc={}; saveState(); }   // new extra → re-run the waterfall
function ftSetAlloc(key,v){ const ft=_ft(); ft.alloc=ft.alloc||{}; const n=parseFloat(v); ft.alloc[key]=isNaN(n)?null:Math.max(0,n); saveState(); }
function ftAuto(uid){ const ft=_ft(); ft.alloc={}; saveState(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); if(sbRichie)sbRichie.do('nod'); }
function ftReset(uid){ const ft=_ft(); ft.extra=null; ft.alloc={}; saveState(); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function ftCommit(uid){ const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }

/* ═══ PROFIT & LOSS WIDGET ═══ */
let _plGroup={};  // per-widget grouping (daily/weekly/monthly)
function plWidgetBody(w){
  const group=_plGroup[w.uid]||'daily';
  const days=wDays(w);
  return `<div class="pl-wrap">
    <div class="pl-toolbar">
      <span class="pl-grp-label">Group by</span>
      <div class="pl-toggle">
        ${['daily','weekly','monthly'].map(g=>`<button class="pl-gbtn${group===g?' active':''}" onclick="setPLGroup('${w.uid}','${g}')">${g[0].toUpperCase()+g.slice(1)}</button>`).join('')}
      </div>
      <span class="pl-netbadge" id="plnet_${w.uid}"></span>
    </div>
    <div class="pl-strip" id="plstrip_${w.uid}"></div>
    <div class="pl-detail" id="pldet_${w.uid}"></div>
  </div>`;
}
function setPLGroup(uid,g){ _plGroup[uid]=g; const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function plMount(w){
  const group=_plGroup[w.uid]||'daily';
  const days=wDays(w);
  const s=dataLoaded?engPLStats(days,group):(function(){ const b=engPLSample(group); const ti=b.reduce((x,y)=>x+y.inc,0),ts=b.reduce((x,y)=>x+y.spend,0); const nets=b.map(x=>x.inc-x.spend); return {buckets:b,totalInc:ti,totalSpend:ts,net:ti-ts,sr:ti>0?Math.round((ti-ts)/ti*100):0,best:b[nets.indexOf(Math.max(...nets))],worst:b[nets.indexOf(Math.min(...nets))],txnCount:b.reduce((x,y)=>x+y.n,0),avgNet:Math.round((ti-ts)/b.length),periods:b.length}; })();
  const badge=gg('plnet_'+w.uid);
  if(badge){ badge.textContent='Net '+(s.net>=0?'+':'-')+fmtK(Math.abs(s.net)); badge.style.color=s.net>=0?'var(--pos)':'var(--red)'; }
  const strip=gg('plstrip_'+w.uid);
  if(strip){
    const stats=[
      {l:'Income',v:fmtK(s.totalInc),c:'var(--green)'},
      {l:'Spending',v:fmtK(s.totalSpend),c:'var(--red)'},
      {l:'Net',v:(s.net>=0?'+':'-')+fmtK(Math.abs(s.net)),c:s.net>=0?'var(--pos)':'var(--red)'},
      {l:'Savings Rate',v:s.sr+'%',c:'var(--blue)'},
    ];
    strip.innerHTML=stats.map(x=>`<div class="pl-stat"><div class="pl-stat-l">${x.l}</div><div class="pl-stat-v" style="color:${x.c}">${x.v}</div></div>`).join('');
  }
  const det=gg('pldet_'+w.uid);
  if(det){
    // net-per-period LINE chart: solid baseline at 0, dotted line at the average
    det.innerHTML=`${plLineSVG(s.buckets, s.avgNet, {wide: (w&&w.span===2)})}
      <div class="pl-extra">
        <div class="pl-xrow"><span>Avg net / period</span><b style="color:${s.avgNet>=0?'var(--pos)':'var(--red)'}">${s.avgNet>=0?'+':'-'}${fmtK(Math.abs(s.avgNet))}</b></div>
        <div class="pl-xrow"><span>Best period</span><b style="color:var(--green)">${s.best?s.best.key+' · +'+fmtK(s.best.inc-s.best.spend):'—'}</b></div>
        <div class="pl-xrow"><span>Worst period</span><b style="color:var(--red)">${s.worst?s.worst.key+' · '+(s.worst.inc-s.worst.spend>=0?'+':'-')+fmtK(Math.abs(s.worst.inc-s.worst.spend)):'—'}</b></div>
        <div class="pl-xrow"><span>Transactions</span><b>${s.txnCount} over ${s.periods} period${s.periods!==1?'s':''}</b></div>
      </div>`;
  }
}
/* Smooth monotone-cubic path (Fritsch–Carlson) — stays within the data, no overshoot */
function _smoothPath(pts){
  const n=pts.length;
  if(n<2) return n?`M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`:'';
  const dx=[],dy=[],m=[];
  for(let i=0;i<n-1;i++){ dx[i]=pts[i+1].x-pts[i].x||1; dy[i]=pts[i+1].y-pts[i].y; m[i]=dy[i]/dx[i]; }
  const t=new Array(n); t[0]=m[0]; t[n-1]=m[n-2];
  for(let i=1;i<n-1;i++){ t[i]=(m[i-1]*m[i]<=0)?0:(m[i-1]+m[i])/2; }
  for(let i=0;i<n-1;i++){
    if(m[i]===0){ t[i]=0; t[i+1]=0; }
    else { const a=t[i]/m[i], b=t[i+1]/m[i]; const h=Math.hypot(a,b); if(h>3){ const tau=3/h; t[i]=tau*a*m[i]; t[i+1]=tau*b*m[i]; } }
  }
  let d=`M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for(let i=0;i<n-1;i++){
    const h=dx[i];
    const c1x=pts[i].x+h/3, c1y=pts[i].y+t[i]*h/3;
    const c2x=pts[i+1].x-h/3, c2y=pts[i+1].y-t[i+1]*h/3;
    d+=` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${pts[i+1].x.toFixed(1)} ${pts[i+1].y.toFixed(1)}`;
  }
  return d;
}
/* Net-per-period SMOOTH line chart — uniform scaling (crisp on any width),
   area fill, hard zero baseline, dashed average line. Wide vs tall layout. */
function plLineSVG(buckets, avgNet, opts){
  opts=opts||{};
  const b=buckets||[]; if(!b.length) return '';
  const nets=b.map(x=>x.inc-x.spend);
  const avg=avgNet!=null?avgNet:Math.round(nets.reduce((s,v)=>s+v,0)/nets.length);
  const wide=!!opts.wide;
  const W=wide?960:460, H=wide?300:340;
  const padL=46, padR=wide?26:16, padT=24, padB=46;
  const plotW=W-padL-padR, plotH=H-padT-padB, baseY=padT+plotH;
  const maxV=Math.max(...nets, avg, 0), minV=Math.min(...nets, avg, 0);
  const sp=(maxV-minV)||Math.max(Math.abs(maxV),1); const padV=sp*0.14;
  const top=maxV+padV, bot=minV-padV, rng=(top-bot)||1;
  const X=i=> padL + (b.length<=1? plotW/2 : (i/(b.length-1))*plotW);
  const Y=v=> padT + (top - v)/rng*plotH;
  const pts=nets.map((v,i)=>({x:X(i), y:Y(v), v}));
  const zeroY=Y(0), avgY=Y(avg);
  const line=_smoothPath(pts);
  const area=`${line} L ${X(b.length-1).toFixed(1)} ${baseY.toFixed(1)} L ${X(0).toFixed(1)} ${baseY.toFixed(1)} Z`;
  const gid='plg'+Math.random().toString(36).slice(2,7);
  const fs=wide?15:17, fsAxis=wide?13:15, dotR=wide?4:5;
  const dots=pts.map((p,i)=>{
    const last=i===pts.length-1;
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${last?dotR+1.5:dotR}" fill="${p.v>=0?'var(--pos)':'var(--red)'}" stroke="var(--surface)" stroke-width="2"/>`;
  }).join('');
  const step=b.length>(wide?9:6)?Math.ceil(b.length/(wide?7:5)):1;
  const xlabels=b.map((x,i)=> (i%step===0||i===b.length-1)
    ? `<text x="${X(i).toFixed(1)}" y="${(H-16).toFixed(1)}" text-anchor="middle" font-size="${fsAxis}" fill="var(--muted)">${esc(x.key)}</text>`:'').join('');
  const fk=(n)=>`${n>=0?'+':'-'}$${Math.abs(n)>=1000?(Math.abs(n)/1000).toFixed(1)+'k':Math.abs(n)}`;
  const avgCol=avg>=0?'var(--pos)':'var(--red)';
  return `<svg class="pl-linechart${wide?' wide':''}" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--blue)" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="var(--blue)" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${(W-padR).toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="var(--text)" stroke-width="1" opacity="0.4"/>
    <text x="${(padL-8).toFixed(1)}" y="${(zeroY+4).toFixed(1)}" text-anchor="end" font-size="${fsAxis}" fill="var(--muted)" opacity="0.85">0</text>
    <line x1="${padL}" y1="${avgY.toFixed(1)}" x2="${(W-padR).toFixed(1)}" y2="${avgY.toFixed(1)}" stroke="${avgCol}" stroke-width="1.4" stroke-dasharray="6 4" opacity="0.8"/>
    ${(()=>{ const txt='avg '+fk(avg); const tw=txt.length*(fsAxis*0.6)+12; const x1=W-padR; const flip=(avgY-7-fsAxis)<padT; const ly=flip?avgY+fsAxis+6:avgY-8; const ry=flip?avgY+4:avgY-9-fsAxis;
      return `<rect x="${(x1-tw).toFixed(1)}" y="${ry.toFixed(1)}" width="${tw.toFixed(1)}" height="${(fsAxis+7).toFixed(1)}" rx="4" fill="var(--surface)" opacity="0.8"/><text x="${(x1-6).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="end" font-size="${fsAxis}" font-weight="600" fill="${avgCol}">${txt}</text>`; })()}
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${line}" fill="none" stroke="var(--blue)" stroke-width="${wide?3:3.4}" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    ${xlabels}
  </svg>`;
}

/* ═══ ALL ACCOUNTS WIDGET ═══ */
let _acctOpen={};  // per-widget expanded account id
function _acctIsLiability(a){
  if(a.type==='credit'||a.type==='loan') return true;
  try{ const def=ACCT_CAT_BY_ID[getAccountCategory(a._acct||a)]; if(def) return def.kind==='liability'; }catch(e){}
  return (a.bal||0)<0;
}
function acctWidgetBody(w){
  const accts=engAccounts();
  const rowHTML=(a)=>{
    const col=a.bal<0?'var(--red)':'var(--pos)';
    const balStr=(a.bal<0?'-':'+')+fmtK(Math.abs(a.bal));
    const open=_acctOpen[w.uid]===a.id;
    const raw=a.rawName||a.name;
    const cd=_cdFor(a);
    const kEsc=esc(_acctIdKey(a)).replace(/'/g,"\\'");
    const editBtn = a.manual
      ? `<button class="bill-edit" onclick="event.stopPropagation();openManualAccount(${(APP.manualAccounts||[]).findIndex(x=>x.id===a.id)})" title="Edit">\u270E</button>`
      : `<button class="bill-edit" onclick="event.stopPropagation();openAccountEditor('${kEsc}')" title="Edit details">\u270E</button>`;
    const promoBadge = cd.promoEnd ? `<span class="acct-badge">0%</span>` : '';
    const exclBadge = a.excluded ? `<span class="acct-badge" style="color:var(--muted);background:var(--surface3)">excluded</span>` : '';
    const pend=engAcctPending(a);
    const pendStr=pend.count?` \u00b7 <span style="color:var(--amber)">\u23f3 ${pend.count} pending \u2192 ${fmtK(engExpectedBalance(a))} expected</span>`:'';
    return `<div class="acct-chip${open?' open':''}${a.excluded?' acct-excluded':''}" onclick="toggleAcct('${w.uid}','${a.id}')">
        <span class="acct-ic">${_acctIcon(a)}</span>
        <div class="acct-meta"><div class="acct-nm">${esc(a.name)}${promoBadge}${exclBadge}${editBtn}</div><div class="acct-sub">${esc(a.institution||a.subtype||a.type)}${a.mask?' \u00b7\u00b7\u00b7'+esc(a.mask):''}${a.manual?' \u00b7 manual':''}${(+cd.contrib||+a.contrib)?` \u00b7 <span style="color:var(--green)">\ud83d\udcb5 ${fmtK(+cd.contrib||+a.contrib)}/mo planned</span>`:''}${pendStr}</div></div>
        <div class="acct-bal" style="color:${col}">${balStr}</div>
        <span class="acct-arr">${open?'\u25b2':'\u25bc'}</span>
      </div>${open?`<div class="acct-txns" id="acdt_${w.uid}"></div>`:''}`;
  };
  const assets=accts.filter(a=>!_acctIsLiability(a));
  const liabs=accts.filter(_acctIsLiability);
  // Statement-imported investment accounts (net-worth assets) live here too \u2014 they're real
  // accounts, just fed by uploads instead of Plaid. Click opens the shared asset editor.
  const stmtAssets=engInvestNWAssets();
  const stmtRow=(x)=>{
    const contrib=+x.contrib||0;
    return `<div class="acct-chip" onclick="portfolioEditNWAsset('${x.id}')">
        <span class="acct-ic">\ud83d\udcc8</span>
        <div class="acct-meta"><div class="acct-nm">${esc(x.name||'Investment')}<button class="bill-edit" onclick="event.stopPropagation();portfolioEditNWAsset('${x.id}')" title="Edit details">\u270e</button></div><div class="acct-sub">statement import \u00b7 investment${contrib?` \u00b7 <span style="color:var(--green)">\ud83d\udcb5 ${fmtK(contrib)}/mo planned</span>`:''}</div></div>
        <div class="acct-bal" style="color:var(--pos)">+${fmtK(+x.value||0)}</div>
        <span class="acct-arr">\u203a</span>
      </div>`;
  };
  // Investment accounts represented only by portfolio positions (no bank link, no net-worth
  // asset) \u2014 same grouping engine as net worth / invest totals (engPosOnlyAccounts).
  const posEntries=engPosOnlyAccounts();
  const posRow=(p)=>{
    const nEsc=esc(p.name).replace(/'/g,"\\'");
    return `<div class="acct-chip" onclick="openPosAcctEditor('${nEsc}')">
        <span class="acct-ic">\ud83d\udcc8</span>
        <div class="acct-meta"><div class="acct-nm">${esc(p.name)}<button class="bill-edit" onclick="event.stopPropagation();openPosAcctEditor('${nEsc}')" title="Edit details">\u270e</button></div><div class="acct-sub">portfolio positions \u00b7 investment${p.contrib?` \u00b7 <span style="color:var(--green)">\ud83d\udcb5 ${fmtK(p.contrib)}/mo planned</span>`:''}</div></div>
        <div class="acct-bal" style="color:var(--pos)">+${fmtK(p.value)}</div>
        <span class="acct-arr">\u203a</span>
      </div>`;
  };
  const posTot=posEntries.reduce((s,p)=>s+p.value,0);
  const assetTot=assets.reduce((s,a)=>s+(a.excluded?0:a.bal),0)+stmtAssets.reduce((s,x)=>s+(+x.value||0),0)+posTot;
  const liabTot=liabs.reduce((s,a)=>s+(a.excluded?0:Math.abs(a.bal)),0);
  const net=assetTot-liabTot;
  const assetCount=assets.length+stmtAssets.length+posEntries.length;
  const assetsHtml=assetCount?`<div class="acct-group-h"><span>\ud83d\udc9a Assets \u00b7 ${assetCount}</span><b style="color:var(--green)">${fmtK(assetTot)}</b></div>${assets.map(rowHTML).join('')}${stmtAssets.map(stmtRow).join('')}${posEntries.map(posRow).join('')}`:'';
  const section=(title,icon,list,subtotal,color)=> list.length?`<div class="acct-group-h"><span>${icon} ${title} \u00b7 ${list.length}</span><b style="color:${color}">${fmtK(subtotal)}</b></div>${list.map(rowHTML).join('')}`:'';
  // Banks the server couldn't sync \u2014 without this banner their accounts silently vanish.
  const errRow=(e)=>`<div style="display:flex;align-items:center;gap:8px;margin-top:4px"><span style="flex:1;min-width:0">${esc(e.institution||'Bank')}<span style="color:var(--muted)"> \u2014 ${e.needsRelink?'login expired':'sync failed'}</span></span>${e.needsRelink&&e.itemId?`<button class="btn" style="height:24px;font-size:11px;padding:0 10px;color:var(--amber);border-color:var(--amber)" onclick="event.stopPropagation();openLinkHandler('${e.itemId}')">Reconnect</button>`:''}</div>`;
  const errBanner=_acctErrors.length?`<div style="background:var(--amber-dim);border:1px solid var(--amber);border-radius:9px;padding:9px 11px;margin-bottom:9px;font-size:12px;color:var(--text)"><b style="color:var(--amber)">\u26a0\ufe0f ${_acctErrors.length} bank${_acctErrors.length!==1?'s':''} not syncing</b> \u2014 accounts below are incomplete${_acctErrors.map(errRow).join('')}</div>`:'';
  return `<div class="acct-wrap">
    ${errBanner}
    <div class="acct-summary">
      <span>${assetCount+liabs.length} account${(assetCount+liabs.length)!==1?'s':''}</span>
    </div>
    ${assetsHtml}
    ${section('Liabilities','\u2764\ufe0f',liabs,liabTot,'var(--red)')}
    <button class="manual-add-btn" onclick="event.stopPropagation();openManualAccount()">\u2795 Add an account</button>
  </div>`;
}
function toggleAcct(uid,id){
  _acctOpen[uid]=(_acctOpen[uid]===id)?null:id;
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg);
}
function acctMount(w){
  const id=_acctOpen[w.uid]; if(!id) return;
  const el=gg('acdt_'+w.uid); if(!el) return;
  const acct=engAccounts().find(a=>a.id===id); if(!acct){ el.innerHTML=''; return; }
  const info=engAcctNet30(acct);
  if(!info){ el.innerHTML='<div class="acct-empty">Connect your bank to see transactions for this account.</div>'; return; }
  const net=info.net;
  let html=`<div class="acct-txn-head">${info.count} txns · last 30d · net <b style="color:${net>=0?'var(--pos)':'var(--red)'}">${net>=0?'+':'-'}${fmt2(Math.abs(net))}</b></div>`;
  if(!info.txns.length){ html+='<div class="acct-empty">No transactions in last 30 days.</div>'; el.innerHTML=html; return; }
  const keys=[];
  html+=info.txns.map((t,i)=>{ const key=_txnKey(t); keys[i]=key; const pos=t.amount>0; const col=pos?'var(--red)':'var(--pos)'; const amt=(pos?'-':'+')+fmt2(Math.abs(t.amount)); const cat=getTxnCategory(t); const note=getTxnNote(t); const tag=getTxnTag(t); const name=t.merchant_name||t.name||''; const dt=new Date(t.date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
      const tagChip = tag&&TXN_TAG_BY_ID[tag]?`<span class="txf-tag">${TXN_TAG_BY_ID[tag].icon} ${esc(TXN_TAG_BY_ID[tag].label)}</span>`:'';
      return `<div class="acct-txn-row">
        <div style="flex:1;min-width:0">
          <div class="acct-txn-nm">${esc(name)} ${tagChip}</div>
          <div class="acct-txn-meta"><span class="acct-txn-cat">${esc(cat)}</span>${note?`<span class="acct-txn-note">📝 ${esc(note)}</span>`:''}</div>
        </div>
        <div style="text-align:right;flex-shrink:0"><div class="acct-txn-amt" style="color:${col}">${amt}</div><div class="acct-txn-dt">${dt}</div></div>
      </div>`;
  }).join('');
  html+='<div class="acct-txn-hint">Edit categories, notes &amp; tags in the <b>All Transactions</b> widget.</div>';
  _acctTxnKeys[w.uid]=keys;
  el.innerHTML=html;
}
let _acctTxnKeys={};
// Change a transaction's category (writes a persistent override → flows through every widget)
function setAcctTxnCat(uid, idx, cat){
  const k=(_acctTxnKeys[uid]||[])[idx]; if(!k) return;
  if(cat) _catOverrides[k]=cat; else delete _catOverrides[k];
  try{ LS.setItem('mdf_cat_overrides', JSON.stringify(_catOverrides)); }catch(e){}
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg) renderCanvas(pg);   // re-render so spending/category widgets update too
}
// Save a free-text note on a transaction (no re-render, so typing stays smooth)
function setAcctTxnNote(uid, idx, note){
  const k=(_acctTxnKeys[uid]||[])[idx]; if(!k) return;
  if(note&&note.trim()) _txnNotes[k]=note.trim(); else delete _txnNotes[k];
  try{ LS.setItem('mdf_txn_notes', JSON.stringify(_txnNotes)); }catch(e){}
}

/* ═══ ALL TRANSACTIONS widget — searchable feed with per-txn category, note & tag ═══ */
let _txnFeed={}, _txnFeedKeys={}, _txnFeedRows={};
const TXF_FILTERS=[{id:'all',label:'All'},{id:'income',label:'Income'},{id:'spending',label:'Spending'},{id:'pending',label:'⏳ Pending'},{id:'paycheck',label:'💵 Paychecks'},{id:'tagged',label:'Tagged'},{id:'untagged',label:'Untagged'}];
const TXN_TF=[{key:'1w',label:'1 wk',days:7},{key:'30d',label:'30 days',days:30},{key:'3m',label:'3 mo',days:90},{key:'1y',label:'1 yr',days:365},{key:'all',label:'All',days:100000}];
function _txfDays(tf){ const t=TXN_TF.find(x=>x.key===tf); return t?t.days:30; }
function txnFeedBody(w){
  const st=_txnFeed[w.uid]||(_txnFeed[w.uid]={q:'',filter:'all',tf:'30d'});
  if(!st.tf) st.tf='30d';
  return `<div class="txf-wrap">
    <div class="txf-tf" id="txftf_${w.uid}"></div>
    <input class="txf-search" id="txfq_${w.uid}" placeholder="🔍 Search transactions…" value="${esc(st.q)}" oninput="txnFeedSearch('${w.uid}',this.value)" onclick="event.stopPropagation()">
    <div class="txf-chips" id="txfchips_${w.uid}"></div>
    <div class="txf-summary" id="txfsum_${w.uid}"></div>
    <div class="txf-list" id="txflist_${w.uid}"></div>
  </div>`;
}
function _txnFeedData(w){
  const st=_txnFeed[w.uid]||{q:'',filter:'all'};
  let list = dataLoaded ? allTxns.slice() : [
    {date:'2026-01-08',name:'Paycheck — Employer',amount:-2000,transaction_id:'ex1',institution:'Example'},
    {date:'2026-01-07',name:'Grocery Store',amount:82.14,transaction_id:'ex2',institution:'Example'},
    {date:'2026-01-06',name:'Coffee Shop',amount:5.75,transaction_id:'ex3',institution:'Example'},
    {date:'2026-01-05',name:'Electric Bill',amount:120,transaction_id:'ex4',institution:'Example'},
    {date:'2026-01-04',name:'Transfer to Savings',amount:300,transaction_id:'ex5',institution:'Example'},
  ];
  const q=(st.q||'').toLowerCase().trim();
  const cut=Date.now()-_txfDays(st.tf||'30d')*86400000;
  list=list.filter(t=>{
    if(new Date(t.date).getTime()<cut) return false;
    if(q){ const name=(t.merchant_name||t.name||'').toLowerCase(); const cat=getTxnCategory(t).toLowerCase(); if(!(name.includes(q)||cat.includes(q))) return false; }
    const tag=getTxnTag(t);
    switch(st.filter){
      case 'income':    return _isIncomeTxn(t);   // true income only — CC payments/transfers are inflows, not income
      case 'spending':  return t.amount>0 && !_txnExcludedFromSpend(t);   // real spending — CC payments/transfers excluded
      case 'pending':   return !!t.pending;
      case 'paycheck':  return tag==='paycheck';
      case 'tagged':    return !!tag;
      case 'untagged':  return !tag;
      default:          return true;
    }
  });
  list.sort((a,b)=>new Date(b.date)-new Date(a.date));
  return list;
}
function txnFeedMount(w){
  const st=_txnFeed[w.uid]||{q:'',filter:'all'};
  const chipsEl=gg('txfchips_'+w.uid);
  if(chipsEl) chipsEl.innerHTML=TXF_FILTERS.map(f=>`<button class="txf-chip${st.filter===f.id?' on':''}" onclick="event.stopPropagation();txnFeedFilter('${w.uid}','${f.id}')">${esc(f.label)}</button>`).join('');
  const tfEl=gg('txftf_'+w.uid);
  if(tfEl) tfEl.innerHTML=TXN_TF.map(t=>`<button class="txf-tfchip${(st.tf||'30d')===t.key?' on':''}" onclick="event.stopPropagation();txnFeedTf('${w.uid}','${t.key}')">${esc(t.label)}</button>`).join('');
  txnFeedRender(w);
}
function txnFeedRender(w){
  const list=_txnFeedData(w);
  const inTot=list.filter(t=>t.amount<0).reduce((s,t)=>s+Math.abs(t.amount),0);
  const outTot=list.filter(t=>t.amount>0).reduce((s,t)=>s+t.amount,0);
  const pendN=list.filter(t=>t.pending).length;
  const pendOut=list.filter(t=>t.pending&&t.amount>0).reduce((s,t)=>s+t.amount,0);
  const sumEl=gg('txfsum_'+w.uid);
  if(sumEl) sumEl.innerHTML=`<span>${list.length} txn${list.length!==1?'s':''}</span><span class="txf-in">+${fmtK(inTot)} in</span><span class="txf-out">−${fmtK(outTot)} out</span>`+(pendN?`<span style="color:var(--amber)">⏳ ${pendN} pending${pendOut?' · '+fmtK(pendOut):''}</span>`:'');
  const el=gg('txflist_'+w.uid); if(!el) return;
  if(!list.length){ el.innerHTML='<div class="acct-empty">No transactions match.</div>'; _txnFeedKeys[w.uid]=[]; return; }
  const cats=getUserCategories().filter(c=>!c.group).map(c=>c.label);
  const keys=[]; const capped=list.slice(0,300); _txnFeedRows[w.uid]=capped;
  const _exSet=_excludedAcctIds();
  el.innerHTML=capped.map((t,i)=>{
    const key=_txnKey(t); keys[i]=key;
    const pos=t.amount>0, col=pos?'var(--red)':'var(--pos)', amt=(pos?'-':'+')+fmt2(Math.abs(t.amount));
    const cat=getTxnCategory(t), note=getTxnNote(t), tag=getTxnTag(t);
    const name=t.merchant_name||t.name||'', dt=new Date(t.date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
    const mk=_merchKey(t), hasRule=!!(mk&&_catRules[mk]);
    const acctExcl=_exSet.has(t.account_id);
    const catList=cats.includes(cat)?cats:[cat].concat(cats);
    const opts=catList.map(c=>`<option value="${esc(c)}"${c===cat?' selected':''}>${esc(c)}</option>`).join('');
    const tagOpts=`<option value="">🏷️ tag…</option>`+TXN_TAGS.map(tg=>`<option value="${tg.id}"${tag===tg.id?' selected':''}>${tg.icon} ${tg.label}</option>`).join('');
    const tagChip = tag&&TXN_TAG_BY_ID[tag]?`<span class="txf-tag">${TXN_TAG_BY_ID[tag].icon} ${esc(TXN_TAG_BY_ID[tag].label)}</span>`:'';
    const ruleChip = hasRule?`<span class="txf-tag" style="color:var(--blue,#5b8def);background:rgba(91,141,239,.14)">＝ rule</span>`:'';
    const exclChip = acctExcl?`<span class="txf-tag" style="color:var(--muted);background:var(--surface3)">excluded acct</span>`:'';
    const pendChip = t.pending?`<span class="txf-tag" style="color:var(--amber);background:var(--amber-dim)">⏳ pending</span>`:'';
    return `<div class="txf-row"${acctExcl?' style="opacity:.55"':''}>
      <div class="txf-main">
        <div class="txf-nm">${esc(name)} ${pendChip}${tagChip}${ruleChip}${exclChip}</div>
        <div class="txf-edit">
          <select class="txn-cat-sel" onclick="event.stopPropagation()" onchange="txnFeedSetCat('${w.uid}',${i},this.value)" title="Category">${opts}</select>
          <select class="txn-cat-sel txf-tagsel" onclick="event.stopPropagation()" onchange="txnFeedSetTag('${w.uid}',${i},this.value)" title="Tag">${tagOpts}</select>
          <button class="txf-rulebtn${hasRule?' on':''}" onclick="event.stopPropagation();txnFeedRule('${w.uid}',${i})" title="Always categorize this merchant this way">＝</button>
          <input class="txn-note-in" type="text" placeholder="📝 note…" value="${esc(note)}" onclick="event.stopPropagation()" onchange="txnFeedSetNote('${w.uid}',${i},this.value)" onkeydown="if(event.key==='Enter')this.blur()">
        </div>
      </div>
      <div class="txf-side"><div class="txf-amt" style="color:${col}">${amt}</div><div class="txf-dt">${dt}${t.institution?' · '+esc(t.institution):''}</div></div>
    </div>`;
  }).join('') + (list.length>capped.length?`<div class="txf-more">Showing 300 of ${list.length} — search to narrow.</div>`:'');
  _txnFeedKeys[w.uid]=keys;
}
function txnFeedSearch(uid,val){ (_txnFeed[uid]=_txnFeed[uid]||{q:'',filter:'all'}).q=val; const w=_findWidget(uid); if(w) txnFeedRender(w); }
function txnFeedFilter(uid,f){ (_txnFeed[uid]=_txnFeed[uid]||{q:'',filter:'all'}).filter=f; const w=_findWidget(uid); if(w) txnFeedMount(w); }
function txnFeedTf(uid,key){ (_txnFeed[uid]=_txnFeed[uid]||{q:'',filter:'all'}).tf=key; const w=_findWidget(uid); if(w) txnFeedMount(w); }
function txnFeedSetCat(uid,idx,cat){ const k=(_txnFeedKeys[uid]||[])[idx]; if(!k)return; if(cat)_catOverrides[k]=cat; else delete _catOverrides[k]; try{LS.setItem('mdf_cat_overrides',JSON.stringify(_catOverrides));}catch(e){} try{ gamiMarkEngaged('categorize'); }catch(e){} const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function txnFeedSetNote(uid,idx,note){ const k=(_txnFeedKeys[uid]||[])[idx]; if(!k)return; if(note&&note.trim())_txnNotes[k]=note.trim(); else delete _txnNotes[k]; try{LS.setItem('mdf_txn_notes',JSON.stringify(_txnNotes));}catch(e){} }
function txnFeedSetTag(uid,idx,tag){ const k=(_txnFeedKeys[uid]||[])[idx]; if(!k)return; setTxnTag(k,tag); const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }
function txnFeedRule(uid,idx){ const t=(_txnFeedRows[uid]||[])[idx]; if(!t)return; const mk=_merchKey(t); if(!mk)return; if(_catRules[mk]){ setCatRule(mk,''); } else { setCatRule(mk, getTxnCategory(t)); } const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg)renderCanvas(pg); }

function fdWidgetBody(w){
  if(!_fd.scenario) _fd.scenario='job';
  const cards=Object.entries(FD_SCENARIOS).map(([id,sc])=>`<div class="fd-scen${_fd.scenario===id?' active':''}" onclick="fdSetScenario('${id}')">
    <div class="fd-scen-icon">${sc.icon}</div><div class="fd-scen-name">${sc.name}</div><div class="fd-scen-sub">${sc.sub}</div></div>`).join('');
  return `<div class="fd-wrap">
    <div class="fd-scen-grid">${cards}</div>
    <div class="fd-banner" id="fdBanner"></div>
    <div class="fd-body">
      <div class="fd-col">
        <div class="ww-section-label" style="margin-top:0">Income (drag to model loss)</div>
        <div id="fdIncome"></div>
        <div class="ww-section-label">Extra costs <button class="fd-add" onclick="fdAddCost()">+ add</button></div>
        <div id="fdExtra"></div>
      </div>
      <div class="fd-col fd-result">
        <div class="fd-runway-label">Survival runway</div>
        <div class="fd-runway-num" id="fdRunwayNum">—</div>
        <div class="fd-runway-sub" id="fdRunwaySub"></div>
        <div class="fd-net-rows" id="fdNetRows"></div>
        <div class="fd-alert" id="fdAlert"></div>
      </div>
    </div>
  </div>`;
}
function fdRefresh(){
  const sc=FD_SCENARIOS[_fd.scenario];
  document.querySelectorAll('.fd-scen').forEach(c=>{}); // (re-render below handles highlight)
  // re-render scenario cards highlight by re-rendering body pieces we own
  const banner=gg('fdBanner'); if(banner){ banner.className='fd-banner '+(sc.severity||'info'); banner.textContent=sc.banner; }
  // income sliders
  const inc=gg('fdIncome');
  if(inc){ inc.innerHTML=incomeSources.map((src,i)=>{
    const origMo=Math.round(src.amt*(FREQ_TO_MONTHLY[src.freq]||1));
    const scenMo=_fd.incomeOverrides[i]!==undefined?_fd.incomeOverrides[i]:origMo;
    const pct=origMo>0?Math.round(scenMo/origMo*100):0;
    const color=pct===0?'var(--red)':pct<75?'var(--amber)':'var(--green)';
    return `<div class="fd-inc-row">
      <span class="fd-inc-name">${esc(src.name)}</span>
      <input type="range" min="0" max="${origMo}" value="${scenMo}" step="50" oninput="_fd.incomeOverrides[${i}]=+this.value; gg('fdiv${i}').textContent=fmtK(+this.value); gg('fdiv${i}').style.color=(+this.value===0?'var(--red)':(+this.value/${origMo}<0.75?'var(--amber)':'var(--green)')); fdRecalc()">
      <span class="fd-inc-val" id="fdiv${i}" style="color:${color}">${fmtK(scenMo)}</span>
    </div>`;
  }).join(''); }
  // extra costs
  const ex=gg('fdExtra');
  if(ex){ ex.innerHTML=_fd.extraCosts.length?_fd.extraCosts.map((c,i)=>`<div class="fd-ex-row">
      <input type="text" value="${esc(c.name)}" onblur="_fd.extraCosts[${i}].name=this.value" placeholder="Cost">
      <input type="number" value="${c.amt}" min="0" step="50" oninput="_fd.extraCosts[${i}].amt=+this.value; fdRecalc()">
      <button class="fd-del" onclick="_fd.extraCosts.splice(${i},1); fdRefresh()">✕</button>
    </div>`).join(''):'<div class="ww-card-desc" style="padding:4px 0">No extra costs — add scenario expenses.</div>'; }
  // scenario card highlight
  document.querySelectorAll('.fd-scen').forEach(el=>{}); // handled by full re-render on scenario switch
  fdRecalc();
}
function fdAddCost(){ _fd.extraCosts.push({name:'New cost',amt:0}); fdRefresh(); }
function fdRecalc(){
  const r=fdRunway();
  const num=gg('fdRunwayNum'), sub=gg('fdRunwaySub');
  if(num){ if(r.months>=999){ num.textContent='∞'; num.style.color='var(--green)'; } else { num.textContent=r.months+' mo'; num.style.color=r.months<3?'var(--red)':r.months<6?'var(--amber)':'var(--green)'; } }
  if(sub) sub.textContent=r.months>=999?'Net positive — you can sustain this indefinitely.':`On ${fmtK(r.cash)} cash, burning ${fmtK(Math.abs(r.net))}/mo.`;
  const rows=gg('fdNetRows');
  if(rows){ rows.innerHTML=`
    <div class="fd-nr"><span>Income</span><b style="color:var(--green)">${fmtK(fdScenarioIncome())}</b></div>
    <div class="fd-nr"><span>Bills</span><b style="color:var(--red)">-${fmtK(fdMonthlyBills())}</b></div>
    <div class="fd-nr"><span>Extra costs</span><b style="color:var(--red)">-${fmtK(fdExtraTotal())}</b></div>
    <div class="fd-nr fd-nr-tot"><span>Net / month</span><b style="color:${r.net>=0?'var(--pos)':'var(--red)'}">${r.net>=0?'+':'-'}${fmtK(Math.abs(r.net))}</b></div>`; }
  const al=gg('fdAlert');
  if(al){ if(r.months>=999){ al.className='fd-alert info'; al.textContent='✅ Net positive — solid footing in this scenario.'; }
    else if(r.months<3){ al.className='fd-alert danger'; al.textContent='⚠️ Critical: under 3 months runway. Contact creditors now.'; }
    else if(r.months<6){ al.className='fd-alert warn'; al.textContent='⚡ '+r.months+' months. Activate emergency levers, cut non-essentials.'; }
    else{ al.className='fd-alert info'; al.textContent='📊 '+r.months+' months runway. Monitor and trim spending.'; } }
}

/* ── Debt Payoff Planner (ported from Playground F2) ── */
let _dp={method:'avalanche', extra:0};
function dpWidgetBody(w){
  return `<div class="fd-wrap">
    <div class="dp-toggle">
      <button class="dp-mtab${_dp.method==='avalanche'?' active':''}" onclick="dpSet('avalanche')">🏔️ Avalanche<span>highest APR first</span></button>
      <button class="dp-mtab${_dp.method==='snowball'?' active':''}" onclick="dpSet('snowball')">⛄ Snowball<span>smallest balance first</span></button>
    </div>
    <div class="ww-section-label">Extra payment / month: <b id="dpExtraVal" style="color:var(--green)">${fmtK(_dp.extra)}</b></div>
    <input type="range" min="0" max="2000" step="50" value="${_dp.extra}" style="width:100%;accent-color:var(--green)" oninput="_dp.extra=+this.value; gg('dpExtraVal').textContent=fmtK(+this.value); dpRecalc()">
    <div class="dp-result" id="dpResult"></div>
    <div class="ww-section-label">Payoff order</div>
    <div id="dpOrder"></div>
  </div>`;
}
function dpSet(m){ _dp.method=m; document.querySelectorAll('.dp-mtab').forEach(b=>b.classList.remove('active')); event&&event.currentTarget&&event.currentTarget.classList.add('active'); dpRecalc(); dpRenderOrder(); }
function dpDebts(){
  // each debt: name, bal(+), apr, min
  return engBills().filter(b=>b.bal<0).map(b=>({name:b.name, bal:Math.abs(b.bal), apr:b.apr||0, min:b.min||b.pay||0}));
}
function dpSimulate(){
  let debts=dpDebts().map(d=>({...d}));
  if(!debts.length) return {months:0,interest:0,order:[]};
  debts.sort((a,b)=> _dp.method==='avalanche' ? b.apr-a.apr : a.bal-b.bal);
  const order=debts.map(d=>d.name);
  let months=0, totalInterest=0; const extra=_dp.extra;
  while(debts.some(d=>d.bal>0.5) && months<600){
    months++;
    debts.forEach(d=>{ if(d.bal>0){ const interest=d.bal*(d.apr/100/12); totalInterest+=interest; d.bal+=interest; } });
    // pay minimums
    let pool=extra;
    debts.forEach(d=>{ if(d.bal>0){ const pay=Math.min(d.min,d.bal); d.bal-=pay; } });
    // throw extra at first unpaid in order
    for(const d of debts){ if(d.bal>0.5 && pool>0){ const pay=Math.min(pool,d.bal); d.bal-=pay; pool-=pay; break; } }
  }
  return {months,interest:Math.round(totalInterest),order};
}
function dpRecalc(){
  const r=dpSimulate(); const el=gg('dpResult'); if(!el) return;
  if(!r.order.length){ el.innerHTML='<div class="ww-card-desc">No debts found. Connect your bank or add bills.</div>'; return; }
  const yrs=Math.floor(r.months/12), mo=r.months%12;
  el.innerHTML=`<div class="dp-stat"><div class="dp-stat-num">${r.months>=600?'—':yrs+'y '+mo+'m'}</div><div class="dp-stat-lbl">debt-free</div></div>
    <div class="dp-stat"><div class="dp-stat-num" style="color:var(--red)">${fmtK(r.interest)}</div><div class="dp-stat-lbl">total interest</div></div>`;
}
function dpRenderOrder(){
  const el=gg('dpOrder'); if(!el) return; const r=dpSimulate();
  el.innerHTML=r.order.slice(0,8).map((n,i)=>`<div class="dp-ord"><span class="dp-ord-n">${i+1}</span><span>${esc(n)}</span></div>`).join('');
}

function buildSankey(cid, days){
  days=days||30;
  const canvas=gg(cid); if(!canvas) return;
  const parent=canvas.parentElement; if(!parent||parent.clientWidth<50){ setTimeout(()=>buildSankey(cid,days),200); return; }
  const FM={weekly:52/12,biweekly:26/12,monthly:1,quarterly:1/3,annual:1/12,yearly:1/12};

  // ── Income column (tier 1) ──
  const incSrc=_effectiveIncomeSources?_effectiveIncomeSources():incomeSources;
  const incNodes=incSrc.map(s=>({label:s.name.split(' ').slice(0,2).join(' '),value:Math.round(s.amt*(FM[s.freq]||1)),color:'#3dda91'})).filter(n=>n.value>0);
  const incTotal=incNodes.reduce((s,n)=>s+n.value,0)||1;

  // ── Child categories (tier 3) from the live category breakdown or a sample ──
  let childRaw;
  if(dataLoaded && allTxns.length){ childRaw=engCategoryBreakdown(days).map(c=>({label:c.label,value:Math.round(c.value),color:c.color})); }
  else { childRaw=[
      {label:'Housing',value:Math.round(2640*days/30)},{label:'Loan Payments',value:Math.round(780*days/30)},
      {label:'Dining Out',value:Math.round(612*days/30)},{label:'Food & Groceries',value:Math.round(498*days/30)},
      {label:'Auto Payments',value:Math.round(452*days/30)},{label:'Utilities',value:Math.round(320*days/30)},
      {label:'Insurance',value:Math.round(266*days/30)},{label:'Shopping',value:Math.round(240*days/30)},
      {label:'Gas & Fuel',value:Math.round(233*days/30)},{label:'Medical',value:Math.round(178*days/30)},
      {label:'Subscriptions',value:Math.round(142*days/30)},{label:'Entertainment',value:Math.round(121*days/30)},
    ].map(c=>({...c,color:getCatColor(c.label)})); }
  childRaw=childRaw.filter(c=>c.value>0).sort((a,b)=>b.value-a.value).slice(0,11);

  // ── Parent groups (tier 2), derived from the displayed children so columns balance ──
  const groupMap={};
  childRaw.forEach(c=>{ const p=getCatParent(c.label); c.parentId=p.id; c.parentLabel=p.label; if(!groupMap[p.id])groupMap[p.id]={id:p.id,label:p.label,color:p.color,value:0}; groupMap[p.id].value+=c.value; });
  const groupNodes=Object.values(groupMap).sort((a,b)=>b.value-a.value);
  const groupOrder={}; groupNodes.forEach((g,i)=>groupOrder[g.id]=i);
  // order children by their group, then by value, to minimize crossing
  const childNodes=childRaw.slice().sort((a,b)=> (groupOrder[a.parentId]-groupOrder[b.parentId]) || (b.value-a.value));
  const spTotal=childNodes.reduce((s,n)=>s+n.value,0)||1;

  if(!incNodes.length && !childNodes.length){ const ctx0=canvas.getContext('2d'); ctx0.fillStyle='#888';ctx0.font='12px sans-serif';ctx0.textAlign='center';ctx0.fillText('Add income & spending to see flow',parent.clientWidth/2,100); return; }

  // ── Canvas sizing (taller when more children) ──
  const dpr=window.devicePixelRatio||1, W=parent.clientWidth-2, H=Math.max(230, childNodes.length*23+44);
  canvas.width=W*dpr; canvas.height=H*dpr; canvas.style.width=W+'px'; canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr); ctx.clearRect(0,0,W,H);

  const PADT=18,PADB=10,GAP=5,NW=11,LLW=Math.min(58,W*0.16),RLW=Math.min(90,W*0.24);
  const xI=LLW, xC=W-RLW-NW, xG=Math.round((xI+NW+xC)/2 - NW/2);
  const avail=H-PADT-PADB;
  function layout(nodes,total){ const g=Math.max(nodes.length-1,0)*GAP; const scale=avail-g; let y=PADT; return nodes.map(n=>{const h=Math.max(5,n.value/total*scale);const r={...n,y,h};y+=h+GAP;return r;}); }
  const iN=layout(incNodes,incTotal), gN=layout(groupNodes,spTotal), cN=layout(childNodes,spTotal);

  function flow(x0,y0,h0,x1,y1,h1,c0,c1){
    const mx=(x0+x1)/2; const g=ctx.createLinearGradient(x0,0,x1,0);
    g.addColorStop(0,(c0||'#3dda91')+'7a'); g.addColorStop(1,(c1||'#94a3b8')+'7a');
    ctx.beginPath(); ctx.moveTo(x0,y0); ctx.bezierCurveTo(mx,y0,mx,y1,x1,y1); ctx.lineTo(x1,y1+h1); ctx.bezierCurveTo(mx,y1+h1,mx,y0+h0,x0,y0+h0); ctx.closePath(); ctx.fillStyle=g; ctx.fill();
  }
  // income → group
  const iR=iN.map(n=>n.y), gL=gN.map(n=>n.y);
  iN.forEach((src,si)=>{ gN.forEach((dst,di)=>{
    const sfh=Math.max(0.5,src.h*dst.value/spTotal), dfh=Math.max(0.5,dst.h*src.value/incTotal);
    flow(xI+NW,iR[si],sfh,xG,gL[di],dfh,src.color,dst.color); iR[si]+=sfh; gL[di]+=dfh;
  }); });
  // group → child (each child to its own parent only)
  const gR=gN.map(n=>n.y);
  gN.forEach((g,gi)=>{ cN.forEach((c)=>{ if(c.parentId!==g.id) return;
    const sfh=Math.max(0.5,g.h*c.value/g.value), dfh=c.h;
    flow(xG+NW,gR[gi],sfh,xC,c.y,dfh,g.color,c.color); gR[gi]+=sfh;
  }); });

  const textC=getComputedStyle(document.documentElement).getPropertyValue('--text').trim()||'#e4e6f0';
  const mutC=getComputedStyle(document.documentElement).getPropertyValue('--muted').trim()||'#8b8fa8';
  const short=(s,n)=>s.length>n?s.slice(0,n-1)+'\u2026':s;
  // income nodes + labels (left)
  iN.forEach(n=>{ ctx.fillStyle=n.color; ctx.beginPath(); if(ctx.roundRect)ctx.roundRect(xI,n.y,NW,n.h,2);else ctx.rect(xI,n.y,NW,n.h); ctx.fill();
    ctx.textAlign='right'; ctx.font='bold 9px sans-serif'; ctx.fillStyle=textC; ctx.fillText(short(n.label,9),xI-4,n.y+n.h/2+3); });
  // group nodes + labels (centered above bar)
  gN.forEach(n=>{ ctx.fillStyle=n.color; ctx.beginPath(); if(ctx.roundRect)ctx.roundRect(xG,n.y,NW,n.h,2);else ctx.rect(xG,n.y,NW,n.h); ctx.fill();
    ctx.textAlign='center'; ctx.font='bold 9px sans-serif'; ctx.fillStyle=textC; ctx.fillText(short(n.label,16)+' '+Math.round(n.value/spTotal*100)+'%',xG+NW/2,n.y-4); });
  // child nodes + labels (right)
  cN.forEach(n=>{ ctx.fillStyle=n.color; ctx.beginPath(); if(ctx.roundRect)ctx.roundRect(xC,n.y,NW,n.h,2);else ctx.rect(xC,n.y,NW,n.h); ctx.fill();
    const midY=n.y+n.h/2; ctx.textAlign='left'; ctx.font='bold 9.5px sans-serif'; ctx.fillStyle=textC; ctx.fillText(short(n.label,15),xC+NW+4,midY-1);
    const val=n.value>=1000?'$'+(n.value/1000).toFixed(1)+'K':'$'+n.value; ctx.font='8.5px monospace'; ctx.fillStyle=mutC; ctx.fillText(val,xC+NW+4,midY+9); });
  // column headers
  ctx.font='bold 8px sans-serif'; ctx.fillStyle=mutC;
  ctx.textAlign='right'; ctx.fillText('INCOME',xI+NW,9);
  ctx.textAlign='center'; ctx.fillText('GROUP',xG+NW/2,9);
  ctx.textAlign='left'; ctx.fillText('CATEGORY',xC,9);
}

/* ═══════════════ GAMIFICATION: THE JOURNEY (real-money achievements) ═══════════════
   Minor → grand milestones tied to ACTUAL financial data. XP + levels + a daily
   streak + a wins log, surfaced in the "Your Journey" widget. Richie celebrates. */
let _gami=null;
const TIER_RANK={minor:1,major:2,grand:3};
function gamiLoad(){
  if(_gami) return _gami;
  try{ _gami=JSON.parse(LS.getItem('mdf_gami')||'null'); }catch(e){ _gami=null; }
  if(!_gami) _gami={ unlocked:{}, wins:[], streak:0, lastSeen:null, seeded:false, widgetSeeded:false };
  return _gami;
}
function gamiSave(){ try{ LS.setItem('mdf_gami', JSON.stringify(_gami)); }catch(e){} }
function _gMonthlyExpenses(){ try{ return dataLoaded?engSpend30():engMonthlyBills(); }catch(e){ return 0; } }
function gamiMetrics(){
  const G=GOAL_METRICS; const safe=(f,d)=>{ try{ const v=f(); return (v==null||isNaN(v))?(d||0):v; }catch(e){ return d||0; } };
  const liquid=safe(()=>dataLoaded?_liquidCash():0);
  const emer=safe(()=>G.emergency.get());
  const m={
    accounts: safe(()=>allAccts.length),
    goals: safe(()=>_goals().length),
    completedGoals: safe(()=>_goals().filter(x=>x.completed).length),
    catEdits: safe(()=>Object.keys(_catOverrides).length),
    notes: safe(()=>Object.keys(_txnNotes).length),
    cash: safe(()=>dataLoaded?engNetBalance():engNetWorth()),
    liquidCash: liquid,
    networth: safe(()=>G.networth.get()),
    debt: safe(()=>G.debt.get()),
    savings: safe(()=>G.savings.get()),
    savingsrate: safe(()=>G.savingsrate.get()),
    monthlyExpenses: _gMonthlyExpenses(),
    streak: (gamiLoad().streak||0),
    nwUpMonths: (typeof nwUpStreak==='function'?nwUpStreak():0),
  };
  m.efFund=Math.max(emer, liquid>0?liquid:0);   // emergency-fund value = bucket OR liquid cash, whichever is higher
  return m;
}
const ACHIEVEMENTS=[
  // ── minor: get going ──
  {id:'connect',  tier:'minor', icon:'🔗', name:'Linked Up',     desc:'Connect your first account.',            xp:20, cond:m=>m.accounts>0},
  {id:'firstgoal',tier:'minor', icon:'🎯', name:'Goal Setter',    desc:'Set your first goal.',                   xp:15, cond:m=>m.goals>0},
  {id:'cat10',    tier:'minor', icon:'🏷️', name:'Tidy Books',     desc:'Re-categorize 10 transactions.',         xp:15, cond:m=>m.catEdits>=10, prog:m=>({cur:m.catEdits,target:10,unit:''})},
  {id:'note1',    tier:'minor', icon:'📝', name:'Note to Self',   desc:'Add your first transaction note.',        xp:10, cond:m=>m.notes>0},
  {id:'streak3',  tier:'minor', icon:'🔥', name:'Warming Up',     desc:'Check in 3 days in a row.',               xp:20, cond:m=>m.streak>=3, prog:m=>({cur:m.streak,target:3,unit:'d'})},
  {id:'cashpos',  tier:'minor', icon:'💵', name:'In the Green',   desc:'Hold a positive cash balance.',           xp:10, cond:m=>m.cash>0},
  // ── major: real traction ──
  {id:'ef1k',     tier:'major', icon:'🛟', name:'Safety Net',     desc:'Save your first $1,000.',                xp:50, cond:m=>m.efFund>=1000, prog:m=>({cur:m.efFund,target:1000,unit:'$'})},
  {id:'nwpos',    tier:'major', icon:'⚖️', name:'Above Water',    desc:'Reach a positive net worth.',            xp:40, cond:m=>m.networth>0},
  {id:'sr10',     tier:'major', icon:'📊', name:'Saver',          desc:'Hit a 10% savings rate.',                xp:50, cond:m=>m.savingsrate>=10, prog:m=>({cur:m.savingsrate,target:10,unit:'%'})},
  {id:'ef1mo',    tier:'major', icon:'🛡️', name:'One Month Strong',desc:'Bank one month of expenses.',           xp:60, cond:m=>m.monthlyExpenses>0&&m.efFund>=m.monthlyExpenses, prog:m=>({cur:m.efFund,target:Math.max(1,m.monthlyExpenses),unit:'$'})},
  {id:'streak7',  tier:'major', icon:'🔥', name:'On a Roll',      desc:'Check in 7 days in a row.',              xp:40, cond:m=>m.streak>=7, prog:m=>({cur:m.streak,target:7,unit:'d'})},
  {id:'goaldone', tier:'major', icon:'🏅', name:'First Victory',  desc:'Complete a goal.',                       xp:60, cond:m=>m.completedGoals>=1},
  {id:'goals3',   tier:'major', icon:'🏅', name:'Goal Crusher',   desc:'Complete 3 goals.',                      xp:80, cond:m=>m.completedGoals>=3, prog:m=>({cur:m.completedGoals,target:3,unit:''})},
  {id:'nwup3',    tier:'major', icon:'🌊', name:'Rising Tide',    desc:'Grow net worth 3 months running.',       xp:60, cond:m=>m.nwUpMonths>=3, prog:m=>({cur:m.nwUpMonths,target:3,unit:''})},
  // ── grand: life-changing ──
  {id:'debtfree', tier:'grand', icon:'🚀', name:'Debt-Free',      desc:'Bring all debt to zero.',                xp:150, cond:m=>m.accounts>0&&m.debt<=0},
  {id:'ef3mo',    tier:'grand', icon:'🏰', name:'Fortress Fund',  desc:'Save 3 months of expenses.',             xp:120, cond:m=>m.monthlyExpenses>0&&m.efFund>=m.monthlyExpenses*3, prog:m=>({cur:m.efFund,target:Math.max(1,m.monthlyExpenses*3),unit:'$'})},
  {id:'nw100k',   tier:'grand', icon:'💎', name:'Six Figures',    desc:'Cross $100,000 net worth.',              xp:200, cond:m=>m.networth>=100000, prog:m=>({cur:Math.max(0,m.networth),target:100000,unit:'$'})},
  {id:'sr20',     tier:'grand', icon:'📈', name:'Wealth Builder', desc:'Sustain a 20% savings rate.',            xp:100, cond:m=>m.savingsrate>=20, prog:m=>({cur:m.savingsrate,target:20,unit:'%'})},
  {id:'streak30', tier:'grand', icon:'☄️', name:'Unstoppable',    desc:'Check in 30 days in a row.',             xp:100, cond:m=>m.streak>=30, prog:m=>({cur:m.streak,target:30,unit:'d'})},
  {id:'nwup6',    tier:'grand', icon:'🏔️', name:'Momentum',       desc:'Grow net worth 6 months running.',       xp:140, cond:m=>m.nwUpMonths>=6, prog:m=>({cur:m.nwUpMonths,target:6,unit:''})},
  {id:'goals5',   tier:'grand', icon:'👑', name:'Goal Machine',   desc:'Complete 5 goals.',                      xp:160, cond:m=>m.completedGoals>=5, prog:m=>({cur:m.completedGoals,target:5,unit:''})},
];
const ACH_BY_ID=Object.fromEntries(ACHIEVEMENTS.map(a=>[a.id,a]));
// Records daily activity only. The STREAK no longer advances just for opening the app —
// it advances on a real action (see gamiMarkEngaged), which is what makes it meaningful.
function gamiCheckin(){
  const s=gamiLoad(); const today=new Date(); today.setHours(0,0,0,0);
  s.lastSeen=today.getTime(); gamiSave();
}
function _streakDay(ts){ ts=ts||Date.now(); return Math.floor((ts - new Date(ts).getTimezoneOffset()*60000)/86400000); }   // local day number
const STREAK_MILESTONES=[3,7,14,30,60,100,180,365];
function streakNextMilestone(n){ for(const mi of STREAK_MILESTONES){ if(mi>n) return mi; } return null; }
function _refreshJourney(){ try{ const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg && (pg.widgets||[]).some(w=>w.type==='journey')) renderCanvas(pg); }catch(e){} }
// Advance the daily streak when the user takes a real action. One missed day is forgiven by a
// weekly-regenerating grace day; a bigger gap resets. No-op if today is already counted.
function gamiMarkEngaged(reason){
  const s=gamiLoad(); const today=_streakDay();
  if(s.lastAction==null && s.lastSeen!=null){ s.lastAction=_streakDay(s.lastSeen); if(!s.streak) s.streak=1; }   // carry existing streaks over on first run
  if(s.lastAction===today) return s.streak||0;
  if(s.freeze==null) s.freeze=1;
  const prev=s.lastAction;
  if(prev==null) s.streak=1;
  else { const gap=today-prev;
    if(gap<=1) s.streak=(s.streak||0)+1;
    else if(gap===2 && s.freeze>0){ s.freeze=0; s.freezeUsedDay=today; s.streak=(s.streak||0)+1; }   // one missed day forgiven
    else s.streak=1;
  }
  s.lastAction=today; s.bestStreak=Math.max(s.bestStreak||0, s.streak||0);
  if(s.freeze<1 && s.freezeUsedDay!=null && (today-s.freezeUsedDay)>=7) s.freeze=1;   // grace regenerates weekly
  gamiSave();
  if(STREAK_MILESTONES.includes(s.streak)){
    try{ gamiCelebrate({icon:'🔥', title:'Streak milestone!', name:`${s.streak}-day streak`, desc:`You've shown up ${s.streak} days running — that consistency is exactly how the money habit sticks.`, share:`I'm on a ${s.streak}-day money streak with Richie! 🔥`}); }catch(e){}
  }
  try{ gamiEvaluate(); }catch(e){}   // may unlock streak badges
  try{ _refreshJourney(); }catch(e){}
  return s.streak;
}
/* ═══ DAILY / WEEKLY QUESTS ═══
   A repeatable XP loop on top of the one-time achievements. Each quest checks derivable
   state; completing it credits XP once per period (day or ISO week). Evaluated from
   gamiEvaluate, so it re-checks on every data refresh and after any tracked action. */
const QUESTS=[
  {id:'review',   scope:'daily',  icon:'🏷️', label:'Clear your review queue',       xp:15, check:()=>{ try{ return dataLoaded && _reviewTxns().length===0; }catch(e){ return false; } }},
  {id:'onpace',   scope:'daily',  icon:'🎯', label:'Keep spending on pace',          xp:10, check:()=>{ try{ const s=engSpendTrends(); return !s.budget || s.budget.pace>=0; }catch(e){ return false; } }},
  {id:'balanced', scope:'daily',  icon:'🧮', label:'Give every dollar a job',         xp:10, check:()=>{ try{ const inc=engMonthlyIncome(); if(inc<=0) return false; const env=_zbBuckets().reduce((s,b)=>s+(b.amt||0),0); return Math.abs(inc-(env+engMonthlyBills()))<1; }catch(e){ return false; } }},
  {id:'util',     scope:'weekly', icon:'💳', label:'Credit utilization under 30%',    xp:30, check:()=>{ try{ const c=engCreditUtil(); return !(c.limit>0) || c.pct<30; }catch(e){ return false; } }},
  {id:'streak5',  scope:'weekly', icon:'🔥', label:'Reach a 5-day streak',            xp:40, check:()=>{ try{ return (gamiLoad().streak||0)>=5; }catch(e){ return false; } }},
];
function _questDayKey(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function _questWeekKey(){ const d=new Date(); const oneJan=new Date(d.getFullYear(),0,1); const wk=Math.ceil((((d-oneJan)/86400000)+oneJan.getDay()+1)/7); return d.getFullYear()+'-W'+String(wk).padStart(2,'0'); }
function _questState(){ const s=gamiLoad(); if(!s.quests) s.quests={}; const dk=_questDayKey(), wk=_questWeekKey();
  if(!s.quests.d || s.quests.d.k!==dk) s.quests.d={k:dk, done:{}};
  if(!s.quests.w || s.quests.w.k!==wk) s.quests.w={k:wk, done:{}};
  return s.quests; }
function questEvaluate(){
  const q=_questState(); let awarded=0;
  QUESTS.forEach(def=>{ const bucket=def.scope==='daily'?q.d:q.w; if(bucket.done[def.id]) return;
    let ok=false; try{ ok=!!def.check(); }catch(e){}
    if(ok){ bucket.done[def.id]=true; awarded+=def.xp; }
  });
  gamiSave();
  if(awarded>0){ try{ awardXp(awarded,'quest'); }catch(e){}
    try{ const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg && (pg.widgets||[]).some(w=>w.type==='journey')) renderCanvas(pg); }catch(e){} }
  return q;
}
function gamiEvaluate(opts){
  opts=opts||{}; try{ nwHistRecord(); }catch(e){} try{ hsHistRecord(); }catch(e){} try{ questEvaluate(); }catch(e){}
  const s=gamiLoad(); const firstRun=!s.seeded; const m=gamiMetrics(); const newly=[];
  ACHIEVEMENTS.forEach(a=>{
    if(s.unlocked[a.id]) return;
    let ok=false; try{ ok=!!a.cond(m); }catch(e){ ok=false; }
    if(ok){ s.unlocked[a.id]=Date.now(); s.wins.unshift({id:a.id,icon:a.icon,name:a.name,tier:a.tier,ts:Date.now()}); newly.push(a); }
  });
  if(s.wins.length>40) s.wins.length=40;
  if(newly.length){
    let xpSum=0; newly.forEach(a=>xpSum+=a.xp);
    try{ awardXp(xpSum); }catch(e){ try{ APP.xp=(APP.xp||0)+xpSum; saveState(); }catch(_){} }
    if(!firstRun && !opts.silent){
      const top=newly.slice().sort((a,b)=>TIER_RANK[b.tier]-TIER_RANK[a.tier])[0];
      const extra=newly.length>1?` (+${newly.length-1} more)`:'';
      if(TIER_RANK[top.tier]>=2){   // major/grand → full-screen celebration + share card
        try{ gamiCelebrate({icon:top.icon, title:top.tier==='grand'?'Grand milestone! 🎉':'Achievement unlocked!', name:top.name, desc:top.desc}); }catch(e){}
        try{ richieCelebrate(`${top.icon} ${top.name}!${extra} +${xpSum} XP`); }catch(e){}
      } else {                      // minor → light Richie celebration
        try{ richieCelebrate(`${top.icon} ${top.name}!${extra} +${xpSum} XP`); }catch(e){}
      }
    }
  }
  if(firstRun) s.seeded=true;
  gamiSave();
  return newly;
}
function gamiInit(){
  gamiCheckin();
  const s=gamiLoad();
  if(!s.widgetSeeded){
    try{ const has=(APP.pages||[]).some(p=>(p.widgets||[]).some(w=>w.type==='journey')); if(!has && APP.pages && APP.pages[0]){ APP.pages[0].widgets=APP.pages[0].widgets||[]; APP.pages[0].widgets.unshift(makeWidget('journey')); saveState(); } }catch(e){}
    s.widgetSeeded=true; gamiSave();
  }
  gamiEvaluate();
}
function _gProgLabel(p){ if(p.unit==='$') return fmtK(p.cur)+' / '+fmtK(p.target); if(p.unit==='%') return Math.round(p.cur)+'% / '+p.target+'%'; if(p.unit==='d') return p.cur+' / '+p.target+'d'; return p.cur+' / '+p.target; }
function _gRelDate(ts){ const d=Math.floor((Date.now()-ts)/86400000); if(d<=0) return 'today'; if(d===1) return 'yesterday'; if(d<7) return d+'d ago'; return new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric'}); }
// Household weekly challenge — this rolling 7-day spend vs the 7 before. State syncs across the
// household, so it's a shared "beat last week" game for everyone on the account (not per-member
// attribution, which the data model doesn't track).
function _householdChallenge(){
  try{
    if(!dataLoaded) return '';
    const now=Date.now();
    const wk=(a,b)=>(allTxns||[]).filter(t=>{ const d=new Date(t.date).getTime(); return d>=now-b*86400000 && d<now-a*86400000 && t.amount>0 && !_txnExcludedFromSpend(t); }).reduce((s,t)=>s+t.amount,0);
    const thisWk=Math.round(wk(0,7)), lastWk=Math.round(wk(7,14));
    if(lastWk<=0 && thisWk<=0) return '';
    const members=((APP.profiles)||[]).length;
    const who=members>1?'Your household':'You';
    const under=thisWk<=lastWk, diff=Math.abs(lastWk-thisWk);
    const pct=lastWk>0?Math.min(100,Math.round(thisWk/lastWk*100)):100;
    const col=under?'var(--pos)':'var(--amber)';
    const msg = lastWk<=0 ? `First week tracked — ${fmtK(thisWk)} spent. Next week you'll have a number to beat.`
      : under ? `${who} spent ${fmtK(thisWk)} — ${fmtK(diff)} under last week's ${fmtK(lastWk)}. 🏆 Keep it up!`
      : `${who} spent ${fmtK(thisWk)} — ${fmtK(diff)} over last week's ${fmtK(lastWk)}. Rein it in to win the week.`;
    return `<div class="jrn-sec">Beat last week${members>1?' · household':''}</div>
      <div class="jrn-chal">
        <div class="jrn-chal-top"><span class="jrn-chal-lbl">This week</span><b style="color:${col}">${fmtK(thisWk)}</b><span class="jrn-chal-vs">vs ${fmtK(lastWk)} last week</span></div>
        <div class="jrn-chal-bar"><div class="jrn-chal-fill" style="width:${pct}%;background:${col}"></div></div>
        <div class="jrn-chal-msg">${msg}</div>
      </div>`;
  }catch(e){ return ''; }
}
function journeyBody(w){
  try{ gamiCheckin(); gamiEvaluate(); }catch(e){}
  const s=gamiLoad(); const m=gamiMetrics();
  const lv=LEVELS.find(l=>l.n===APP.level)||LEVELS[0];
  const lp=levelProgress();
  const nextLv=LEVELS.find(l=>l.n===APP.level+1);
  const locked=ACHIEVEMENTS.filter(a=>!s.unlocked[a.id]);
  const withProg=locked.filter(a=>a.prog).map(a=>{ const p=a.prog(m); const pct=Math.max(0,Math.min(100,Math.round((p.cur/(p.target||1))*100))); return {a,p,pct}; }).sort((x,y)=>y.pct-x.pct);
  const nextThree=withProg.slice(0,3);
  const unlockedCount=Object.keys(s.unlocked).length, totalCount=ACHIEVEMENTS.length;
  const milestones = nextThree.length ? nextThree.map(o=>`<div class="jrn-ms"><div class="jrn-ms-top"><span>${o.a.icon} ${esc(o.a.name)}</span><b>${_gProgLabel(o.p)}</b></div><div class="jrn-ms-bar"><i style="width:${o.pct}%"></i></div><div class="jrn-ms-desc">${esc(o.a.desc)}</div></div>`).join('') : `<div class="jrn-empty">🎉 You've cleared every tracked milestone — grand work!</div>`;
  const wins=(s.wins||[]).slice(0,4).map(wn=>`<div class="jrn-win"><span class="jrn-win-ic">${wn.icon}</span><span class="jrn-win-nm">${esc(wn.name)}</span><span class="jrn-win-dt">${_gRelDate(wn.ts)}</span></div>`).join('') || `<div class="jrn-empty">Your wins will show up here as you hit milestones.</div>`;
  const badges=ACHIEVEMENTS.map(a=>{ const on=!!s.unlocked[a.id]; return `<div class="jrn-badge ${on?'on':'off'} t-${a.tier}" title="${esc(a.name)} — ${esc(a.desc)}"><span class="jrn-badge-ic">${on?a.icon:'🔒'}</span><span class="jrn-badge-nm">${esc(a.name)}</span></div>`; }).join('');
  return `<div class="jrn">
    <div class="jrn-head">
      <div class="jrn-lvl"><span class="jrn-lvl-ic">${lv.icon}</span><div><div class="jrn-lvl-nm">Level ${lv.n} · ${esc(lv.name)}</div><div class="jrn-lvl-sub">${APP.proMode?'Pro Mode — maxed out':(nextLv?(lp.toNext.toLocaleString()+' XP to '+esc(nextLv.name)):'Top level reached')}</div></div></div>
      ${(function(){
        const st=s.streak||0, today=_streakDay(), doneToday=(s.lastAction!=null && s.lastAction===today);
        const nm=streakNextMilestone(st), freezeOn=(s.freeze==null?1:s.freeze)>0;
        const sub=doneToday ? (nm?`${nm-st} to your ${nm}-day badge`:'every day counts') : 'do one thing today to keep it';
        return `<div class="jrn-streak ${doneToday?'lit':'dim'}" title="${doneToday?'Checked in today ✓':'Take one action today to keep your streak alive'}">
          <span class="jrn-flame">${st>0?'🔥':'🕯️'}</span>
          <div class="jrn-streak-txt"><div class="jrn-streak-n"><b>${st}</b> day${st===1?'':'s'}${freezeOn?' <span class="jrn-freeze" title="Grace day — one miss is forgiven">❄️</span>':''}</div><div class="jrn-streak-sub">${sub}</div></div>
        </div>`;
      })()}
    </div>
    <div class="jrn-xp"><i style="width:${APP.proMode?100:lp.pct}%"></i></div>
    <div class="jrn-stats"><span><b>${APP.xp}</b> XP</span><span><b>${unlockedCount}/${totalCount}</b> badges</span><span><b>${m.completedGoals}</b> goals done</span><span><b>${s.bestStreak||s.streak||0}</b> best 🔥</span></div>
    ${(function(){ try{
      const q=_questState();
      const row=def=>{ const done=(def.scope==='daily'?q.d:q.w).done[def.id]; return `<div class="jrn-quest${done?' done':''}"><span class="jrn-q-ic">${done?'✅':def.icon}</span><span class="jrn-q-lbl">${esc(def.label)}</span><span class="jrn-q-xp">+${def.xp} XP</span></div>`; };
      const daily=QUESTS.filter(x=>x.scope==='daily'), weekly=QUESTS.filter(x=>x.scope==='weekly');
      const dDone=daily.filter(x=>q.d.done[x.id]).length, wDone=weekly.filter(x=>q.w.done[x.id]).length;
      return `<div class="jrn-sec">Daily quests <span class="jrn-sec-ct">${dDone}/${daily.length}</span></div><div class="jrn-quests">${daily.map(row).join('')}</div>`
        + `<div class="jrn-sec">Weekly quests <span class="jrn-sec-ct">${wDone}/${weekly.length}</span></div><div class="jrn-quests">${weekly.map(row).join('')}</div>`;
    }catch(e){ return ''; } })()}
    ${(function(){ try{ const h=nwHistMonthly(6); if(h&&h.length>=2){ const vals=h.map(x=>x.v); const diff=vals[vals.length-1]-vals[0]; const up=diff>=0; return `<div class="jrn-sec">Net worth trend <span class="jrn-trend-lbl ${up?'up':'down'}">${up?'▲':'▼'} ${fmtK(Math.abs(diff))} · ${h.length}mo</span></div><div class="jrn-trend">${_sparkline(vals, up?'#2ecc8a':'#e85d75', 260, 42)}</div>`; } }catch(e){} return ''; })()}
    ${_householdChallenge()}
    <div class="jrn-sec">Next milestones</div>
    ${milestones}
    <div class="jrn-sec">Recent wins</div>
    <div class="jrn-wins">${wins}</div>
    <div class="jrn-sec">Badges <span class="jrn-sec-ct">${unlockedCount}/${totalCount}</span></div>
    <div class="jrn-badges">${badges}</div>
  </div>`;
}

/* ── Net-worth history (real trend + month-over-month streaks) ── */
function _nwNow(){ try{ return dataLoaded?engNetBalance()+engNWAssets()-engNWLiab():engNetWorth(); }catch(e){ return 0; } }
function nwHistLoad(){ try{ const a=JSON.parse(LS.getItem('mdf_nw_history')||'[]'); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
function nwHistRecord(){
  try{
    const v=_nwNow(); if(v==null||isNaN(v)) return;
    const d=new Date(); const key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    let h=nwHistLoad();
    if(h.length && h[h.length-1].d===key) h[h.length-1].v=Math.round(v);
    else h.push({d:key, v:Math.round(v)});
    if(h.length>420) h=h.slice(h.length-420);
    LS.setItem('mdf_nw_history', JSON.stringify(h));
  }catch(e){}
}
function nwHistMonthly(n){
  const h=nwHistLoad(); if(!h.length) return [];
  const byMonth={};
  h.forEach(e=>{ const mk=e.d.slice(0,7); byMonth[mk]=e.v; });   // last value seen in each month wins
  const keys=Object.keys(byMonth).sort();
  const out=keys.map(k=>{ const [y,m]=k.split('-'); const lbl=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(+m)-1]; return {label:lbl, key:k, v:byMonth[k]}; });
  return n?out.slice(-n):out;
}
/* ── Health-score history (real trend + grade-up celebrations) ── */
function hsHistLoad(){ try{ const a=JSON.parse(LS.getItem('mdf_health_history')||'[]'); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
function _hsLetterRank(g){ const r={F:0,D:1,C:2,B:3,A:4}[String(g||'F').charAt(0)]; return r==null?0:r; }
const HS_BANDS=[[60,'D'],[67,'D+'],[70,'C−'],[73,'C'],[77,'C+'],[80,'B−'],[83,'B'],[87,'B+'],[90,'A−'],[93,'A']];
function _hsToNext(score){ for(let i=0;i<HS_BANDS.length;i++){ if(HS_BANDS[i][0]>score) return {pts:HS_BANDS[i][0]-score, grade:HS_BANDS[i][1]}; } return null; }
function hsHistRecord(){
  try{
    if(!dataLoaded || typeof engHealthScore!=='function') return;
    const r=engHealthScore(); if(!r||!r.hasData) return;
    const d=new Date(); const key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    let h=hsHistLoad();
    if(h.length && h[h.length-1].d===key){ h[h.length-1].v=r.overall; h[h.length-1].g=r.grade; }
    else h.push({d:key, v:r.overall, g:r.grade});
    if(h.length>420) h=h.slice(h.length-420);
    LS.setItem('mdf_health_history', JSON.stringify(h));
    const ack=LS.getItem('mdf_health_grade')||'';
    if(!ack){ LS.setItem('mdf_health_grade', r.grade); }
    else if(_hsLetterRank(r.grade)>_hsLetterRank(ack)){ LS.setItem('mdf_health_grade', r.grade);
      try{ gamiCelebrate({icon:'🩺', title:'Health grade up!', name:`You reached ${r.grade}`, desc:`Your financial-health grade climbed to ${r.grade} (${r.overall}/100) — real progress across the pillars.`, share:`My financial-health grade just hit ${r.grade} on Richie! 🩺`}); }catch(e){}
    }
    else if(_hsLetterRank(r.grade)<_hsLetterRank(ack)){ LS.setItem('mdf_health_grade', r.grade); }   // dropped — reset baseline so a re-climb re-celebrates
  }catch(e){}
}
// Health-score change over the last `days` (points). Returns {abs, fromKey} or null.
function hsChangeSince(days){
  const h=hsHistLoad(); if(h.length<2) return null;
  const now=h[h.length-1].v; const cutoff=Date.now()-days*86400000;
  let base=null;
  for(let i=h.length-1;i>=0;i--){ if(new Date(h[i].d+'T12:00:00').getTime()<=cutoff){ base=h[i]; break; } }
  if(!base) base=h[0];
  if(base.d===h[h.length-1].d) return null;
  return {abs:now-base.v, fromKey:base.d};
}
function nwUpStreak(){
  const mo=nwHistMonthly(); if(mo.length<2) return 0;
  let streak=0;
  for(let i=mo.length-1;i>0;i--){ if(mo[i].v>mo[i-1].v) streak++; else break; }
  return streak;
}
// Net-worth change over the last `days` (from the daily snapshot log). Returns {abs, pct, fromKey} or null.
function nwChangeSince(days){
  const h=nwHistLoad(); if(h.length<2) return null;
  const now=h[h.length-1].v;
  const cutoff=Date.now()-days*86400000;
  let base=null;
  for(let i=h.length-1;i>=0;i--){ if(new Date(h[i].d+'T12:00:00').getTime()<=cutoff){ base=h[i]; break; } }
  if(!base) base=h[0];              // not enough history yet — compare to the earliest snapshot
  if(base.d===h[h.length-1].d) return null;
  const prev=base.v;
  return {abs:now-prev, pct: prev!==0?((now-prev)/Math.abs(prev)*100):0, fromKey:base.d};
}
// Monthly snapshots with month-over-month deltas, for the history detail view.
function nwHistWithDeltas(n){
  const mo=nwHistMonthly(n);
  return mo.map((m,i)=>({...m, delta: i>0 ? m.v-mo[i-1].v : null}));
}
/* ── Goal completion → wins + celebration (custom or preset goals) ── */
function gamiGoalCompleted(g){
  const s=gamiLoad(); const wid='goal_'+(g.id||g.name);
  if(!(s.wins||[]).some(w=>w.id===wid)){ s.wins.unshift({id:wid, icon:'🎯', name:'Goal: '+(g.name||'Goal'), tier:'major', ts:Date.now()}); if(s.wins.length>40) s.wins.length=40; gamiSave(); }
  try{ gamiCelebrate({icon:'🎯', title:'Goal complete!', name:g.name||'Goal complete', desc:'You set this goal and saw it through — that\u2019s real progress.', share:`I just completed my "${g.name}" goal on Richie! 🎯💰`}); }catch(e){}
  try{ gamiEvaluate(); }catch(e){}   // may unlock Goal Crusher / Goal Machine
}
/* ── Full-screen celebration + share card ── */
let _celeShareText='';
function gamiCelebrate(opts){
  opts=opts||{}; const el=gg('gamiCele'); if(!el) return;
  const set=(id,t)=>{ const n=gg(id); if(n) n.textContent=t; };
  set('celeIcon', opts.icon||'🏆'); set('celeKicker', opts.title||'Achievement unlocked!');
  set('celeName', opts.name||''); set('celeDesc', opts.desc||'');
  const lv=LEVELS.find(l=>l.n===APP.level)||LEVELS[0];
  set('celeMeta', `${lv.icon} Level ${lv.n} · ${APP.xp} XP`);
  _celeShareText=opts.share||`I just unlocked "${opts.name}" on Richie! ${lv.icon} Level ${lv.n} · ${APP.xp} XP 💰`;
  el.style.display='flex';
  requestAnimationFrame(()=>{ el.classList.add('show'); _celeConfetti(); try{ emojiBurst(opts.fx||'rocket', {particle:'stars', count:16}); }catch(e){} });
}
function closeGamiCele(){ const el=gg('gamiCele'); if(el){ el.classList.remove('show'); el.style.display='none'; } }
async function gamiShare(){
  try{ if(navigator.share){ await navigator.share({text:_celeShareText}); return; } }catch(e){}
  try{ await navigator.clipboard.writeText(_celeShareText); const b=gg('celeShareBtn'); if(b){ const o=b.textContent; b.textContent='Copied! ✓'; setTimeout(()=>{ b.textContent=o; }, 1600); } }catch(e){}
}
function _celeConfetti(){
  const cv=gg('celeCanvas'); if(!cv) return;
  const W=window.innerWidth, H=window.innerHeight, dpr=window.devicePixelRatio||1;
  cv.width=W*dpr; cv.height=H*dpr; cv.style.width=W+'px'; cv.style.height=H+'px';
  const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr);
  const cols=['#2ecc8a','#7be0b4','#f5a623','#5b8def','#e85d75','#c9a84c'];
  const parts=[]; for(let i=0;i<150;i++){ parts.push({x:Math.random()*W, y:-20-Math.random()*H*0.5, r:5+Math.random()*7, c:cols[i%cols.length], vy:2.4+Math.random()*4, vx:-2.4+Math.random()*4.8, rot:Math.random()*6.28, vr:-0.25+Math.random()*0.5, shape:Math.random()<0.5?0:1}); }
  const t0=performance.now(); let raf;
  function frame(t){
    const el=gg('gamiCele'); if(!el || el.style.display==='none'){ cancelAnimationFrame(raf); return; }
    ctx.clearRect(0,0,W,H);
    parts.forEach(p=>{ p.x+=p.vx; p.y+=p.vy; p.vy+=0.045; p.rot+=p.vr; ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.fillStyle=p.c; if(p.shape===0) ctx.fillRect(-p.r/2,-p.r/2,p.r,p.r*0.62); else { ctx.beginPath(); ctx.arc(0,0,p.r/2,0,6.28); ctx.fill(); } ctx.restore(); });
    if(t-t0<4400) raf=requestAnimationFrame(frame); else ctx.clearRect(0,0,W,H);
  }
  raf=requestAnimationFrame(frame);
}

function renderWidgetBody(w){
  const def=WIDGET_BY_ID[w.type]; if(!def) return '';
  if(!widgetUnlocked(def)) return `<div class="wph-lock"><div class="wph-lock-icon">🔒</div><div style="font-size:12.5px">Unlocks at level ${def.minLevel}</div></div>`;
  const bars=n=>`<div class="wph-bars">${Array.from({length:n}).map(()=>`<div class="wph-bar" style="height:${30+Math.random()*70}%"></div>`).join('')}</div>`;
  switch(w.type){
    case 'journey': return journeyBody(w);
    case 'net_worth_summary': { const a=engNWAssets(), l=engNWLiab(); const nw=dataLoaded?(engNetBalance()+a-l):(a-l); const nwGoalG=(APP.goals||[]).filter(x=>x.metric==='networth'&&x.target>0).sort((x,y)=>y.target-x.target)[0]; const goalNW=nwGoalG?nwGoalG.target:(nw>0?Math.max(100000,Math.ceil((nw+1)/100000)*100000):100000); const gPct=goalNW>0?Math.max(0,Math.min(100,Math.round(nw/goalNW*100))):0; return `<div class="wph"><div class="wph-stat" style="color:${moneyCol(nw)}">${fmtK(nw)}</div><div class="wph-sub">net worth · ${gPct}% to goal</div><div class="ds-budget"><div class="ds-budget-top"><span style="color:${moneyCol(nw)};font-weight:700">Now ${fmtK(nw)}</span><span style="color:var(--muted)">Goal ${fmtK(goalNW)}</span></div><div class="ds-bar" style="background:var(--surface3)"><div class="ds-bar-fill" style="width:${gPct}%;background:var(--pos)"></div></div></div><button class="nw-manage" onclick="event.stopPropagation();openNetWorthEditor()">🏠 Add home, car & other assets</button></div>`; }
    case 'cash_summary': return cashSummaryBody(w);
    case 'health_score': return healthScoreBody(w);
    case 'spending_hub': return spendingHubBody(w);
    case 'spending_month': return discretionarySpendBody(w);
    case 'income_month': { const days=wDays(w); if(dataLoaded){ const inc=engIncome(days); const now=Date.now(), ps=new Date(now-2*days*86400000), pe=new Date(now-days*86400000); const prev=allTxns.filter(t=>{const d=new Date(t.date);return d>=ps&&d<pe&&_isIncomeTxn(t);}).reduce((s,t)=>s+Math.abs(t.amount),0); const dl=prev>0?Math.round((inc-prev)/prev*100):null; const up=dl!==null&&dl>=0; const trend=dl===null?'':`<div class="ds-trend-label" style="color:${up?'var(--green)':'var(--amber)'};margin-top:9px">${up?'▲':'▼'} ${Math.abs(dl)}% vs prior ${tfLabel(w.tf||'30d')}</div>`; const rec=engRecent(days).filter(_isIncomeTxn); const byC={}; rec.forEach(t=>{const c=getTxnCategory(t);byC[c]=(byC[c]||0)+Math.abs(t.amount);}); const top=Object.entries(byC).sort((a,b)=>b[1]-a[1])[0]; return `<div class="wph"><div class="wph-stat" style="color:var(--pos)">${fmtK(inc)}</div><div class="wph-sub">last ${tfLabel(w.tf||'30d')}</div>${trend}${top?`<div class="wph-inline"><span>Top source: ${esc(top[0])}</span><b style="color:var(--pos)">${fmtK(top[1])}</b></div>`:''}</div>`; } const top=incomeSources.slice().sort((a,b)=>b.amt*(FREQ_TO_MONTHLY[b.freq]||1)-a.amt*(FREQ_TO_MONTHLY[a.freq]||1))[0]; return `<div class="wph"><div class="wph-stat" style="color:var(--pos)">${fmtK(Math.round(5400*days/30))}</div><div class="wph-sub">${incomeSources.length} sources \u00b7 sample</div><div class="ds-trend-label" style="color:var(--green);margin-top:9px">▲ 6% vs prior 30d</div><div class="wph-inline"><span>Top source: ${top.name}</span><b style="color:var(--green)">${fmtK(Math.round(top.amt*(FREQ_TO_MONTHLY[top.freq]||1)))}/mo</b></div></div>`; }
    case 'debt_summary': return debtSummaryBody(w);
    case 'category_heatmap': return categoryHeatmapBody(w);
    case 'spending_trends': return spendTrendsBody(w);
    case 'budget_doughnut': return budgetTiersBody(w);
    case 'top_categories': { const cfg=widgetConfig(w); const days=wDays(w);
      let cats = dataLoaded ? engCategoryBreakdownQ(days, cfg.query) : [{label:'Dining Out',value:612,color:'#f5a623'},{label:'Food & Groceries',value:498,color:'#3dda91'},{label:'Auto Payments',value:284,color:'#b09afa'},{label:'Subscriptions',value:142,color:'#22d3ee'},{label:'Travel',value:96,color:'#818cf8'},{label:'Medical',value:60,color:'#34d399'}];
      // sort
      if(cfg.sortBy==='name') cats=cats.slice().sort((a,b)=>cfg.sortDir==='asc'?a.label.localeCompare(b.label):b.label.localeCompare(a.label));
      else if(cfg.sortBy==='value') cats=cats.slice().sort((a,b)=>cfg.sortDir==='asc'?a.value-b.value:b.value-a.value);
      cats=cats.slice(0, cfg.topN||(w.type==='top_categories'?4:6));
      const tot=cats.reduce((s,c)=>s+c.value,0);
      const col=(c,i)=>cfg.accent||palColor(cfg.palette,i,cats.length,c.color);
      const style = cfg.chartStyle==='auto' ? (w.type==='budget_doughnut'?'doughnut':'list') : cfg.chartStyle;
      // value/pct display per item
      const itemVal=(c)=>{ const parts=[]; if(cfg.showValues&&cfg.numFormat!=='hidden') parts.push(fmtCfg(c.value,cfg,tot)); if(cfg.showPct&&tot>0) parts.push(Math.round(c.value/tot*100)+'%'); return parts.join(' · ')||fmtCfg(c.value,cfg,tot); };
      const legendItems=cats.map((c,i)=>`<div class="cwl-item"><span class="cwl-dot" style="background:${col(c,i)}"></span><span class="cwl-label">${esc(c.label)}</span><span class="cwl-amt">${itemVal(c)}</span></div>`).join('');
      const legendOn = cfg.legend&&cfg.legendPos!=='none';
      if(style==='doughnut'||style==='pie'){
        const thick=cfg.donutThickness;
        let acc=0; const stops=tot>0?cats.map((c,i)=>{ const a=acc/tot*100; acc+=c.value; const b=acc/tot*100; return `${col(c,i)} ${a.toFixed(1)}% ${b.toFixed(1)}%`; }).join(','):'var(--surface3) 0 100%';
        const holePx = style==='pie'||thick==='full'?0:(thick==='thin'?64:48);
        const hole = holePx>0?`<div style="position:absolute;inset:50% auto auto 50%;transform:translate(-50%,-50%);width:${holePx}px;height:${holePx}px;border-radius:50%;background:var(--surface)"></div>`:'';
        const ring=`<div style="position:relative;width:96px;height:96px;flex-shrink:0;border-radius:50%;background:conic-gradient(${stops})">${hole}</div>`;
        const side = (cfg.legendPos==='left'||cfg.legendPos==='right');
        if(legendOn&&side){
          return `<div class="cwl-flexrow ${cfg.legendPos==='left'?'cwl-rev':''}">${ring}<div class="cwl-legend cwl-side">${legendItems}</div></div>`;
        }
        if(legendOn&&cfg.legendPos==='top'){
          return `<div class="cwl-flexcol"><div class="cwl-legend">${legendItems}</div><div style="text-align:${cfg.align};margin-top:8px">${ring}</div></div>`;
        }
        return `<div class="wph" style="text-align:${cfg.align}"><div style="display:flex;justify-content:${cfg.align==='left'?'flex-start':cfg.align==='right'?'flex-end':'center'}">${ring}</div>${legendOn?`<div class="cwl-legend" style="margin-top:10px">${legendItems}</div>`:`<div class="wph-sub" style="margin-top:6px">${cats.length} categories \u00b7 ${fmtCfg(tot,cfg)}</div>`}</div>`;
      }
      if(style==='bar'){
        const mx=Math.max(...cats.map(c=>c.value),1);
        return `<div class="wph wph-${cfg.density}">${cats.map((c,i)=>`<div class="cwl-barrow"><div class="cwl-barlabel">${esc(c.label)}</div><div class="cwl-bartrack"><div class="cwl-barfill" style="width:${Math.round(c.value/mx*100)}%;background:${col(c,i)}"></div></div><div class="cwl-barval">${itemVal(c)}</div></div>`).join('')}</div>`;
      }
      // list
      return `<div class="wph wph-${cfg.density}">${cats.map((c,i)=>`<div class="wph-row"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col(c,i)};margin-right:7px"></span>${esc(c.label)}</span><b>${itemVal(c)}</b></div>`).join('')}</div>`;
    }
    case 'bills_list': { return billsWidgetBody(w); }
    case 'bill_calendar': return billCalBody(w);
    case 'cashflow_chart': return cashflowChartBody(w);
    case 'pl_panel': return plWidgetBody(w);
    case 'cashflow_planner': return cfpWidgetBody(w);
    case 'goals': return goalsWidgetBody(w);
    case 'accounts_list': return acctWidgetBody(w);
    case 'all_transactions': return txnFeedBody(w);
    case 'safe_to_spend': case 'safe_spend': return safeToSpendBody(w);
    case 'recurring': return recurringBody(w);
    case 'investments': return portfolioBody(w);
    case 'sankey': return `<div class="wph"><div class="wph-sub" style="margin-bottom:6px">Income → group → category${dataLoaded?' · last '+tfLabel(w.tf||'30d'):' · sample'}</div><div style="position:relative"><canvas id="cv_${w.uid}"></canvas></div></div>`;
    case 'net_worth_chart': {
      const nw=Math.round(_nwNow());
      const chg=(typeof nwChangeSince==='function')?nwChangeSince(30):null;
      const tracked=(typeof nwHistMonthly==='function')?nwHistMonthly().length:0;
      let head;
      if(chg){ const up=chg.abs>=0; const pctStr=Math.abs(chg.pct)>=0.1?` (${up?'+':'−'}${Math.abs(chg.pct).toFixed(1)}%)`:''; head=`<div style="font-size:12.5px;font-weight:700;color:${up?'var(--pos)':'var(--red)'};margin-top:2px">${up?'▲':'▼'} ${fmtK(Math.abs(chg.abs))}${pctStr}<span style="color:var(--muted);font-weight:500"> · last 30 days</span></div>`; }
      else head=`<div class="wph-sub" style="margin-top:2px">Trend builds as you check in${tracked?` · ${tracked} month${tracked!==1?'s':''} tracked`:''}.</div>`;
      return `<div class="wph"><div class="wph-stat" style="font-size:23px">${nw<0?'−':''}${fmtK(Math.abs(nw))}</div>${head}<div style="height:128px;margin-top:8px"><canvas id="cv_${w.uid}"></canvas></div>${dataLoaded?'':'<div class="ws-hint" style="margin-top:4px">Sample trend — connect a bank to track for real.</div>'}</div>`;
    }
    case 'fire_progress': return fireProgressBody(w);
    case 'fire_hub': return fireHubBody(w);
    case 'retirement_proj': return `<div class="wph"><div class="wph-sub" style="margin-bottom:6px">Projected growth</div><div style="height:140px"><canvas id="cv_${w.uid}"></canvas></div></div>`;
    case 'fire_calc': return fireWidgetBody(w);
    case 'debt_payoff': return debtPayoffBody(w);
    case 'debt_hub': return debtHubBody(w);
    case 'zero_budget': return zbWidgetBody(w);
    case 'fund_triage': return fundTriageBody(w);
    case 'budget_actual': return budgetActualBody(w);
    case 'savings_buckets': return savingsBucketsBody(w);
    case 'fire_drill': return fdWidgetBody(w);
    case 'debt_planner': return dpWidgetBody(w);
    default: return `<div class="wph"><div class="wph-sub">${def.name}</div></div>`;
  }
}

let dragUid=null;

/* ── Widget detail drill-down ──
   Widgets that support an expanded view declare it here. Opening shows a modal
   with richer Plaid / bills / income breakdowns (amounts + %, sortable lists). */
const WIDGET_HAS_DETAIL=['net_worth_summary','cash_summary','spending_month','income_month','debt_summary','top_categories','budget_doughnut','cashflow_chart','sankey','net_worth_chart','debt_payoff','fire_progress','health_score'];
function widgetHasDetail(type){ return WIDGET_HAS_DETAIL.includes(type); }
function _detailRows(items, total){
  // items: [{label, value, color?, note?}] → rows with amount + %
  return items.map(it=>{
    const pct=total>0?Math.round((Math.abs(it.value)/total)*100):0;
    const dot=it.color?`<span class="wd-dot" style="background:${it.color}"></span>`:'';
    return `<div class="wdt-row"><span class="wdt-label">${dot}${esc(it.label)}${it.note?`<span class="wdt-note">${esc(it.note)}</span>`:''}</span>
      <span class="wdt-vals"><b>${fmtK(it.value)}</b><span class="wdt-pct">${pct}%</span></span></div>`;
  }).join('');
}
function widgetDetailContent(type, days){
  const live=dataLoaded;
  days=days||30;
  const dl=tfLabel(TIMEFRAMES.find(t=>t.days===days)?TIMEFRAMES.find(t=>t.days===days).key:'30d');
  switch(type){
    case 'spending_month': {
      const bcats=_budgetCatSet(); const linked=bcats.size>0;
      let all;
      if(live){ all=engCategoryBreakdown(days); }
      else { const g=engCategoryMonthGrid(6); const li=g.months.length-1; all=g.cats.map(c=>({label:c.label,value:Math.round((c.vals[li]||0)*(days/30)),color:c.color})).filter(r=>r.value>0).sort((a,b)=>b.value-a.value); }
      const totalSpend=all.reduce((s,c)=>s+c.value,0);
      const cats=linked?all.filter(c=>bcats.has(c.label)):all.filter(c=>isDiscretionary(c.label));
      const other=linked?all.filter(c=>!bcats.has(c.label)):[];
      const tot=cats.reduce((s,c)=>s+c.value,0);
      const budget=(linked?engBudgetLinkedBudget():engDiscretionaryBudget())*(days/30);
      const pct=budget>0?Math.round(tot/budget*100):0;
      return { title:linked?'Current spending — budget categories':'Current discretionary spending', sub:`${live?'Last '+dl:'Sample'} · ${fmtK(tot)} of ${fmtK(budget)} budget (${pct}%) · ${linked?'linked to your budget':'bills & savings excluded'} · ${fmtK(totalSpend)} total all categories`,
        body:`<div class="wdt-total" style="color:${pct<85?'var(--green)':pct<=100?'var(--amber)':'var(--red)'}">${fmtK(tot)}<span>${linked?'in budget':'discretionary'} · ${pct}% of budget</span></div>${_detailRows(cats,tot)}`
          +(other.length?`<div class="wdt-section">Outside the budget · ${fmtK(totalSpend-tot)}</div>${_detailRows(other,totalSpend-tot)}`:'')
          +`<div class="wdt-row"><span class="wdt-label"><b>Total spending — all categories</b></span><span class="wdt-vals"><b>${fmtK(totalSpend)}</b></span></div>` };
    }
    case 'budget_doughnut': {
      let kids=live?engCategoryBreakdown(days):[{label:'Housing',value:2640},{label:'Dining Out',value:612},{label:'Food & Groceries',value:498},{label:'Auto Payments',value:452},{label:'Utilities',value:320},{label:'Subscriptions',value:142}].map(c=>({...c,color:getCatColor(c.label)}));
      kids=kids.filter(c=>c.value>0);
      const gmap={}; kids.forEach(c=>{ const p=getCatParent(c.label); if(!gmap[p.id])gmap[p.id]={label:p.label,color:p.color,value:0,kids:[]}; gmap[p.id].value+=c.value; gmap[p.id].kids.push(c); });
      const groups=Object.values(gmap).sort((a,b)=>b.value-a.value);
      const tot=kids.reduce((s,c)=>s+c.value,0)||1;
      const body=`<div class="wdt-total">${fmtK(tot)}<span>total · ${groups.length} groups, ${kids.length} categories</span></div>`+
        groups.map(g=>`<div class="wdt-section">${esc(g.label)} · ${fmtK(g.value)} (${Math.round(g.value/tot*100)}%)</div>${_detailRows(g.kids.sort((a,b)=>b.value-a.value),g.value)}`).join('');
      return { title:'Budget by category', sub:`${live?'Last '+dl:'Sample data'} · grouped by your category tree`, body };
    }
    case 'spending_trends': {
      const s=engSpendTrends();
      const rows=s.movers.map(m=>{ const up=m.delta>0; return `<div class="wdt-row"><span class="wdt-label">${esc(m.label)}<br><span style="font-size:10.5px;color:var(--muted)">this ${fmtK(m.cur)} · last ${fmtK(m.prev)}</span></span><b style="color:${up?'var(--amber)':'var(--green)'}">${up?'▲':'▼'} ${fmtK(Math.abs(m.delta))}</b></div>`; }).join('') || '<div class="ws-hint">Not enough category history to compare months yet.</div>';
      const pace=s.budget?` · projected ${fmtK(s.budget.projected)} vs ${fmtK(s.budget.amount)} budget`:'';
      return { title:'Spending trends', sub:`${fmtK(s.curTotal)} so far (day ${s.dom}/${s.daysInMonth}) · ${s.vsLastPeriod>0?'+':''}${fmtK(s.vsLastPeriod)} vs same point last month${pace}`, body:`<div class="wdt-total">${fmtK(s.projected)}<span>projected this month</span></div>${rows}` };
    }
    case 'top_categories': {
      const cats=live?engCategoryBreakdown(days):[{label:'Dining Out',value:612,color:'#f5a623'},{label:'Food & Groceries',value:498,color:'#3dda91'},{label:'Auto Payments',value:284,color:'#b09afa'},{label:'Subscriptions',value:142,color:'#22d3ee'}];
      const tot=cats.reduce((s,c)=>s+c.value,0);
      return { title:'Spending by category', sub:`${live?'Last '+dl:'Sample data'} · ${fmtK(tot)} total across ${cats.length} categories`,
        body:`<div class="wdt-total">${fmtK(tot)}<span>total spend</span></div>${_detailRows(cats,tot)}` };
    }
    case 'income_month': {
      if(live){ const rec=engRecent(days).filter(_isIncomeTxn); const byCat={}; rec.forEach(t=>{const c=getTxnCategory(t); byCat[c]=(byCat[c]||0)+Math.abs(t.amount);}); const items=Object.entries(byCat).map(([l,v])=>({label:l,value:v,color:getCatColor(l)})).sort((a,b)=>b.value-a.value); const tot=items.reduce((s,i)=>s+i.value,0);
        return { title:'Income — last '+dl, sub:`${fmtK(tot)} across ${items.length} source${items.length!==1?'s':''}`, body:`<div class="wdt-total" style="color:var(--green)">${fmtK(tot)}<span>received</span></div>${_detailRows(items,tot)}` }; }
      const items=incomeSources.map(s=>({label:s.name,value:Math.round(s.amt*(FREQ_TO_MONTHLY[s.freq]||1)),note:s.freq})); const tot=items.reduce((s,i)=>s+i.value,0);
      return { title:'Income sources', sub:`${fmtK(tot)}/mo from ${items.length} sources`, body:`<div class="wdt-total" style="color:var(--green)">${fmtK(tot)}<span>per month</span></div>${_detailRows(items,tot)}` };
    }
    case 'net_worth_summary': case 'net_worth_chart': {
      // Real monthly history with month-over-month deltas (empty until a couple of check-ins accrue).
      const histSection=(()=>{ try{
        const h=(typeof nwHistWithDeltas==='function')?nwHistWithDeltas(12):[];
        if(!h.length) return '';
        const rows=h.slice().reverse().map(m=>{ const d=m.delta; const dTxt=d==null?'<span style="color:var(--muted)">—</span>':`<span style="color:${d>=0?'var(--pos)':'var(--red)'}">${d>=0?'▲':'▼'} ${fmtK(Math.abs(d))}</span>`; const [y,mo]=m.key.split('-'); const yr=(''+y).slice(2); return `<div class="wdt-row"><span class="wdt-label">${esc(m.label)} '${yr}</span><span style="display:flex;gap:12px;align-items:center">${dTxt}<b>${m.v<0?'−':''}${fmtK(Math.abs(m.v))}</b></span></div>`; }).join('');
        return `<div class="wdt-section">Monthly history · ${h.length} month${h.length!==1?'s':''} tracked</div>${rows}`;
      }catch(e){ return ''; } })();
      if(live){ const ea=engAccounts().filter(a=>!a.manual&&!a.excluded); const acctA=ea.filter(a=>(a.bal||0)>=0&&a.type!=='credit'&&a.type!=='loan').map(a=>({label:a.name,value:a.bal||0,note:(a.institution||'bank')+(a.mask?' ···'+a.mask:'')})); const acctD=ea.filter(a=>(a.bal||0)<0||a.type==='credit'||a.type==='loan').map(a=>({label:a.name||'Debt',value:Math.abs(a.bal||0),note:(a.institution||'bank')+(a.mask?' ···'+a.mask:'')})); const manA=nwAssets.filter(x=>x.value>0).map(x=>({label:x.name,value:x.value,note:x.cat||'manual'})).concat(_nwManA()); const manL=nwLiab.filter(x=>x.value>0).map(x=>({label:x.name,value:x.value,note:x.cat||'manual'})).concat(_nwManL()); const assets=acctA.concat(manA); const debts=acctD.concat(manL); const aTot=assets.reduce((s,a)=>s+a.value,0); const dTot=debts.reduce((s,d)=>s+d.value,0); const net=engNetBalance()+engNWAssets()-engNWLiab();
        return { title:'Net worth breakdown', sub:`${fmtK(net)} net · ${fmtK(aTot)} assets − ${fmtK(dTot)} debts`, body:`<div class="wdt-total">${fmtK(net)}<span>net worth</span></div>${histSection}<div class="wdt-section">Assets</div>${_detailRows(assets,aTot)}<div class="wdt-section">Debts</div>${_detailRows(debts,dTot)}` }; }
      const a=nwAssets.filter(x=>x.value>0).map(x=>({label:x.name,value:x.value,note:x.cat})).concat(_nwManA()); const l=nwLiab.filter(x=>x.value>0).map(x=>({label:x.name,value:x.value,note:x.cat})).concat(_nwManL()); const aT=engNWAssets(),lT=engNWLiab();
      return { title:'Net worth breakdown', sub:`${fmtK(aT-lT)} net`, body:`<div class="wdt-total">${fmtK(aT-lT)}<span>net worth</span></div>${histSection}<div class="wdt-section">Assets</div>${_detailRows(a,aT)}<div class="wdt-section">Liabilities</div>${_detailRows(l,lT)}` };
    }
    case 'cash_summary': {
      const dep=live?allAccts.filter(a=>a.type==='depository').map(a=>({label:(a.name||'Account'),value:(a.balances&&(a.balances.available??a.balances.current))||0,note:a.institution})):[{label:'Checking',value:5200,note:'sample'},{label:'Savings',value:3040,note:'sample'}];
      const tot=dep.reduce((s,a)=>s+a.value,0);
      return { title:'Cash accounts', sub:`${fmtK(tot)} across ${dep.length} account${dep.length!==1?'s':''}`, body:`<div class="wdt-total">${fmtK(tot)}<span>available cash</span></div>${_detailRows(dep,tot)}` };
    }
    case 'health_score': {
      const h=engHealthScore();
      const rows=h.comps.map(c=>{ const sc=_hsColor(c.score); return `<div class="wdt-row"><span class="wdt-label">${c.icon} ${esc(c.label)}<br><span style="font-size:10.5px;color:var(--muted)">${esc(c.tip)}</span></span><span style="display:flex;gap:10px;align-items:center"><span style="color:var(--muted);font-size:11px">${esc(c.value)}</span><b style="color:${sc}">${c.score}</b></span></div>`; }).join('');
      return { title:'Financial health score', sub:`${h.overall}/100 · grade ${h.grade} · ${h.comps.length} pillar${h.comps.length!==1?'s':''} weighted`, body:`<div class="wdt-total" style="color:${_hsColor(h.overall)}">${h.overall}<span>grade ${h.grade}</span></div>${rows}` };
    }
    case 'promo_tracker': return promoTrackerBody(w);
    case 'credit_util': return creditUtilBody(w);
    case 'debt_summary': case 'debt_payoff': {
      const debtBills=engBills().filter(b=>b.bal<0).sort((a,b)=>Math.abs(b.bal)-Math.abs(a.bal));
      const tot=debtBills.reduce((s,d)=>s+Math.abs(d.bal),0);
      const totMin=debtBills.reduce((s,d)=>s+(d.min||0),0);
      const rows=debtBills.map(b=>{
        const po=payoffMonths(b.bal, b.apr, b.pay||b.min);
        const poStr = po.paidOff?'paid' : po.neverPaysOff?'<b style="color:var(--red)">payment ≤ interest</b>' : `${fmtMonths(po.months)}${po.interest>0?` · ${fmtK(po.interest)} int`:''}`;
        return `<div class="wdt-row"><span class="wdt-label">${esc(b.name)}<br><span style="font-size:10.5px;color:var(--muted)">${b.apr?b.apr.toFixed(2)+'% · ':''}pay ${fmtK(b.pay||b.min)}/mo → ${poStr}</span></span><b style="color:var(--red)">${fmtK(Math.abs(b.bal))}</b></div>`;
      }).join('');
      // overall payoff at current total payment
      const blended = tot>0 ? debtBills.reduce((s,b)=>s+Math.abs(b.bal)*(b.apr||0),0)/tot : 0;
      const totPay=debtBills.reduce((s,d)=>s+(d.pay||d.min||0),0);
      const overall=payoffMonths(tot, blended, totPay);
      return { title:'Debt breakdown', sub:`${fmtK(tot)} across ${debtBills.length} balance${debtBills.length!==1?'s':''}${plaidHasLiab()?' · live from Plaid':''}`, body:`<div class="wdt-total" style="color:var(--red)">${fmtK(tot)}<span>total debt · ${overall.neverPaysOff?'increase payments to make progress':'clear in ~'+fmtMonths(overall.months)+' at current pace'}</span></div>${rows}` };
    }
    case 'bills_list': {
      const bl=engUpcomingBills().map(b=>({label:b.name,value:b.pay,note:`due ${b.due}${b.due%10===1&&b.due!==11?'st':b.due%10===2&&b.due!==12?'nd':b.due%10===3&&b.due!==13?'rd':'th'}`+(b.apr?` · ${b.apr.toFixed(1)}%`:'')}));
      const tot=bl.reduce((s,b)=>s+b.value,0);
      return { title:'All upcoming bills', sub:`${fmtK(tot)}/mo across ${bl.length} bills${plaidHasLiab()?' · live':''}`, body:`<div class="wdt-total">${fmtK(tot)}<span>monthly bills</span></div>${_detailRows(bl,tot)}` };
    }
    case 'cashflow_chart': {
      const p=engCashFlowProjection(90);
      const ev=[...p.events].sort((a,b)=>a.day-b.day).slice(0,12).map(e=>({label:(e.day===0?'today':'day '+e.day)+' · '+e.name, value:Math.abs(e.amt), color:e.type==='income'?'var(--pos)':'var(--red)', note:e.type}));
      return { title:'Cash flow projection', sub:`Start ${fmtK(p.start)} → end ${fmtK(p.end)} over 90 days · low ${fmtK(p.low.bal)} on day ${p.low.day}`,
        body:`<div class="wdt-total" style="color:${p.end>=0?'var(--pos)':'var(--red)'}">${fmtK(p.end)}<span>projected balance in 90 days</span></div>
        <div class="wdt-row"><span class="wdt-label">Income in</span><span class="wdt-vals"><b style="color:var(--green)">+${fmtK(p.totalIn)}</b></span></div>
        <div class="wdt-row"><span class="wdt-label">Bills out</span><span class="wdt-vals"><b style="color:var(--red)">-${fmtK(p.totalOut)}</b></span></div>
        <div class="wdt-row"><span class="wdt-label">Lowest point</span><span class="wdt-vals"><b style="color:${p.low.bal<0?'var(--red)':'var(--amber)'}">${fmtK(p.low.bal)}</b> · day ${p.low.day}</span></div>
        <div class="wdt-section">Next events</div>${_detailRows(ev, ev.reduce((s,e)=>s+e.value,0))}` };
    }
    case 'sankey': {
      const inc=(_effectiveIncomeSources?_effectiveIncomeSources():incomeSources).map(s=>({label:s.name,value:Math.round(s.amt*(FREQ_TO_MONTHLY[s.freq]||1)),color:'#3dda91'})); const incT=inc.reduce((s,i)=>s+i.value,0);
      let kids = live&&allTxns.length?engCategoryBreakdown(days):[{label:'Housing',value:2640},{label:'Loan Payments',value:780},{label:'Dining Out',value:612},{label:'Food & Groceries',value:498},{label:'Auto Payments',value:452},{label:'Utilities',value:320},{label:'Gas & Fuel',value:233},{label:'Medical',value:178},{label:'Subscriptions',value:142}].map(c=>({...c,color:getCatColor(c.label)}));
      // group into the category tree
      const gmap={};
      kids.forEach(c=>{ const p=getCatParent(c.label); if(!gmap[p.id])gmap[p.id]={label:p.label,color:p.color,value:0,kids:[]}; gmap[p.id].value+=c.value; gmap[p.id].kids.push(c); });
      const groups=Object.values(gmap).sort((a,b)=>b.value-a.value);
      const spT=kids.reduce((s,i)=>s+i.value,0)||1;
      const body=`<div class="wdt-section">Income in · ${fmtK(incT)}</div>${_detailRows(inc,incT)}`+
        groups.map(g=>`<div class="wdt-section">${esc(g.label)} · ${fmtK(g.value)} (${Math.round(g.value/spT*100)}%)</div>${_detailRows(g.kids.sort((a,b)=>b.value-a.value),g.value)}`).join('');
      return { title:'Money flow by category tree', sub:`${fmtK(incT)} in → ${fmtK(spT)} out across ${groups.length} groups`, body };
    }
    case 'zero_budget': {
      const income=engMonthlyIncome(); const sc=engSpendingCards();
      // Spending-card payments are represented by their envelopes — only non-card bills
      // and paydown beyond the envelopes count as fixed here (same math as the widget).
      const billRows=engBills().filter(b=>b.pay>0&&!sc.names.has(b.name)).map(b=>({label:b.name,value:b.pay,note:'bill'}));
      if(sc.extraPaydown>0) billRows.push({label:'Card paydown beyond envelopes',value:sc.extraPaydown,note:'debt paydown'});
      const bucketRows=_zbBuckets().map(z=>({label:z.name+(z.card?' · 💳 '+z.card:''),value:z.amt,note:'envelope'}));
      const all=[...billRows,...bucketRows]; const assigned=all.reduce((s,i)=>s+i.value,0); const left=income-assigned;
      return { title:'Zero-based budget', sub:`${fmtK(income)} income − ${fmtK(assigned)} assigned = ${left>=0?'':'-'}${fmtK(Math.abs(left))} ${Math.abs(left)<1?'balanced ✓':left>0?'to assign':'over'}`, body:`<div class="wdt-total" style="color:${Math.abs(left)<1?'var(--green)':left>0?'var(--amber)':'var(--red)'}">${left>=0?'':'-'}${fmtK(Math.abs(left))}<span>${Math.abs(left)<1?'balanced':left>0?'left to budget':'over budget'}</span></div><div class="wdt-section">Fixed bills</div>${_detailRows(billRows,assigned)}<div class="wdt-section">Envelopes</div>${_detailRows(bucketRows,assigned)}` };
    }
    case 'fire_progress': {
      const target=engMonthlyBills()*12*25; const cur=live?Math.max(engNWAssets(),engNetBalance()):engNWAssets(); const pct=target>0?Math.min(100,Math.round(cur/target*100)):0;
      return { title:'FIRE progress detail', sub:`${pct}% to financial independence`, body:`<div class="wdt-total">${pct}%<span>to FI</span></div>
        <div class="wdt-row"><span class="wdt-label">Current nest egg</span><span class="wdt-vals"><b>${fmtK(cur)}</b></span></div>
        <div class="wdt-row"><span class="wdt-label">FI target (25× annual bills)</span><span class="wdt-vals"><b>${fmtM(target)}</b></span></div>
        <div class="wdt-row"><span class="wdt-label">Still needed</span><span class="wdt-vals"><b style="color:var(--amber)">${fmtK(Math.max(0,target-cur))}</b></span></div>
        <div class="wdt-row"><span class="wdt-label">Annual expenses</span><span class="wdt-vals"><b>${fmtK(engMonthlyBills()*12)}</b></span></div>` };
    }
    default: return { title:WIDGET_BY_ID[type]?.name||'Details', sub:'', body:'<div class="wdt-row"><span class="wdt-label">No extra detail for this widget.</span></div>' };
  }
}
function openWidgetDetail(type, days){
  const d=widgetDetailContent(type, days);
  gg('wdtTitle').textContent=d.title;
  gg('wdtSub').textContent=d.sub||'';
  gg('wdtBody').innerHTML=d.body;
  gg('widgetDetailModal').style.display='flex';
}
function closeWidgetDetail(){ gg('widgetDetailModal').style.display='none'; }

function wireDragDrop(){
  const grid=gg('canvasGrid'); if(!grid) return;
  grid.querySelectorAll('.canvas-widget-card').forEach(card=>{
    card.draggable=false;  // not draggable by default — only via the grip handle
    const handle=card.querySelector('.cwh-drag');
    if(handle){
      const enable=()=>{ card.draggable=true; };
      const disable=()=>{ setTimeout(()=>{ card.draggable=false; },0); };
      handle.addEventListener('mousedown',enable);
      handle.addEventListener('touchstart',enable,{passive:true});
      handle.addEventListener('mouseup',disable);
      handle.addEventListener('touchend',disable);
    }
    card.addEventListener('dragstart',e=>{ if(!card.draggable){ e.preventDefault(); return; } dragUid=card.dataset.uid; card.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; });
    card.addEventListener('dragend',()=>{ dragUid=null; card.draggable=false; card.classList.remove('dragging'); grid.querySelectorAll('.canvas-widget-card').forEach(c=>c.classList.remove('drag-over-before','drag-over-after')); });
    card.addEventListener('dragover',e=>{ if(!dragUid) return; e.preventDefault(); const r=card.getBoundingClientRect(); const after=(e.clientX-r.left)>r.width/2; card.classList.toggle('drag-over-after',after); card.classList.toggle('drag-over-before',!after); });
    card.addEventListener('dragleave',()=>{ card.classList.remove('drag-over-before','drag-over-after'); });
    card.addEventListener('drop',e=>{ if(!dragUid) return; e.preventDefault(); const targetUid=card.dataset.uid; const r=card.getBoundingClientRect(); const after=(e.clientX-r.left)>r.width/2; reorderWidget(dragUid,targetUid,after); });
  });
}
function reorderWidget(fromUid,toUid,after){
  if(!fromUid||fromUid===toUid) return;
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(!pg) return;
  const arr=pg.widgets; const fromI=arr.findIndex(w=>w.uid===fromUid);
  if(fromI<0) return;
  const [moved]=arr.splice(fromI,1);
  let toI=arr.findIndex(w=>w.uid===toUid);
  if(toI<0) toI=arr.length-1;
  arr.splice(after?toI+1:toI,0,moved);
  saveState(); renderCanvas(pg);
}

function renderSettings(){
  gg('tbIcon').textContent='⚙️';
  gg('tbTitle').textContent='Settings';
  const p=RICHIE_PERSONAS[APP.persona];
  gg('page-content').innerHTML=`
    <div class="settings-page">
      <h2 style="font-size:19px;margin-bottom:4px">Settings</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px">Tune how Richie guides you, how the app looks, and how your data is handled.</p>

      <div class="set-section">🤝 Your Guide</div>
      <div class="set-card">
        <div class="set-card-label">Richie's personality</div>
        <div style="font-size:12px;color:var(--muted);margin:2px 0 10px;line-height:1.5">Pick the coaching style that fits you — it shapes how Richie talks and what he nudges.</div>
        <div class="persona-row" id="setPersonaRow"></div>
      </div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">💬 Richie auto-responses</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Let Richie pop in with a tip as you move around the app. Turn this off to keep him quiet — he'll still respond when you tap him or use Ask Richie.</div>
          </div>
          <button class="toggle${_raProactiveOn?' on':''}" id="proactiveToggle" onclick="setRichieProactive(!_raProactiveOn)" aria-label="Toggle Richie auto-responses"><span class="toggle-knob"></span></button>
        </div>
      </div>
      <div class="set-card">
        <div class="set-card-label">Knowledge Level</div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <div class="level-badge" id="setLevelBadge"></div>
          <div style="flex:1;min-width:160px">
            <div class="xp-bar"><div class="xp-fill" id="setXpFill"></div></div>
            <div style="font-size:11.5px;color:var(--hint);margin-top:5px" id="setXpText"></div>
          </div>
        </div>
      </div>

      <div class="set-section">🎨 Appearance</div>
      <div class="set-card">
        <div style="font-size:12px;color:var(--muted);margin:0 0 12px;line-height:1.5">Pick a theme, tweak any color, and choose a font. Starts from your Richie persona — change it whenever you like. Saved per profile.</div>
        <div class="ap-sub">Theme</div>
        <div class="ap-themes" id="apThemes"></div>
        <div class="ap-sub" style="margin-top:15px">Font</div>
        <div class="ap-fonts" id="apFonts"></div>
        <div class="ap-sub" style="margin-top:15px">Custom colors</div>
        <div class="ap-colors" id="apColors"></div>
        <button class="btn" style="margin-top:13px" onclick="resetAppearance()">↺ Reset to Richie default</button>
      </div>

      <div class="set-section">♿ Accessibility</div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">🐢 Reduce motion</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Calm animations and transitions across the whole app — Richie's movements, celebrations, and theme effects. (Also honored automatically if your device already asks for reduced motion.)</div>
          </div>
          <button class="toggle${_reduceMotion?' on':''}" id="reduceMotionToggle" onclick="setReduceMotion(!_reduceMotion)" aria-label="Toggle reduce motion"><span class="toggle-knob"></span></button>
        </div>
      </div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">✨ Theme animations</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Playful ambient motion for fun themes — spaceships for Galaxy, sparkles for Princess, falling leaves for Forest, slime drip for Slime. Off automatically under reduce motion.</div>
          </div>
          <button class="toggle${_appearance().fx!==false?' on':''}" id="animToggle" onclick="setThemeAnim(_appearance().fx===false)" aria-label="Toggle theme animations"><span class="toggle-knob"></span></button>
        </div>
      </div>

      <div class="set-section">🔗 Connected data</div>
      <div class="set-card">
        <div style="font-size:12px;color:var(--muted);margin:0 0 12px;line-height:1.5">Your linked banks and anything you've uploaded. Remove a bank or an import to pull its data out of every widget.</div>
        <div class="cd-tabs">
          <button class="cd-tab on" id="cdTabBanks" onclick="setCdTab('banks')">🏦 Linked banks</button>
          <button class="cd-tab" id="cdTabUploads" onclick="setCdTab('uploads')">📄 Uploaded documents</button>
        </div>
        <div id="cdList" class="cd-list"><div class="ws-hint">Loading…</div></div>
      </div>

      <div class="set-section">🏷️ Categories</div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">🏷️ Spending Categories</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Customize the labels and colors used across your charts and budgets.</div>
          </div>
          <button class="btn" onclick="openCatEditor()">Edit categories</button>
        </div>
      </div>
      <div class="set-card">
        <div class="set-card-label">🔁 Category rules</div>
        <div style="font-size:12px;color:var(--muted);margin:2px 0 12px;line-height:1.5">"Always categorize this merchant as…" — every rule in one place. Change where one points, delete it, or add a new one. Rules auto-apply to matching transactions and sync across your devices.</div>
        <div id="rulesList"></div>
      </div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">🏦 Account Categories</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Group accounts by type — Cash, Savings, Investment, Retirement, HSA, Credit, Loans, Mortgage — so widgets can include or exclude them.</div>
          </div>
          <button class="btn" onclick="openAcctCatEditor()">Manage accounts</button>
        </div>
      </div>

      <div class="set-section">📊 Data & tools</div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">📄 Monthly report</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">A clean one-month summary — income, spending by category, income sources, top merchants, and a net-worth snapshot. Export as CSV or save to PDF.</div>
          </div>
          <button class="btn primary" onclick="openReport()">View report</button>
        </div>
      </div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">📥 Import transactions (CSV)</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Bring in transactions from a bank or card CSV — map the columns, skip duplicates, and auto-categorize. Great for accounts Plaid can't reach.</div>
          </div>
          <button class="btn primary" onclick="gg('csvFileInput').click()">Choose CSV</button>
        </div>
      </div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">📊 Export to Excel</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Download a full workbook — bills & debt with payoff times, cash-flow projection, budget vs actual, savings buckets, credit & utilization, income, and goals.</div>
          </div>
          <button class="btn primary" onclick="exportToExcel()">Download .xlsx</button>
        </div>
      </div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">🔓 Pro Mode — unlock everything</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Ignore level gating and show every feature & advanced widget right now.</div>
          </div>
          <button class="toggle${APP.proMode?' on':''}" id="proToggle" onclick="toggleProMode()" aria-label="Toggle Pro Mode"><span class="toggle-knob"></span></button>
        </div>
      </div>

      <div class="set-section">🔒 Security</div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">🔒 Password</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Change your sign-in password. You'll get a new recovery code.</div>
          </div>
          <button class="btn" onclick="openChangePassword()">Change password</button>
        </div>
      </div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">🛡️ Two-factor authentication</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5" id="twofaDesc">Require a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password) each time you sign in.</div>
          </div>
          <div id="twofaAction"><button class="btn" disabled>…</button></div>
        </div>
      </div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">🔐 Session</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Sign out — you'll log back in and get a fresh SWOT next time.</div>
          </div>
          <button class="btn" onclick="logout()">Sign out</button>
        </div>
      </div>

      <div class="set-section" style="color:var(--red)">⚠️ Danger zone</div>
      <div class="set-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0">🔄 Reset my world</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Rebuild your pages and widgets from a fresh starter layout. Your login and bank stay connected.</div>
          </div>
          <button class="btn" onclick="resetWorld()">Reset pages</button>
        </div>
      </div>
      <div class="set-card set-danger">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="set-card-label" style="margin:0;color:var(--red)">⚠️ Full reset — start over</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Erase <b>everything</b> — pages, widgets, categories, goals, bank links, and settings — and go all the way back to Richie's intro. This cannot be undone.</div>
          </div>
          <button class="btn danger-btn" onclick="openFullResetConfirm()">Full reset</button>
        </div>
      </div>
    </div>`;
  gg('setPersonaRow').innerHTML=Object.keys(RICHIE_PERSONAS).map(k=>{
    const pp=RICHIE_PERSONAS[k];
    return `<div class="persona-opt${k===APP.persona?' sel':''}" onclick="setPersona('${k}')" style="${k===APP.persona?'border-color:'+pp.accent:''}">
      <div style="font-size:22px">${pp.icon}</div><div style="font-size:11px;font-weight:600;margin-top:3px">${pp.name}</div></div>`;
  }).join('');
  const lv=LEVELS.find(l=>l.n===APP.level)||LEVELS[0];
  gg('setLevelBadge').textContent=lv.icon+' Lv '+lv.n+' · '+lv.name;
  const pct=APP.proMode?100:levelProgress().pct;
  gg('setXpFill').style.width=pct+'%';
  gg('setXpText').textContent=APP.proMode?'Pro Mode active — all features unlocked':(APP.xp.toLocaleString()+' XP'+(levelProgress().next!=null?(' · '+levelProgress().toNext.toLocaleString()+' to next level'):' · max level'));
  try{ renderConnectedData(); }catch(e){}
  try{ renderAppearance(); }catch(e){}
  try{ renderRulesManager(); }catch(e){}
  try{ render2faStatus(); }catch(e){}
}
/* ── Appearance render + handlers (per profile) ── */
function renderAppearance(){
  const a=_appearance();
  const preset=THEME_BY_ID[a.preset||'midnight']||THEME_PRESETS[0];
  const persona=RICHIE_PERSONAS[APP.persona];
  const tw=gg('apThemes');
  if(tw){
    const cur=a.preset||'midnight';
    const btn=p=>`<button class="ap-theme${cur===p.id?' on':''}" onclick="setThemePreset('${p.id}')" title="${esc(p.name)}${p.pattern?' · patterned':''}"><span class="ap-sw" style="background-color:${p.bg};background-image:${p.pattern||'none'};border-color:${p.border2}"><i style="background:${p.accent}"></i><i style="background:${p.surface}"></i><i style="background:${p.text}"></i></span><span class="ap-theme-nm">${esc(p.name)}</span></button>`;
    const dark=THEME_PRESETS.filter(p=>!p.light), light=THEME_PRESETS.filter(p=>p.light);
    tw.innerHTML=`<div class="ap-theme-cat">🌙 Dark</div><div class="ap-themes-grid">${dark.map(btn).join('')}</div>`
      +`<div class="ap-theme-cat">☀️ Bright</div><div class="ap-themes-grid">${light.map(btn).join('')}</div>`;
  }
  const fw=gg('apFonts');
  if(fw) fw.innerHTML=FONT_OPTS.map(f=>`<button class="ap-font${(a.font||'dm')===f.id?' on':''}" style="font-family:${f.css}" onclick="setThemeFont('${f.id}')">${esc(f.name)}</button>`).join('');
  const cw=gg('apColors');
  if(cw){
    const rows=[
      ['Accent','accent', a.accent||(persona&&persona.accent)||preset.accent],
      ['Background','bg', a.bg||preset.bg],
      ['Cards','surface', a.surface||preset.surface],
      ['Text','text', a.text||preset.text],
      ['Money in','pos', a.pos||'#2ecc8a'],
      ['Money out','neg', a.neg||'#f05c5c'],
    ];
    cw.innerHTML=rows.map(([lbl,key,val])=>`<label class="ap-color"><input type="color" value="${_toHexColor(val)}" oninput="setThemeColor('${key}',this.value)"><span>${esc(lbl)}</span></label>`).join('');
  }
}
function setThemePreset(id){ _setAppearance({preset:id, bg:null, surface:null, text:null, accent:null}); applyAppearance(); saveState(); renderAppearance(); }
function setThemeFont(id){ _setAppearance({font:id}); applyAppearance(); saveState(); renderAppearance(); }
function setThemeColor(key,val){ const patch={}; patch[key==='neg'?'neg':key]=val; _setAppearance(patch); applyAppearance(); saveState(); }
function resetAppearance(){ if(APP.appearances) APP.appearances[APP.activeProfile]={}; applyAppearance(); saveState(); renderAppearance(); renderShell(); if(typeof richieSay==='function') richieSay('Back to your Richie look. ✨'); }
/* ── Connected data: banks + imported statements ── */
let _cdTab='banks';
function setCdTab(t){ _cdTab=t; renderConnectedData(); }
function _collectImports(){
  const out=[], seen={};
  (APP.imports||[]).forEach(im=>{ if(im&&im.id){ out.push(im); seen[im.id]=1; } });
  // legacy uploads (transactions tagged before unified tracking existed)
  const g={};
  (APP.importedTxns||[]).forEach(t=>{ const k=t._importId||'legacy'; if(seen[k])return; (g[k]=g[k]||{id:k,kind:'bank',label:t._importLabel||t.institution||'Import',ts:0,count:0,sum:0}); g[k].count++; });
  Object.values(g).forEach(x=>{ x.summary=`${x.count} transaction${x.count!==1?'s':''}`; out.push(x); });
  return out.sort((a,b)=>(b.ts||0)-(a.ts||0));
}
async function renderConnectedData(){
  const tb=gg('cdTabBanks'), tu=gg('cdTabUploads');
  if(tb) tb.classList.toggle('on',_cdTab==='banks');
  if(tu) tu.classList.toggle('on',_cdTab==='uploads');
  const box=gg('cdList'); if(!box) return;
  if(_cdTab==='uploads'){
    const ups=_collectImports();
    box.innerHTML = ups.length ? ups.map(im=>{
      const icon=im.kind==='investment'?'📈':im.kind==='bill'?'🧾':im.kind==='score'?'📊':'📄';
      return `<div class="cd-row"><div class="cd-meta"><div class="cd-nm">${icon} ${esc(im.label||'Upload')}</div><div class="cd-info">${esc(im.summary||'')}</div></div><button class="cd-rm" onclick="removeImport('${esc(im.id)}')">Remove</button></div>`;
    }).join('') : '<div class="ws-hint">No uploaded documents yet. Use “📄 Upload statement” to add one.</div>';
    return;
  }
  box.innerHTML='<div class="ws-hint">Loading…</div>';
  try{
    const d=await _fetchJSON('/api/items?ts='+Date.now());   // cache-bust so removals reflect immediately
    if(!d||!Array.isArray(d.items)){ box.innerHTML='<div class="ws-hint">Connect a bank to see it here.</div>'; return; }
    box.innerHTML = d.items.length ? d.items.map(it=>`<div class="cd-row" id="cdbank_${esc(it.itemId)}"><div class="cd-meta"><div class="cd-nm">🏦 ${esc(it.institutionName||'Bank')}</div><div class="cd-info">${it.addedAt?('linked '+new Date(it.addedAt).toLocaleDateString()):'linked'}</div></div><button class="cd-rm" onclick="removeBank('${esc(it.itemId)}','${esc((it.institutionName||'this bank').replace(/'/g,''))}')">Remove</button></div>`).join('') : '<div class="ws-hint">No banks connected yet.</div>';
  }catch(e){ box.innerHTML='<div class="ws-hint">Could not load connected banks.</div>'; }
}
async function removeBank(itemId, name){
  if(!confirm('Disconnect '+(name||'this bank')+'? Its accounts and transactions will be removed.')) return;
  const row=gg('cdbank_'+itemId), btn=row&&row.querySelector('.cd-rm');
  if(btn){ btn.textContent='Removing…'; btn.disabled=true; } if(row) row.style.opacity='.5';
  try{
    const r=await fetch('/api/item/'+encodeURIComponent(itemId),{method:'DELETE'});
    if(!r.ok){ alert('Could not remove that bank. Try again.'); if(btn){btn.textContent='Remove';btn.disabled=false;} if(row)row.style.opacity=''; return; }
    if(row) row.remove();                       // instant UI removal
    await loadEngineData();                      // refresh accounts + transactions
    await renderConnectedData();                 // re-render list from server (cache-busted)
    const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg&&APP.activePage!=='__settings__')renderCanvas(pg);
    if(typeof richieSay==='function') richieSay((name||'Bank')+' disconnected.');
  }catch(e){ alert('Could not reach the server.'); if(btn){btn.textContent='Remove';btn.disabled=false;} if(row)row.style.opacity=''; }
}
function removeImport(id){
  if(!confirm('Remove this upload and everything it added?')) return;
  const rec=(APP.imports||[]).find(im=>im.id===id);
  // transactions (unified id OR legacy _importId)
  APP.importedTxns=(APP.importedTxns||[]).filter(t=>{ const k=t._importId||'legacy'; return k!==id && (!rec||!rec.txnImportId||k!==rec.txnImportId); });
  if(rec){
    if(rec.holdingIds&&rec.holdingIds.length) APP.holdings=(APP.holdings||[]).filter(h=>!rec.holdingIds.includes(h.id));
    if(rec.assetId) APP.nwManualAssets=(APP.nwManualAssets||[]).filter(a=>a.id!==rec.assetId);
    if(rec.billName) APP.manualBills=(APP.manualBills||[]).filter(b=>(b.name||'').toLowerCase()!==String(rec.billName).toLowerCase());
  }
  APP.imports=(APP.imports||[]).filter(im=>im.id!==id);
  saveState(); _rebuildTxns(); try{ nwHistRecord(); }catch(e){}
  renderConnectedData();
  const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg&&APP.activePage!=='__settings__')renderCanvas(pg);
}

function setPersona(key){ APP.persona=key; saveState(); applyAccent(); renderShell(); renderSettings(); if(sbRichie)sbRichie.do('bounce'); richieSay(RICHIE_PERSONAS[key].quips[0]); }
function toggleProMode(){ APP.proMode=!APP.proMode; saveState(); gg('proToggle').classList.toggle('on',APP.proMode); renderSettings(); richieSay(APP.proMode?"Pro Mode ON. Everything's unlocked — go wild.":"Pro Mode off. Back to leveling up the fun way."); }
// ── Full reset: wipe all data and revert to onboarding (type-YES confirm) ──
function openFullResetConfirm(){
  const inp=gg('resetConfirmInput'); if(inp){ inp.value=''; }
  const btn=gg('resetConfirmBtn'); if(btn){ btn.disabled=true; btn.textContent='Erase everything & start over'; }
  const cb=gg('resetBanks'); if(cb) cb.checked=false;
  gg('fullResetModal').style.display='flex';
  setTimeout(()=>{ if(inp) inp.focus(); },50);
}
function closeFullReset(){ gg('fullResetModal').style.display='none'; }
function fullResetCheck(){
  const v=(gg('resetConfirmInput').value||'').trim().toUpperCase();
  gg('resetConfirmBtn').disabled = (v!=='YES');
}
function doFullReset(){
  const v=(gg('resetConfirmInput').value||'').trim().toUpperCase();
  if(v!=='YES') return;  // hard guard — only proceeds on an exact YES
  const disconnectBanks=!!(gg('resetBanks')&&gg('resetBanks').checked);
  const btn=gg('resetConfirmBtn'); if(btn){ btn.disabled=true; btn.textContent='Resetting…'; }
  try{ _cancelPendingStateWrite(); }catch(e){}   // a pending debounced write must not resurrect the erased world
  try{
    ['richie_setup','richie_app','mdf_categories','mdf_cat_overrides','mdf_txn_notes','mdf_fire','mdf_acct_cats','mdf_txn_tags','mdf_cat_rules'].forEach(k=>{ try{LS.removeItem(k);}catch(e){} });
    try{ SS.removeItem('mdf_token'); SS.removeItem('mdf_auth'); }catch(e){}
    // defensive sweep of any remaining app-scoped keys
    try{ Object.keys(window.localStorage||{}).forEach(k=>{ if(/^(richie_|mdf_)/.test(k)) window.localStorage.removeItem(k); }); }catch(e){}
    // Force onboarding on the reload. The key deliberately sits OUTSIDE the swept prefixes:
    // start() otherwise routes "no local data + login exists" to the login screen (the
    // cold-reopen restore path), which made onboarding unreachable after a reset.
    try{ LS.setItem('rz_force_onboard','1'); }catch(e){}
  }catch(e){}
  // Ask the SERVER to delete the household state (and optionally every Plaid item) — a
  // client-only wipe gets undone by the next syncPull, and a pushed-up "blank" blob keeps
  // old XP via the max-merge. The endpoint deletes appstate.json outright, so the reset
  // really is zero. mdf_sync_ts is stamped as belt-and-braces: if the request fails or
  // times out, the reloaded page still refuses to adopt the old state (localTs is newer).
  const ts=Date.now();
  let fired=false;
  const done=()=>{ if(fired) return; fired=true; try{ LS.setItem('mdf_sync_ts', String(ts)); }catch(e){} location.reload(); };
  try{
    fetch('/api/full_reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({disconnect_banks:disconnectBanks})})
      .catch(()=>{}).then(done);
    setTimeout(done, 8000);   // generous failsafe — a cold server needs a few seconds to wake
  }catch(e){ done(); }
}

function resetWorld(){
  if(!confirm("Rebuild your pages and widgets from a fresh starter layout? Your custom page edits will be replaced (login & bank stay connected).")) return;
  const setup=JSON.parse(LS.getItem('richie_setup')||'{}');
  const bundleKey=setup.bundle||'overview';
  APP.pages=seedPages(bundleKey);
  APP.activePage=APP.pages[0]?APP.pages[0].id:null;
  saveState();
  renderShell();
  switchPage(APP.activePage);
  richieSay("Fresh start! Your pages are rebuilt and loaded with widgets. 🎉");
  if(sbRichie)sbRichie.do('tada');
}

/* ═══════════════ PAGE CRUD ═══════════════ */
let editingPageId=null, peIcon='💰', peColor='#2ecc8a';
function openPageEditor(id){
  editingPageId=id||null;
  const pg=id?APP.pages.find(p=>p.id===id):null;
  gg('pageEditorTitle').textContent=pg?'Edit Page':'New Page';
  gg('pageNameInput').value=pg?pg.name:'';
  peIcon=pg?pg.icon:'💰'; peColor=pg?pg.color:'#2ecc8a';
  gg('iconPicker').innerHTML=ICON_CHOICES.map(ic=>`<div class="icon-opt${ic===peIcon?' sel':''}" onclick="peSetIcon('${ic}',this)">${ic}</div>`).join('');
  gg('colorPicker').innerHTML=COLOR_CHOICES.map(c=>`<div class="color-opt${c===peColor?' sel':''}" style="background:${c}" onclick="peSetColor('${c}',this)"></div>`).join('');
  gg('pageEditorModal').style.display='flex';
  setTimeout(()=>gg('pageNameInput').focus(),50);
}
function peSetIcon(ic,el){ peIcon=ic; document.querySelectorAll('#iconPicker .icon-opt').forEach(o=>o.classList.remove('sel')); el.classList.add('sel'); }
function peSetColor(c,el){ peColor=c; document.querySelectorAll('#colorPicker .color-opt').forEach(o=>o.classList.remove('sel')); el.classList.add('sel'); }
function closePageEditor(){ gg('pageEditorModal').style.display='none'; }
function savePageEditor(){
  const name=gg('pageNameInput').value.trim();
  if(!name){ gg('pageNameInput').style.borderColor='var(--red)'; setTimeout(()=>gg('pageNameInput').style.borderColor='',900); return; }
  if(editingPageId){
    const pg=APP.pages.find(p=>p.id===editingPageId);
    if(pg){ pg.name=name; pg.icon=peIcon; pg.color=peColor; }
  } else {
    const pg={id:'p'+Date.now(),name,icon:peIcon,color:peColor,widgets:[]};
    APP.pages.push(pg); APP.activePage=pg.id;
    awardXp(5,'New page created!');
  }
  saveState(); closePageEditor(); renderShell();
  if(APP.activePage&&APP.activePage!=='__settings__') switchPage(APP.activePage);
  if(sbRichie)sbRichie.do('bounce');
}
function deletePage(id){
  const pg=APP.pages.find(p=>p.id===id); if(!pg)return;
  if(APP.pages.length<=1){ richieSay("Whoa — keep at least one page, friend!"); return; }
  if(!confirm('Delete "'+pg.name+'"? This can\'t be undone.')) return;
  APP.pages=APP.pages.filter(p=>p.id!==id);
  if(APP.activePage===id) APP.activePage=APP.pages[0].id;
  saveState(); renderShell();
  if(APP.activePage!=='__settings__') switchPage(APP.activePage);
}

/* ═══════════════ XP / LEVEL UP ═══════════════ */
function awardXp(amount,reason){
  APP.xp+=amount;
  const newLevel=xpToLevel(APP.xp);
  const leveled=newLevel>APP.level;
  if(leveled){ APP.level=newLevel; levelUp(); }
  saveState();
  gg('sbXp').textContent=APP.xp+' XP';
  if(!leveled){ try{ _xpSparkle(); }catch(e){} if(reason) try{ richieHopFx(); }catch(e){} }   // a lively "+XP" beat (level-up already bursts)
  if(reason) richieSay(reason+' (+'+amount+' XP)');
}
// Award XP the first time a feature is used (once ever, tracked in the synced gami store).
function discoverXp(key, xp, label){
  try{ const s=gamiLoad(); s.discovered=s.discovered||{}; if(s.discovered[key]) return; s.discovered[key]=Date.now(); gamiSave();
    awardXp(xp||10, `✨ First time using ${label}`);
  }catch(e){}
}
function levelUp(){
  const lv=LEVELS.find(l=>l.n===APP.level);
  if(sbRichie)sbRichie.do('tada');
  try{ emojiBurst('stars', {particle:'star', count:16, life:2200}); }catch(e){}
  try{ richieHopFx(); }catch(e){}
  richieCelebrate('🎉 LEVEL UP! You hit '+lv.icon+' '+lv.name+'! New features unlocked.');
  renderShell();
}

/* ═══════════════ FLOATING RICHIE ═══════════════ */
function toggleRichiePanel(){ richieHopOut(); }
function richieQuips(){ const p=RICHIE_PERSONAS[APP.persona]; return p?p.quips:["Money should be a journey, not a chore."]; }
function newRichieTip(){ richieCoachNow(); }
// ── Ask Richie: full advisory chat wired to /api/advisor (deep FinClear-style answers) ──
let _rchatHistory=[], _rchatMode='personal', _rchatBusy=false;
const RCHAT_STARTERS=["How should I budget my take-home pay?","What's the fastest way to kill my debt?","Am I saving enough for retirement?","How big should my emergency fund be?"];
function openRichieChat(){
  try{ richieGoHome(); }catch(e){}
  const m=gg('richieChat'); if(!m) return; m.style.display='flex';
  try{ const ic=(RICHIE_PERSONAS[APP.persona]&&RICHIE_PERSONAS[APP.persona].icon)||'💰'; const bag=gg('rchatBag'); if(bag) bag.textContent=ic; }catch(e){}
  _rchatRender();
  setTimeout(()=>{ const i=gg('rchatInput'); if(i) i.focus(); }, 60);
}
function closeRichieChat(){ const m=gg('richieChat'); if(m) m.style.display='none'; }
function rchatSetMode(mode){
  _rchatMode=mode;
  const p=gg('rchatModePersonal'), b=gg('rchatModeBusiness'); if(p)p.classList.toggle('active',mode==='personal'); if(b)b.classList.toggle('active',mode==='business');
  const i=gg('rchatInput'); if(i) i.placeholder = mode==='business' ? 'Ask about cash flow, pricing, taxes, P&L…' : 'Ask about budgeting, debt, investing, taxes…';
}
function rchatKey(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); rchatSend(); } }
function _rchatEsc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function _rchatFmt(text){ let t=_rchatEsc(text); t=t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>'); t=t.replace(/^[\-•]\s+(.+)$/gm,'<li>$1</li>'); t=t.replace(/(<li>[\s\S]*?<\/li>)/,'<ul>$1</ul>'); t=t.replace(/\n{2,}/g,'<br><br>').replace(/\n/g,'<br>'); return t; }
function _rchatRender(){
  const body=gg('rchatBody'); if(!body) return;
  const bag=(RICHIE_PERSONAS[APP.persona]&&RICHIE_PERSONAS[APP.persona].icon)||'💰';
  if(!_rchatHistory.length){
    body.innerHTML=`<div class="rchat-greet">Hey, I'm Richie ${bag} — ask me anything about your money. I'll use your real numbers when it helps.</div><div class="rchat-starters">${RCHAT_STARTERS.map(q=>`<button class="rchat-starter" data-q="${_rchatEsc(q)}" onclick="rchatStarter(this.getAttribute('data-q'))">${_rchatEsc(q)}</button>`).join('')}</div>`;
    return;
  }
  body.innerHTML=_rchatHistory.map(m=> m.role==='user'
    ? `<div class="rchat-row me"><div class="rchat-av">🧑</div><div class="rchat-msg">${_rchatEsc(m.content)}</div></div>`
    : `<div class="rchat-row"><div class="rchat-av">${bag}</div><div class="rchat-msg">${_rchatFmt(m.content)}</div></div>`
  ).join('') + (_rchatBusy?`<div class="rchat-row"><div class="rchat-av">${bag}</div><div class="rchat-msg"><div class="rchat-typing"><i></i><i></i><i></i></div></div></div>`:'');
  body.scrollTop=body.scrollHeight;
}
function rchatStarter(q){ const i=gg('rchatInput'); if(i) i.value=q; rchatSend(); }
async function rchatSend(){
  if(_rchatBusy) return;
  const i=gg('rchatInput'); if(!i) return;
  const text=(i.value||'').trim(); if(!text) return;
  i.value=''; i.style.height='auto';
  _rchatHistory.push({role:'user', content:text});
  _rchatBusy=true; _rchatRender();
  const sendBtn=gg('rchatSend'); if(sendBtn) sendBtn.disabled=true;
  let reply='';
  try{
    const res=await fetch('/api/advisor',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ messages:_rchatHistory, mode:_rchatMode, persona:APP.persona||'coach', level:APP.level||1, context:richieContext() })});
    if(res.ok){ const j=await res.json(); reply=(j&&j.reply||'').trim(); }
  }catch(e){}
  _rchatBusy=false; if(sendBtn) sendBtn.disabled=false;
  if(!reply) reply="I couldn't reach my brain just now — check the connection and try again.";
  _rchatHistory.push({role:'assistant', content:reply});
  _rchatRender();
}
// ── AI Coach: pull a context-aware tip from /api/coach (falls back to canned quips) ──
let _aiSeen=[];
function richieContext(){
  const pg=APP.pages.find(p=>p.id===APP.activePage);
  const ctx={ page: pg?pg.name:'Dashboard', widgets: pg?(pg.widgets||[]).map(w=>w.type):[] };
  if(pg&&pg.goalMetric) ctx.goal=pg.goalMetric;
  try{ ctx.netWorth=Math.round(engNetWorth()); }catch(e){}
  try{ ctx.cash=Math.round(engNetBalance()); }catch(e){}
  try{ ctx.monthlyIncome=Math.round(engMonthlyIncome()); }catch(e){}
  try{ ctx.spentLast30=Math.round(engSpend30()); }catch(e){}
  try{ const b=engUpcomingBills()||[]; const unpaid=b.filter(x=>!x.paid); ctx.billsDue=unpaid.length; ctx.billsDueTotal=Math.round(unpaid.reduce((s,x)=>s+(x.pay||x.amount||0),0)); }catch(e){}
  try{ if(typeof gamiLoad==='function'){ const s=gamiLoad(); const gm=gamiMetrics(); const lv=LEVELS.find(l=>l.n===APP.level)||LEVELS[0];
    const locked=ACHIEVEMENTS.filter(a=>!s.unlocked[a.id]&&a.prog).map(a=>{ const p=a.prog(gm); return {name:a.name, desc:a.desc, pct:Math.round((p.cur/(p.target||1))*100), progress:_gProgLabel(p)}; }).sort((x,y)=>y.pct-x.pct);
    ctx.gamification={ level:lv.n, levelName:lv.name, xp:APP.xp, streakDays:s.streak||0, badges:Object.keys(s.unlocked).length+'/'+ACHIEVEMENTS.length, recentWins:(s.wins||[]).slice(0,3).map(w=>w.name), nextMilestone: locked[0]?{name:locked[0].name, needs:locked[0].desc, progress:locked[0].progress}:null };
  } }catch(e){}
  return ctx;
}
async function richieAITip(){
  const tipEl=gg('rpTip'); const a=gg('rpAction'); if(a)a.innerHTML='';
  const fallback=()=>{ const b=richieQuips(); const m=b[Math.floor(Math.random()*b.length)]; tipEl.textContent=m; if(typeof riAudioOn!=='undefined'&&riAudioOn)riSpeak(m); };
  tipEl.textContent='Let me take a look…';
  if(rpChar){rpChar.talk(true);setTimeout(()=>rpChar.talk(false),1200);}
  try{
    const res=await fetch('/api/coach',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ context:richieContext(), persona:APP.persona||'coach', level:APP.level||1, seen:_aiSeen.slice(-6) })});
    if(!res.ok) throw new Error('coach '+res.status);
    const j=await res.json(); const tip=(j&&j.tip||'').trim();
    if(!tip) throw new Error('empty');
    _aiSeen.push(tip); if(_aiSeen.length>12)_aiSeen.shift();
    tipEl.textContent=tip; if(rpChar)rpChar.do('nod');
    if(typeof riAudioOn!=='undefined'&&riAudioOn)riSpeak(tip);
  }catch(e){ fallback(); }
}
// ── Richie leaves his house (FAB), interacts, and returns ──
let _raChar=null, _raBusy=false, _raHomeTimer=null, _raActions=null, _raSelfNav=false;
function _fabRect(){ const f=document.querySelector('.richie-fab'); return f?f.getBoundingClientRect():{left:window.innerWidth-80,top:window.innerHeight-80,width:58,height:58}; }
// Richie stays out of the way while any full-screen overlay (onboarding / welcome / login) is up
function _richieBlocked(){
  if((typeof _tourQueue!=='undefined'&&_tourQueue.length)||(typeof APP!=='undefined'&&(APP._goalsFirst||APP._awaitingBuild))) return true;
  const ids=['richieIntro','welcomeBack','setupWizard','loginScreen','richieChat','gamiCele'];
  for(let i=0;i<ids.length;i++){ const el=gg(ids[i]); if(el){ const d=el.style.display; if(d&&d!=='none') return true; } }
  return false;
}
// Leaving a screen: stop this page's Richie instantly so the next page can greet
function richieStopForNav(){
  richieStopAllSpeech();
  clearTimeout(_raHomeTimer);
  const b=gg('raBubble'); if(b) b.classList.remove('show');
  const actor=gg('raActor'); if(actor){ actor.classList.remove('out'); actor.style.opacity='0'; actor.style.transform='scale(.3)'; }
  const fc=gg('fabChar'); if(fc) fc.style.opacity='1';
  const ff=gg('richieFab'); if(ff) ff.classList.remove('open');
  _raBusy=false; _raActions=null; _raSnoozeUntil=0; _raLastPop=0;   // a new screen always gets a fresh Richie
}
// A short, instant, page-specific greeting (no network) — "More/Tip" fetches the full AI tip
function richiePageLine(pg){
  const name=(pg&&pg.name)||'this page';
  try{ if((pg.widgets||[]).some(w=>w.type==='net_worth_summary'||w.type==='cash_summary'||w.type==='net_worth_chart')){
    return `Net worth's at ${typeof fmtK==='function'?fmtK(Math.round(engNetWorth())):'$'+Math.round(engNetWorth())}. Want today's focus?`; } }catch(e){}
  try{ if((pg.widgets||[]).some(w=>w.type==='bills_list')){ const n=(engUpcomingBills()||[]).filter(b=>!b.paid).length; if(n) return `${n} bill${n>1?'s':''} on deck here. Want a hand?`; } }catch(e){}
  if(pg&&pg.goalMetric) return `Your ${name} goal — want a quick read on progress?`;
  return `You're on ${name}. Want a quick tip?`;
}
// Interactive bubble buttons — Richie can offer real choices the user taps
// iOS/Android → emerging bubble; ANY desktop browser (incl. touch laptops) → block panel
function _richieMobile(){
  try{
    const ua=navigator.userAgent||navigator.vendor||'';
    if(/iPhone|iPad|iPod|Android/i.test(ua)) return true;
    if(/Macintosh/.test(ua) && (navigator.maxTouchPoints||0)>1) return true;   // iPad on iPadOS reports as Mac+touch
  }catch(e){}
  return false;
}
// Render Richie's action buttons into either the bubble (raActs) or the panel (rpAction)
function _renderActs(containerId){
  const wrap=gg(containerId); if(!wrap) return;
  if(_raActions && _raActions.length){
    wrap.innerHTML=_raActions.map((a,i)=>`<button class="${a.cls||''}" onclick="_raAct(${i})">${a.label}</button>`).join('');
  } else if(containerId==='raActs'){
    wrap.innerHTML=`<button class="ra-go" onclick="openRichieChat()">💬 Ask Richie</button><button onclick="richieDismiss()">✕ go home</button>`;
  } else { wrap.innerHTML=''; }
}
function _renderRaActs(){ _renderActs('raActs'); }
// Desktop: show Richie's message in the original bottom-right block panel
function _panelShow(msg, opts){
  opts=opts||{};
  const bub=gg('raBubble'); if(bub) bub.classList.remove('show');   // never leave the mobile bubble up on desktop
  const asst=gg('richieAssistant'); if(asst) asst.style.display='block';
  const pn=gg('richiePanel'); if(!pn) return;
  if(opts.celebrate) _raConfetti();
  try{ const k=(typeof APP!=='undefined'&&APP.persona)||'coach'; const p=RICHIE_PERSONAS[k];
    if(p){ const nm=gg('rpName'); if(nm)nm.textContent='Richie · '+p.name; const c=gg('rpChar'); if(c)c.textContent=p.icon||'💰'; } }catch(e){}
  pn.classList.add('open'); _raBusy=true;
  _raActions = opts.actions || null; _renderActs('rpAction');
  const nb=pn.querySelector('.rp-new-tip-btn'); if(nb) nb.style.display=(_raActions&&_raActions.length)?'none':'';
  if(rpChar){ rpChar.emotion(opts.celebrate?'celebrate':(opts.emo||'happy')); rpChar.talk(true); }
  richieSpeakType(gg('rpTip'), msg, ()=>{ if(rpChar)rpChar.talk(false); });   // types (voice off)
}
function _raAct(i){ const a=_raActions&&_raActions[i]; if(a&&typeof a.on==='function') a.on(); }
// Stop everything Richie is currently saying/typing (used when leaving the SWOT)
function richieStopAllSpeech(){
  try{ _stopTts(); }catch(e){}
  ['wbText','wbTask','raMsg','rpTip'].forEach(id=>{ const el=gg(id); if(el&&el._tt){ clearTimeout(el._tt); el._tt=null; } });
}
// Richie physically helps: jump to the page with a widget and spotlight it
function richieFindWidget(type){
  if(typeof APP==='undefined'||!APP.pages) return null;
  for(const pg of APP.pages){ const w=(pg.widgets||[]).find(x=>x.type===type); if(w) return {pageId:pg.id, uid:w.uid}; }
  return null;
}
function richieSpotlight(uid){
  const el=document.querySelector(`[data-uid="${uid}"]`); if(!el) return;
  try{ el.scrollIntoView({behavior:'smooth', block:'center'}); }catch(e){}
  el.classList.add('ra-spot'); setTimeout(()=>{ try{el.classList.remove('ra-spot');}catch(e){} }, 5500);
}
function richieTakeTo(type, line){
  const t=richieFindWidget(type); if(!t){ if(line) richieShow(line); return; }
  if(APP.activePage!==t.pageId){ _raSelfNav=true; switchPage(t.pageId); _raSelfNav=false; }
  setTimeout(()=>{ richieSpotlight(t.uid);
    richieShow(line||'Here it is — take a look. 👇', {actions:[{label:'👍 Got it', on:richieGoHome}]});
  }, 400);
}
// ── Richie lands ON a specific spot ──
// Fly the actor next to a target element (any DOM rect) and speak a bubble. Always actor-based
// (works on desktop too) so Richie physically arrives where his suggestion applies.
function richieLandAt(rect, msg, opts){
  opts=opts||{};
  const actor=gg('raActor'); if(!actor || !rect){ richieShow(msg, opts); return; }
  try{ clearTimeout(_raHomeTimer); }catch(e){}
  if(!_raChar){ try{ _raChar=spawnRichie(gg('raChar')); }catch(e){} }
  const ff=gg('richieFab'); if(ff) ff.classList.add('open');
  const fc=gg('fabChar'); if(fc) fc.style.opacity='0';
  const home=_fabRect();
  actor.style.left=(home.left+2)+'px'; actor.style.top=home.top+'px';
  actor.classList.add('out'); actor.style.opacity='1'; actor.style.transform='scale(1)';
  const vw=window.innerWidth, vh=window.innerHeight, AW=56;
  let tx=rect.left-AW-4; if(tx<10) tx=Math.min(rect.right+6, vw-AW-10);   // sit left of the target, else right
  let ty=Math.max(10, Math.min(vh-72, rect.top-8));
  requestAnimationFrame(()=>{ actor.style.left=tx+'px'; actor.style.top=ty+'px'; });
  _raBusy=true;
  setTimeout(()=>{   // after the fly-in transition settles, point + speak (bubble positions off the actor)
    if(_raChar){ _raChar.emotion(opts.emo||'happy'); _raChar.do('point'); }
    _raBubble(msg||'Here — this is the spot. 👇');
    _raActions = opts.actions || [{label:'👍 Got it', on:richieGoHome}]; _renderRaActs();
    try{ richieSpeakType(gg('raMsg'), msg||'Here — this is the spot.', ()=>{ clearTimeout(_raHomeTimer); _raHomeTimer=setTimeout(richieGoHome, opts.linger||10000); }); }
    catch(e){ clearTimeout(_raHomeTimer); _raHomeTimer=setTimeout(richieGoHome, opts.linger||10000); }
  }, 580);
}
// Navigate to a widget, scroll to the exact area (optional focusSel within the card), highlight
// it, then land Richie on it. opts: {widgetType, tab, focusSel, message, emo, actions, linger}
function richieSpotlightAt(opts){
  opts=opts||{}; const type=opts.widgetType;
  const t=type?richieFindWidget(type):null;
  if(t && opts.tab && type==='debt_hub'){ try{ _debtHub[t.uid]=opts.tab; }catch(e){} }   // land on the right tab
  const land=()=>{
    const card=t?document.querySelector(`[data-uid="${t.uid}"]`):null;
    let target=card;
    if(card && opts.focusSel){ const f=card.querySelector(opts.focusSel); if(f) target=f; }
    if(!target){ richieShow(opts.message, opts); return; }
    try{ target.scrollIntoView({behavior:'smooth', block:'center'}); }catch(e){}
    if(card){ card.classList.add('ra-spot'); setTimeout(()=>{ try{card.classList.remove('ra-spot');}catch(e){} }, 8000); }
    if(target!==card){ target.classList.add('ra-focus'); setTimeout(()=>{ try{target.classList.remove('ra-focus');}catch(e){} }, 8000); }
    setTimeout(()=>{ let r=null; try{ r=target.getBoundingClientRect(); }catch(e){} if(r) richieLandAt(r, opts.message, opts); else richieShow(opts.message, opts); }, 430);
  };
  if(t && APP.activePage!==t.pageId){ _raSelfNav=true; try{ switchPage(t.pageId); }catch(e){} _raSelfNav=false; setTimeout(land, 430); }
  else if(t){ setTimeout(land, 90); }
  else { richieShow(opts.message, opts); }   // widget nowhere → just speak the suggestion
}
// ── ONE funnel for everything Richie says out of his house ──
// Emerges if needed, types in lockstep with the voice, and only heads home
// AFTER he has finished speaking (plus a short linger so the text stays up).
// ── Richie's animated-emoji props (Google Noto Animated Emoji — free, CDN-hosted webp; the app's
//    CSP img-src already allows https:, so no server change needed. A small animated prop appears
//    on Richie's shoulder keyed to the moment — tips, goals, celebrations, nudges, etc.) ──
// Codepoints verified to exist in Google's animated set (not every emoji is animated).
const RICHIE_PROP_EMOJI={ tip:'1f4a1', goal:'1f3af', celebrate:'1f389', win:'1f973', trophy:'1f3c6', streak:'1f525', money:'1fa99', save:'1f911', debt:'1f4b8', invest:'1f680', warn:'26a0', nudge:'1f440', health:'1f4aa' };
function _notoAnim(hex){ return `https://fonts.gstatic.com/s/e/notoemoji/latest/${hex}/512.webp`; }
function richieSetProp(key){
  const el=gg('raProp'); if(!el) return;
  const hex=key&&RICHIE_PROP_EMOJI[key];
  if(!hex){ el.style.display='none'; el.removeAttribute('src'); return; }
  el.onerror=()=>{ el.style.display='none'; };   // CDN blocked/offline → hide silently, never a broken image
  el.onload=()=>{ el.style.display='block'; };
  el.src=_notoAnim(hex);
}

/* ── Emoji FX: full-screen animated-emoji moments that make the app feel alive.
   All Noto animated webp (CSP img-src https: already allows it); onerror hides silently. ── */
const FX_EMOJI={ rocket:'1f680', boom:'1f4a5', party:'1f389', tada:'1f38a', stars:'2728', alarm:'1f6a8', fire:'1f525', trophy:'1f3c6', up:'1f4c8', coin:'1fa99', star:'2b50', glow:'1f31f', hundred:'1f4af', money:'1f911' };
function _emojiFxLayer(){ let el=gg('fxLayer'); if(el) return el; el=document.createElement('div'); el.id='fxLayer'; el.className='fx-layer'; document.body.appendChild(el); return el; }
function emojiBurst(kind, opts){
  opts=opts||{};
  try{
    const hex=FX_EMOJI[kind]||FX_EMOJI.party;
    const layer=_emojiFxLayer();
    const reduce=(typeof _reduceMotion!=='undefined'&&_reduceMotion);
    const main=document.createElement('img'); main.className='fx-main fx-'+kind+(reduce?' fx-reduce':''); main.alt=''; main.setAttribute('aria-hidden','true');
    main.onerror=()=>{ try{ main.remove(); }catch(e){} }; main.src=_notoAnim(hex);
    layer.appendChild(main);
    if(opts.particles!==false && !reduce){
      const pHex=FX_EMOJI[opts.particle||'stars']; const n=opts.count||12;
      for(let i=0;i<n;i++){ const s=document.createElement('img'); s.className='fx-part'; s.alt=''; s.setAttribute('aria-hidden','true');
        const ang=(i/n)*Math.PI*2 + Math.random()*0.5, dist=90+Math.random()*170;
        s.style.setProperty('--dx',Math.round(Math.cos(ang)*dist)+'px');
        s.style.setProperty('--dy',Math.round(Math.sin(ang)*dist)+'px');
        s.style.animationDelay=Math.round(Math.random()*160)+'ms';
        s.onerror=()=>{ try{ s.remove(); }catch(e){} }; s.src=_notoAnim(pHex); layer.appendChild(s);
      }
    }
    const life=opts.life||(kind==='rocket'?2200:kind==='alarm'?1700:2000);
    setTimeout(()=>{ try{ main.remove(); layer.querySelectorAll('.fx-part').forEach(n=>n.remove()); }catch(e){} }, life);
  }catch(e){}
}
// A quick sparkle at the XP badge — the lightweight "+XP" beat used on every award.
function _xpSparkle(){
  try{ const b=gg('sbXp'); if(!b || (typeof _reduceMotion!=='undefined'&&_reduceMotion)) return; const r=b.getBoundingClientRect(); const layer=_emojiFxLayer();
    for(let i=0;i<4;i++){ const s=document.createElement('img'); s.className='fx-sparkle'; s.alt=''; s.setAttribute('aria-hidden','true');
      s.style.left=(r.left+r.width*Math.random())+'px'; s.style.top=(r.top+r.height/2)+'px';
      s.style.setProperty('--sx',(-12+Math.random()*24)+'px'); s.style.animationDelay=(i*55)+'ms';
      s.onerror=()=>{ try{ s.remove(); }catch(e){} }; s.src=_notoAnim(FX_EMOJI.stars); layer.appendChild(s);
      setTimeout(()=>{ try{ s.remove(); }catch(e){} }, 1100);
    }
  }catch(e){}
}
function richieHopFx(){ try{ const el=gg('raChar'); if(el){ el.classList.remove('richie-hop'); void el.offsetWidth; el.classList.add('richie-hop'); setTimeout(()=>{ try{ el.classList.remove('richie-hop'); }catch(e){} }, 900); } }catch(e){} }
function richieShakeFx(){ try{ const el=gg('raChar'); if(el){ el.classList.remove('richie-shake'); void el.offsetWidth; el.classList.add('richie-shake'); setTimeout(()=>{ try{ el.classList.remove('richie-shake'); }catch(e){} }, 800); } }catch(e){} }
function richieShow(msg, opts){
  opts=opts||{};
  if(_richieBlocked()){ richieGoHome(); return; }   // overlay came up — clean up, don't speak over it
  if(opts.danger){ try{ emojiBurst('alarm',{particles:false}); }catch(e){} try{ richieShakeFx(); }catch(e){} }   // a real red-flag moment
  if(!_richieMobile()){ _panelShow(msg, opts); return; }   // desktop browser → original block panel
  if(opts.celebrate) _raConfetti();
  const present=()=>{
    if(_raChar){ if(opts.celebrate){ _raChar.emotion('celebrate'); _raChar.do('tada'); } else { _raChar.emotion(opts.emo||'happy'); } }
    try{ richieSetProp(opts.prop || (opts.celebrate?'celebrate':({curious:'nudge',no:'warn',proud:'trophy'}[opts.emo]||''))); }catch(e){}
    _raBubble(msg);
    _raActions = opts.actions || null; _renderRaActs();         // interactive choices, if any
    richieSpeakType(gg('raMsg'), msg, ()=>{                        // done = finished speaking
      if(_raChar)_raChar.do(opts.celebrate?'celebrate':'point');
      clearTimeout(_raHomeTimer);
      _raHomeTimer=setTimeout(richieGoHome, opts.linger||6000);    // linger AFTER he finishes
    });
  };
  clearTimeout(_raHomeTimer);                                       // never auto-home mid-sentence
  if(_raBusy){ present(); } else { _raBusy=true; _raEmerge(present); }
}
function richieHopOut(){ if(_raBusy){ richieGoHome(); return; } richieCoachNow(); }
function _raEmerge(then){
  if(!_raChar){ try{ _raChar=spawnRichie(gg('raChar')); }catch(e){} }
  const op=gg('richiePanel'); if(op) op.classList.remove('open');   // make sure the old panel is never up
  const ff=gg('richieFab'); if(ff) ff.classList.add('open');       // roof opens
  const fc=gg('fabChar'); if(fc) fc.style.opacity='0';              // the bag leaves the house
  const actor=gg('raActor'); const r=_fabRect();
  actor.style.left=(r.left+2)+'px'; actor.style.top=r.top+'px';
  actor.classList.add('out'); actor.style.transform='scale(1)';
  setTimeout(()=>{ const tx=Math.max(12, r.left-118), ty=Math.max(12, r.top-118); actor.style.left=tx+'px'; actor.style.top=ty+'px'; if(then)then(); }, 80);
}
// Emerge with a fixed message (no AI fetch) — used for off-track nudges
function richiePopMessage(msg, emo){ richieShow(msg, {emo:emo||'curious'}); }
// 🎉 Win celebration — confetti + excited Richie + spoken praise
function richieCelebrate(msg){ richieShow(msg, {celebrate:true, linger:5000}); }
function _raConfetti(){
  const r=_fabRect(); const cx=r.left-100, cy=r.top-100;
  const cols=['#2ecc8a','#5b8def','#f0a540','#f05c5c','#a78bfa','#ffd23f'];
  for(let i=0;i<18;i++){ const d=document.createElement('div'); d.className='ra-confetti';
    d.style.left=cx+Math.random()*40+'px'; d.style.top=cy+Math.random()*30+'px';
    d.style.background=cols[i%cols.length];
    d.style.setProperty('--dx',(Math.random()*180-90)+'px'); d.style.setProperty('--dy',(60+Math.random()*120)+'px');
    document.body.appendChild(d); setTimeout(()=>{ try{d.remove();}catch(e){} },1000); }
}
// User dismisses → go home and hold off briefly (he'll greet again on the next page)
function richieDismiss(){ _raSnoozeUntil=Date.now()+30000; richieGoHome(); }

// ── Proactive: Richie greets when you arrive on a page, and pops for events ──
let _raProactiveOn=true; try{ const v=LS.getItem('richie_proactive'); if(v!==null)_raProactiveOn=v==='1'; }catch(e){}
let _raLastPop=0, _raSnoozeUntil=0, _raOffTrackAt=0;
function setRichieProactive(on){ _raProactiveOn=!!on; try{ LS.setItem('richie_proactive', on?'1':'0'); }catch(e){} const b=gg('setProactiveBtn'); if(b)b.textContent=_raProactiveOn?'🔔 Pop-in tips: on':'🔕 Pop-in tips: off'; const t=gg('proactiveToggle'); if(t)t.classList.toggle('on',_raProactiveOn); if(_raProactiveOn && typeof richieSay==='function') richieSay("I'll pop in with a tip now and then. Tap me anytime too!"); else if(!_raProactiveOn){ try{ richieGoHome(); }catch(e){} } }
function richieOffTrackSignal(pg){
  // Anomaly first — a category running well above its usual pace is the most useful thing to flag.
  try{ const st=engSpendTrends(); const a=(st.movers||[]).filter(m=>m.delta>60 && m.prev>0 && m.cur>=m.prev*1.8).sort((x,y)=>y.delta-x.delta)[0];
    if(a){ const x=a.cur/a.prev; const desc=x>=2?`${x>=10?Math.round(x):x.toFixed(1)}× your usual`:`${Math.round((x-1)*100)}% over your usual`;
      return {msg:`Heads up — ${esc(a.label)} is running ${desc} this month (${fmtK(a.cur)} vs ${fmtK(a.prev)} by now last month). Want to see what's driving it?`, widget:'spending_trends', cta:'Show me', danger:true}; } }catch(e){}
  try{ const pace=engPaceAlert(); if(pace){ return {msg:`You're moving fast on ${esc(pace.name)} — ${fmtK(pace.spent)} spent of a ${fmtK(pace.budget)} budget, with ${pace.daysLeft} day${pace.daysLeft!==1?'s':''} left this month. Want to ease off or adjust it?`, widget:'budget_actual', cta:'Show me', danger:true}; } }catch(e){}
  try{ const bills=(engUpcomingBills()||[]).filter(b=>!b.paid);
    if(bills.length>=3){ const tot=bills.reduce((s,b)=>s+(b.pay||b.amount||0),0); return {msg:`Heads up — you've got ${bills.length} bills coming up, about ${typeof fmtK==='function'?fmtK(tot):'$'+Math.round(tot)}. Want to run through them?`, widget:'bills_list', cta:'Show me'}; } }catch(e){}
  try{ const inc=engMonthlyIncome(), sp=engSpend30(); if(inc>0 && sp>inc*1.05){ return {msg:`Spending's running ahead of income this month. Want a quick look at where it's going?`, widget:'spending_hub', cta:'Show me', danger:true}; } }catch(e){}
  return null;
}
// A once-a-week recap: this week's spend vs last, the health grade, safe-to-spend, and the
// one move that helps most (which is also the health-score coaching line). Returns a signal or null.
function richieWeeklyRecap(){
  try{
    if(!dataLoaded) return null;
    let last=0; try{ last=parseInt(LS.getItem('richie_recap_ts')||'0',10)||0; }catch(e){}
    if(Date.now()-last < 7*86400000) return null;
    const now=Date.now();
    const wk=(a,b)=>(allTxns||[]).filter(t=>{ const d=new Date(t.date).getTime(); return d>=now-b*86400000 && d<now-a*86400000 && t.amount>0 && !_txnExcludedFromSpend(t); }).reduce((s,t)=>s+t.amount,0);
    const thisWk=Math.round(wk(0,7)), lastWk=Math.round(wk(7,14));
    let h=null; try{ h=engHealthScore(); }catch(e){}
    let pool=null; try{ pool=Math.round(engSafeToSpend().pool); }catch(e){}
    if(thisWk<=0 && !(h&&h.hasData)) return null;   // nothing meaningful to recap yet
    const dlt=lastWk>0?Math.round((thisWk-lastWk)/lastWk*100):null;
    const trend=dlt==null?'':(thisWk>=lastWk?` (▲ ${Math.abs(dlt)}% vs last week)`:` (▼ ${Math.abs(dlt)}% vs last week)`);
    const bits=[`Quick week recap — you spent ${fmtK(thisWk)}${trend}.`];
    if(h&&h.hasData) bits.push(`Health score's a ${h.grade} (${h.overall}/100).`);
    if(pool!=null) bits.push(`Safe to spend right now: ${fmtK(pool)}.`);
    if(h&&h.weakest){ bits.push(h.weakest.tip); return { msg:bits.join(' '), widget:'health_score', cta:'Show me' }; }
    bits.push(`Nice and steady — keep it rolling.`);
    return { msg:bits.join(' '), widget:'spending_trends', cta:'Show me' };
  }catch(e){ return null; }
}
function richieMaybeProactive(pg){
  if(!_raProactiveOn || _raBusy || _richieBlocked() || !pg || pg.id==='__settings__') return;
  const now=Date.now();
  if(now<_raSnoozeUntil || now-_raLastPop<1500) return;     // debounce duplicate renders only
  _raLastPop=now;
  const recap=richieWeeklyRecap();                          // weekly recap wins when it's due
  const off=(!recap && now-_raOffTrackAt>480000) ? richieOffTrackSignal(pg) : null;   // else off-track at most ~every 8 min
  setTimeout(()=>{ if(_raBusy||document.hidden||APP.activePage!==pg.id) return;
    if(recap){ try{ LS.setItem('richie_recap_ts', String(Date.now())); }catch(e){}
      richieShow(recap.msg, {emo:'happy', actions:[
        {label:recap.cta||'Show me', cls:'ra-go', on:()=>richieSpotlightAt(Object.assign({widgetType:recap.widget}, RICHIE_SPOTS[recap.widget]||{}))},
        {label:'Thanks', on:richieDismiss}
      ]}); }
    else if(off){ _raOffTrackAt=Date.now(); richieShow(off.msg, {emo:off.danger?'no':'curious', danger:!!off.danger, actions:[
        {label:off.cta||'Show me', cls:'ra-go', on:()=>richieSpotlightAt(Object.assign({widgetType:off.widget}, RICHIE_SPOTS[off.widget]||{}))},   // decide first, THEN Richie flies to the spot
        {label:'Not now', on:richieDismiss}
      ]}); }
    else { richieShow(richiePageLine(pg), {emo:'happy', actions:[      // short + instant; no network
        {label:'💬 Tip', cls:'ra-go', on:richieCoachNow},
        {label:'✕', on:richieGoHome}
      ]}); }
  }, 280);
}
function richieGoHome(){
  clearTimeout(_raHomeTimer); try{ _stopTts(); }catch(e){}
  try{ richieSetProp(''); }catch(e){}   // drop the animated prop when he heads home
  const pn=gg('richiePanel'); if(pn) pn.classList.remove('open');   // close the desktop block panel
  if(!_richieMobile()){ _raBusy=false; _raActions=null; }
  gg('raBubble').classList.remove('show');
  const actor=gg('raActor'); const r=_fabRect();
  actor.style.left=(r.left+2)+'px'; actor.style.top=r.top+'px';
  actor.style.transform='scale(.3)'; actor.style.opacity='0';
  setTimeout(()=>{ actor.classList.remove('out'); const fc=gg('fabChar'); if(fc) fc.style.opacity='1'; const ff=gg('richieFab'); if(ff) ff.classList.remove('open'); _raBusy=false; }, 480);
}
function _raBubble(msg){
  const m=gg('raMsg'); m.textContent=msg;
  const b=gg('raBubble'); b.classList.add('show');
  requestAnimationFrame(()=>{
    const M=16, vw=window.innerWidth, vh=window.innerHeight;     // keep a clear margin from every edge
    b.style.maxWidth=Math.min(340, vw-2*M)+'px';                 // never wider than the screen
    m.style.maxHeight=Math.max(120, vh-2*M-72)+'px';            // long tips scroll; action buttons stay visible
    m.style.overflowY='auto';
    const a=gg('raActor').getBoundingClientRect();
    const bw=b.offsetWidth, bh=b.offsetHeight;
    // horizontal: sit near the actor, then clamp inside the margins
    let x=a.left+a.width-bw+18;
    x=Math.max(M, Math.min(vw-bw-M, x));
    // vertical: prefer above the actor; drop below only if there's room; then clamp fully on-screen
    let y=a.top-bh-10;
    if(y<M) y=a.top+a.height+10;
    y=Math.max(M, Math.min(vh-bh-M, y));                         // never runs past the bottom (taskbar)
    b.style.left=x+'px'; b.style.top=y+'px';
  });
}
async function richieCoachNow(){
  if(_richieBlocked()) return;            // not while onboarding / welcome / login is showing
  if(_richieMobile()){
    if(!_raBusy){ _raBusy=true; await new Promise(res=>_raEmerge(res)); }
    _raBubble('…'); if(_raChar)_raChar.emotion('curious');
  } else {
    _panelShow('…', {});                 // desktop → open the block panel with a placeholder
  }
  let tip='';
  try{
    const res=await fetch('/api/coach',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ context:richieContext(), persona:APP.persona||'coach', level:APP.level||1, seen:_aiSeen.slice(-6) })});
    if(res.ok){ const j=await res.json(); tip=(j&&j.tip||'').trim(); }
  }catch(e){}
  if(!tip){ const q=richieQuips(); tip=q[Math.floor(Math.random()*q.length)]; }
  _aiSeen.push(tip); if(_aiSeen.length>12)_aiSeen.shift();
  richieShow(tip, {prop:'tip', actions:[{label:'👍 Got it', cls:'ra-go', on:richieGoHome},{label:'💬 Ask Richie', on:openRichieChat}]});
}
window.addEventListener('resize',()=>{ if(_raBusy){ const a=gg('raActor'); const r=_fabRect(); /* keep bubble anchored */ if(gg('raBubble').classList.contains('show')) _raBubble(gg('raMsg').textContent); } });
function newSbTip(){ const b=richieQuips(); gg('sbRichieTip').textContent=b[Math.floor(Math.random()*b.length)]; }
function richieSay(msg){
  // During the one-time goals-first tour, keep the guided panel (it carries action buttons).
  if((typeof _tourQueue!=='undefined' && _tourQueue.length) || (typeof APP!=='undefined' && APP._goalsFirst)){
    gg('richieAssistant').style.display='block';
    const a=gg('rpAction'); if(a)a.innerHTML='';
    const pn=gg('richiePanel'); if(pn)pn.classList.add('open');
    gg('rpTip').textContent=msg;
    if(rpChar){rpChar.talk(true);setTimeout(()=>rpChar.talk(false),1400);}
    return;
  }
  richieShow(msg);   // normal use → Richie comes out of his house (single, unified system)
}
// Richie proactively offers to guide the first bank connection
function richieGuideConnect(){
  if(APP.plaidConnected||dataLoaded) return; // already connected
  gg('richieAssistant').style.display='block';
  const pn=gg('richiePanel'); pn.classList.add('open');
  const p=RICHIE_PERSONAS[APP.persona];
  const line = APP.persona==='crusher' ? "Time to face the numbers. Connect your bank and I'll show you exactly what we're up against."
    : "Ready for the magic? Connect your bank and I'll fill every widget with your real numbers — balances, spending, the works. Bank-level encryption, read-only.";
  gg('rpTip').textContent=line;
  const a=gg('rpAction');
  if(a) a.innerHTML=`<button class="btn primary" style="width:100%;margin-top:10px" onclick="richieStartConnect()">🏦 Connect my bank</button>
    <button class="rp-new-tip-btn" style="margin-top:6px" onclick="richieMaybeLater()">Maybe later</button>`;
  if(rpChar){rpChar.do('wiggle');rpChar.talk(true);setTimeout(()=>rpChar.talk(false),1500);}
}
function richieStartConnect(){
  const a=gg('rpAction'); if(a)a.innerHTML='';
  gg('rpTip').textContent="Opening the secure connection… pick your bank in the window that appears.";
  if(rpChar)rpChar.do('bounce');
  openLinkHandler();
}
function richieMaybeLater(){
  const a=gg('rpAction'); if(a)a.innerHTML='';
  gg('rpTip').textContent="No rush! Tap \"Connect your bank\" in the sidebar whenever you're ready. I'll be here.";
  if(rpChar)rpChar.do('nod');
}

/* ═══════════════ SIDEBAR (mobile) ═══════════════ */
function openSidebar(){
  const sb=gg('sidebar'), sc=gg('sidebarScrim');
  if(!sb) return;
  sb.classList.add('open');
  // belt-and-suspenders: force visible inline in case a CSS rule loses specificity on a device
  sb.style.transform='translateX(0)';
  if(sc){ sc.classList.add('open'); sc.style.display='block'; }
}
function closeSidebar(){
  const sb=gg('sidebar'), sc=gg('sidebarScrim');
  if(!sb) return;
  sb.classList.remove('open');
  if(window.innerWidth<=900) sb.style.transform='translateX(-100%)'; else sb.style.transform='';
  if(sc){ sc.classList.remove('open'); sc.style.display=''; }
}
function toggleSidebar(){
  const sb=gg('sidebar'); if(!sb) return;
  if(sb.classList.contains('open')) closeSidebar(); else openSidebar();
}
function closeSidebarMobile(){ if(window.innerWidth<=900) closeSidebar(); }
function handleResize(){
  const h=gg('hamburger'); if(h) h.style.display=window.innerWidth<=900?'flex':'none';
  const sb=gg('sidebar');
  if(sb && window.innerWidth>900){ sb.style.transform=''; const sc=gg('sidebarScrim'); if(sc){sc.classList.remove('open');sc.style.display='';} sb.classList.remove('open'); }
}

/* ═══ Swipe navigation: change pages by swiping left/right; edge-swipe opens sidebar ═══ */
function _orderedPageIds(){ return (APP.pages||[]).map(p=>p.id); }
function swipeToPage(dir){  // dir: +1 = next page, -1 = prev
  const ids=_orderedPageIds(); if(ids.length<2) return;
  let i=ids.indexOf(APP.activePage);
  if(i<0) i=0;
  let ni=i+dir;
  if(ni<0) ni=ids.length-1; else if(ni>=ids.length) ni=0;
  if(ni===i) return;
  // brief slide hint on the page content
  const pc=gg('page-content');
  if(pc){ pc.style.transition='transform .12s ease, opacity .12s ease'; pc.style.transform=`translateX(${dir>0?'-':''}14px)`; pc.style.opacity='0.6';
    setTimeout(()=>{ switchPage(ids[ni]); pc.style.transform='translateX(0)'; pc.style.opacity='1'; setTimeout(()=>{pc.style.transition='';},140); },120);
  } else { switchPage(ids[ni]); }
}
function initSwipeNav(){
  let x0=null,y0=null,t0=0,tracking=false,fromEdge=false;
  const TH=window;
  document.addEventListener('touchstart',(e)=>{
    if(window.innerWidth>900) return;            // mobile only
    if(e.touches.length!==1) return;
    // ignore swipes that start on interactive/scrollable controls
    const t=e.target;
    if(t.closest('input,textarea,select,canvas,.zb-slider,.ws-input,.bill-pay,.cfp-ev-edit,.pl-toggle,.bills-tf,#sidebar,.modal,.wdt-modal,#widgetStudio')) return;
    const tt=e.touches[0]; x0=tt.clientX; y0=tt.clientY; t0=Date.now(); tracking=true;
    fromEdge = x0<=24;                            // left-edge swipe opens sidebar
  },{passive:true});
  document.addEventListener('touchend',(e)=>{
    if(!tracking) return; tracking=false;
    const tt=e.changedTouches[0];
    const dx=tt.clientX-x0, dy=tt.clientY-y0, dt=Date.now()-t0;
    if(dt>700) return;                            // too slow = not a swipe
    if(Math.abs(dx)<60) return;                   // too short
    if(Math.abs(dx)<Math.abs(dy)*1.6) return;     // mostly vertical = scroll, ignore
    const sb=gg('sidebar');
    const sidebarOpen=sb&&sb.classList.contains('open');
    if(sidebarOpen){
      if(dx<0) closeSidebar();                    // swipe left closes the open sidebar
      return;
    }
    if(fromEdge && dx>60){ openSidebar(); return; } // edge swipe right opens nav
    // otherwise: swipe to change page
    if(dx<0) swipeToPage(+1);                      // swipe left → next page
    else      swipeToPage(-1);                     // swipe right → prev page
  },{passive:true});
}

/* ═══════════════ BOOT ═══════════════ */

/* ═══════════════════════════════════════════════════════════════
   FIRST-RUN INTRO STORY + SETUP WIZARD (ported from Phase 1 demo)
   Reuses app's RichieEmoji, RICHIE_PERSONAS, LEVELS, BUNDLE_PAGES.
═══════════════════════════════════════════════════════════════ */
const RICHIE_STORY=[
  {text:"Psst. Hey. Yeah\u2026 you.", emotion:'wiggle', wake:false},
  {text:"Oh thank goodness, someone finally showed up. A money bag can only nap for so long.", emotion:'surprised', wake:true},
  {text:"Name's Richie. I'm your money guy. Part accountant, part hype man, fully made of cash.", emotion:'happy', wake:true},
  {text:"Most people have no clue where their money goes. It just\u2026 vanishes. Spooky.", emotion:'surprised', wake:true},
  {text:"But you? You showed up. That already puts you ahead of most folks. No pressure.", emotion:'proud', wake:true},
  {text:"Before we build your world \u2014 let me get to know you. A few quick questions, be honest.", emotion:'curious', wake:true},
  {choice:'levelquiz'},
  {text:"Perfect \u2014 I'll tune everything to match.", emotion:'excited', wake:true},
  {text:"Now the fun part \u2014 what are we actually working toward? Pick what matters most to you.", emotion:'excited', wake:true},
  {choice:'goals'},
  {text:"Reveal placeholder", emotion:'celebrate', wake:true},
  {text:"Alright. Enough chit-chat. Let's build something good. Ready?", emotion:'celebrate', wake:true},
];
let riScene=0, riTyping=false, riTypeTimer=null, riFullText="";
let riChar=null, wizChar=null, wizStep=1;
let setupConfig={ persona:null, level:1, householdName:'', profiles:[{name:'',avatar:'💰'}], bundle:null, chosenGoals:[], plaidConnected:false, xp:0, proMode:false };

function introApplyAccent(){ const p=setupConfig.persona&&RICHIE_PERSONAS[setupConfig.persona]; document.documentElement.style.setProperty('--green', p?p.accent:'#2ecc8a'); }

function runIntro(){
  _obVoice=true; riAudioOn=true;        // Richie speaks during onboarding only
  const stars=gg('riStars'); if(stars){ let sh=''; for(let i=0;i<40;i++) sh+=`<div class="ri-star" style="left:${Math.random()*100}%;top:${Math.random()*100}%;--dur:${2+Math.random()*3}s;--delay:${Math.random()*3}s"></div>`; stars.innerHTML=sh; }
  gg('riDots').innerHTML=RICHIE_STORY.map((_,i)=>`<div class="ri-dot" id="riDot-${i}"></div>`).join('');
  riChar=spawnRichie(gg('riChar'), gg('riZzz')); riChar.sleep(true);
  gg('richieIntro').style.display='flex';
  const vb=gg('riVoiceBar'); if(vb) vb.style.display='none';   // voice chooser removed — Richie has one locked voice
  riSyncVoiceUI();
  riScene=0; riRenderScene();
}
function riRenderScene(){
  const scene=RICHIE_STORY[riScene];
  RICHIE_STORY.forEach((_,i)=>{const d=gg('riDot-'+i);if(d)d.className='ri-dot'+(i===riScene?' active':i<riScene?' done':'');});
  const choices=gg('riChoices'), cta=gg('riCta'), hint=gg('riClickHint'), bubble=document.querySelector('.ri-bubble-wrap');
  choices.style.display='none'; cta.style.display='none';
  if(scene.choice){
    hint.style.display='none';
    if(scene.choice==='levelquiz'){ bubble.style.display='block'; if(scene.wake&&riChar&&riChar.sleeping){riChar.sleep(false);} riStartInterview(); return; }
    if(scene.choice==='goals'){ bubble.style.display='block'; if(scene.wake&&riChar&&riChar.sleeping){riChar.sleep(false);} riTypeText("Pick up to 3 \u2014 these become your home pages."); riShowChoices('goals'); return; }
    bubble.style.display='none'; riShowChoices(scene.choice); return;
  }
  bubble.style.display='block';
  if(scene.wake && riChar && riChar.sleeping){ riChar.sleep(false); riChar.wave(); }
  else if(scene.emotion){ setTimeout(()=>{ if(riChar) riChar.emotion(scene.emotion); }, 120); }
  riTypeText(scene.text);
  hint.style.display = (riScene===RICHIE_STORY.length-1)?'none':'inline';
}
let _riTypeSeq=0;
// Types a line and \u2014 during onboarding \u2014 speaks it IN SYNC: the words appear at the pace
// of the spoken audio so Richie's voice tracks the text. Returns a promise that resolves
// when the line is fully delivered (audio finished), so callers can pace what comes next.
// Falls back to plain fixed-pace typing when voice is off or TTS is slow/unavailable.
function riTypeText(txt){
  clearTimeout(riTypeTimer); riFullText=txt; riTyping=true; if(riChar) riChar.talk(true);
  const el=gg('riText'); if(!el) return Promise.resolve();
  const mySeq=++_riTypeSeq;
  return new Promise(resolve=>{
    let done=false;
    const finish=()=>{ if(done) return; done=true;
      if(mySeq===_riTypeSeq){ el.innerHTML=esc(txt); riTyping=false; if(riChar)riChar.talk(false);
        if(riScene===RICHIE_STORY.length-1){ gg('riCta').style.display='block'; gg('riCtaBtn').textContent="Let's build it \u2192"; } }
      resolve();
    };
    // Typewriter at perMs/char. onEnd runs when the visual finishes (defaults to finish()).
    const typeAt=(perMs,onEnd)=>{ let i=0; clearTimeout(riTypeTimer);
      (function step(){
        if(mySeq!==_riTypeSeq || !riTyping){ resolve(); return; }   // superseded by a newer line, or skipped
        if(i<=txt.length){ el.innerHTML=esc(txt.slice(0,i))+'<span class="ri-cursor"></span>'; i++; riTypeTimer=setTimeout(step, perMs); }
        else (onEnd||finish)();
      })();
    };
    // Onboarding: fetch the voice first, then type paced to its real duration so the
    // words land exactly as they're spoken; resolve when the audio actually ends.
    if(_obVoice && riAudioOn && _ttsMode!=='browser'){
      _stopTts(); el.innerHTML='<span class="ri-cursor"></span>';
      const clean=(txt||'').replace(/[\u{1F000}-\u{1FAFF}\u2190-\u27bf\u2b00-\u2bff\ufe0f\u2022]/gu,'').replace(/\s+/g,' ').trim();
      let settled=false;
      const fixed=()=>{ if(settled) return; settled=true; if(mySeq===_riTypeSeq) typeAt(26); else resolve(); };
      const guard=setTimeout(fixed, 2800);   // never block the flow waiting on TTS
      _ttsFetchAudio(clean).then(audio=>{
        clearTimeout(guard);
        if(settled || mySeq!==_riTypeSeq){ resolve(); return; }
        settled=true; _stopTts(); _ttsMode='cloud'; _ttsAudio=audio; _ttsSeq++;
        let started=false;
        const play=()=>{ if(started) return; started=true;                          // 'loadedmetadata' AND the fallback timer can both fire — type only once
          if(mySeq!==_riTypeSeq || !riTyping){ resolve(); return; }                  // superseded or already skipped
          let dur=audio.duration; if(!dur||!isFinite(dur)||dur<=0) dur=Math.max(1.4, clean.length/14);
          const per=Math.max(13, Math.min(55, (dur*1000)/Math.max(txt.length,1)));
          audio.play().catch(()=>{});
          audio.addEventListener('ended', finish, {once:true});
          setTimeout(finish, (dur*1000)+2000);            // safety net if 'ended' never fires
          typeAt(per, ()=>{ if(mySeq===_riTypeSeq) el.innerHTML=esc(txt); });   // visual done; resolve waits for the voice
        };
        if(audio.readyState>=1) play(); else { audio.addEventListener('loadedmetadata', play, {once:true}); setTimeout(play, 600); }
      }).catch(()=>{ clearTimeout(guard); fixed(); });
      return;
    }
    // No voice (in-app, or forced browser mode): plain typewriter.
    el.innerHTML='<span class="ri-cursor"></span>'; typeAt(20+Math.random()*10);
  });
}
function riAdvance(e){
  if(e&&e.target&&e.target.closest&&e.target.closest('.ri-choice, .ri-cta-btn')) return;
  const scene=RICHIE_STORY[riScene];
  if(scene && scene.choice) return;
  if(riTyping){ clearTimeout(riTypeTimer); try{_stopTts();}catch(e){} gg('riText').innerHTML=riFullText; riTyping=false; if(riChar)riChar.talk(false);
    if(riScene===RICHIE_STORY.length-1){gg('riCta').style.display='block';gg('riCtaBtn').textContent="Let's build it \u2192";} return; }
  if(riScene>=RICHIE_STORY.length-1) return;
  riScene++; riRenderScene();
}
function riCtaAction(e){ e.stopPropagation(); riFinishIntro(); }
function riShowChoices(kind){
  const wrap=gg('riChoices'); wrap.style.display='grid'; wrap.style.gridTemplateColumns=''; wrap.classList.remove('ri-quiz');
  if(kind==='persona'){
    wrap.innerHTML='<div class="ri-choices-title">Pick your guide \u2014 you can change this later in settings</div>'+
      PERSONA_ORDER.map(k=>{const p=RICHIE_PERSONAS[k];return `<div class="ri-choice" onclick="riPickPersona('${k}',event)"><div class="ri-choice-icon">${p.icon}</div><div class="ri-choice-name">${p.name}</div><div class="ri-choice-desc">${p.blurb||''}</div></div>`;}).join('');
  } else if(kind==='goals'){
    riRenderGoals();
  } else {
    wrap.innerHTML='<div class="ri-choices-title">Your starting level \u2014 you\'ll level up as you go</div>'+
      LEVELS.map(l=>`<div class="ri-choice" onclick="riPickLevel(${l.n},event)"><div class="ri-choice-icon">${l.icon}</div><div class="ri-choice-name">Lv ${l.n} \u00b7 ${l.name}</div><div class="ri-choice-desc">${l.desc||''}</div></div>`).join('');
  }
}
function riPickPersona(key,e){
  if(e)e.stopPropagation();
  setupConfig.persona=key; introApplyAccent();
  gg('riChoices').style.display='none'; document.querySelector('.ri-bubble-wrap').style.display='block';
  if(riChar) riChar.emotion('excited'); riScene++; gg('riClickHint').style.display='inline';
  riTypeText(RICHIE_PERSONAS[key].introLine||"Great pick! Let's keep going.");
}
function riPickLevel(n,e){
  if(e)e.stopPropagation();
  setupConfig.level=1; const lv=LEVELS.find(l=>l.n===1);
  gg('riChoices').style.display='none'; document.querySelector('.ri-bubble-wrap').style.display='block';
  if(riChar) riChar.emotion('happy'); riScene++; gg('riClickHint').style.display='inline';
  riTypeText(`${lv.icon} ${lv.name} it is. Good to know \u2014 I'll keep things just right for you.`);
}
/* ── Level quiz: Richie determines the level AND which coach to become ── */
let riQuizIdx=0, riQuizScore=0, riQuizLevelCount=0, _quizCoach={};
function riStartQuiz(){ riQuizIdx=0; riQuizScore=0; riQuizLevelCount=0; _quizCoach={}; riRenderQuiz(); }
function riRenderQuiz(){
  const q=LEVEL_QUIZ[riQuizIdx];
  if(riChar) riChar.emotion(riQuizIdx%2?'curious':'happy');
  riTypeText(q.q);
  const wrap=gg('riChoices'); wrap.style.display='grid'; wrap.style.gridTemplateColumns='1fr'; wrap.classList.add('ri-quiz');
  wrap.innerHTML=`<div class="ri-choices-title">Question ${riQuizIdx+1} of ${LEVEL_QUIZ.length}</div>`+
    q.opts.map((o,oi)=>`<div class="ri-choice ri-quiz-opt" onclick="riAnswerQuiz(${oi},event)">${esc(o.label)}</div>`).join('');
}
function riAnswerQuiz(oi,e){
  if(e)e.stopPropagation();
  const o=LEVEL_QUIZ[riQuizIdx].opts[oi]||{};
  if(o.pts!=null){ riQuizScore+=o.pts; riQuizLevelCount++; }
  if(o.coach){ const w=(o.pts!=null?1:2); _quizCoach[o.coach]=(_quizCoach[o.coach]||0)+w; }  // style Qs weigh 2×
  riQuizIdx++;
  if(riQuizIdx<LEVEL_QUIZ.length){ riRenderQuiz(); return; }
  const lvl=1;
  setupConfig.level=1; const lv=LEVELS.find(l=>l.n===lvl);
  const wrap=gg('riChoices'); wrap.style.display='none'; wrap.classList.remove('ri-quiz'); wrap.style.gridTemplateColumns='';
  document.querySelector('.ri-bubble-wrap').style.display='block';
  if(riChar) riChar.emotion('excited'); riScene++; gg('riClickHint').style.display='inline';
  riTypeText(`Got it \u2014 you're a ${lv.icon} Lv ${lv.n} \u00b7 ${lv.name}. ${lv.desc} As you hit goals you'll LEVEL UP and unlock more.`);
}
/* ── AI-driven onboarding: Richie interviews the user (4 adaptive rounds) ── */
const OB_ROUNDS=4;
// Fallback / opener questions WITH multiple-choice options (round 1 is fixed for speed; if the API is down these are used too)
const OB_FLOW=[
  { q:"To start \u2014 how would you describe your money life right now?",
    opts:["Just getting started, figuring it out","Getting by, but I want a real plan","Pretty stable \u2014 optimizing now","Confident \u2014 investing & building wealth"] },
  { q:"How do you keep track of your money today?",
    opts:["Mostly in my head","A budgeting app","A spreadsheet","I don't really track it"] },
  { q:"When it comes to saving & investing, how do you feel?",
    opts:["Total beginner","Learning the ropes","Fairly comfortable","Very experienced"] },
  { q:"What would feel like the biggest win this year?",
    opts:["Build an emergency fund","Pay off debt","Save for a specific goal","Grow investments / net worth"] },
];
let _obHistory=[], _obRound=0, _obBusy=false, _obOpts=[];
function riStartInterview(){
  _obHistory=[]; _obRound=0; _obBusy=false;
  riAskInterview(OB_FLOW[0].q, OB_FLOW[0].opts);
}
function riAskInterview(q, opts){
  if(riChar) riChar.emotion(_obRound%2?'curious':'happy');
  riTypeText(q);
  _obHistory.push({q});
  riShowChoicesMC(opts);
}
// Multiple-choice answers (no typing) \u2014 Richie's AI sets the options each round
function riShowChoicesMC(opts){
  const wrap=gg('riChoices'); wrap.style.display='grid'; wrap.style.gridTemplateColumns='1fr';
  wrap.classList.remove('ri-quiz','ri-goals'); wrap.classList.add('ri-interview');
  _obOpts=(opts&&opts.length?opts:OB_FLOW[Math.min(_obRound,OB_FLOW.length-1)].opts).slice(0,5);
  wrap.innerHTML=`<div class="ri-choices-title">Round ${Math.min(_obRound+1,OB_ROUNDS)} of ${OB_ROUNDS} \u2014 tap what fits best</div>`+
    _obOpts.map((o,i)=>`<button class="ob-choice" onclick="riPickAnswer(${i})">${esc(o)}</button>`).join('');
}
async function riPickAnswer(i){
  if(_obBusy) return;
  const a=_obOpts[i]; if(!a) return;
  _obBusy=true;
  _obHistory[_obHistory.length-1].a=a;
  const wrap=gg('riChoices'); const btns=wrap.querySelectorAll('.ob-choice');
  btns.forEach((b,bi)=>{ b.disabled=true; if(bi===i) b.classList.add('sel'); });
  _obRound++;
  await new Promise(r=>setTimeout(r,300));
  if(_obRound>=OB_ROUNDS){
    wrap.innerHTML=`<div class="ri-choices-title">Reading between the lines\u2026</div>`;
    if(riChar) riChar.emotion('curious');
    riTypeText("Love it. Give me a sec \u2014 I'm putting the pieces together\u2026");
    const profile=await riFetchProfile();
    _obBusy=false;
    riApplyProfile(profile);
    return;
  }
  wrap.innerHTML=`<div class="ri-choices-title ri-thinking">Richie's thinking<span class="ri-dots"></span></div>`;
  if(riChar) riChar.emotion('happy');
  const nq=await riFetchNextQuestion();
  // Call-and-response: Richie reacts to what you just said (in sync voice+text), then asks.
  if(nq.reaction){ await riTypeText(nq.reaction); await new Promise(r=>setTimeout(r,200)); }
  _obBusy=false;
  riAskInterview(nq.q, nq.opts);
}
// POST /api/onboard with a hard timeout so a slow/hung OpenAI call can NEVER freeze the
// interview \u2014 on timeout/error we abort and let the caller fall back to its scripted path.
async function _obFetch(body){
  const ctl=(typeof AbortController!=='undefined')?new AbortController():null;
  const t=ctl?setTimeout(()=>{try{ctl.abort();}catch(e){}},13000):null;
  try{ return await fetch('/api/onboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:ctl?ctl.signal:undefined}); }
  finally{ if(t) clearTimeout(t); }
}
async function riFetchNextQuestion(){
  try{
    const res=await _obFetch({ history:_obHistory.map(h=>({q:h.q,a:h.a})), mode:'next' });
    if(res.ok){ const j=await res.json(); if(j&&j.question&&Array.isArray(j.options)&&j.options.length) return {q:j.question.trim(), opts:j.options.slice(0,5), reaction:(j.reaction||'').trim()}; }
  }catch(e){}
  const fb=OB_FLOW[Math.min(_obRound, OB_FLOW.length-1)];
  return {q:fb.q, opts:fb.opts, reaction:''};
}
async function riFetchProfile(){
  try{
    const res=await _obFetch({ history:_obHistory.map(h=>({q:h.q,a:h.a})), mode:'finalize' });
    if(res.ok){ const j=await res.json(); if(j&&(j.level||j.persona||(j.goals&&j.goals.length))) return j; }
  }catch(e){}
  return _obFallbackProfile();
}
function _obFallbackProfile(){
  const text=_obHistory.map(h=>(h.a||'')).join(' ').toLowerCase();
  let level=2;
  if(/spreadsheet|portfolio|rebalance|net worth|index fund|diversif/.test(text)) level=4;
  else if(/budget|track|saving|invest/.test(text)) level=3;
  if(/no idea|don.t know|paycheck to paycheck|struggl|behind|overwhelm/.test(text)) level=1;
  const goals=[];
  if(/debt|credit card|loan|owe/.test(text)) goals.push({metric:'debt'});
  if(/emergency|safety net|cushion|rainy/.test(text)) goals.push({metric:'emergency'});
  if(/save|saving/.test(text)) goals.push({metric:'savings'});
  if(/invest|retire|net worth|wealth|fire/.test(text)) goals.push({metric:'networth'});
  if(!goals.length) goals.push({metric:'emergency'});
  let persona='coach';
  if(/debt|behind|stress|owe/.test(text)) persona='crusher';
  else if(/spreadsheet|precise|number|exact/.test(text)) persona='accountant';
  else if(/invest|retire|wealth|portfolio/.test(text)) persona='investor';
  return {level, persona, goals};
}
// Turn one AI goal into a real goal object. WIDENED: preserve the AI's SPECIFIC goal
// (its exact name, metric, and dollar/percent target) instead of forcing it into a fixed
// preset — so Richie can propose "Save $8k for the wedding", not just "Save $10,000".
// Falls back to a matching preset only when the AI gave no usable name.
const _AI_GOAL_ICONS={emergency:'🛟',debt:'✂️',savings:'💰',networth:'💎',savingsrate:'📊',retirement:'🔥',custom:'🎯'};
function _aiGoalToPreset(g, i){
  const metric=((g&&g.metric)||'').toLowerCase();
  const m=_AI_GOAL_ICONS[metric]?metric:'custom';
  const name=(g&&g.name)?String(g.name).trim().slice(0,42):'';
  if(!name){ // no specifics → fall back to the closest preset
    const byMetric={emergency:'ef3mo',debt:'debtfree',savings:'save10k',networth:'nw100k',savingsrate:'sr20',retirement:'fire25'};
    const preset=GOAL_PRESETS.find(p=>p.key===(byMetric[m]||'ef3mo'))||GOAL_PRESETS[0];
    return Object.assign({}, preset, {key:'ai_'+i});
  }
  const target=(g&&g.target!=null&&isFinite(+g.target)&&+g.target>0)?Math.round(+g.target):null;
  const icon=(g&&g.icon&&String(g.icon).trim().length<=4)?String(g.icon).trim():(_AI_GOAL_ICONS[m]||'🎯');
  return { key:'ai_'+i, name, metric:m, target, icon, note:(g&&g.note)?String(g.note).slice(0,60):'', ai:true };
}
function riApplyProfile(profile){
  profile=profile||_obFallbackProfile();
  setupConfig.level=1;   // all new users start at Level 1 and earn their way up
  const pk=(typeof PERSONA_ORDER!=='undefined'&&PERSONA_ORDER.includes(profile.persona))?profile.persona:'coach';
  setupConfig.persona=pk; setupConfig._aiPersona=true; introApplyAccent();
  const seen={}; const goals=(profile.goals||[]).slice(0,4).map((g,i)=>_aiGoalToPreset(g,i)).filter(g=>{ const k=(g&&g.name||'').toLowerCase(); if(!g||seen[k])return false; seen[k]=1; return true; });
  setupConfig._aiGoals = goals.length?goals:[_aiGoalToPreset({metric:'emergency'},0)];   // Richie's suggested set (survives deselection so it can be re-picked)
  setupConfig.chosenGoals = setupConfig._aiGoals.slice(0,3);
  const wrap=gg('riChoices'); wrap.style.display='none'; wrap.classList.remove('ri-interview');
  document.querySelector('.ri-bubble-wrap').style.display='block';
  if(riChar) riChar.emotion('excited');
  const gnames=setupConfig.chosenGoals.map(g=>g.name).join(', ');
  const gi=RICHIE_STORY.findIndex(s=>s.choice==='goals'); if(gi>=0) riScene=gi; gg('riClickHint').style.display='inline';
  riTypeText(`Okay \u2014 I've got a real read on you now. Based on everything, here's what I think we should work toward: ${gnames}. Tweak below if you want, then we'll build it.`);
  setTimeout(()=>{ riShowChoices('goals'); }, 320);   // goal picker, pre-filled with the AI's picks
}
/* ── Narrated goals picker (now part of the intro, before naming) ── */
function riRenderGoals(){
  const chosen=setupConfig.chosenGoals||[];
  const ai=(setupConfig._aiGoals||[]);
  const wrap=gg('riChoices'); wrap.style.display='grid'; wrap.style.gridTemplateColumns=''; wrap.classList.remove('ri-quiz'); wrap.classList.add('ri-goals');
  const chip=(g)=>{ const sel=chosen.some(c=>c.key===g.key); const dim=!sel&&chosen.length>=3;
    return `<div class="ri-choice ri-goal${sel?' sel':''}${dim?' dim':''}${g.ai?' ri-goal-ai':''}" onclick="${dim?'':`riToggleGoal('${g.key}',event)`}"><div class="ri-choice-icon">${g.icon}</div><div class="ri-choice-name">${esc(g.name)}</div><div class="ri-choice-desc">${esc(g.note||g.blurb||'')}</div></div>`; };
  // Richie's tailored picks first (when the interview produced them), then the standard menu.
  const head = ai.length ? `<div class="ri-choices-title">\u2728 Richie's picks, just for you \u2014 ${chosen.length}/3</div>` : `<div class="ri-choices-title">Pick up to 3 \u2014 ${chosen.length}/3 chosen</div>`;
  const aiHtml = ai.map(chip).join('');
  const presets = GOAL_PRESETS.filter(p=>!ai.some(a=>a.key===p.key));
  const presetHtml = (ai.length?`<div class="ri-goals-more">Or add one of these:</div>`:'') + presets.map(chip).join('');
  wrap.innerHTML = head + aiHtml + presetHtml +
    `<div class="ri-goals-foot"><button class="ri-cta-btn${chosen.length?'':' disabled'}" onclick="riGoalsDone(event)">${chosen.length?`Continue with ${chosen.length} goal${chosen.length>1?'s':''} \u2192`:'Pick at least one'}</button></div>`;
}
function riToggleGoal(key,e){
  if(e)e.stopPropagation();
  const g=(setupConfig._aiGoals||[]).find(x=>x.key===key) || GOAL_PRESETS.find(x=>x.key===key); if(!g) return;
  setupConfig.chosenGoals=setupConfig.chosenGoals||[];
  const i=setupConfig.chosenGoals.findIndex(c=>c.key===key);
  if(i>=0) setupConfig.chosenGoals.splice(i,1);
  else { if(setupConfig.chosenGoals.length>=3) return; setupConfig.chosenGoals.push({key:g.key,name:g.name,metric:g.metric,target:g.target,icon:g.icon,auto:g.auto,note:g.note,ai:g.ai}); }
  if(riChar) riChar.do('bounce');
  riRenderGoals();
}
function riGoalsDone(e){
  if(e)e.stopPropagation();
  if(!(setupConfig.chosenGoals||[]).length) return;
  const wrap=gg('riChoices'); wrap.style.display='none'; wrap.classList.remove('ri-goals');
  document.querySelector('.ri-bubble-wrap').style.display='block';
  // Persona: keep the AI's pick from the interview; otherwise derive it
  const pk = setupConfig._aiPersona ? setupConfig.persona : determinePersona(_quizCoach);
  setupConfig.persona=pk; introApplyAccent();
  const p=RICHIE_PERSONAS[pk];
  if(riChar) riChar.emotion('celebrate'); riScene++; gg('riClickHint').style.display='inline';
  const names=setupConfig.chosenGoals.map(g=>g.name).join(', ');
  // persona voice is now active for this reveal line
  riTypeText(`Love it \u2014 ${names}. Based on everything you told me, here's who I'm going to be for you: your ${p.icon} ${p.name}. ${p.introLine}`);
}

/* ── Richie's voice (Web Speech API) — preset-based, persona-inflected ── */
let riAudioOn = false;   // voice is OFF in the app; ON only during onboarding (see _obVoice)
try{ const s=LS.getItem('richie_audio'); if(s!==null) riAudioOn = s==='1'; }catch(e){}
riAudioOn = false;       // start silent; runIntro() turns it on, wizFinish()/enterApp() turn it back off
let _obVoice = false;    // true ONLY during the onboarding intro/interview/wizard — Richie speaks then, silent after
let riVoiceId='guy';   // LOCKED to one warm, upbeat male voice — the voice chooser was removed
let _riVoice=null, _riVoiceForId=null;
const _FEMALE_VOICES=/(female|woman|samantha|victoria|karen|moira|tessa|fiona|serena|allison|ava|susan|zira|kate|catherine|nora|sandy|veena|amelie|anna|google us english|google uk english female)/;
const _MALE_VOICES=/(\bmale\b|\bman\b|daniel|alex|fred|tom|aaron|nathan|oliver|david|mark|gordon|arthur|reed|eddy|junior|ralph|albert|bruce|lee|rishi|google uk english male)/;
function currentPreset(){ return VOICE_PRESETS.find(p=>p.id===riVoiceId)||VOICE_PRESETS[0]; }
function _pickVoice(preset){
  if(typeof window==='undefined' || !window.speechSynthesis) return null;
  const vs=window.speechSynthesis.getVoices()||[]; if(!vs.length) return null;
  const want=preset.gender;
  const score=v=>{ let s=0; const n=(v.name||'').toLowerCase(), l=(v.lang||'').toLowerCase();
    if(/^en[-_]us/.test(l)) s+=5; else if(/^en[-_]gb/.test(l)) s+=3; else if(/^en/.test(l)) s+=2; else s-=4;
    if(/natural|neural|enhanced|premium/.test(n)) s+=7;
    if(/google/.test(n)) s+=4;
    if(/microsoft/.test(n)) s+=2;
    if(preset.match && preset.match.test(n)) s+=9;            // preferred names for this preset
    if(want==='male'){ if(_MALE_VOICES.test(n)) s+=10; else if(_FEMALE_VOICES.test(n)) s-=9; }
    else if(want==='female'){ if(_FEMALE_VOICES.test(n)) s+=10; else if(_MALE_VOICES.test(n)) s-=9; }
    return s; };
  return vs.slice().sort((a,b)=>score(b)-score(a))[0]||vs[0];
}
function _personaMod(){ const k=setupConfig.persona||(typeof APP!=='undefined'&&APP.persona); return PERSONA_VOICE[k]||{r:1.0,p:0.04}; }
function _resolveVoice(){
  const pre=currentPreset();
  if(_riVoiceForId!==pre.id){ _riVoice=_pickVoice(pre); _riVoiceForId=pre.id; }
  return _riVoice;
}
/* Cloud TTS via our backend proxy → OpenAI. Auto-detects; falls back to the
   browser voice if the /api/tts route isn't set up (no key / not deployed). */
let _ttsMode='auto';   // 'auto' | 'cloud' | 'browser'
let _ttsAudio=null, _ttsSeq=0;
function _stopTts(){ _ttsSeq++; try{ if(_ttsAudio){ _ttsAudio.pause(); _ttsAudio=null; } }catch(e){} try{ if(window.speechSynthesis) window.speechSynthesis.cancel(); }catch(e){} }
async function _ttsCloud(text){
  if(!_obVoice) return;   // voice only during onboarding
  const pre=currentPreset();
  const k=setupConfig.persona||(typeof APP!=='undefined'&&APP.persona)||'coach';
  const instructions=`Speak as Richie, a money coach, in ${pre.style}. ${PERSONA_TTS_STYLE[k]||''}`.trim();
  const seq=++_ttsSeq;
  const res=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text, voice:pre.oai||'cedar', instructions})});
  if(!res.ok) throw new Error('tts '+res.status);
  const buf=await res.arrayBuffer();
  if(seq!==_ttsSeq) return;                 // a newer line superseded this one
  const url=URL.createObjectURL(new Blob([buf],{type:'audio/mpeg'}));
  _stopTts();
  _ttsAudio=new Audio(url); _ttsAudio.play().catch(()=>{});
  _ttsAudio.onended=()=>{ try{URL.revokeObjectURL(url);}catch(e){} };
}
// Fetch a preloaded <audio> for text (current preset voice + persona), or throw
const _ttsCache=new Map();   // voice|persona|text → Blob (instant replays)
async function _ttsFetchAudio(text){
  const pre=currentPreset();
  const k=setupConfig.persona||(typeof APP!=='undefined'&&APP.persona)||'coach';
  const instructions=`Speak as Richie, a money coach, in ${pre.style}. ${PERSONA_TTS_STYLE[k]||''}`.trim();
  const key=(pre.oai||'cedar')+'|'+k+'|'+text;
  let blob=_ttsCache.get(key);
  if(!blob){
    const res=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text, voice:pre.oai||'cedar', instructions})});
    if(!res.ok) throw new Error('tts '+res.status);
    blob=new Blob([await res.arrayBuffer()],{type:'audio/mpeg'});
    _ttsCache.set(key, blob); if(_ttsCache.size>40){ _ttsCache.delete(_ttsCache.keys().next().value); }
  }
  const url=URL.createObjectURL(blob);
  const a=new Audio(url); a.preload='auto';
  a.addEventListener('ended',()=>{ try{URL.revokeObjectURL(url);}catch(e){} });
  return a;
}
function _typeInto(el, text, perMs, done){
  if(!el) return; el.textContent=''; let i=0; clearTimeout(el._tt);
  (function step(){ if(i<=text.length){ el.textContent=text.slice(0,i); i++; el._tt=setTimeout(step, perMs); } else if(done) done(); })();
}
// Speak + type IN SYNC: type the text at the pace of the spoken audio so the
// voice tracks the words as they appear (falls back to browser voice / plain type).
async function richieSpeakType(el, text, doneCb){
  if(!el) return;
  const audioOn=false;   // VOICE DISABLED app-wide (text only) — types without sound
  const clean=(text||'').replace(/[\u{1F000}-\u{1FAFF}\u2190-\u27BF\u2B00-\u2BFF\uFE0F\u2022]/gu,'').replace(/\s+/g,' ').trim();
  try{ _stopTts(); }catch(e){}
  const seq=_ttsSeq;                                  // this line's audio generation
  el._sseq=seq;                                       // claim THIS bubble for this line
  let _done=false;
  const fireDone=()=>{ if(_done) return; _done=true; if(el._sseq===seq && typeof doneCb==='function') doneCb(); };
  if(!audioOn || _ttsMode==='browser'){
    if(audioOn) _speakBrowser(clean);
    _typeInto(el, text, 24, fireDone); return;
  }
  el.textContent='…';
  let audio=null;
  try{ audio=await _ttsFetchAudio(clean); }catch(e){ audio=null; }
  if(el._sseq!==seq) return;                           // a NEWER line claimed this same bubble → abort cleanly
  if(!audio || seq!==_ttsSeq){                          // lost the audio slot (another line is speaking): show text silently, still finish
    _typeInto(el, text, 24, fireDone); return;
  }
  _ttsAudio=audio; _ttsMode='cloud';
  let started=false;
  const begin=()=>{ if(started) return; started=true;
    if(el._sseq!==seq){ return; }                      // bubble reclaimed
    if(seq!==_ttsSeq){ _typeInto(el, text, 24, fireDone); return; }   // lost audio slot late → type silently + finish
    let dur=audio.duration; if(!dur||!isFinite(dur)||dur<=0) dur=Math.max(1.4, clean.length/14);
    const per=Math.max(13, Math.min(55, (dur*1000)/Math.max(text.length,1)));
    audio.play().catch(()=>{});
    _typeInto(el, text, per, null);                     // typing is visual; "done" waits for the voice
    audio.addEventListener('ended', fireDone, {once:true});
    setTimeout(fireDone, (dur*1000)+1800);              // safety net if 'ended' never fires
  };
  if(audio.readyState>=1) begin();
  else { audio.addEventListener('loadedmetadata', begin, {once:true}); setTimeout(begin, 700); }
}
function _speakBrowser(clean){
  if(!_obVoice) return;   // voice only during onboarding
  if(typeof window==='undefined' || !window.speechSynthesis) return;
  const pre=currentPreset(); const voice=_resolveVoice(); const mod=_personaMod();
  const rate=Math.max(0.6,Math.min(1.8, pre.rate*mod.r));
  const pitch=Math.max(0.1,Math.min(2, pre.pitch+mod.p));
  window.speechSynthesis.cancel();
  const chunks=clean.match(/[^.!?…]+[.!?…]*/g)||[clean];
  chunks.forEach(ch=>{ const t=ch.trim(); if(!t) return;
    const u=new SpeechSynthesisUtterance(t);
    u.rate=rate; u.pitch=pitch; u.volume=1; if(voice) u.voice=voice;
    window.speechSynthesis.speak(u);
  });
}
function riSpeak(text){
  if(!_obVoice) return;   // voice only during onboarding
  if(!riAudioOn || typeof window==='undefined') return;
  const clean=(text||'').replace(/[\u{1F000}-\u{1FAFF}\u2190-\u27BF\u2B00-\u2BFF\uFE0F\u2022]/gu,'').replace(/\s+/g,' ').trim();
  if(!clean) return;
  if(_ttsMode==='browser'){ _speakBrowser(clean); return; }
  // auto / cloud: try the cloud voice; on any failure, fall back to the browser voice
  _ttsCloud(clean).then(()=>{ _ttsMode='cloud'; }).catch(()=>{ _ttsMode='browser'; _speakBrowser(clean); });
}
function riSetVoice(id){
  if(!VOICE_PRESETS.some(p=>p.id===id)) return;
  riVoiceId=id; try{ LS.setItem('richie_voice',id); }catch(e){}
  _riVoiceForId=null; _resolveVoice();
  riSyncVoiceUI();
  _stopTts();
  if(riAudioOn){ const pre=currentPreset(); riSpeak(pre.sample||riFullText||"Hi, I'm Richie."); }  // preview
}
function riSyncVoiceUI(){
  document.querySelectorAll('.ri-vchip').forEach(el=>el.classList.toggle('active', el.getAttribute('data-vid')===riVoiceId));
  const ab=gg('riAudioBtn'); if(ab) ab.textContent=riAudioOn?'🔊':'🔇';
  const st=gg('setVoiceToggle'); if(st) st.textContent=riAudioOn?'🔊 Voice on':'🔇 Voice off';
}
function riToggleAudio(){
  riAudioOn=!riAudioOn;
  try{ LS.setItem('richie_audio', riAudioOn?'1':'0'); }catch(e){}
  if(!riAudioOn){ _stopTts(); }
  else { const pre=currentPreset(); riSpeak(riFullText||pre.sample); }
  riSyncVoiceUI();
}
function voiceChipsHTML(){ return ''; }   // voice chooser removed — Richie speaks in one locked upbeat male voice
// warm up voices list (some browsers load async) and cache the best one
try{ if(typeof window!=='undefined' && window.speechSynthesis){ window.speechSynthesis.onvoiceschanged=()=>{ _riVoiceForId=null; _resolveVoice(); }; window.speechSynthesis.getVoices(); } }catch(e){}
function riFinishIntro(){
  gg('riClickHint').style.display='none'; gg('riCta').style.display='none';
  const bubble=document.querySelector('.ri-bubble-wrap'); if(bubble){bubble.style.transition='opacity .4s';bubble.style.opacity='0';}
  if(riChar) riChar.setWalking&&riChar.setWalking(true);
  const wrap=gg('riChar').parentElement; const startT=performance.now(), dist=window.innerWidth/2+160;
  (function stroll(t){
    const p=Math.min(1,(t-startT)/1500); wrap.style.transform='translateX('+(p*dist)+'px)';
    if(p<1) requestAnimationFrame(stroll);
    else { gg('richieIntro').style.display='none'; wrap.style.transform=''; if(bubble)bubble.style.opacity='1'; startWizard(); }
  })(performance.now());
}

/* ── Wizard ── */
const WIZ_BUNDLES=[
  {id:'overview',icon:'💰',name:'Full Overview',desc:'The complete picture \u2014 everything in one place.',quip:'"Go big. I respect that."',pages:['Dashboard','Budget','Net Worth','Cash Flow']},
  {id:'budget',icon:'🎯',name:'Budget First',desc:'Master your monthly money flow and bills.',quip:'"Every dollar gets a job."',pages:['Budget & Bills','Zero Budget','Income']},
  {id:'wealth',icon:'📈',name:'Wealth Builder',desc:'Track net worth and grow toward retirement.',quip:'"Future-you says thanks."',pages:['Net Worth','FIRE','Retirement']},
  {id:'debt',icon:'🚨',name:'Debt Destroyer',desc:'Crush debt with payoff plans and drills.',quip:'"Send that debt packing."',pages:['Bills','Debt Payoff','Fire Drill']},
  {id:'fire',icon:'🔥',name:'FIRE Path',desc:'Financial independence, mapped out.',quip:'"Retire early? My language."',pages:['FIRE','Retirement','Net Worth']},
  {id:'playground',icon:'🎮',name:'The Playground',desc:'Stress-test scenarios and plan debt payoff interactively.',quip:'"Let\'s run the what-ifs."',pages:['Playground','Net Worth']},
  {id:'blank',icon:'🎨',name:'Blank Canvas',desc:'Start empty and build it your way.',quip:'"A true artist."',pages:['You build everything']},
];
const WIZ_TITLES={1:"Who are we building this for?",2:"Your plan is ready"};
const WIZ_QUIPS={1:"Don't worry, this is the easy part.",2:"Look at you. A plan and a coach. Let's go."};
function startWizard(){ gg('setupWizard').style.display='flex'; if(!wizChar) wizChar=spawnRichie(gg('wizRichie')); wizChar.do('bounce'); wizGoTo(1); }
function wizGoTo(step){
  wizStep=step;
  document.querySelectorAll('.wiz-step-tab').forEach(t=>{const s=+t.dataset.step;t.className='wiz-step-tab'+(s===step?' active':s<step?' done':'');});
  gg('wizTitle').textContent=WIZ_TITLES[step]; gg('wizQuip').textContent=WIZ_QUIPS[step];
  gg('wizBackBtn').style.visibility=step>1?'visible':'hidden';
  gg('wizNextBtn').textContent=step===2?"Sign in to finish \u2192":"Next \u2192";
  if(wizChar) wizChar.do(step===2?'tada':'bounce');
  wizRenderBody();
}
function wizRenderBody(){
  const b=gg('wizBody');
  if(wizStep===1){
    b.innerHTML=`<div class="wiz-field"><label>What should I call this household?</label>
      <input type="text" id="wizHousehold" placeholder="e.g. The Smith Household" value="${esc(setupConfig.householdName||'')}" oninput="setupConfig.householdName=this.value"></div>
      <div class="wiz-field"><label>Who's in it? (add at least one)</label><div id="wizProfiles"></div>
      <button class="btn" onclick="wizAddProfile()" style="margin-top:6px">+ Add a person</button></div>`;
    wizRenderProfiles();
  } else if(wizStep===2){
    const chosen=setupConfig.chosenGoals||[];
    const p=RICHIE_PERSONAS[setupConfig.persona]; const lv=LEVELS.find(l=>l.n===setupConfig.level);
    b.innerHTML=`<div class="wiz-success">
      <span class="richie e-idle" id="wizSuccessChar" style="font-size:64px">💰</span>
      <h2>Your plan is ready, ${esc(setupConfig.householdName||'friend')}!</h2>
      <p>I've built your app around <strong style="color:var(--green)">${chosen.length} goal${chosen.length!==1?'s':''}</strong> — a Goals home page plus a focused page with the right widgets for each.</p>
      <div class="wiz-goal-list">${chosen.map(g=>`<div class="wiz-goal-chip">${g.icon} ${g.name}</div>`).join('')||'<div style="color:var(--muted);font-size:13px">No goals picked — I will start you with a Goals page you can fill in.</div>'}</div>
      <div class="summary-row">
        <div class="summary-chip">Guide: <b>${p?p.icon+' '+p.name:'\u2014'}</b></div>
        <div class="summary-chip">Level: <b>${lv?lv.icon+' '+lv.name:'\u2014'}</b></div>
      </div>
      <p style="font-size:13px;color:var(--muted);line-height:1.55;margin-top:4px">Next: sign in to secure your plan. Once you're in, I'll connect your bank and walk you through each goal. \u{1F3E6}</p></div>`;
    setTimeout(()=>{ const el=gg('wizSuccessChar'); if(el){ const sc=spawnRichie(el); sc.do('celebrate'); } },120);
  }
}
function wizRenderProfiles(){
  const el=gg('wizProfiles'); if(!el)return; const cols=['#2ecc8a','#5b8def','#a78bfa','#f0a540'];
  el.innerHTML=setupConfig.profiles.map((p,i)=>`<div class="profile-row">
    <div class="profile-avatar-pick" style="background:${cols[i%4]}33;border-color:${cols[i%4]}" onclick="wizCycleAvatar(${i})">${p.avatar}</div>
    <input type="text" placeholder="Name (e.g. Alex)" value="${esc(p.name||'')}" oninput="setupConfig.profiles[${i}].name=this.value">
    ${setupConfig.profiles.length>1?`<button class="btn" onclick="wizRemoveProfile(${i})">\u2715</button>`:''}</div>`).join('');
}
function wizAddProfile(){if(setupConfig.profiles.length>=6)return;setupConfig.profiles.push({name:'',avatar:'💰'});wizRenderProfiles();}
function wizRemoveProfile(i){setupConfig.profiles.splice(i,1);wizRenderProfiles();}
function wizCycleAvatar(i){const a=['💰','😎','🧑','👩','🧔','👵','🦊','🐼','🤑','🧙'];const c=a.indexOf(setupConfig.profiles[i].avatar);setupConfig.profiles[i].avatar=a[(c+1)%a.length];wizRenderProfiles();}
function wizPickBundle(id){setupConfig.bundle=id;wizRenderBody();}
function wizToggleGoal(key){
  const g=GOAL_PRESETS.find(x=>x.key===key); if(!g) return;
  setupConfig.chosenGoals=setupConfig.chosenGoals||[];
  const i=setupConfig.chosenGoals.findIndex(c=>c.key===key);
  if(i>=0){ setupConfig.chosenGoals.splice(i,1); }
  else { if(setupConfig.chosenGoals.length>=3) return; setupConfig.chosenGoals.push({key:g.key,name:g.name,metric:g.metric,target:g.target,icon:g.icon,auto:g.auto}); }
  wizRenderBody();
}
function wizCustomGoalPrompt(){
  if((setupConfig.chosenGoals||[]).length>=3){ alert("Richie says: you've picked 3 already! Remove one to add a custom goal."); return; }
  const name=prompt("Name your custom goal (e.g. 'Save for a house'):"); if(!name) return;
  const amt=prompt("Target amount ($):","5000"); const target=parseFloat(amt)||0;
  setupConfig.chosenGoals=setupConfig.chosenGoals||[];
  setupConfig.chosenGoals.push({key:'custom'+Date.now(),name:name.trim(),metric:'custom',target,icon:'🎯'});
  wizRenderBody();
}
function wizBack(){if(wizStep>1)wizGoTo(wizStep-1);}
function wizNext(){
  if(wizStep===1){ if(!setupConfig.householdName.trim()){wizShake('wizHousehold');return;} if(!setupConfig.profiles.some(p=>p.name.trim())){alert("Richie says: give me at least one name!");return;} }
  if(wizStep===2){ wizFinish(); return; }
  wizGoTo(wizStep+1);
}
function wizShake(id){const el=gg(id);if(!el)return;el.style.borderColor='#f05c5c';el.animate([{transform:'translateX(0)'},{transform:'translateX(-6px)'},{transform:'translateX(6px)'},{transform:'translateX(0)'}],{duration:300});setTimeout(()=>el.style.borderColor='',800);}
/* ═══════════════════════════════════════════════════════════════
   AUTH (server login) + WELCOME-BACK SWOT
═══════════════════════════════════════════════════════════════ */
// The auth secret lives in an httpOnly cookie (set by /api/login) that page JS can't
// read. We only keep a non-secret "signed-in this session" flag for UI gating.
function setToken(t){ try{ SS.setItem('mdf_auth','1'); }catch(e){} }
function clearToken(){ try{ SS.removeItem('mdf_auth'); SS.removeItem('mdf_token'); }catch(e){} }
function isLoggedIn(){ return SS.getItem('mdf_auth')==='1'; }
function refreshEnvBadge(){
  const b=gg('envBadge'); if(!b) return;
  fetch('/api/health').then(r=>r.json()).then(d=>{
    const env=((d&&d.env)||'sandbox').toLowerCase();
    if(env==='production'){ b.style.display='none'; }
    else { b.style.display=''; b.textContent=env.charAt(0).toUpperCase()+env.slice(1); }
  }).catch(()=>{});
}
// ── Two-factor authentication (Settings) ──
let _2faSecret='', _2faOtpauth='';
async function render2faStatus(){
  const act=gg('twofaAction'), desc=gg('twofaDesc'); if(!act) return;
  act.innerHTML='<button class="btn" disabled>…</button>';
  let enabled=false, userLogin=true;
  try{ const r=await fetch('/api/2fa/status'); if(r.ok){ const d=await r.json(); enabled=!!d.enabled; userLogin=!!d.userLogin; } }catch(e){}
  if(!userLogin){ if(desc) desc.textContent='Create a username/password login first — 2FA protects that login.'; act.innerHTML=''; return; }
  if(enabled){
    if(desc) desc.innerHTML='✅ <b style="color:var(--green)">On</b> — you enter a code from your authenticator app each time you sign in.';
    act.innerHTML='<button class="btn danger-btn" onclick="open2faDisable()">Turn off</button>';
  } else {
    if(desc) desc.textContent='Require a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password) each time you sign in.';
    act.innerHTML='<button class="btn primary" onclick="open2faSetup()">Enable 2FA</button>';
  }
}
async function open2faSetup(){
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Enable two-factor';
  gg('manualSub').textContent='Scan the QR with your authenticator app, then enter the code to confirm.';
  gg('manualBody').innerHTML='<div class="ws-hint">Setting up…</div>';
  try{
    const r=await fetch('/api/2fa/setup',{method:'POST'});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){ gg('manualBody').innerHTML=`<div class="login-err">${esc(d.error||'Could not start setup.')}</div><div class="mf-actions"><span></span><button class="btn" onclick="closeManual()">Close</button></div>`; return; }
    _2faSecret=d.secret||''; _2faOtpauth=d.otpauth||'';
    render2faSetupBody();
  }catch(e){ gg('manualBody').innerHTML='<div class="login-err">Could not reach the server.</div>'; }
}
function render2faSetupBody(err){
  const grouped=(_2faSecret.match(/.{1,4}/g)||[]).join(' ');
  gg('manualBody').innerHTML=`
    <div style="text-align:center"><img id="twofaQr" alt="Two-factor QR code" width="180" height="180" style="background:#fff;border-radius:10px;padding:6px;image-rendering:pixelated"></div>
    <div class="ws-hint" style="text-align:center;margin:8px 0 4px">Can't scan? Type this key into your app instead:</div>
    <div style="text-align:center;font-family:var(--font);font-size:14px;font-weight:700;letter-spacing:.06em;word-break:break-all;color:var(--text);margin-bottom:12px">${esc(grouped)}</div>
    <label class="mf-label">6-digit code from your app</label>
    <input class="mf-in" id="twofaCode" inputmode="numeric" maxlength="6" placeholder="123456" style="text-align:center;letter-spacing:.3em;font-size:18px" onkeydown="if(event.key==='Enter')do2faEnable()">
    ${err?`<div class="login-err" style="margin-top:8px">${esc(err)}</div>`:''}
    <div class="mf-actions"><button class="btn" onclick="closeManual()">Cancel</button><button class="btn primary" onclick="do2faEnable()">Turn on 2FA</button></div>`;
  setTimeout(()=>{ const c=gg('twofaCode'); if(c) c.focus(); },80);
  try{ _loadScript('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js').then(()=>{
    try{ if(window.qrcode && _2faOtpauth){ const qr=qrcode(0,'M'); qr.addData(_2faOtpauth); qr.make(); const img=gg('twofaQr'); if(img) img.src=qr.createDataURL(4,10); } }catch(e){}
  }).catch(()=>{}); }catch(e){}
}
async function do2faEnable(){
  const code=(gg('twofaCode').value||'').trim();
  if(!/^\d{6}$/.test(code)){ render2faSetupBody('Enter the 6-digit code.'); return; }
  try{
    const r=await fetch('/api/2fa/enable',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){ render2faSetupBody(d.error||"That code didn't match — check your device's clock and try again."); return; }
    closeManual(); render2faStatus(); if(sbRichie)sbRichie.do('tada'); try{ richieSay('Two-factor is on — your account just got a lot harder to break into. 🛡️'); }catch(e){}
  }catch(e){ render2faSetupBody('Could not reach the server.'); }
}
function open2faDisable(){
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Turn off two-factor';
  gg('manualSub').textContent='Confirm your password to turn 2FA off.';
  gg('manualBody').innerHTML=`
    <label class="mf-label">Password</label>
    <input class="mf-in" id="twofaOffPw" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')do2faDisable()">
    <div class="login-err" id="twofaOffErr" style="margin-top:8px"></div>
    <div class="mf-actions"><button class="btn" onclick="closeManual()">Cancel</button><button class="btn danger-btn" onclick="do2faDisable()">Turn off 2FA</button></div>`;
  setTimeout(()=>{ const el=gg('twofaOffPw'); if(el) el.focus(); },80);
}
async function do2faDisable(){
  const pw=gg('twofaOffPw').value; const err=gg('twofaOffErr'); if(err) err.textContent='';
  try{
    const r=await fetch('/api/2fa/disable',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){ if(err) err.textContent=d.error||'Password incorrect.'; return; }
    closeManual(); render2faStatus();
  }catch(e){ if(err) err.textContent='Could not reach the server.'; }
}
// ── Change password (Settings) ──
function openChangePassword(){
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='Change password';
  gg('manualSub').textContent='Enter your current password and choose a new one.';
  gg('manualBody').innerHTML=
    '<div class="cpw-form">'
    +'<input type="password" class="mf-in" id="cpwCur" placeholder="Current password" autocomplete="current-password">'
    +'<input type="password" class="mf-in" id="cpwNew" placeholder="New password (8+ characters)" autocomplete="new-password">'
    +'<input type="password" class="mf-in" id="cpwNew2" placeholder="Confirm new password" autocomplete="new-password">'
    +'<div class="login-err" id="cpwErr"></div>'
    +'<div id="cpwRecovery" class="login-recovery" style="display:none"></div>'
    +'</div>'
    +'<div class="mf-actions"><button class="btn" onclick="closeManual()">Cancel</button><button class="btn primary" id="cpwBtn" onclick="doChangePassword()">Update password</button></div>';
  setTimeout(()=>{ const el=gg('cpwCur'); if(el) el.focus(); },80);
}
async function doChangePassword(){
  const cur=gg('cpwCur').value, nw=gg('cpwNew').value, nw2=gg('cpwNew2').value;
  const err=gg('cpwErr'), btn=gg('cpwBtn'); err.textContent='';
  if(nw.length<8){ err.textContent='New password must be at least 8 characters.'; return; }
  if(nw!==nw2){ err.textContent='New passwords don\u2019t match.'; return; }
  btn.disabled=true; btn.textContent='Updating…';
  try{
    const r=await fetch('/api/change_password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current:cur,new:nw})});
    const d=await r.json().catch(()=>({}));
    btn.disabled=false; btn.textContent='Update password';
    if(!r.ok || !d.ok){ err.textContent=d.error||'Could not update your password.'; return; }
    const rb=gg('cpwRecovery');
    ['cpwCur','cpwNew','cpwNew2'].forEach(id=>{ const el=gg(id); if(el) el.value=''; });
    if(rb){ rb.style.display='block'; rb.innerHTML='<div class="lrec-h">✅ Password updated · new recovery code</div><div class="lrec-code">'+esc(d.recovery_code)+'</div><div class="lrec-note">Your old recovery code no longer works. Save this new one somewhere safe.</div><button class="btn primary" style="width:100%;margin-top:10px" onclick="closeManual()">Done</button>'; }
  }catch(e){ btn.disabled=false; btn.textContent='Update password'; err.textContent='Could not reach the server. Try again.'; }
}

// Wrap fetch so every /api/ call carries the Bearer token automatically.
(function installAuthFetch(){
  const _fetch=window.fetch.bind(window);
  window.fetch=function(url,opts){
    opts=opts||{};
    if(typeof url==='string' && url.indexOf('/api/')===0){
      opts.credentials=opts.credentials||'same-origin';   // send the httpOnly auth cookie
      const tok=authToken();
      if(tok){ opts.headers=Object.assign({}, opts.headers||{}, {'Authorization':'Bearer '+tok}); }
    }
    return _fetch(url,opts);
  };
})();

let _loginMode='signin';
function setLoginMode(m){
  _loginMode=m;
  if(_await2fa){ _await2fa=false; _pending2fa=null; const f=gg('login2fa'); if(f){ f.style.display='none'; f.value=''; } const b=gg('loginBtn'); if(b) b.textContent='Sign in'; ['loginUser','loginPass'].forEach(id=>{ const el=gg(id); if(el) el.style.display=''; }); }
  const err=gg('loginErr'); if(err) err.textContent='';
  const show=(id,on)=>{ const el=gg(id); if(el) el.style.display=on?'':'none'; };
  const rb=gg('loginRecoveryBox'); if(rb){ rb.style.display='none'; rb.innerHTML=''; }
  show('loginPass2', m==='create');
  show('loginRecovery', m==='forgot');
  show('loginForgotLink', m==='signin');
  show('loginBackLink', m==='forgot');
  const scr=gg('loginScreen'), title=scr&&scr.querySelector('.login-title'), sub=gg('loginSub'), btn=gg('loginBtn'), pass=gg('loginPass');
  if(m==='create'){
    if(title) title.textContent='Create your login';
    if(sub) sub.textContent='Set a username and password to secure your dashboard.';
    if(btn) btn.textContent='Create login';
    if(pass){ pass.placeholder='Password (8+ characters)'; pass.setAttribute('autocomplete','new-password'); }
  } else if(m==='forgot'){
    if(title) title.textContent='Reset password';
    if(sub) sub.textContent='Enter your username, recovery code, and a new password.';
    if(btn) btn.textContent='Reset password';
    if(pass){ pass.placeholder='New password (8+ characters)'; pass.setAttribute('autocomplete','new-password'); }
  } else {
    if(title) title.textContent='Welcome back';
    if(sub) sub.textContent="Richie's been keeping an eye on things. Sign in to see where you stand.";
    if(btn) btn.textContent='Sign in';
    if(pass){ pass.placeholder='Password'; pass.setAttribute('autocomplete','current-password'); }
  }
}
async function initLoginScreen(){
  try{ const r=await fetch('/api/auth_status'); const d=await r.json().catch(()=>({})); setLoginMode(d&&d.configured?'signin':'create'); }
  catch(e){ setLoginMode('signin'); }
}
function _afterAuthedEnter(){
  gg('loginScreen').style.display='none';
  ['loginPass','loginPass2','loginRecovery'].forEach(id=>{ const el=gg(id); if(el) el.value=''; });
  setToken(1);
  showLoader('Loading your money world…');
  loadEngineData().then(()=>runWelcomeBack());
}
function _showRecovery(code,contLabel){
  const rb=gg('loginRecoveryBox'); if(!rb) return;
  rb.style.display='block';
  rb.innerHTML='<div class="lrec-h">🔑 Save your recovery code</div><div class="lrec-code">'+esc(code)+'</div><div class="lrec-note">This is the only way to reset your password if you forget it. Store it somewhere safe — you won\u2019t see it again.</div><button class="btn primary" style="width:100%;margin-top:10px" onclick="_afterAuthedEnter()">'+(contLabel||'I saved it — continue')+'</button>';
}
let _await2fa=false, _pending2fa=null;
function _show2fa(on){
  ['loginUser','loginPass','loginForgotLink'].forEach(id=>{ const el=gg(id); if(el) el.style.display=on?'none':''; });
  const f=gg('login2fa'); if(f) f.style.display=on?'block':'none';
  const back=gg('loginBackLink'); if(back && on) back.style.display='inline';
  const sub=gg('loginSub'); if(sub) sub.textContent=on?'Two-factor is on — enter the 6-digit code from your authenticator app.':"Richie's been keeping an eye on things. Sign in to see where you stand.";
}
async function doLogin(){
  if(_loginMode==='create') return doCreateLogin();
  if(_loginMode==='forgot') return doResetPassword();
  const err=gg('loginErr'), btn=gg('loginBtn');
  err.textContent='';
  let u, p, code='';
  if(_await2fa && _pending2fa){ u=_pending2fa.u; p=_pending2fa.p; code=(gg('login2fa').value||'').trim(); if(!code){ err.textContent='Enter the 6-digit code from your authenticator.'; return; } }
  else { u=gg('loginUser').value.trim(); p=gg('loginPass').value; if(!u||!p){ err.textContent='Enter your username and password.'; return; } }
  btn.disabled=true; btn.textContent=_await2fa?'Verifying…':'Signing in…';
  let loginRichie=window._loginRichie;
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p,code})});
    const d=await r.json().catch(()=>({}));
    if(d.needs2fa && !d.ok){   // password OK, second factor required (or the code was wrong)
      _await2fa=true; _pending2fa={u,p}; _show2fa(true);
      err.textContent = code ? (d.error||"That code didn't match — try again.") : '';
      btn.disabled=false; btn.textContent='Verify code';
      const f=gg('login2fa'); if(f){ f.value=''; try{ f.focus(); }catch(e){} }
      if(code && loginRichie) loginRichie.emotion('no');
      return;
    }
    if(!r.ok || (!d.token && !d.ok)){
      err.textContent=d.error||'Wrong username or password.';
      btn.disabled=false; btn.textContent=_await2fa?'Verify code':'Sign in';
      if(loginRichie) loginRichie.emotion('no');
      return;
    }
    _await2fa=false; _pending2fa=null; _show2fa(false); const _f2=gg('login2fa'); if(_f2) _f2.value='';
    if(d.token || d.ok || d.success){ setToken(1); try{ SS.setItem('mdf_user',u); }catch(e){} }
    gg('loginScreen').style.display='none';
    gg('loginPass').value='';
    showLoader('Loading your money world…');
    // Storage-cleared device (no local world): restore the household state from the server
    // BEFORE entering, so enterApp's loadState finds the real dashboard instead of seeding a
    // blank one and re-triggering the Richie-build gate.
    try{
      if(!LS.getItem('richie_app')){
        const sd=await _fetchJSON('/api/state');
        if(sd && sd.state){ syncApplyToLS(sd.state); if(sd.state._ts) LS.setItem('mdf_sync_ts', String(sd.state._ts)); }
      }
    }catch(e){}
    btn.disabled=false; btn.textContent='Sign in';
    // Nothing local AND nothing on the server (fresh household, or right after a full
    // reset): this login has no world to restore — run onboarding instead of silently
    // seeding the generic default dashboard (which also skipped Richie's first build).
    if(!LS.getItem('richie_app') && !LS.getItem('richie_setup')){ hideLoader(); runIntro(); return; }
    await loadEngineData();
    runWelcomeBack();
  }catch(e){
    err.textContent='Could not reach the server. Try again.';
    btn.disabled=false; btn.textContent='Sign in';
  }
}
async function doCreateLogin(){
  const u=gg('loginUser').value.trim(), p=gg('loginPass').value, p2=gg('loginPass2').value;
  const err=gg('loginErr'), btn=gg('loginBtn'); err.textContent='';
  if(u.length<3){ err.textContent='Username must be at least 3 characters.'; return; }
  if(p.length<8){ err.textContent='Password must be at least 8 characters.'; return; }
  if(p!==p2){ err.textContent='Passwords don\u2019t match.'; return; }
  btn.disabled=true; btn.textContent='Creating…';
  try{
    const r=await fetch('/api/set_password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const d=await r.json().catch(()=>({}));
    btn.disabled=false; btn.textContent='Create login';
    if(!r.ok || !d.ok){ err.textContent=d.error||'Could not create your login.'; return; }
    try{ SS.setItem('mdf_user',u); }catch(e){}
    _showRecovery(d.recovery_code,'I saved it — enter my dashboard');
  }catch(e){ btn.disabled=false; btn.textContent='Create login'; err.textContent='Could not reach the server. Try again.'; }
}
async function doResetPassword(){
  const u=gg('loginUser').value.trim(), code=gg('loginRecovery').value.trim(), p=gg('loginPass').value;
  const err=gg('loginErr'), btn=gg('loginBtn'); err.textContent='';
  if(!u||!code){ err.textContent='Enter your username and recovery code.'; return; }
  if(p.length<8){ err.textContent='New password must be at least 8 characters.'; return; }
  btn.disabled=true; btn.textContent='Resetting…';
  try{
    const r=await fetch('/api/reset_password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,recovery_code:code,new_password:p})});
    const d=await r.json().catch(()=>({}));
    btn.disabled=false; btn.textContent='Reset password';
    if(!r.ok || !d.ok){ err.textContent=d.error||'Could not reset your password.'; return; }
    try{ SS.setItem('mdf_user',u); }catch(e){}
    _showRecovery(d.recovery_code,'I saved it — enter my dashboard');
  }catch(e){ btn.disabled=false; btn.textContent='Reset password'; err.textContent='Could not reach the server. Try again.'; }
}

function showLogin(greet){
  gg('appShell').style.display='none';
  gg('richieAssistant').style.display='none';
  gg('welcomeBack').style.display='none';
  gg('loginScreen').style.display='flex';
  if(greet){ setLoginMode('signin'); gg('loginSub').textContent=greet; }
  else { initLoginScreen(); }
  if(!window._loginRichie) window._loginRichie=spawnRichie(gg('loginRichie'));
  setTimeout(()=>{ if(window._loginRichie) window._loginRichie.wave(); },300);
  setTimeout(()=>{ const el=gg('loginUser'); if(el) el.focus(); },400);
}

// Build a SWOT snapshot from live Plaid data, falling back to bills/income.
function buildSWOT(){
  const live=dataLoaded;
  const S=[],W=[],O=[],T=[];
  const nw = live ? (engNetBalance()+engNWAssets()-engNWLiab()) : engNetWorth();
  const monthlyIncome=engMonthlyIncome(), monthlyBills=engMonthlyBills();
  // Debt split — credit cards (the high-APR priority) vs long-term installment
  // (mortgage/auto/HELOC). Keeps the SWOT from framing the whole unattainable pile as one fight.
  const grp = (live && typeof engDebtGroups==='function') ? engDebtGroups() : null;
  const liabCards = (plaidLiabilities&&plaidLiabilities.credit_cards)||[];
  const ccDebt = grp ? grp.revTotal
                : liabCards.length ? liabCards.reduce((s,c)=>s+Math.abs(c.current_balance||0),0)
                : bills.filter(b=>b.cat==='CC').reduce((s,b)=>s+Math.abs(b.bal||0),0);
  const longTermDebt = grp ? grp.instTotal : 0;
  const focusItems = grp ? grp.focusItems : [];
  const focusTotal = grp ? grp.focusTotal : ccDebt;
  const highApr = grp ? grp.revolving.filter(c=>(c.apr||0)>=25)
                : liabCards.length ? liabCards.filter(c=>(c.apr||0)>=25)
                : bills.filter(b=>b.apr>=25&&b.bal<0);
  const totalDebt = live ? engTotalDebt() : engBillsDebt();
  // Concrete payoff nudge: extra $/mo to clear the focus set (default CC) in ~2 years.
  const _fBal=focusItems.reduce((s,x)=>s+Math.abs(x.bal||0),0);
  const _wApr=_fBal>0?focusItems.reduce((s,x)=>s+Math.abs(x.bal||0)*(x.apr||0),0)/_fBal:0;
  const _curPay=focusItems.reduce((s,x)=>s+(x.pay||x.min||0),0);
  const _r=_wApr/100/12; const _pmt24=focusTotal>0?(_r<=0?focusTotal/24:focusTotal*_r/(1-Math.pow(1+_r,-24))):0;
  const _extra=Math.max(0, Math.ceil(_pmt24)-_curPay);
  // Strengths
  if(nw>0) S.push(`Net worth is positive at ${fmtM(nw)}.`);
  if(monthlyIncome>monthlyBills) S.push(`Income (${fmtK(monthlyIncome)}/mo) covers your bills (${fmtK(monthlyBills)}/mo).`);
  const cushion=monthlyIncome-monthlyBills;
  if(cushion>0) S.push(`You have ${fmtK(cushion)}/mo of breathing room after fixed bills.`);
  if(longTermDebt>0 && longTermDebt>=ccDebt) S.push(`Most of your debt is long-term & lower-rate (${fmtM(longTermDebt)} mortgage/auto/HELOC) — steady, not the fire to fight first.`);
  if(!S.length) S.push(`You're here and looking — that's the first win.`);
  // Weaknesses — credit cards are the priority, called out on their own
  if(ccDebt>0) W.push(`${fmtK(ccDebt)} in credit-card debt — your highest-rate balances and the payoff to prioritize.`);
  if(highApr.length) W.push(`${highApr.length} card${highApr.length>1?'s':''} above 25% APR draining cash.`);
  if(cushion<=0) W.push(`Bills eat all of your income — no monthly cushion.`);
  if(!W.length) W.push(`Nothing major — keep the momentum.`);
  // Opportunities
  if(focusTotal>0 && _extra>0) O.push(`Add ~${fmtK(_extra)}/mo to your ${grp&&!_focusIsCC(grp)?'focus':'card'} payoff and you're clear in about 2 years.`);
  else if(focusTotal>0) O.push(`You're already on pace to clear your priority payoff — keep it up.`);
  if(cushion>200) O.push(`Auto-invest part of that ${fmtK(cushion)}/mo cushion toward FIRE.`);
  const promo=bills.filter(b=>b.promo&&/0%/.test(b.promo));
  if(promo.length) O.push(`${promo.length} balance${promo.length>1?'s are':' is'} on 0% promos — pay them before the rate jumps.`);
  if(!O.length) O.push(`Set one money goal this month and let's track it.`);
  // Threats
  if(highApr.length) T.push(`High-APR balances grow fast if left unpaid.`);
  if(promo.length) T.push(`Promo APRs expire — missing the window means back-interest.`);
  if(!live) T.push(`No bank connected yet — these numbers are from your manual data.`);
  if(!T.length) T.push(`Watch for lifestyle creep as income grows.`);
  return {S,W,O,T,nw};
}

function runWelcomeBack(){
  try{ hideLoader(); }catch(e){}
  gg('welcomeBack').style.display='flex';
  const stars=gg('wbStars'); if(stars){ let s=''; for(let i=0;i<30;i++) s+=`<div class="ri-star" style="left:${Math.random()*100}%;top:${Math.random()*100}%;--dur:${2+Math.random()*3}s;--delay:${Math.random()*3}s"></div>`; stars.innerHTML=s; }
  const wb=spawnRichie(gg('wbRichie')); window._wbRichie=wb;
  wb.do('bounce');
  const name=(JSON.parse(LS.getItem('richie_setup')||'{}').householdName)||(APP&&APP.household)||'friend';
  const swot=buildSWOT();
  const greet=`Welcome back! Here's your money SWOT — a quick read on where ${name} stands today.`;
  const el=gg('wbText'); el.innerHTML='';
  richieSpeakType(el, greet, ()=>{ wb.talk(false); showSwotPanel(swot); });   // SWOT only — no daily tip
  wb.talk(true);
}
function suggestDailyTask(swot){
  try{ const bills=(engUpcomingBills()||[]).filter(b=>!b.paid);
    if(bills.length){ return `You've got ${bills.length} bill${bills.length>1?'s':''} coming up — check them and mark anything you've already paid.`; } }catch(e){}
  try{ if(!APP.plaidConnected && !dataLoaded){ return `Connect a bank so I can coach you with your real, live numbers.`; } }catch(e){}
  if(swot&&swot.O&&swot.O.length) return `Today's move: ${swot.O[0]}`;
  if(swot&&swot.W&&swot.W.length) return `One thing worth a look today: ${swot.W[0]}`;
  return `Open your top goal and log one small win today.`;
}
async function wbDailyTask(swot, greet){
  if(gg('welcomeBack').style.display==='none') return;     // already moved to the app — don't speak
  let task=suggestDailyTask(swot);
  try{
    const res=await fetch('/api/coach',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ context:{ screen:'Welcome / daily SWOT', ask:'Suggest ONE concrete task the user should do today', swot:{S:swot.S,W:swot.W,O:swot.O,T:swot.T}, netWorth:swot.nw }, persona:(APP&&APP.persona)||'coach', level:(APP&&APP.level)||1, seen:[] })});
    if(res.ok){ const j=await res.json(); if(j&&j.tip) task=j.tip.trim(); }
  }catch(e){}
  if(gg('welcomeBack').style.display==='none') return;     // left during the fetch — stay silent
  const el=gg('wbText');
  el.innerHTML = esc(greet||el.textContent) + `<br><br><span style="color:var(--green);font-weight:700">🎯 Today: </span>${esc(task)}`;
  if(window._wbRichie) window._wbRichie.do('point');
  if(typeof riAudioOn!=='undefined'&&riAudioOn) riSpeak("And here's a task for today. "+task);
}
function showSwotPanel(swot){
  const sec=(title,items,color,icon)=>`<div class="swot-cell"><div class="swot-head" style="color:${color}">${icon} ${title}</div><ul>${items.map(x=>`<li>${x}</li>`).join('')}</ul></div>`;
  const el=gg('wbSwot');
  el.innerHTML=
    sec('Strengths',swot.S,'#2ecc8a','💪')+
    sec('Weaknesses',swot.W,'#f05c5c','⚠️')+
    sec('Opportunities',swot.O,'#5b8def','🚀')+
    sec('Threats',swot.T,'#f0a540','🛡️');
  el.style.display='grid';
  gg('wbContinue').style.display='inline-block';
  if(window._wbRichie) window._wbRichie.emotion('proud');
}
function wbEnter(){
  richieStopAllSpeech();              // stop the SWOT greeting/voice the moment you move on
  _raSnoozeUntil=0; _raLastPop=0;     // the first app screen greets right away (no fixed hold)
  gg('welcomeBack').style.display='none';
  Promise.resolve(enterApp()).then(()=>{ setTimeout(()=>{ try{ updateReviewBadge(); }catch(e){} try{ maybeShowBriefing(); }catch(e){} }, 550); });
}

/* ═══════════════ MONEY TO-DO BRIEFING (post-SWOT pop-out) ═══════════════
   A centered Richie pop-out (goal-completion style) that surfaces the handful of things worth
   handling first thing: confirm new transactions are categorized (inline), plus prioritized
   action items. "New since last visit" is tracked with richie_lastvisit; the cutoff advances
   when the briefing is closed. */
let _briefChar=null, _briefTxns=[], _briefBills=[], _briefSteps=[], _briefStep=0, _confirmedTxns=null;
function _briefCutoff(){ let v=0; try{ v=parseInt(LS.getItem('richie_lastvisit')||'0',10); }catch(e){} return (isFinite(v)&&v>0)?v:(Date.now()-7*86400000); }
function _markBriefingSeen(){ try{ LS.setItem('richie_lastvisit', String(Date.now())); }catch(e){} }
function _newTxns(){ const cut=new Date(_briefCutoff()); const ex=(typeof _excludedAcctIds==='function')?_excludedAcctIds():new Set();
  // Freshly-imported transactions (last 3 days) are reviewable even when their CSV dates are old.
  const recentImports=new Set((APP.imports||[]).filter(im=>im&&im.txnImportId&&(Date.now()-(im.ts||0))<3*86400000).map(im=>im.txnImportId));
  return (allTxns||[]).filter(t=> t && !ex.has(t.account_id) && (new Date((t.date||'')+'T12:00:00')>=cut || (t._importId && recentImports.has(t._importId))))
    .sort((a,b)=> new Date(b.date)-new Date(a.date)); }
// Transactions the user hasn't explicitly confirmed yet (auto-categories may be wrong, so we
// ask them to review each — even ones that already have a category). Persisted in mdf_txn_confirmed.
function _confSet(){ if(_confirmedTxns) return _confirmedTxns; _confirmedTxns=new Set(); try{ const a=JSON.parse(LS.getItem('mdf_txn_confirmed')||'[]'); if(Array.isArray(a)) a.forEach(k=>_confirmedTxns.add(k)); }catch(e){} return _confirmedTxns; }
function _confSave(){ try{ LS.setItem('mdf_txn_confirmed', JSON.stringify(Array.from(_confSet()))); }catch(e){} }
function _reviewTxns(){ const conf=_confSet(); return _newTxns().filter(t=>!conf.has(_txnKey(t))).slice(0,25); }
function _billsDueSoon(){ const today=new Date().getDate();
  return (engUpcomingBills()||[]).filter(b=>!b.paid && b.pay>0).map(b=>{ let d=(b.due||1)-today; if(d<0) d+=30; return Object.assign({}, b, {inDays:d}); }).filter(b=>b.inDays<=7).sort((a,b)=>a.inDays-b.inDays); }
function _scoreStale(){ const h=(typeof _ccScores==='function')?_ccScores():[]; if(!h.length) return {stale:true, days:null};
  const last=h.slice().sort((a,b)=>a.d<b.d?1:-1)[0]; const days=Math.round((Date.now()-new Date(last.d+'T12:00:00'))/86400000); return {stale:days>30, days}; }

// ── The transaction-review step (select category, then Confirm each) ──
function _briefTxnStepBody(){
  const list=_reviewTxns(); _briefTxns=list;
  if(!list.length) return `<div class="brief-allclear">✅ All caught up — every recent transaction is confirmed.</div>`;
  const cats=getUserCategories().filter(c=>!c.group).map(c=>c.label);
  const rows=list.map((t,i)=>{
    const name=t.merchant_name||t.name||'Transaction', pos=t.amount>0, amt=(pos?'-':'+')+fmt2(Math.abs(t.amount));
    const dt=new Date((t.date||'')+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
    const cat=getTxnCategory(t); const catList=cats.includes(cat)?cats:[cat].concat(cats);
    const opts=catList.map(c=>`<option value="${esc(c)}"${c===cat?' selected':''}>${esc(c)}</option>`).join('');
    return `<div class="brief-txn"><div class="brief-txn-main"><div class="brief-txn-nm">${esc(name)}</div><div class="brief-txn-meta">${dt} · <b style="color:${pos?'var(--red)':'var(--pos)'}">${amt}</b>${t.institution?' · '+esc(t.institution):''}</div></div><select class="txn-cat-sel" onclick="event.stopPropagation()" onchange="briefTxnCat(${i},this.value)">${opts}</select><button class="brief-confirm" onclick="event.stopPropagation();briefConfirm(${i})">Confirm ✓</button></div>`;
  }).join('');
  return `<div class="brief-txns-hd"><span>${list.length} to review — fix any wrong category, then Confirm</span><button class="brief-confirm-all" onclick="event.stopPropagation();briefConfirmAll()">Confirm all ✓</button></div><div class="brief-txns">${rows}</div>`;
}
function briefTxnCat(i,cat){ const t=_briefTxns[i]; if(!t||!cat) return; const k=_txnKey(t); _catOverrides[k]=cat; try{ LS.setItem('mdf_cat_overrides',JSON.stringify(_catOverrides)); }catch(e){} }   // change now; stays until Confirmed
function briefConfirm(i){ const t=_briefTxns[i]; if(!t) return; _confSet().add(_txnKey(t)); _confSave(); try{ gamiMarkEngaged('confirm'); }catch(e){} if(_briefChar)_briefChar.do('nod'); _briefRefreshBody(); }
function briefConfirmAll(){ (_briefTxns||[]).forEach(t=>_confSet().add(_txnKey(t))); _confSave(); try{ gamiMarkEngaged('confirm'); }catch(e){} if(_briefChar)_briefChar.do('tada'); _briefRefreshBody(); }

// ── High-interest debt step (pay a little extra toward the top-APR card, inline) ──
function _topHiCard(){ try{ const g=engDebtGroups(); const all=[...g.revolving,...g.installment].filter(b=>Math.abs(b.bal||0)>0 && (b.cat==='CC'||(b.apr||0)>=8)); all.sort((a,b)=>(b.apr||0)-(a.apr||0)); return all[0]||null; }catch(e){ return null; } }
function _briefHidebtStepBody(){
  const b=_topHiCard();
  if(!b) return `<div class="brief-allclear">✅ No high-interest debt right now — keep it up.</div>`;
  const cur=Math.round((((_billOverrides()[billKey(b)]||{}).pay)) ?? (b.pay||0));
  return `<div class="brief-mini">
    <div class="brief-actdesc">Top target: <b>${esc(b.name)}</b>${b.apr?` · ${b.apr.toFixed(1)}% APR`:''} · paying ${fmtK(cur)}/mo</div>
    <div class="brief-mini-row"><span>Add extra this month</span><div class="brief-pay"><span>$</span><input id="brHiExtra" type="number" min="0" step="10" value="50" onclick="event.stopPropagation()"></div><button class="brief-confirm" onclick="event.stopPropagation();briefPayExtra()">Apply ✓</button></div>
    <button class="brief-goto brief-goto-sm" onclick="event.stopPropagation();briefGoto('fund_triage')">Plan it all in Extra Funds Triage →</button>
  </div>`;
}
function briefPayExtra(){
  const e=gg('brHiExtra'); const amt=Math.round(parseFloat((e&&e.value)||'')||0); if(!(amt>0)) return;
  const b=_topHiCard(); if(!b) return; const key=billKey(b);
  const cur=(((_billOverrides()[key]||{}).pay)) ?? (b.pay||0);
  setBillPay(key, cur+amt); saveState(); try{ _memoInvalidate(); }catch(e){}
  if(_briefChar)_briefChar.do('tada');
  const body=gg('briefStepBody'); if(body) body.innerHTML=`<div class="brief-allclear">✅ Bumped ${esc(b.name)} to ${fmtK(cur+amt)}/mo (${fmtK(amt)} extra). That's a guaranteed return.</div>`;
}
// ── Emergency-fund step (add to a savings bucket, inline) ──
function _emergencyBucket(){ try{ const bs=_savingsBuckets(); return bs.find(b=>!b.acctId && /emer|reserve|safety|rainy/i.test(b.name||'')) || bs.find(b=>!b.acctId) || null; }catch(e){ return null; } }
function _briefEmergencyStepBody(){
  const b=_emergencyBucket(); const ef=(typeof engEmergencyFund==='function')?engEmergencyFund():0;
  return `<div class="brief-mini">
    <div class="brief-actdesc">You're at ${fmtK(ef)} of a $1,000 starter buffer.</div>
    ${b?`<div class="brief-mini-row"><span>Add to ${esc(b.name)}</span><div class="brief-pay"><span>$</span><input id="brEmAmt" type="number" min="0" step="10" value="50" onclick="event.stopPropagation()"></div><button class="brief-confirm" onclick="event.stopPropagation();briefAddEmergency()">Add ✓</button></div>`:`<div class="brief-actdesc" style="color:var(--muted)">Set up a savings bucket to track it.</div>`}
    <button class="brief-goto brief-goto-sm" onclick="event.stopPropagation();briefGoto('savings_buckets')">Open Savings Buckets →</button>
  </div>`;
}
function briefAddEmergency(){
  const e=gg('brEmAmt'); const amt=Math.round(parseFloat((e&&e.value)||'')||0); if(!(amt>0)) return;
  const b=_emergencyBucket(); if(!b) return;
  b.balance=(+b.balance||0)+amt; saveState(); try{ _memoInvalidate(); }catch(e){}
  if(_briefChar)_briefChar.do('tada');
  const body=gg('briefStepBody'); if(body) body.innerHTML=`<div class="brief-allclear">✅ Added ${fmtK(amt)} to ${esc(b.name)}. Every bit builds the buffer.</div>`;
}

// ── Bills step (mark paid / edit amount inline) ──
function _briefBillsStepBody(){
  const bds=_billsDueSoon(); _briefBills=bds;
  if(!bds.length) return `<div class="brief-allclear">✅ Nothing due in the next 7 days — you're ahead of it.</div>`;
  const rows=bds.map((b)=>{
    const key=billKey(b).replace(/'/g,"\\'");
    const due=b.inDays===0?'due today':'in '+b.inDays+'d';
    return `<div class="brief-txn"><div class="brief-txn-main"><div class="brief-txn-nm">${esc(b.name)}</div><div class="brief-txn-meta">${due}${b.apr?' · '+b.apr.toFixed(1)+'%':''}</div></div><div class="brief-pay"><span>$</span><input type="number" min="0" step="10" value="${Math.round(b.pay||0)}" onclick="event.stopPropagation()" oninput="setBillPay('${key}',this.value)"></div><button class="brief-confirm" onclick="event.stopPropagation();briefPayBill('${key}')">Mark paid ✓</button></div>`;
  }).join('');
  return `<div class="brief-txns-hd"><span>${bds.length} due · ${fmtK(bds.reduce((s,b)=>s+(b.pay||0),0))} total</span></div><div class="brief-txns">${rows}</div><button class="brief-goto brief-goto-sm" onclick="event.stopPropagation();briefGoto('bills_list')">Open the full Bills widget →</button>`;
}
function briefPayBill(key){ const ov=_billOverrides(); ov[key]=ov[key]||{}; ov[key].paid=true; saveState(); try{ _memoInvalidate(); }catch(e){} if(_briefChar)_briefChar.do('nod'); _briefRefreshBody(); }

// ── Credit-score step (log it inline) ──
function _briefScoreStepBody(){
  const today=new Date().toISOString().slice(0,10);
  const last=(typeof _ccScores==='function')?_ccScores().slice().sort((a,b)=>a.d<b.d?1:-1)[0]:null;
  return `<div class="brief-score">
    <div class="brief-score-row"><label>Score</label><input id="brScoreVal" type="number" min="300" max="850" inputmode="numeric" placeholder="300–850" onclick="event.stopPropagation()"></div>
    <div class="brief-score-row"><label>Date</label><input id="brScoreDate" type="date" value="${today}" onclick="event.stopPropagation()"></div>
    <button class="brief-confirm brief-confirm-wide" onclick="event.stopPropagation();briefSaveScore()">Save score ✓</button>
    ${last?`<div class="brief-actdesc">Last logged: <b>${last.v}</b> on ${esc(last.d)}</div>`:''}
    <button class="brief-goto brief-goto-sm" onclick="event.stopPropagation();briefGoto('debt_hub','score')">Open score history →</button>
  </div>`;
}
function briefSaveScore(){
  const ve=gg('brScoreVal'), de=gg('brScoreDate');
  const v=Math.round(parseFloat((ve&&ve.value)||'')||0); const d=((de&&de.value)||'').trim();
  if(!(v>=300&&v<=850)){ try{ ve&&ve.focus(); }catch(e){} return; }
  if(!d) return;
  const list=_ccScores(); const i=list.findIndex(x=>x.d===d); if(i>=0) list[i]={d,v}; else list.push({d,v}); list.sort((a,b)=>a.d<b.d?-1:1);
  saveState(); if(_briefChar)_briefChar.do('tada');
  const body=gg('briefStepBody'); if(body) body.innerHTML=`<div class="brief-allclear">✅ Logged ${v}. I'll watch the trend for you — nice.</div>`;
}
// Guarantee a deep link lands on the right widget: add it to a page if it isn't anywhere yet,
// and pre-select the debt-hub tab (promo / score) so you arrive exactly where you need to be.
function _ensureWidgetOnPage(type){
  let id=_pageWithWidget(type); if(id) return id;
  const pg=(APP.pages||[]).find(p=>p.id===APP.activePage)||(APP.pages||[])[0]; if(!pg) return null;
  try{ pg.widgets=pg.widgets||[]; pg.widgets.push(makeWidget(type)); saveState(); }catch(e){}
  return pg.id;
}

// ── The prioritized action steps (each with a Richie line + optional deep link) ──
function _briefActionItems(){
  const items=[];
  const bds=_billsDueSoon();
  if(bds.length){ const tot=bds.reduce((s,b)=>s+(b.pay||0),0);
    items.push({ id:'bills', icon:'📋', title:'Bills due this week', say:`Heads up — ${bds.length} bill${bds.length>1?'s':''} (${fmtK(tot)}) ${bds.length>1?'are':'is'} due within 7 days. Want to look them over?`,
      sub:`${bds.slice(0,4).map(b=>esc(b.name)+' · '+(b.inDays===0?'today':'in '+b.inDays+'d')).join('<br>')}`, action:{label:'Review bills', go:'bills_list'} }); }
  try{ const p=engCashFlowProjection(30); if(p.low.bal<0){ const when=p.low.day===0?'today':_projDate(p.low.day).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    items.push({ id:'shortfall', icon:'⚠️', title:'A shortfall is coming', say:`Careful — I'm projecting your balance dips to ${fmtK(p.low.bal)} on ${when}. Let's head it off.`, sub:`Move income earlier or trim a bill in the planner.`, action:{label:'Open planner', go:'cashflow_planner'} }); } }catch(e){}
  let promos=[]; try{ promos=(engPromos()||[]).filter(p=>p.bal>0.5 && p.days>=0 && p.days<=45); }catch(e){}
  if(promos.length){ const soon=promos.slice().sort((a,b)=>a.days-b.days)[0];
    items.push({ id:'promo', icon:'⏰', title:'A 0% promo is ending', say:`Your 0% deal on ${esc(soon.name)} jumps to ${soon.apr?soon.apr.toFixed(1)+'%':'its rate'} in ${soon.days} day${soon.days!==1?'s':''}. Let's beat the clock.`, sub:`${promos.length} promo${promos.length>1?'s':''} within 45 days.`, action:{label:'See promos', go:'debt_hub', tab:'promo'} }); }
  const ss=_scoreStale(); if(ss.stale){ items.push({ id:'score', icon:'📊', title:'Log your credit score', say: ss.days==null?`I don't have a credit score from you yet — it takes ten seconds and I'll track the trend.`:`Your last credit score was ${ss.days} days ago. Drop in this month's so I can watch the trend.`, sub:'Free in your card app or Credit Karma — no score impact.', action:{label:'Log score', open:'openScoreEditor'} }); }
  try{ const hi=engHighInterestDebt(); if(hi>0){ items.push({ id:'hidebt', icon:'🔥', title:'High-interest debt to attack', say:`You're carrying ${fmtK(hi)} in high-interest debt. Sending your extra funds here first is a guaranteed return — want to plan it?`, sub:'The Extra Funds Triage delegates your surplus by priority.', action:{label:'Open triage', go:'fund_triage'} }); } }catch(e){}
  try{ const ef=engEmergencyFund(); if(ef<1000){ items.push({ id:'emergency', icon:'🛟', title:'Build your safety net', say:`Your starter emergency fund is at ${fmtK(ef)} of $1,000. That buffer keeps a surprise off your cards — let's grow it.`, sub:'Fund it in Savings Buckets.', action:{label:'Open buckets', go:'savings_buckets'} }); } }catch(e){}
  try{ const rec=engRecurring(); const hikes=rec.filter(r=>r.priceUp); const cancel=_cancelSubs(); const flagged=rec.filter(r=>cancel[r.merchKey]);
    if(hikes.length){ items.push({ id:'subhike', icon:'🔁', title:'A subscription price went up', say:`${hikes.length===1?esc(hikes[0].merchant)+' raised its price':hikes.length+' subscriptions raised their prices'} — worth a look before the next charge?`, sub:hikes.slice(0,3).map(r=>esc(r.merchant)+' · '+fmtK(r.prior)+'→'+fmtK(r.recent)).join('<br>'), action:{label:'Review subscriptions', go:'recurring'} }); }
    else if(flagged.length){ items.push({ id:'subcancel', icon:'⊘', title:'Subscriptions to cancel', say:`You flagged ${flagged.length} subscription${flagged.length>1?'s':''} to cancel — done it yet? That's ${fmtK(flagged.reduce((s,r)=>s+r.monthly,0))}/mo back in your pocket.`, sub:flagged.slice(0,4).map(r=>esc(r.merchant)).join(', '), action:{label:'Review subscriptions', go:'recurring'} }); }
  }catch(e){}
  return items;
}
function buildBriefSteps(){
  const steps=[];
  const rl=_relinkErrors();
  if(rl.length){ steps.push({ id:'relink', icon:'🔌', title:'Reconnect a bank', say:`Quick one first — ${rl.length===1?(rl[0].institution||'a bank')+' needs':rl.length+' banks need'} you to sign in again so I can keep your numbers live. It only takes a sec.` }); }
  const rev=_reviewTxns();
  if(rev.length){ steps.push({ id:'txncat', icon:'🏷️', title:'Confirm your transactions', say:`${rl.length?'Next':'First'} up — ${rev.length} new transaction${rev.length>1?'s':''} since you were last here. My auto-categories aren't always right, so give each a glance, fix anything off, and hit Confirm.` }); }
  _briefActionItems().forEach(it=>{
    it.body=`<div class="brief-actbody"><div class="brief-actdesc">${it.sub||''}</div>${it.action?`<button class="brief-goto" onclick="event.stopPropagation();${it.action.go?`briefGoto('${it.action.go}')`:`briefOpen('${it.action.open}')`}">${esc(it.action.label)} →</button>`:''}</div>`;
    steps.push(it);
  });
  return steps;
}

function _briefEl(){ let el=gg('briefModal'); if(el) return el;
  el=document.createElement('div'); el.id='briefModal'; el.className='brief-overlay';
  el.innerHTML=`<div class="brief-card">
    <div class="brief-hd"><div id="briefChar" class="brief-char"></div><div class="brief-hd-txt"><div class="brief-kicker" id="briefKicker">Richie's rundown</div><div class="brief-dots" id="briefDots"></div></div><button class="brief-x" onclick="briefBypass()" title="Skip to dashboard" aria-label="Skip to dashboard">✕</button></div>
    <div class="brief-say" id="briefSay"></div>
    <div class="brief-step" id="briefStepBody"></div>
    <div class="brief-foot"><button class="brief-back" id="briefBack" onclick="briefBack()">← Back</button><button class="brief-skip" onclick="briefSkip()">Skip</button><button class="brief-done" id="briefNextBtn" onclick="briefNext()">Next →</button></div>
    <button class="brief-bypass" onclick="briefBypass()">Bypass → take me to the dashboard</button>
  </div>`;
  document.body.appendChild(el);
  return el;
}
function _briefRefreshBody(){ const step=_briefSteps[_briefStep]; const body=gg('briefStepBody'); if(!step||!body) return;
  body.innerHTML = step.id==='relink' ? _briefRelinkStepBody()
    : step.id==='txncat' ? _briefTxnStepBody()
    : step.id==='bills' ? _briefBillsStepBody()
    : step.id==='score' ? _briefScoreStepBody()
    : step.id==='hidebt' ? _briefHidebtStepBody()
    : step.id==='emergency' ? _briefEmergencyStepBody()
    : (step.body||''); }
function _briefRelinkStepBody(){
  const rl=_relinkErrors();
  if(!rl.length) return `<div class="brief-allclear">✅ All your banks are connected.</div>`;
  return `<div class="brief-mini"><div class="brief-actdesc">Banks expire access every so often — it's normal. Sign back in to keep the data flowing:</div>`
    + rl.map(e=>`<div class="brief-txn"><div class="brief-txn-main"><div class="brief-txn-nm">🏦 ${esc(e.institution||'Bank')}</div><div class="brief-txn-meta">login expired</div></div><button class="brief-confirm" onclick="event.stopPropagation();briefReconnect('${esc(String(e.itemId)).replace(/'/g,"\\'")}')">Reconnect</button></div>`).join('')
    + `</div>`;
}
function briefReconnect(itemId){ briefFinish(); setTimeout(()=>{ try{ openLinkHandler(itemId); }catch(e){} }, 220); }
function _briefGoStep(i){
  _briefStep=Math.max(0, Math.min(i, _briefSteps.length-1));
  const step=_briefSteps[_briefStep]; if(!step) return;
  const kick=gg('briefKicker'); if(kick) kick.textContent=`${step.icon} ${step.title}`;
  const dots=gg('briefDots'); if(dots) dots.innerHTML=_briefSteps.map((_,k)=>`<span class="brief-dot${k===_briefStep?' active':k<_briefStep?' done':''}"></span>`).join('');
  const say=gg('briefSay');
  if(say){ try{ if(_briefChar)_briefChar.talk(true); richieSpeakType(say, step.say||'', ()=>{ try{ if(_briefChar)_briefChar.talk(false); }catch(e){} }); }catch(e){ say.textContent=step.say||''; } }
  _briefRefreshBody();
  const nb=gg('briefNextBtn'); if(nb) nb.textContent=_briefStep>=_briefSteps.length-1?'Done ✓':'Next →';
  const back=gg('briefBack'); if(back) back.style.visibility=_briefStep>0?'visible':'hidden';
  try{ if(_briefChar) _briefChar.emotion(_briefStep===0?'excited':'happy'); }catch(e){}
}
function briefNext(){ if(_briefStep>=_briefSteps.length-1) briefFinish(); else _briefGoStep(_briefStep+1); }
function briefBack(){ if(_briefStep>0) _briefGoStep(_briefStep-1); }
function briefSkip(){ briefNext(); }
function briefBypass(){ briefFinish(); }
function briefFinish(){ const el=gg('briefModal'); if(el){ el.classList.remove('show'); setTimeout(()=>{ el.style.display='none'; }, 200); } try{ if(_briefChar)_briefChar.talk(false); }catch(e){} _markBriefingSeen(); try{ updateReviewBadge(); }catch(e){} }
function _pageWithWidget(type){ for(const p of (APP.pages||[])){ if((p.widgets||[]).some(w=>w&&w.type===type)) return p.id; } return null; }
// Where Richie should land (and what he says) for each widget he sends you to.
const RICHIE_SPOTS={
  cashflow_planner:{ focusSel:'.cfp-lowflag', message:"Here's your low point 👇 — trim a bill or shift income so this line stays above zero." },
  debt_hub:{ tab:'promo', message:"Your 0% promo lives here 👇 — pay it down before the rate jumps." },
  fund_triage:{ focusSel:'.ft-extra-edit input', message:"Set your extra funds right here 👇 and I'll split them by priority for you." },
  savings_buckets:{ message:"Grow your safety-net bucket here 👇 — a little each payday adds up fast." },
  recurring:{ focusSel:'.rec-cancelbtn', message:"Here are your subscriptions 👇 — flag any to ⊘ Cancel and watch the ▲ price rises." },
  bills_list:{ focusSel:'.bill-row', message:"Here are your bills 👇 — mark them paid or tweak what you'll pay." },
  top_categories:{ message:"Here's where your money's going 👇 — pick a category to trim this month." },
  health_score:{ focusSel:'.hs-tip', message:"Here's your money check-up 👇 — this one move lifts your score the most." },
  spending_trends:{ focusSel:'.st-row', message:"Here's what changed vs last month 👇 — tap a mover to see the transactions behind it." },
  bill_calendar:{ focusSel:'.bcal-summary', message:"Here's your month at a glance 👇 — watch the heavy weeks so nothing catches you out." },
  net_worth_chart:{ focusSel:'.wph-stat', message:"Here's your net worth trend 👇 — every check-in adds a real data point." },
};
function briefGoto(type){
  const spot=RICHIE_SPOTS[type]||{};
  briefFinish();
  setTimeout(()=>{ try{ _ensureWidgetOnPage(type); richieSpotlightAt(Object.assign({widgetType:type}, spot)); }catch(e){} }, 260);
}
function briefOpen(fn){ briefFinish(); setTimeout(()=>{ try{ if(typeof window[fn]==='function') window[fn](); }catch(e){} }, 240); }
function maybeShowBriefing(){
  if(!dataLoaded) return;                       // needs real data to be meaningful
  if(!buildBriefSteps().length) return;         // nothing actionable — don't nag
  showBriefing();
}
function showBriefing(){
  const el=_briefEl(); el.style.display='flex';
  try{ if(!_briefChar) _briefChar=spawnRichie(gg('briefChar')); }catch(e){}
  _briefSteps=buildBriefSteps(); _briefStep=0;
  requestAnimationFrame(()=>el.classList.add('show'));
  _briefGoStep(0);
}
// On-demand open (topbar Review button) — always shows, with an all-clear step when nothing's pending.
function openBriefing(){
  const el=_briefEl(); el.style.display='flex';
  try{ if(!_briefChar) _briefChar=spawnRichie(gg('briefChar')); }catch(e){}
  _briefSteps=buildBriefSteps();
  if(!_briefSteps.length){ _briefSteps=[{ id:'allclear', icon:'✅', title:'All caught up', say:`Nice — nothing needs you right now. Everything's reviewed and on track. I'll flag anything new next time you're in.`, body:`<div class="brief-allclear">You're all set. 🎉</div>` }]; }
  _briefStep=0;
  requestAnimationFrame(()=>el.classList.add('show'));
  _briefGoStep(0);
}
// Topbar Review badge — count of things worth handling (0 hides it).
function updateReviewBadge(){
  const b=gg('tbReviewBadge');
  if(b){ let n=0; try{ if(dataLoaded) n=buildBriefSteps().length; }catch(e){} if(n>0){ b.textContent=n; b.style.display='inline-flex'; } else { b.style.display='none'; } }
  try{ updateNotifBadge(); }catch(e){}   // the bell refreshes on the same beats as the Review badge
}

/* ═══════════════ IN-APP NOTIFICATIONS (topbar bell) ═══════════════
   A glanceable, read/unread list of the time-sensitive alerts Richie computes — the same
   signals the briefing uses, plus reconnect. Read state persists (APP.notifsRead) so a seen
   alert stops nagging; a re-raised one (new price, later date) gets a fresh key and re-appears. */
let _notifCache=[];
function _notifRead(){ APP.notifsRead=APP.notifsRead||{}; return APP.notifsRead; }
function buildNotifications(){
  if(!dataLoaded) return [];
  const N=[];
  try{ _relinkErrors().forEach(e=>N.push({key:'relink:'+e.itemId, icon:'🔌', crit:true, title:`${e.institution||'A bank'} needs reconnecting`, sub:'Sign in again to keep your data live.', go:'__reconnect__', itemId:e.itemId})); }catch(e){}
  try{ const rev=_reviewTxns(); if(rev.length) N.push({key:'txncat', icon:'🏷️', title:`${rev.length} new transaction${rev.length>1?'s':''} to review`, sub:'Confirm the categories are right.', go:'__briefing__'}); }catch(e){}
  try{ const bds=_billsDueSoon(); if(bds.length){ const nm=bds.map(b=>b.name).sort().join('|'); N.push({key:'bills:'+nm, icon:'📋', title:`${bds.length} bill${bds.length>1?'s':''} due this week`, sub:bds.slice(0,3).map(b=>esc(b.name)).join(', '), go:'bills_list'}); } }catch(e){}
  try{ const p=engCashFlowProjection(30); if(p.low.bal<0){ const d=_projDate(p.low.day); const when=p.low.day===0?'today':d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); N.push({key:'shortfall:'+d.toISOString().slice(0,10), icon:'⚠️', crit:true, title:`Low balance coming ${when}`, sub:`Projected to dip to ${fmtK(p.low.bal)}.`, go:'cashflow_planner'}); } }catch(e){}
  try{ (engPromos()||[]).filter(p=>p.bal>0.5&&p.days>=0&&p.days<=45).forEach(p=>N.push({key:'promo:'+(p.name||''), icon:'⏰', title:`0% promo ending: ${esc(p.name)}`, sub:`Rate jumps to ${p.apr?p.apr.toFixed(1)+'%':'its APR'} in ${p.days} day${p.days!==1?'s':''}.`, go:'debt_hub', tab:'promo'})); }catch(e){}
  try{ engRecurring().filter(r=>r.priceUp).forEach(r=>N.push({key:'hike:'+r.merchKey+':'+Math.round(r.recent), icon:'🔁', title:`${esc(r.merchant)} raised its price`, sub:`${fmtK(r.prior)} → ${fmtK(r.recent)}.`, go:'recurring'})); }catch(e){}
  try{ const st=engSpendTrends(); if(st.budget && st.elapsed>=0.25 && st.budget.pace<-25){ N.push({key:'overbudget:'+new Date().toISOString().slice(0,7), icon:'🆚', title:'Spending is pacing over budget', sub:`On track for ${fmtK(Math.abs(st.budget.pace))} over this month — tap to see the movers.`, go:'spending_trends'}); } }catch(e){}
  try{ const h=engHealthScore(); if(h.hasData && h.overall<70 && h.weakest){ N.push({key:'health:'+new Date().toISOString().slice(0,7)+':'+h.grade, icon:'🩺', title:`Your financial health is ${h.grade} (${h.overall}/100)`, sub:h.weakest.tip, go:'health_score'}); } }catch(e){}
  try{ const ss=_scoreStale(); if(ss.stale){ N.push({key:'score:'+new Date().toISOString().slice(0,7), icon:'📊', title:'Log your credit score', sub: ss.days==null?'None on file yet — takes 10 seconds.':`Last logged ${ss.days} days ago.`, open:'openScoreEditor'}); } }catch(e){}
  const read=_notifRead();
  N.forEach(n=>{ n.unread=!read[n.key]; });
  N.sort((a,b)=>(b.crit?1:0)-(a.crit?1:0) || (b.unread?1:0)-(a.unread?1:0));   // critical first, then unread
  return N;
}
function updateNotifBadge(){
  const b=gg('tbBellBadge'); if(!b) return;
  let n=0; try{ n=buildNotifications().filter(x=>x.unread).length; }catch(e){}
  if(n>0){ b.textContent=n>9?'9+':n; b.style.display='inline-flex'; } else { b.style.display='none'; }
}
function _notifEl(){ let el=gg('notifPanel'); if(el) return el;
  el=document.createElement('div'); el.id='notifPanel'; el.className='notif-panel';
  el.innerHTML=`<div class="notif-hd"><span>Notifications</span><button class="notif-allread" id="notifAllRead" onclick="notifMarkAllRead()">Mark all read</button></div><div class="notif-list" id="notifList"></div>`;
  document.body.appendChild(el);
  return el;
}
let _notifOpen=false, _notifOutside=null;
function toggleNotifPanel(ev){ if(ev) ev.stopPropagation(); if(_notifOpen) closeNotifPanel(); else openNotifPanel(); }
function openNotifPanel(){
  const el=_notifEl(); renderNotifPanel();
  const bell=gg('tbBell'); const r=bell?bell.getBoundingClientRect():{bottom:54,right:window.innerWidth-16};
  el.style.top=(r.bottom+8)+'px'; el.style.right=Math.max(8,(window.innerWidth-r.right))+'px';
  el.classList.add('show'); _notifOpen=true;
  _notifOutside=(e)=>{ if(!el.contains(e.target) && e.target.id!=='tbBell' && !(e.target.closest&&e.target.closest('#tbBell'))) closeNotifPanel(); };
  setTimeout(()=>document.addEventListener('click', _notifOutside), 0);
}
function closeNotifPanel(){ const el=gg('notifPanel'); if(el) el.classList.remove('show'); _notifOpen=false; if(_notifOutside){ document.removeEventListener('click', _notifOutside); _notifOutside=null; } }
function renderNotifPanel(){
  const list=gg('notifList'); if(!list) return;
  const N=buildNotifications(); _notifCache=N;
  const ar=gg('notifAllRead'); if(ar) ar.style.display=N.some(n=>n.unread)?'inline-block':'none';
  if(!N.length){ list.innerHTML=`<div class="notif-empty">✅ You're all caught up — no alerts right now.</div>`; return; }
  list.innerHTML=N.map((n,i)=>`<button class="notif-row${n.unread?' unread':''}" onclick="notifAct(${i})"><span class="notif-ic">${n.icon}</span><span class="notif-body"><span class="notif-title">${esc(n.title)}</span><span class="notif-sub">${n.sub}</span></span>${n.unread?'<span class="notif-dot" aria-label="unread"></span>':''}</button>`).join('');
}
function notifMarkRead(key){ if(!key) return; _notifRead()[key]=true; saveState(); }
function notifMarkAllRead(){ const r=_notifRead(); buildNotifications().forEach(n=>{ r[n.key]=true; }); saveState(); renderNotifPanel(); updateNotifBadge(); }
function notifAct(i){
  const n=_notifCache[i]; if(!n) return;
  notifMarkRead(n.key); closeNotifPanel(); updateNotifBadge();
  if(n.go==='__reconnect__'){ setTimeout(()=>{ try{ openLinkHandler(n.itemId); }catch(e){} }, 160); return; }
  if(n.go==='__briefing__'){ setTimeout(()=>{ try{ openBriefing(); }catch(e){} }, 160); return; }
  if(n.open){ setTimeout(()=>{ try{ if(typeof window[n.open]==='function') window[n.open](); }catch(e){} }, 200); return; }
  if(n.go){ try{ briefGoto(n.go); }catch(e){} }
}
function _doSignOut(greet){
  // Revoke the session cookie server-side (sent automatically), then return to login.
  try{ fetch('/api/logout',{method:'POST'}).catch(()=>{}); }catch(e){}
  clearToken();
  try{ SS.removeItem('mdf_user'); }catch(e){}
  closeUserMenu();
  showLogin(greet||"Signed out. Sign back in when you're ready.");
}
function logout(){ _doSignOut("Signed out. Sign back in when you're ready."); }
function switchUser(){ _doSignOut('Switch user — sign in below.'); }

/* ── Reusable Richie step-by-step wizard ──
   richieWizard({ title, steps:[{title, body, action?:{label, fn, advance?}}], onDone }) */
let _rwiz={steps:[],i:0,onDone:null}, _rwizChar=null;
function richieWizard(cfg){
  cfg=cfg||{};
  _rwiz={steps:(cfg.steps||[]).filter(Boolean), i:0, onDone:cfg.onDone||null, title:cfg.title||'Step by step'};
  if(!_rwiz.steps.length) return;
  gg('richieWiz').style.display='flex';
  gg('rwizTitle').textContent=_rwiz.title;
  gg('rwizDots').innerHTML=_rwiz.steps.map((_,i)=>'<span class="rwiz-dot" id="rwizDot-'+i+'"></span>').join('');
  try{ if(!_rwizChar) _rwizChar=spawnRichie(gg('rwizChar')); }catch(e){}
  rwizRender();
}
function rwizRender(){
  const st=_rwiz.steps[_rwiz.i]; if(!st) return;
  gg('rwizStepLabel').textContent='Step '+(_rwiz.i+1)+' of '+_rwiz.steps.length;
  gg('rwizStepTitle').textContent=st.title||'';
  gg('rwizMsg').textContent=st.body||'';
  const a=gg('rwizAction');
  if(st.action && st.action.label){ a.style.display='block'; a.innerHTML='<button class="btn primary rwiz-actbtn" onclick="rwizDoAction()">'+esc(st.action.label)+'</button>'; }
  else { a.style.display='none'; a.innerHTML=''; }
  _rwiz.steps.forEach((_,i)=>{ const d=gg('rwizDot-'+i); if(d) d.className='rwiz-dot'+(i===_rwiz.i?' active':i<_rwiz.i?' done':''); });
  gg('rwizBack').style.visibility=_rwiz.i>0?'visible':'hidden';
  gg('rwizNext').textContent=_rwiz.i>=_rwiz.steps.length-1?'Done':'Next';
  try{ if(_rwizChar) _rwizChar.do(_rwiz.i===0?'wave':'nod'); }catch(e){}
}
function rwizNext(){ if(_rwiz.i>=_rwiz.steps.length-1) rwizFinish(); else { _rwiz.i++; rwizRender(); } }
function rwizPrev(){ if(_rwiz.i>0){ _rwiz.i--; rwizRender(); } }
function rwizDoAction(){
  const st=_rwiz.steps[_rwiz.i]; if(!st||!st.action) return;
  if(typeof st.action.fn==='function'){ try{ st.action.fn(); }catch(e){} }
  if(st.action.advance!==false) rwizNext();
}
function rwizFinish(){ const cb=_rwiz.onDone; rwizClose(); if(typeof cb==='function'){ try{ cb(); }catch(e){} } }
function rwizClose(){ const w=gg('richieWiz'); if(w) w.style.display='none'; }

/* Example flow built on the engine — the "Getting started" walkthrough. */
function startGettingStarted(){
  closeUserMenu();
  richieWizard({
    title:"Getting started with Richie",
    steps:[
      { title:"Hey, I'm Richie 💰", body:"I'll walk you through the basics in a few quick steps. You can leave anytime with the ✕ and come back from the user menu." },
      { title:"Connect a bank (or explore first)", body:"Connecting a bank lets me build your dashboard from real balances and transactions. Not ready? Skip this and explore with the sample examples — nothing's real until you connect.",
        action:{ label:"🔗 Connect a bank", fn:()=>{ try{ openLinkHandler(); }catch(e){} }, advance:false } },
      { title:"Set a goal", body:"Richie is goals-first. Pick something to aim at — an emergency fund, paying off a card, hitting a savings rate — and I'll track it and cheer you on.",
        action:{ label:"🎯 Add a goal", fn:()=>{ try{ rwizClose(); if(typeof openGoalCreator==='function') openGoalCreator(); else switchPage('__settings__'); }catch(e){} }, advance:false } },
      { title:"Make it yours", body:"Add pages and drag widgets to build the dashboard you want. Tap me (the 💰 in the sidebar) anytime for a tip, or open Ask Richie for real questions about your money." },
      { title:"You're set 🎉", body:"That's the tour. Everything's saved as you go. Head to your dashboard and start exploring — I'll be right here in the sidebar." }
    ]
  });
}

function _loginUsername(){ try{ return SS.getItem('mdf_user')||''; }catch(e){ return ''; } }
function toggleUserMenu(e){
  if(e) e.stopPropagation();
  const m=gg('userMenu'); if(!m) return;
  if(m.style.display==='none' || !m.style.display){ populateUserMenu(); m.style.display='block'; setTimeout(()=>document.addEventListener('click',_umOutside),0); }
  else closeUserMenu();
}
function closeUserMenu(){ const m=gg('userMenu'); if(m) m.style.display='none'; document.removeEventListener('click',_umOutside); }
function _umOutside(ev){ const m=gg('userMenu'), b=gg('sbUserBtn'); if(m && !m.contains(ev.target) && b && !b.contains(ev.target)) closeUserMenu(); }
function populateUserMenu(){
  const prof=_activeProfile();
  const lv=LEVELS.find(l=>l.n===APP.level)||LEVELS[0];
  const av=gg('umAvatar'); if(av) av.textContent=prof.avatar||'💰';
  const nm=gg('umName'); if(nm) nm.textContent=prof.name||_loginUsername()||'Me';
  const sb=gg('umSub'); if(sb) sb.textContent=(APP.household||'My Finance World')+' · '+lv.icon+' '+lv.name;
  const pl=gg('umProfiles');
  if(pl){
    const rows=(APP.profiles||[]).map(p=>`<button class="um-prof${p.id===APP.activeProfile?' on':''}" onclick="switchProfile('${p.id}')"><span class="um-prof-av">${esc(p.avatar||'💰')}</span><span class="um-prof-nm">${esc(p.name||'Me')}</span>${p.id===APP.activeProfile?'<span class="um-prof-chk">✓</span>':''}</button>`).join('');
    pl.innerHTML=`<div class="um-prof-lbl">Viewing as · your own layout</div>${rows}<button class="um-prof um-prof-add" onclick="addProfile()"><span class="um-prof-av">➕</span><span class="um-prof-nm">Add profile</span></button>`;
  }
}
function openUserInfo(){
  closeUserMenu();
  const prof=_activeProfile();
  const lv=LEVELS.find(l=>l.n===APP.level)||LEVELS[0];
  gg('manualModal').style.display='flex';
  gg('manualTitle').textContent='User info';
  gg('manualSub').textContent='Your account at a glance.';
  const rows=[
    ['Username', _loginUsername()||'—'],
    ['Household', APP.household||'—'],
    ['Profile', prof.name||'—'],
    ['Level', lv.icon+' '+lv.n+' · '+lv.name],
    ['XP', (APP.xp||0).toLocaleString()],
    ['Bank data', dataLoaded?'Connected':'Not connected'],
  ];
  gg('manualBody').innerHTML='<div class="uinfo">'+rows.map(r=>'<div class="uinfo-row"><span>'+esc(r[0])+'</span><b>'+esc(String(r[1]))+'</b></div>').join('')
    +'</div><div class="mf-actions"><button class="btn" onclick="closeManual()">Close</button><button class="btn primary" onclick="closeManual();switchPage(\'__settings__\')">Open settings</button></div>';
}

/* ═══════════════════════════════════════════════════════════════ */
function wizFinish(){
  _obVoice=false; riAudioOn=false;        // onboarding done — Richie goes silent from here on
  try{ _stopTts(); }catch(e){}
  const _seedLv=1;   // all new users start at Level 1   // head-start up to Saver; Budgeter+ must be earned
  setupConfig.xp=LEVEL_XP[_seedLv-1]||0;
  try{ LS.setItem('richie_setup',JSON.stringify(setupConfig)); LS.removeItem('richie_app'); }catch(e){}
  gg('setupWizard').style.display='none';
  // After first-run setup, require login before entering (server auth + Plaid).
  showLogin("You're all set! Sign in to lock things down — Richie will greet you each time.");
}

function showLoader(msg){ const l=gg('bootLoader'); if(!l)return; if(msg){ const m=gg('blMsg'); if(m)m.textContent=msg; } l.style.display='flex'; void l.offsetWidth; l.classList.remove('hide'); }
function hideLoader(){ const l=gg('bootLoader'); if(!l)return; l.classList.add('hide'); setTimeout(()=>{ if(l.classList.contains('hide')) l.style.display='none'; },450); }
function boot(){
  enterApp();
}
async function enterApp(){
  _obVoice=false; riAudioOn=false;        // app is silent (voice was onboarding-only)
  // Local state cleared (tracking prevention / storage wipe) but a world lives on the server?
  // Restore it BEFORE loadState — otherwise loadState's "setup but no app" branch flashes the
  // blank build gate ("Let's build your app") on every reload. Keep the loader up and RETRY
  // the restore because a cold Render server takes ~30s to wake; a returning user with a
  // dashboard must never drop to the connect-a-bank gate just because the server was napping.
  if(!LS.getItem('richie_app')){
    try{ showLoader('Restoring your dashboard…'); }catch(e){}
    for(let i=0;i<6;i++){
      let sd=null; try{ sd=await _fetchJSON('/api/state'); }catch(e){ sd=null; }
      if(sd){   // server ANSWERED (dashboard present, or genuinely empty for a new user) → stop retrying
        if(sd.state){ syncApplyToLS(sd.state); if(sd.state._ts) LS.setItem('mdf_sync_ts', String(sd.state._ts)); }
        break;
      }
      await new Promise(r=>setTimeout(r,2500));   // sd===null = unreachable/cold → wait and try again
    }
  }
  try{ syncPull(); }catch(e){}            // adopt newer edits from another device (may reload once)
  loadState();
  _appEntered=true;                        // sync may push from here on — never from the wizard
  gg('appShell').style.display='block';
  gg('richieAssistant').style.display='block';
  sbRichie=spawnRichie(gg('sbRichie'));
  fabChar=spawnRichie(gg('fabChar'));
  rpChar=spawnRichie(gg('rpChar'));
  renderShell();
  try{ hideLoader(); }catch(e){}
  try{ refreshEnvBadge(); }catch(e){}
  try{ if(APP._awaitingBuild){ if(typeof gamiCheckin==='function') gamiCheckin(); } else { gamiInit(); } }catch(e){}
  if(APP.activePage&&APP.activePage!=='__settings__') switchPage(APP.activePage);
  else if(APP.pages[0]) switchPage(APP.pages[0].id);
  handleResize();
  window.addEventListener('resize',handleResize);
  initSwipeNav();
  setTimeout(()=>{ if(sbRichie)sbRichie.do('wiggle'); },600);
  // attempt live data load; re-render active page when it arrives
  updateConnectBtn();
  loadEngineData().then(ok=>{
    updateConnectBtn();
    // FIRST WIN with banks ALREADY connected (e.g. after a full reset — Plaid tokens live on
    // the server and survive it): data arriving IS the win. Without this, richieBuildApp only
    // ever fired from the Plaid-link callback, so returning users stayed at the connect gate.
    // Awaiting build: ALWAYS run richieBuildApp — it restores the real dashboard from the
    // server (or retries while the server is cold). Gating this on ok/banks meant a cold
    // server left the user stuck at the build gate forever, with nothing retrying once it
    // woke. Award the first-win XP only when banks actually loaded (a genuine first build).
    if(APP._awaitingBuild){ if(ok && (allAccts||[]).length){ try{ awardXp(15); }catch(e){} } richieBuildApp(); return; }
    try{ if(typeof gamiEvaluate==='function' && !APP._awaitingBuild) gamiEvaluate(); }catch(e){}
    if(ok && APP.activePage && APP.activePage!=='__settings__'){
      const pg=APP.pages.find(p=>p.id===APP.activePage); if(pg) renderCanvas(pg);
    }
    // If no bank is connected yet, have Richie offer to guide the first connect
    if(!ok && !APP.plaidConnected && !APP._awaitingBuild){
      setTimeout(()=>richieGuideConnect(), 1400);
    }
  });
  // Goals-first: Richie walks the user through their goal plan on first entry
  if(APP._goalsFirst){ setTimeout(()=>startGoalWalkthrough(), 1800); }
}
/* Richie's goal-plan walkthrough: greets, explains the plan, offers a tour of each goal page. */
function startGoalWalkthrough(){
  APP._goalsFirst=false; saveState();
  const goals=_goals();
  const names=goals.map(g=>g.icon+' '+g.name).join(', ');
  gg('richieAssistant').style.display='block';
  const pn=gg('richiePanel'); if(pn)pn.classList.add('open');
  richieSay(`Welcome! I built your whole app around your goals: ${names}. Each goal has its own page with exactly the widgets you need. Tap "Show me" and I'll walk you through the first one.`);
  const a=gg('rpAction');
  if(a){ a.innerHTML=`<button class="btn primary" onclick="goalTourStart()" style="width:100%;margin-top:8px">Show me my plan →</button>
    <button class="btn" onclick="goalTourSkip()" style="width:100%;margin-top:6px">I'll explore on my own</button>`; }
}
let _tourQueue=[];
function goalTourStart(){
  _tourQueue=(APP.pages||[]).filter(p=>p.goalMetric).map(p=>p.id);
  goalTourNext();
}
function goalTourNext(){
  const a=gg('rpAction'); if(a)a.innerHTML='';
  if(!_tourQueue.length){
    richieSay("That's your plan! Connect your bank so I can track real progress, and tap any goal's 💡 anytime you want a hint. Let's make some moves. 💪");
    return;
  }
  const pid=_tourQueue.shift();
  const pg=APP.pages.find(p=>p.id===pid); if(!pg){ goalTourNext(); return; }
  switchPage(pid);
  const plan=goalPlanFor(pg.goalMetric);
  setTimeout(()=>{
    richieSay(plan.coach);
    const a2=gg('rpAction');
    if(a2){ a2.innerHTML=`<button class="btn primary" onclick="goalTourNext()" style="width:100%;margin-top:8px">${_tourQueue.length?'Next goal →':'Got it!'}</button>`; }
    if(sbRichie)sbRichie.do('bounce');
  }, 500);
}
function goalTourSkip(){ const a=gg('rpAction'); if(a)a.innerHTML=''; richieSay("No problem — explore away. I'm always one tap away if you want coaching on any goal. 🎯"); }
function showStorageWarning(){
  if(!_storageBlocked) return;
  if(gg('storageWarn')) return;
  const bar=document.createElement('div');
  bar.id='storageWarn';
  bar.style.cssText='position:fixed;top:0;left:0;right:0;z-index:4000;background:#3a2d12;color:#f0c674;font-size:12.5px;padding:9px 16px;text-align:center;border-bottom:1px solid rgba(240,165,64,0.3);line-height:1.5;';
  bar.innerHTML="⚠️ Your browser is blocking storage (Tracking Prevention / private mode). The app works, but won't remember your setup between visits. To fix: click the shield icon in the address bar → turn Tracking Prevention <b>off for this site</b> → reload. <span style='cursor:pointer;text-decoration:underline;margin-left:8px' onclick=\"this.closest('#storageWarn').remove()\">Dismiss</span>";
  document.body.appendChild(bar);
}
async function start(){
  showStorageWarning();
  // A just-completed full reset explicitly requests onboarding — it outranks the
  // returning-user detection below (the login survives a reset by design).
  try{ if(LS.getItem('rz_force_onboard')==='1'){ LS.removeItem('rz_force_onboard'); runIntro(); hideLoader(); return; } }catch(e){}
  let hasSetup=false;
  try{ hasSetup=!!(LS.getItem('richie_setup')||LS.getItem('richie_app')); }catch(e){}
  if(hasSetup){
    if(isLoggedIn()){ enterApp(); }                 // already authenticated this session
    else { showLogin(); hideLoader(); }             // returning → login → welcome-back SWOT
    return;
  }
  // No local data. This is EITHER a brand-new install OR a returning user whose browser
  // cleared storage on close (the login cookie is gone too). Ask the server before assuming
  // "new" — otherwise a wiped device restarts onboarding ("Richie build") every reopen and
  // never restores the saved world. doLogin() then pulls the state back down.
  try{
    const r=await fetch('/api/auth_status');
    const d=await r.json().catch(()=>({}));
    if(d && d.configured){                          // a login already exists → returning user
      if(isLoggedIn()){ enterApp(); }               // (cookie somehow survived) → straight in
      else { showLogin("Welcome back! Sign in and I’ll bring your whole dashboard right back."); hideLoader(); }
      return;
    }
  }catch(e){ /* server unreachable → fall through to intro */ }
  runIntro(); hideLoader();                          // genuinely new → onboarding
}
window.addEventListener('load',start);
