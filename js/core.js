"use strict";
/* ═══════════════════════════════════════════════════════════════
   core.js —— 状态 · 持久化 · 事件日志 · 全部算法（连续区间/拆坐/移位/统计/仿真）
   注意：本文件顶层一律用 var（经典脚本间共享全局），函数名即跨文件契约。
   ═══════════════════════════════════════════════════════════════ */

/* ========== 状态 ========== */
var LS_KEY = 'seat-alloc-v1';
var state = load() || defaultState();
var selection = null;    // {k, note, queueId, cands}
var mergeDismissed = {}; // 本事件周期内被“稍后处理”的合并提议
var SIM = false;         // 离线仿真模式：save/render/toast 全部旁路
var simAvgMs = 60*60000; // 仿真用平均就餐时长
var shiftCtx = null;     // {plan, beneficiary}

function defaultState(){
  return {
    version: 1,
    cleanMin: 3,                       // 清理倒计时（分钟）
    splitSeating: true,                // 拆坐开关（一人一锅店型才开）
    shiftSeating: true,                // 移位拼座开关（高峰期可选模块）
    layout: demoLayout(),
    seatStates: {},                    // key -> {st:'free'|'occ'|'clean', party?, until?}
    parties: {},                       // id -> {id,size,note,seatedAt,seatKeys[]}
    queue: [],                         // [{id,size,note,since}]
    log: []                            // 事件日志 [{t, type, detail}]
  };
}
function demoLayout(){
  return [
    {id:'r1', label:'A区', seats:10},
    {id:'r2', label:'B区', seats:10},
    {id:'r3', label:'C区', seats:8},
    {id:'r4', label:'D区', seats:8}
  ];
}
function seatKey(rowId, idx){ return rowId + '#' + idx; }
function seatState(rowId, idx){
  const s = state.seatStates[seatKey(rowId, idx)];
  return s ? s : {st:'free'};
}
function maxRowSeats(){
  return Math.max(1, ...state.layout.map(r => r.seats));
}
function ensureAllSeats(s){
  s = s || state;
  s.layout.forEach(row => {
    for(let i=0;i<row.seats;i++){
      const k = seatKey(row.id, i);
      if(!s.seatStates[k]) s.seatStates[k] = {st:'free'};
    }
  });
}
function newId(prefix){
  return prefix + '-' + Date.now().toString(36) + Math.floor(Math.random()*1e4).toString(36);
}
function logEvent(type, detail){
  state.log = state.log || [];
  state.log.push({t: Date.now(), type, detail: detail||{}});
  if(state.log.length > 3000) state.log = state.log.slice(-3000);
}

function save(){
  if(SIM) return;
  mergeDismissed = {}; // 任何状态变更后，合并提议重新生效
  try{ localStorage.setItem(LS_KEY, JSON.stringify(state)); }catch(e){}
}
function load(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return null;
    const s = JSON.parse(raw);
    if(!s || !Array.isArray(s.layout) || s.layout.length===0) return null;
    s.seatStates = s.seatStates || {};
    ensureAllSeats(s); // 补默认空位
    s.parties = s.parties || {};
    s.queue = s.queue || [];
    s.log = s.log || [];
    if(typeof s.cleanMin !== 'number') s.cleanMin = 3;
    if(typeof s.splitSeating !== 'boolean') s.splitSeating = true;
    if(typeof s.shiftSeating !== 'boolean') s.shiftSeating = true;
    // 剔除引用了已不存在座位的桌
    for(const pid in s.parties){
      const p = s.parties[pid];
      const alive = (p.seatKeys||[]).filter(k => k in s.seatStates);
      if(alive.length === 0){ delete s.parties[pid]; }
      else p.seatKeys = alive;
    }
    return s;
  }catch(e){ return null; }
}

