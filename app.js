// ===== BSM V2 — app.js =====
// Public Binance Futures WebSocket streams only. No account, no API key.
// Not financial advice — research/alerting tool. Trade decisions and risk are the user's.

const rowsEl = document.getElementById('rows');
const watchlistEl = document.getElementById('watchlist');
const regimeValue = document.getElementById('regimeValue');
const regimeBar = document.getElementById('regimeBar');
const toastContainer = document.getElementById('toastContainer');
const liveClock = document.getElementById('liveClock');
const bellBtn = document.getElementById('bellBtn');

const HISTORY_MS = 5 * 60 * 1000;
const coins = new Map();
let alertsEnabled = false;
let audioCtx = null;

// ---------- coin state helpers ----------
function isTracked(sym){ return sym.endsWith('USDT') && !/^\d/.test(sym); }
function getCoin(sym){
  let c = coins.get(sym);
  if(!c){ c = {history:[], funding:null, fundingHist:[], liqBuy:[], liqSell:[], lastLog:0, lastAlert:0}; coins.set(sym,c); }
  return c;
}
function prune(arr, now){ while(arr.length && now - arr[0].t > HISTORY_MS) arr.shift(); }

function pushSample(sym, price, vol){
  const c = getCoin(sym); const now = Date.now();
  c.history.push({t:now, price, vol}); prune(c.history, now);
}
function pushFunding(sym, rate){
  const c = getCoin(sym); const now = Date.now();
  c.funding = rate; c.fundingHist.push({t:now, rate}); prune(c.fundingHist, now);
}
function pushLiq(sym, side, qty, price){
  const c = getCoin(sym); const now = Date.now();
  const notional = qty * price;
  if(side === 'SELL') c.liqSell.push({t:now, notional}); // long liquidated
  else c.liqBuy.push({t:now, notional}); // short liquidated
  prune(c.liqSell, now); prune(c.liqBuy, now);
}

// ---------- metrics ----------
function changeOver(hist, ms){
  if(hist.length < 2) return null;
  const now = hist[hist.length-1].t; const target = now - ms;
  let ref = hist[0];
  for(const p of hist){ if(p.t <= target) ref = p; else break; }
  if(ref === hist[hist.length-1]) return null;
  return ((hist[hist.length-1].price - ref.price) / ref.price) * 100;
}
function avgVol(hist){ if(!hist.length) return 0; return hist.reduce((a,p)=>a+p.vol,0)/hist.length; }
function sumWindow(arr, ms){ const now = Date.now(); return arr.filter(e=>now-e.t<=ms).reduce((a,e)=>a+e.notional,0); }
function fundingChange(hist){ if(hist.length<2) return 0; return hist[hist.length-1].rate - hist[0].rate; }

function computeMetrics(c){
  const pct1m = changeOver(c.history, 60*1000);
  const pct3m = changeOver(c.history, 180*1000);
  if(pct1m === null) return null;
  const lastVol = c.history[c.history.length-1].vol;
  const volRatio = avgVol(c.history) > 0 ? lastVol/avgVol(c.history) : 1;
  const shortLiq = sumWindow(c.liqBuy, 3*60*1000);
  const longLiq = sumWindow(c.liqSell, 3*60*1000);
  const fChange = fundingChange(c.fundingHist);

  const accel = Math.min(Math.abs(pct1m) * 8, 55);
  const volS = Math.min(Math.max(volRatio-1,0) * 10, 30);
  const persist = (pct3m!==null && Math.sign(pct1m)===Math.sign(pct3m)) ? 15 : 0;
  const impulse = Math.round(Math.min(accel + volS + persist, 100));

  const squeeze = Math.round(Math.min(
    Math.max(pct1m,0)*4 + Math.min(shortLiq/2000,25) + volS*0.6 + (c.funding!==null && c.funding<0 ? 15:0)
  , 100));
  const cascade = Math.round(Math.min(
    Math.max(-pct1m,0)*4 + Math.min(longLiq/2000,25) + volS*0.6 + (c.funding!==null && c.funding>0.0005 ? 15:0)
  , 100));
  const trap = Math.round(Math.min(
    (persist===0 ? Math.abs(pct1m)*6 : 0) + (Math.abs(fChange)>0.0004 ? 20:0) + (volRatio>3?15:0)
  , 100));

  return {pct1m, pct3m, volRatio, shortLiq, longLiq, impulse, squeeze, cascade, trap, funding:c.funding};
}