/* ========== 指标：统计基础 ========== */
function countStats(){
  let occ=0, clean=0, total=0;
  state.layout.forEach(row => { total += row.seats; });
  for(const k in state.seatStates){
    const st = state.seatStates[k].st;
    if(st==='occ') occ++; else if(st==='clean') clean++;
  }
  return {total, free: total-occ-clean, occ, clean};
}

/* ========== 算法：连续空区间 ========== */
function freeIntervals(){
  const ivs = [];
  state.layout.forEach(row => {
    let run = null;
    for(let i=0;i<row.seats;i++){
      const st = seatState(row.id, i).st;
      if(st === 'free'){
        if(!run) run = {rowId:row.id, start:i};
        run.end = i;
      }else{
        if(run){ run.len = run.end - run.start + 1; ivs.push(run); run = null; }
      }
    }
    if(run){ run.len = run.end - run.start + 1; ivs.push(run); }
  });
  return ivs;
}
function candidatesFor(k){
  return freeIntervals()
    .filter(iv => iv.len >= k)
    .map(iv => ({rowId:iv.rowId, start:iv.start, end:iv.end, len:iv.len, waste:iv.len - k}));
}
function bestCandidate(cands){
  if(!cands.length) return null;
  return cands.reduce((a,b) => (b.waste < a.waste ? b : a));
}
function rowLabel(rowId){
  const r = state.layout.find(x => x.id === rowId);
  return r ? r.label : rowId;
}
function seatName(rowId, idx){
  return rowLabel(rowId) + ' ' + (idx+1) + ' 号';
}

/* ========== 拆坐（P2）========== */
function rowIndex(rowId){ return state.layout.findIndex(r => r.id === rowId); }
function comboScore(parts){
  const sorted = parts.slice().sort((a,b) => a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : a.start - b.start);
  let spread = 0;
  for(let i=1;i<sorted.length;i++){
    const prev = sorted[i-1], cur = sorted[i];
    const ri = rowIndex(prev.rowId), ci = rowIndex(cur.rowId);
    if(ri === ci) spread += Math.max(0, cur.start - prev.end - 1);
    else spread += (ci - ri) * 100;
  }
  return {parts: sorted.length, spread};
}
function betterCombo(pa, pb){
  const a = comboScore(pa), b = comboScore(pb);
  if(a.parts !== b.parts) return a.parts < b.parts;   // 部分数越少越好
  return a.spread < b.spread;                          // 间距越小越好
}
// 拆坐方案：把 k 人拆成若干整块（每块 = 一个连续空区间），部分数最少、间距最小
function splitPlanFor(k){
  if(!state.splitSeating || k < 2) return null;
  const ivs = freeIntervals().sort((a,b) => a.len - b.len);
  if(ivs.some(iv => iv.len >= k)) return null;         // 有整块就不该走到这
  let best = null;
  const MAX_PARTS = 4;
  function dfs(start, remaining, parts){
    if(remaining === 0){
      if(!best || betterCombo(parts, best.parts)) best = {parts: parts.slice()};
      return;
    }
    if(parts.length >= MAX_PARTS) return;
    for(let i=start;i<ivs.length;i++){
      const iv = ivs[i];
      if(iv.len > remaining) break;                     // 已按长度升序
      parts.push({rowId:iv.rowId, start:iv.start, end:iv.end, size:iv.len});
      dfs(i+1, remaining - iv.len, parts);
      parts.pop();
    }
  }
  dfs(0, k, []);
  return best;
}
function applySplitPlan(plan, note, t){
  const k = plan.parts.reduce((s,p)=>s+p.size, 0);
  const pid = newId('p');
  const seatKeys = [];
  plan.parts.forEach(p => {
    for(let i=0;i<p.size;i++){
      const key = seatKey(p.rowId, p.start + i);
      state.seatStates[key] = {st:'occ', party:pid};
      seatKeys.push(key);
    }
  });
  const at = t || Date.now();
  const party = {id:pid, size:k, note:note||'', seatedAt:at, _leavesAt: at + simAvgMs, seatKeys,
                 split:true, parts:plan.parts.map(p=>({rowId:p.rowId, start:p.start, end:p.end, size:p.size})),
                 refuseMerge:false};
  state.parties[pid] = party;
  logEvent('arrive', {size:k, note:note||''});
  logEvent('seated', {size:k, split:true});
  logEvent('split', {size:k, parts: plan.parts.map(p=>p.size)});
  save(); renderAll();
  toast('🔗 已拆坐入座：'+plan.parts.map(p=>rowLabel(p.rowId)+' '+(p.start+1)+'-'+(p.end+1)+' 号').join(' + '));
}
function splitParties(){ return Object.values(state.parties).filter(p => p.split && !p.refuseMerge); }
function mergeSuggestions(){
  const out = [];
  for(const p of splitParties()){
    if(mergeDismissed[p.id]) continue;
    const cands = candidatesFor(p.size);
    if(cands.length) out.push({party:p, target: bestCandidate(cands)});
  }
  return out;
}
function mergeParty(partyId, cand){
  const p = state.parties[partyId];
  if(!p) return;
  const fresh = candidatesFor(p.size).find(c => c.rowId === cand.rowId && c.start === cand.start);
  const owned = p.seatKeys.every(k => state.seatStates[k] && state.seatStates[k].party === partyId);
  if(!fresh || !owned){ toast('⚠️ 位置已变化，请重新操作'); renderAll(); return; }
  p.seatKeys.forEach(k => { state.seatStates[k] = {st:'free'}; });
  const newKeys = [];
  for(let i=0;i<p.size;i++){
    const key = seatKey(cand.rowId, cand.start + i);
    state.seatStates[key] = {st:'occ', party:partyId};
    newKeys.push(key);
  }
  p.seatKeys = newKeys; p.split = false; p.refuseMerge = false; p.parts = null;
  logEvent('merge', {size:p.size, to: rowLabel(cand.rowId)+' '+(cand.start+1)+'-'+(cand.start+p.size)+' 号'});
  save(); renderAll();
  toast('🔗 已合并：'+p.size+' 人桌坐到 '+rowLabel(cand.rowId)+' '+(cand.start+1)+'-'+(cand.start+p.size)+' 号');
}

/* ========== 移位拼座（P3）========== */
function movableParties(){
  return Object.values(state.parties).filter(p =>
    !p.split && !p.dnd && !p.refuseShift &&
    p.seatKeys.length > 0 &&
    p.seatKeys.every(k => state.seatStates[k] && state.seatStates[k].party === p.id)
  );
}
function occupiedKeySet(){
  const set = new Set();
  for(const k in state.seatStates) if(state.seatStates[k].st === 'occ') set.add(k);
  return set;
}
function simFreeIntervals(occSet){
  const ivs = [];
  state.layout.forEach(row => {
    let run = null;
    for(let i=0;i<row.seats;i++){
      const free = !occSet.has(seatKey(row.id, i));
      if(free){ if(!run) run = {rowId:row.id, start:i}; run.end = i; }
      else { if(run){ run.len = run.end - run.start + 1; ivs.push(run); run = null; } }
    }
    if(run){ run.len = run.end - run.start + 1; ivs.push(run); }
  });
  return ivs;
}
function bestFitIv(ivs, k){
  const fit = ivs.filter(iv => iv.len >= k).sort((a,b) => a.len - b.len);
  return fit.length ? fit[0] : null;
}
function moveDistance(party, to){
  const fromRow = rowIndex(party.seatKeys[0].split('#')[0]);
  const fromCol = parseInt(party.seatKeys[0].split('#')[1]);
  const toRow = rowIndex(to.rowId);
  return Math.abs(fromRow - toRow) * 100 + Math.abs(fromCol - to.start);
}
// 移位方案：移动 1-2 桌（整桌、原子）拼出 >=k 的连续块；桌数最少 → 距离最短 → 块浪费最小
function shiftPlanFor(k){
  if(!state.shiftSeating || k < 1) return null;
  const baseOcc = occupiedKeySet();
  if(bestFitIv(simFreeIntervals(baseOcc), k)) return null; // 本来就有整块
  const movable = movableParties();
  if(!movable.length) return null;
  const MAX_DEST = 3;
  function destsFor(p){
    return simFreeIntervals(baseOcc)
      .filter(iv => iv.len >= p.size)
      .sort((a,b) => (a.len - p.size) - (b.len - p.size))
      .slice(0, MAX_DEST)
      .map(iv => ({rowId:iv.rowId, start:iv.start, end:iv.end, len:iv.len}));
  }
  let best = null;
  function consider(moves){
    const occ = new Set(baseOcc);
    const destKeys = [];
    for(const m of moves){
      m.party.seatKeys.forEach(k => occ.delete(k));
      for(let i=0;i<m.party.size;i++){
        const key = seatKey(m.to.rowId, m.to.start + i);
        if(occ.has(key) || destKeys.includes(key)) return;
        destKeys.push(key);
      }
    }
    destKeys.forEach(k => occ.add(k));
    const block = bestFitIv(simFreeIntervals(occ), k);
    if(!block) return;
    const score = {
      moves: moves.length,
      dist: moves.reduce((s,m) => s + moveDistance(m.party, m.to), 0),
      waste: block.len - k
    };
    const cur = best ? best.score : null;
    if(!cur ||
       score.moves < cur.moves ||
       (score.moves === cur.moves && (score.dist < cur.dist || (score.dist === cur.dist && score.waste < cur.waste)))){
      best = {moves, score, block};
    }
  }
  for(const p of movable){
    for(const to of destsFor(p)) consider([{party:p, to}]);
  }
  if(!best){
    for(let i=0;i<movable.length;i++){
      for(let j=i+1;j<movable.length;j++){
        const p1 = movable[i], p2 = movable[j];
        for(const d1 of destsFor(p1)){
          for(const d2 of destsFor(p2)) consider([{party:p1, to:d1}, {party:p2, to:d2}]);
        }
      }
    }
  }
  return best ? {moves: best.moves, block: best.block, score: best.score} : null;
}
function partyPosText(p){
  return rowLabel(p.seatKeys[0].split('#')[0]) + ' ' + (p.seatKeys.map(k => parseInt(k.split('#')[1])+1).join('-')) + ' 号';
}
function executeShiftPlan(plan, beneficiary){
  for(const m of plan.moves){
    const p = state.parties[m.party.id];
    if(!p || p.seatKeys.length !== m.party.seatKeys.length || !p.seatKeys.every((k,i) => k === m.party.seatKeys[i])){
      toast('⚠️ 位置已变化，请重新操作'); renderAll(); return;
    }
    for(let i=0;i<p.size;i++){
      const key = seatKey(m.to.rowId, m.to.start + i);
      const st = state.seatStates[key];
      if(!st || st.st !== 'free'){ toast('⚠️ 落点已被占用，请重新操作'); renderAll(); return; }
    }
  }
  plan.moves.forEach(m => {
    const p = state.parties[m.party.id];
    p.seatKeys.forEach(k => { state.seatStates[k] = {st:'free'}; });
    const newKeys = [];
    for(let i=0;i<p.size;i++){
      const key = seatKey(m.to.rowId, m.to.start + i);
      state.seatStates[key] = {st:'occ', party:p.id};
      newKeys.push(key);
    }
    p.seatKeys = newKeys;
  });
  save(); renderAll();
  toast('📦 已移位拼座，空出 '+rowLabel(plan.block.rowId)+' '+(plan.block.start+1)+'-'+(plan.block.end+1)+' 号');
  logEvent('shift', {size: beneficiary.k, moves: plan.moves.length});
  shiftCtx = null;
  hideModal('mShift');
  if(beneficiary.kind === 'queue'){
    const q = state.queue.find(x => x.id === beneficiary.qid);
    if(q) startSelection(q.size, q.note, q.id);
  }else{
    startSelection(beneficiary.k, beneficiary.note, null);
  }
}