function classify(m){
  if(m.trap >= 55) return {tag:'POSSIBLE TRAP', cls:'trap', dir:0};
  if(m.impulse < 30) return {tag:'—', cls:'', dir:0};
  if(m.impulse < 70) return {tag:'WATCH', cls:'wait', dir:0};
  return m.pct1m >= 0 ? {tag:'LONG BIAS', cls:'long', dir:1} : {tag:'SHORT BIAS', cls:'short', dir:-1};
}

// ---------- sparklines ----------
function sparkPath(hist, w, h){
  if(hist.length<2) return '';
  const prices = hist.map(p=>p.price); const min=Math.min(...prices), max=Math.max(...prices); const range=(max-min)||1;
  const step = w/(hist.length-1);
  return hist.map((p,i)=>{ const x=i*step; const y=h-((p.price-min)/range)*h; return (i===0?'M':'L')+x.toFixed(1)+','+y.toFixed(1); }).join(' ');
}
function svgSpark(hist,w,h,color,id){
  return `<svg ${id?('id="'+id+'" '):''}viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${sparkPath(hist,w,h)}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// ---------- alerts: toast + desktop notification + beep ----------
function beep(freq){
  try{
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.3);
  }catch(e){}
}

function showToast(sym, m, cls){
  const el = document.createElement('div');
  el.className = 'toast ' + (cls.dir===1?'long':cls.dir===-1?'short':'');
  el.innerHTML = `<div><div class="t-title">${sym.replace('USDT','')} — ${cls.tag}</div>
    <div class="t-sub">1m ${m.pct1m>=0?'+':''}${m.pct1m.toFixed(2)}% · impulse ${m.impulse} · vol ${m.volRatio.toFixed(1)}x</div></div>`;
  toastContainer.appendChild(el);
  setTimeout(()=> el.remove(), 5100);
}

function requestAlerts(){
  if(!('Notification' in window)){ alertsEnabled = !alertsEnabled; bellBtn.classList.toggle('on', alertsEnabled); return; }
  if(Notification.permission === 'granted'){
    alertsEnabled = !alertsEnabled;
  } else {
    Notification.requestPermission().then(p => { alertsEnabled = (p === 'granted'); bellBtn.classList.toggle('on', alertsEnabled); });
    return;
  }
  bellBtn.classList.toggle('on', alertsEnabled);
}
window.requestAlerts = requestAlerts;

function fireAlert(sym, m, cls){
  showToast(sym, m, cls);
  if(m.impulse >= 85) beep(cls.dir===1 ? 880 : 440);
  if(alertsEnabled && 'Notification' in window && Notification.permission === 'granted'){
    try{
      new Notification('BSM · ' + sym.replace('USDT','') + ' — ' + cls.tag, {
        body: `1m ${m.pct1m>=0?'+':''}${m.pct1m.toFixed(2)}% · impulse ${m.impulse} · vol ${m.volRatio.toFixed(1)}x`,
        tag: sym
      });
    }catch(e){}
  }
}

// ---------- outcome logging (window.storage) ----------
async function maybeLogSignal(sym, m, price){
  const c = getCoin(sym);
  const cls = classify(m);
  const now = Date.now();
  if(cls.dir !== 0 && now - c.lastLog >= 5*60*1000){
    c.lastLog = now;
    const key = 'signal:'+now+':'+sym;
    const entry = {sym, time:now, price, score:m.impulse, dir:cls.dir, tag:cls.tag, checks:{m5:false,m15:false,m60:false}, outcomes:{}};
    try{ await window.storage.set(key, JSON.stringify(entry), false); }catch(e){}
  }
  // alert throttling separate from logging, fires on any impulse>=70 (incl. traps) once per 3 min per symbol
  if((m.impulse >= 70 || m.trap >= 55) && now - c.lastAlert >= 3*60*1000){
    c.lastAlert = now;
    fireAlert(sym, m, cls);
  }
}

async function evaluateOutcomes(){
  let keysRes;
  try{ keysRes = await window.storage.list('signal:', false); }catch(e){ return; }
  if(!keysRes || !keysRes.keys) return;
  const now = Date.now();
  for(const key of keysRes.keys.slice(-200)){
    let rec;
    try{ const r = await window.storage.get(key, false); if(!r) continue; rec = JSON.parse(r.value); }catch(e){ continue; }
    const c = coins.get(rec.sym);
    if(!c || !c.history.length) continue;
    const curPrice = c.history[c.history.length-1].price;
    let changed = false;
    const horizons = [['m5',5*60*1000],['m15',15*60*1000],['m60',60*60*1000]];
    for(const [k, ms] of horizons){
      if(!rec.checks[k] && now - rec.time >= ms){
        const ret = ((curPrice - rec.price)/rec.price)*100;
        const win = (rec.dir===1 && ret>0.15) || (rec.dir===-1 && ret<-0.15);
        rec.outcomes[k] = {ret: Number(ret.toFixed(3)), win};
        rec.checks[k] = true; changed = true;
      }
    }
    if(changed){ try{ await window.storage.set(key, JSON.stringify(rec), false); }catch(e){} }
  }
}

async function renderTrackRecord(){
  let keysRes;
  try{ keysRes = await window.storage.list('signal:', false); }catch(e){ return; }
  if(!keysRes || !keysRes.keys || !keysRes.keys.length){
    document.getElementById('trackList').innerHTML = '<div class="meta" style="padding:10px 0;">No signals logged yet — they appear here once impulses cross the threshold.</div>';
    return;
  }
  const recs = [];
  for(const key of keysRes.keys.slice(-100)){
    try{ const r = await window.storage.get(key, false); if(r) recs.push(JSON.parse(r.value)); }catch(e){}
  }
  recs.sort((a,b)=>b.time-a.time);
  function winRate(k){
    const done = recs.filter(r=>r.checks[k]);
    if(!done.length) return '—';
    const wins = done.filter(r=>r.outcomes[k].win).length;
    return Math.round(wins/done.length*100) + '% (' + done.length + ')';
  }
  document.getElementById('tr5').textContent = winRate('m5');
  document.getElementById('tr15').textContent = winRate('m15');
  document.getElementById('tr60').textContent = winRate('m60');
  document.getElementById('trackList').innerHTML = recs.slice(0,25).map(r=>{
    const d = new Date(r.time);
    const time = d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const dirTxt = r.dir===1?'LONG':'SHORT';
    const m5 = r.checks.m5 ? (r.outcomes.m5.ret>=0?'+':'')+r.outcomes.m5.ret+'%' : 'pending';
    return `<div class="track-row"><span><b>${r.sym.replace('USDT','')}</b> ${dirTxt} @${time}</span><span>${m5}</span></div>`;
  }).join('');
}

// ---------- render ----------
let selectedSym = null;
function render(){
  const ranked = []; let up=0, down=0, total=0;
  for(const [sym, c] of coins){
    if(c.history.length < 3) continue;
    const m = computeMetrics(c);
    if(!m) continue;
    total++; if(m.pct1m>0) up++; else if(m.pct1m<0) down++;
    ranked.push({sym, m, hist:c.history});
    maybeLogSignal(sym, m, c.history[c.history.length-1].price);
  }
  if(total>0){
    const breadth = Math.round((up/total)*100);
    regimeValue.textContent = breadth+'% up';
    const col = breadth>=55?'var(--up)':breadth<=45?'var(--down)':'var(--amber)';
    regimeValue.style.color = col; regimeBar.style.width = breadth+'%'; regimeBar.style.background = col;
  }
  ranked.sort((a,b)=>b.m.impulse-a.m.impulse);
  const hot = ranked.filter(r=>r.m.impulse>=30 || r.m.trap>=55).slice(0,15);
  const rest = ranked.slice(0,8);

  rowsEl.innerHTML = hot.length===0
    ? '<div class="empty">No abnormal moves yet — watching '+total+' pairs…</div>'
    : hot.map(r=>{
        const m = r.m; const cls = classify(m);
        const rowCls = cls.cls==='trap' ? 'trap' : (m.impulse>=70?'extreme':(m.impulse>=50?'hot':''));
        const color = m.pct1m>=0?'var(--up)':'var(--down)';
        return `<div class="row ${rowCls}" onclick="openDetail('${r.sym}')">
          <div><div class="sym">${r.sym.replace('USDT','')}<span class="tag ${cls.cls}">${cls.tag}</span></div>
          <div class="meta">3m ${m.pct3m!==null?m.pct3m.toFixed(2)+'%':'—'} · vol ${m.volRatio.toFixed(1)}x${m.funding!==null?' · fund '+(m.funding*100).toFixed(3)+'%':''}</div></div>
          <div class="row-mid"><div class="pct ${m.pct1m>=0?'up':'down'} mono">${m.pct1m>=0?'+':''}${m.pct1m.toFixed(2)}%</div><div class="impulse">impulse ${m.impulse}</div></div>
          <div class="spark">${svgSpark(r.hist.slice(-40),52,26,color)}</div>
        </div>`;
      }).join('');

  watchlistEl.innerHTML = rest.slice(0,6).map(r=>{
    const color = r.m.pct1m>=0?'var(--up)':'var(--down)';
    return `<div class="row" onclick="openDetail('${r.sym}')" style="grid-template-columns:1fr auto 52px;">
      <div class="sym">${r.sym.replace('USDT','')}</div>
      <div class="row-mid"><div class="pct ${r.m.pct1m>=0?'up':'down'} mono">${r.m.pct1m>=0?'+':''}${r.m.pct1m.toFixed(2)}%</div></div>
      <div class="spark">${svgSpark(r.hist.slice(-40),52,26,color)}</div>
    </div>`;
  }).join('');

  if(selectedSym) updateDetail(selectedSym);
  liveClock.textContent = new Date().toLocaleTimeString();
}

function openDetail(sym){ selectedSym=sym; document.getElementById('overlay').classList.add('open'); updateDetail(sym); }
function closeDetail(){ document.getElementById('overlay').classList.remove('open'); selectedSym=null; }
window.openDetail = openDetail;
window.closeDetail = closeDetail;

function updateDetail(sym){
  const c = coins.get(sym); if(!c) return;
  const m = computeMetrics(c); if(!m) return;
  const cls = classify(m); const color = m.pct1m>=0?'var(--up)':'var(--down)';
  document.getElementById('dSym').textContent = sym.replace('USDT','')+' / USDT';
  document.getElementById('dMeta').innerHTML = `<span class="tag ${cls.cls}" style="padding:2px 7px;">${cls.tag}</span>`;
  const old = document.getElementById('dSpark');
  old.outerHTML = svgSpark(c.history.slice(-100), old.clientWidth||600, 90, color, 'dSpark');
  document.getElementById('d1m3m').textContent = m.pct1m.toFixed(2)+'% / '+(m.pct3m!==null?m.pct3m.toFixed(2)+'%':'—');
  document.getElementById('dImpulse').textContent = m.impulse+' / 100';
  document.getElementById('dFunding').textContent = m.funding!==null ? (m.funding*100).toFixed(4)+'%' : '—';
  document.getElementById('dVol').textContent = m.volRatio.toFixed(2)+'x avg';
  document.getElementById('dSqueezeN').textContent = m.squeeze;
  document.getElementById('dSqueeze').style.width = m.squeeze+'%';
  document.getElementById('dCascadeN').textContent = m.cascade;
  document.getElementById('dCascade').style.width = m.cascade+'%';
  document.getElementById('dTrapN').textContent = m.trap;
  document.getElementById('dTrap').style.width = m.trap+'%';
}

function switchTab(t){
  document.getElementById('tabScan').classList.toggle('active', t==='scan');
  document.getElementById('tabTrack').classList.toggle('active', t==='track');
  document.getElementById('scanView').style.display = t==='scan'?'block':'none';
  document.getElementById('trackView').style.display = t==='track'?'block':'none';
  document.getElementById('regimeBox').style.display = t==='scan'?'flex':'none';
  if(t==='track') renderTrackRecord();
}
window.switchTab = switchTab;

// ---------- Binance public streams — each with its own independent reconnect ----------
const dotTicker = document.getElementById('dotTicker');
const dotMark = document.getElementById('dotMark');
const dotLiq = document.getElementById('dotLiq');

function connectStream(url, onMessage, dotEl){
  let ws;
  function open(){
    ws = new WebSocket(url);
    ws.onopen = () => dotEl.classList.add('live');
    ws.onclose = () => { dotEl.classList.remove('live'); dotEl.classList.add('down'); setTimeout(open, 2000); };
    ws.onerror = () => ws.close();
    ws.onmessage = onMessage;
  }
  open();
}

connectStream('wss://fstream.binance.com/ws/!ticker@arr', (msg)=>{
  try{ const arr=JSON.parse(msg.data); for(const t of arr){ if(isTracked(t.s)) pushSample(t.s, parseFloat(t.c), parseFloat(t.q)); } }catch(e){}
}, dotTicker);

connectStream('wss://fstream.binance.com/ws/!markPrice@arr@1s', (msg)=>{
  try{ const arr=JSON.parse(msg.data); for(const t of arr){ if(isTracked(t.s)) pushFunding(t.s, parseFloat(t.r)); } }catch(e){}
}, dotMark);

connectStream('wss://fstream.binance.com/ws/!forceOrder@arr', (msg)=>{
  try{
    const d = JSON.parse(msg.data); const o = d.o || d;
    if(o && isTracked(o.s)) pushLiq(o.s, o.S, parseFloat(o.q), parseFloat(o.ap||o.p));
  }catch(e){}
}, dotLiq);

setInterval(render, 1000);
setInterval(evaluateOutcomes, 20000);

// register service worker for installability (best-effort; ignored if unsupported/blocked)
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  });
}