/* ========== 统计与仿真（P4）========== */
function avgMealDuration(){
  const leaves = (state.log||[]).filter(e => e.type === 'leave');
  if(!leaves.length) return 60;
  const avg = leaves.reduce((s,e)=>s+(e.detail.durationMs||0),0) / leaves.length / 60000;
  return Math.max(20, Math.min(180, Math.round(avg)));
}
// 排队桌等待预估：按平均就餐时长模拟未来离座，估算何时能凑出 >=k 的连续块
function estimateWait(k){
  if(candidatesFor(k).length) return 0;
  const avg = avgMealDuration();
  const deps = Object.values(state.parties)
    .filter(p => !p.split)              // 拆坐桌不单独离座（整桌合并后统一算）
    .map(p => ({at: p.seatedAt + avg*60000, keys: p.seatKeys.slice()}))
    .sort((a,b) => a.at - b.at);
  const occ = new Set(occupiedKeySet());
  let t = 0;
  for(const d of deps){
    t = Math.max(t, d.at - Date.now());
    d.keys.forEach(k => occ.delete(k));
    if(bestFitIv(simFreeIntervals(occ), k)) return Math.max(0, Math.round(t/60000));
  }
  return null; // 无法预估（未来离座也凑不出）
}
function computeMetrics(){
  const log = state.log || [];
  const seatedEvts = log.filter(e => e.type === 'seated');
  const desks = seatedEvts.length;
  const persons = seatedEvts.reduce((s,e)=>s+(e.detail.size||0),0);
  const leaves = log.filter(e => e.type === 'leave');
  const avgMeal = leaves.length ? Math.round(leaves.reduce((s,e)=>s+(e.detail.durationMs||0),0)/leaves.length/60000) : null;
  const joinT = {};
  const waits = [];
  for(const e of log){
    if(e.type === 'queue_join') joinT[e.detail.id] = e.t;
    if(e.type === 'seated' && e.detail.queueId && joinT[e.detail.queueId]) waits.push(e.t - joinT[e.detail.queueId]);
  }
  const avgWait = waits.length ? Math.round(waits.reduce((a,b)=>a+b,0)/waits.length/60000) : null;
  const p90 = waits.length ? Math.round(waits.slice().sort((a,b)=>a-b)[Math.ceil(waits.length*0.9)-1]/60000) : null;
  const c = countStats();
  const ivs = freeIntervals();
  const fragMax = ivs.length ? Math.max(...ivs.map(i=>i.len)) : 0;
  const counts = t => log.filter(e => e.type === t).length;
  const mergeOffers = counts('merge') + counts('merge_refuse');
  const shiftOffers = counts('shift') + counts('shift_refuse');
  const acc = counts('merge') + counts('shift');
  const offers = mergeOffers + shiftOffers;
  return { desks, persons, avgMeal, avgWait, p90, util: Math.round(c.occ/c.total*100), fragN: ivs.length, fragMax,
           splitN: counts('split'), mergeN: counts('merge'), mergeRefuse: counts('merge_refuse'),
           shiftN: counts('shift'), shiftRefuse: counts('shift_refuse'),
           accept: offers ? Math.round(acc/offers*100) : null };
}
function buildSimState(cfg, avgDur){
  const sim = {version:1, cleanMin:3, splitSeating:!!cfg.splitSeating, shiftSeating:!!cfg.shiftSeating,
               layout: state.layout.map(r => ({id:r.id, label:r.label, seats:r.seats})),
               seatStates:{}, parties:{}, queue:[], log:[]};
  state.layout.forEach(row => { for(let i=0;i<row.seats;i++) sim.seatStates[seatKey(row.id,i)] = {st:'free'}; });
  return sim;
}
function simSeatBestFit(size, note, t){
  const cands = candidatesFor(size);
  if(!cands.length) return false;
  const c = bestCandidate(cands);
  const pid = newId('p');
  const party = {id:pid, size, note:note||'', seatedAt:t, _leavesAt: t + simAvgMs, seatKeys:[]};
  for(let i=0;i<size;i++){
    const key = seatKey(c.rowId, c.start + i);
    state.seatStates[key] = {st:'occ', party:pid};
    party.seatKeys.push(key);
  }
  state.parties[pid] = party;
  return true;
}
// 离线仿真：用真实到店序列重放一天，对比配置。通过交换全局 state + SIM 标志复用全部算法，跑完还原。
function simulateDay(cfg){
  const arrivals = (state.log || []).filter(e => e.type === 'arrive')
    .map(e => ({t:e.t, size:e.detail.size, note:e.detail.note||''}))
    .sort((a,b) => a.t - b.t);
  if(arrivals.length < 3) return null;
  const avgMin = avgMealDuration();
  simAvgMs = avgMin * 60000;
  const saved = state;
  state = buildSimState(cfg, avgMin);
  SIM = true;
  try{
    const queue = [];
    let seated = 0, waited = 0, waitTotal = 0, maxQ = 0;
    function freeDue(t){
      for(const pid in state.parties){
        const p = state.parties[pid];
        if(p._leavesAt !== undefined && p._leavesAt <= t){
          p.seatKeys.forEach(k => { state.seatStates[k] = {st:'free'}; });
          delete state.parties[pid];
        }
      }
    }
    function seatFromQueue(t){
      let any = true;
      while(any){
        any = false;
        queue.sort((a,b) => a.since - b.since);
        for(let i=0;i<queue.length;i++){
          const q = queue[i];
          if(candidatesFor(q.size).length){
            waitTotal += t - q.since; waited++;
            simSeatBestFit(q.size, q.note, t);
            queue.splice(i,1);
            seated++; any = true;
            break;
          }
        }
      }
    }
    for(const a of arrivals){
      freeDue(a.t);
      seatFromQueue(a.t);
      if(candidatesFor(a.size).length){
        simSeatBestFit(a.size, a.note, a.t); seated++;
      }else if(cfg.splitSeating){
        const plan = splitPlanFor(a.size);
        if(plan){ applySplitPlan(plan, a.note, a.t); seated++; }
        else { queue.push({id:newId('q'), size:a.size, note:a.note, since:a.t}); maxQ = Math.max(maxQ, queue.length); }
      }else if(cfg.shiftSeating){
        const plan = shiftPlanFor(a.size);
        if(plan){ executeShiftPlan(plan, {kind:'arrival', k:a.size, note:a.note}); simSeatBestFit(a.size, a.note, a.t); seated++; }
        else { queue.push({id:newId('q'), size:a.size, note:a.note, since:a.t}); maxQ = Math.max(maxQ, queue.length); }
      }else{
        queue.push({id:newId('q'), size:a.size, note:a.note, since:a.t}); maxQ = Math.max(maxQ, queue.length);
      }
      selection = null;
    }
    // 末段消化队列：按平均就餐时长逐轮推进
    let t = arrivals.length ? arrivals[arrivals.length-1].t : Date.now();
    for(let step=0; step<240 && queue.length; step++){
      freeDue(t);
      const before = seated;
      seatFromQueue(t);
      if(seated === before) t += avgMin * 60000;
    }
    const c = countStats();
    return {
      seated,
      waitAvg: waited ? Math.round(waitTotal/waited/60000) : 0,
      maxQ, stillWaiting: queue.length,
      endOcc: c.occ, totalSeats: c.total
    };
  } finally {
    SIM = false;
    state = saved;
    selection = null;
    shiftCtx = null;
  }
}
