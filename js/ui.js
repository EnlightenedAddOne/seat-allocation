"use strict";
/* ═══════════════════════════════════════════════════════════════
   ui.js —— DOM 助手 · 全部渲染（统计条/座位图/排队/横幅/方案条/弹窗内容）
   依赖 core.js 提供的状态与算法；渲染结构对齐 css/style.css 的设计令牌。
   ═══════════════════════════════════════════════════════════════ */

var $ = id => document.getElementById(id);

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtTime(ts){ const d=new Date(ts); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function fmtDur(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  return Math.floor(s/60) + '分' + String(s%60).padStart(2,'0') + '秒';
}
function showModal(id){ $(id).classList.add('open'); }
function hideModal(id){ $(id).classList.remove('open'); }
function toast(msg){
  if(SIM) return;
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ── 统计条（顶栏） ── */
function statChip(dot, label, val, id){
  return '<div class="stat-chip"><span class="stat-dot" style="--dot: '+dot+'"></span>' +
    '<div><span class="stat-label">'+label+'</span><span class="stat-val" id="'+id+'">'+val+'</span></div></div>';
}
function renderStats(){
  const s = countStats();
  $('stats').innerHTML =
    statChip('var(--muted)', '总座位', s.total, 'stTotal') +
    statChip('var(--st-empty-ink)', '空位', s.free, 'stFree') +
    statChip('var(--st-occ)', '占用', s.occ, 'stOcc') +
    statChip('var(--st-clean)', '清理中', s.clean, 'stClean') +
    statChip('var(--accent)', '排队', state.queue.length, 'stQueue');
}

/* ── 座位图（按排渲染为分区卡片） ── */
function renderSeatMap(){
  const el = $('seatmap');
  let html = '';
  state.layout.forEach((row, ri) => {
    let free = 0;
    for(let i=0;i<row.seats;i++) if(seatState(row.id, i).st === 'free') free++;
    const tag = esc((row.label || 'A').charAt(0));
    html += '<section class="zone">' +
      '<div class="zone-head"><span class="zone-tag">'+tag+'</span>' +
      '<span class="zone-name">'+esc(row.label)+'</span>' +
      '<span class="zone-meta num">'+free+' / '+row.seats+' 空</span></div>' +
      '<div class="zone-rows"><div class="row"><span class="row-label num">'+(ri+1)+'</span><div class="seats">';
    for(let i=0;i<row.seats;i++){
      const k = seatKey(row.id, i);
      const st = seatState(row.id, i);
      const key = esc(k);
      if(st.st === 'occ'){
        const p = state.parties[st.party];
        let cls = 'seat st-occ';
        let info = rowLabel(row.id)+' '+(i+1)+' 号 · 有人';
        if(p){
          info = rowLabel(row.id)+' '+(i+1)+' 号 · '+p.size+' 人 · '+fmtTime(p.seatedAt)+' 入座';
          if(p.split){
            info = '🔗 拆坐中 · '+info+'（'+p.parts.map(pp=>rowLabel(pp.rowId)+' '+(pp.start+1)+'-'+(pp.end+1)).join(' + ')+'）';
            cls += ' split';
          }else if(p.dnd){
            info += ' · 🚫免打扰';
            cls += ' dnd';
          }
        }
        html += '<div class="'+cls+'" data-key="'+key+'" data-party="'+esc(st.party)+'" title="'+esc(info)+'">'+(p?p.size:'?')+'</div>';
      }else if(st.st === 'clean'){
        const remain = Math.max(0, st.until - Date.now());
        html += '<div class="seat st-clean" data-key="'+key+'" title="清理中 '+fmtDur(remain)+'">'+fmtDur(remain)+'</div>';
      }else{
        let cls = 'seat';
        if(selection){
          const ci = selection.cands.findIndex(c => c.rowId === row.id && i >= c.start && i <= c.end);
          if(ci >= 0){
            cls += ' cand';
            const best = bestCandidate(selection.cands);
            if(best && best.rowId === row.id && best.start === selection.cands[ci].start) cls += ' rec';
          }
        }
        html += '<div class="'+cls+'" data-key="'+key+'" title="'+esc(rowLabel(row.id)+' '+(i+1)+' 号 · 空')+'"></div>';
      }
    }
    html += '</div></div></div></section>';
  });
  el.innerHTML = html;
}

/* ── 排队面板 ── */
function renderQueue(){
  $('qcnt').textContent = state.queue.length + ' 桌';
  const el = $('qlist');
  if(!state.queue.length){
    el.innerHTML = '<div class="q-empty">暂无排队，可直接来客入座</div>';
    return;
  }
  let html = '';
  state.queue.slice().sort((a,b) => a.since - b.since).forEach(q => {
    const fit = candidatesFor(q.size).length > 0;
    const shiftOk = !fit && !!shiftPlanFor(q.size);
    const est = fit ? 0 : estimateWait(q.size);
    let btn = '<button type="button" class="btn btn-secondary btn-sm" disabled>暂无可坐</button>';
    if(fit) btn = '<button type="button" class="btn btn-primary btn-sm" data-qseat="'+esc(q.id)+'">安排入座</button>';
    else if(shiftOk) btn = '<button type="button" class="btn btn-secondary btn-sm" data-qshift="'+esc(q.id)+'">📦 移位拼座</button>';
    html += '<div class="q-item">' +
      '<div class="q-main">' +
      '<span class="q-party">'+q.size+'<small>人</small></span>' +
      '<span class="q-info">' +
      '<span class="q-wait">已等 '+fmtDur(Date.now()-q.since)+'</span>' +
      (est!=null && est>0 ? '<span class="q-est">预计还需约 '+est+' 分钟</span>' : '') +
      (q.note ? '<span class="q-est">'+esc(q.note)+'</span>' : '') +
      '</span></div>' +
      '<div class="q-actions">' + btn +
      '<button type="button" class="icon-btn danger" data-qdrop="'+esc(q.id)+'" aria-label="移出排队"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6.5 7l1 13h9l1-13"/></svg></button>' +
      '</div></div>';
  });
  el.innerHTML = html;
}

/* ── 选位横幅 + 方案条 ── */
function renderSelBar(){
  const bar = $('selBar');
  if(!selection){
    bar.classList.add('hidden');
    $('candBar').classList.add('hidden');
    return;
  }
  const cands = selection.cands;
  const best = bestCandidate(cands);
  bar.classList.remove('hidden');
  $('selTxt').innerHTML =
    '正在为 <b>'+selection.k+' 人桌</b>选位'+(selection.note?'（'+esc(selection.note)+'）':'')+
    '：找到 <b>'+cands.length+'</b> 个连续空位方案，蓝色为可选，★ 为推荐。';
  $('candBar').classList.remove('hidden');
  $('candChips').innerHTML = cands.map((c,i) => {
    const isBest = best && best.rowId === c.rowId && best.start === c.start;
    return '<button type="button" class="cand-chip'+(isBest?' rec-chip':'')+'" data-cand="'+c.rowId+'">' +
      '<span class="cand-idx">'+(i+1)+'</span>' +
      (isBest ? '<span class="cand-star">★</span>' : '') +
      '<span>'+esc(rowLabel(c.rowId)+' '+(c.start+1)+'-'+(c.end+1)+' 号')+(c.len > selection.k ? '（'+c.len+' 空取 '+selection.k+'）' : '')+'</span>' +
      '</button>';
  }).join('');
}

/* ── 拆坐合并提示条 ── */
function renderMergeBar(){
  const bar = $('mergeBar');
  const sugs = mergeSuggestions();
  if(!sugs.length){ bar.classList.add('hidden'); return; }
  const s = sugs[0];
  bar.classList.remove('hidden');
  $('mergeTxt').innerHTML =
    '🔗 <b>'+s.party.size+' 人桌</b>（拆坐中）可合并到 <b>'+esc(rowLabel(s.target.rowId)+' '+(s.target.start+1)+'-'+(s.target.start+s.party.size)+' 号')+'</b>';
  $('btnMergeOpen').onclick = () => openMergeConfirm(s.party, s.target);
  $('btnMergeLater').onclick = () => { mergeDismissed[s.party.id] = true; renderAll(); };
}

function renderAll(){ if(SIM) return; renderStats(); renderSeatMap(); renderQueue(); renderSelBar(); renderMergeBar(); }

/* ── 合并确认弹窗 ── */
function openMergeConfirm(party, target){
  $('mgInfo').innerHTML =
    '<b>'+party.size+' 人桌</b>（拆坐中 🔗 '+party.parts.map(p=>rowLabel(p.rowId)+' '+(p.start+1)+'-'+(p.end+1)).join(' + ')+'）'+
    '<br>目标：<b>'+esc(rowLabel(target.rowId))+' '+(target.start+1)+'-'+(target.start+party.size)+' 号</b>'+
    '（'+target.len+' 连座）';
  const seats = [];
  for(let i=0;i<party.size;i++) seats.push(seatName(target.rowId, target.start + i));
  $('mgSeats').innerHTML = seats.map(s => '<span class="seat-chip">'+esc(s)+'</span>').join('');
  $('btnMgGo').onclick = () => { hideModal('mMerge'); mergeParty(party.id, target); };
  $('btnMgNo').onclick = () => {
    party.refuseMerge = true;
    hideModal('mMerge');
    logEvent('merge_refuse', {size: party.size});
    save(); renderAll();
    toast('已记录：该桌不再提议合并');
  };
  showModal('mMerge');
}

/* ── 移位拼座确认弹窗 ── */
const ICON_ARROW = '<svg class="shift-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
function openShiftConfirm(plan, beneficiary){
  shiftCtx = {plan, beneficiary};
  const rows = plan.moves.map((m,i) =>
    '<div class="shift-row">' +
    '<span class="shift-node from"><span class="k">'+esc(partyPosText(m.party))+'</span><span class="m">'+m.party.size+' 人 · 现位置</span></span>' +
    ICON_ARROW +
    '<span class="shift-node to"><span class="k">'+esc(rowLabel(m.to.rowId)+' '+(m.to.start+1)+'-'+(m.to.start+m.party.size)+' 号')+'</span><span class="m">移往目标</span></span>' +
    '<button type="button" class="btn btn-danger btn-sm" data-shift-refuse="'+esc(m.party.id)+'">这桌拒绝</button>' +
    '</div>'
  ).join('');
  let ben = '给来店的 <b>'+beneficiary.k+' 人桌</b>';
  if(beneficiary.kind === 'queue'){
    const q = state.queue.find(x => x.id === beneficiary.qid);
    ben = '给排队'+(q ? ' <b>'+fmtDur(Date.now()-q.since)+'</b>' : '')+'的 <b>'+beneficiary.k+' 人桌</b>';
  }
  $('shInfo').innerHTML =
    '<p class="cf-info"><b>移动桌数：'+plan.score.moves+' 桌</b>（整桌原子移动，任一桌拒绝则整案取消）<br>' +
    '拼出空块：<b>'+esc(rowLabel(plan.block.rowId))+' '+(plan.block.start+1)+'-'+(plan.block.end+1)+' 号</b>（'+plan.block.len+' 连座）→ '+ben+'</p>' +
    rows;
  hideModal('mNoFit');
  showModal('mShift');
}

/* ── 营业统计弹窗 ── */
function mcard(label, numHTML){
  return '<div class="mcard"><div class="mcard-num">'+numHTML+'</div><div class="mcard-label">'+label+'</div></div>';
}
function renderStatsModal(){
  const m = computeMetrics();
  const min = v => v==null ? '-' : v+'<small>分钟</small>';
  $('statsBody').innerHTML =
    mcard('今日接待桌数', m.desks) + mcard('接待人次', m.persons) +
    mcard('平均就餐时长', min(m.avgMeal)) +
    mcard('当前上座率', m.util+'<small>%</small>') +
    mcard('平均等待（排队的）', min(m.avgWait)) +
    mcard('P90 等待', min(m.p90)) +
    mcard('拆坐 / 合并', m.splitN+' / '+m.mergeN+(m.mergeRefuse?'<small>拒 '+m.mergeRefuse+'</small>':'')) +
    mcard('移位 / 拒绝', m.shiftN+' / '+m.shiftRefuse) +
    mcard('建议接受率', m.accept==null?'-':m.accept+'<small>%</small>') +
    mcard('当前空区间', m.fragN+'<small>个 · 最大 '+m.fragMax+' 连座</small>') +
    mcard('排队预估基准', (m.avgMeal==null?'默认 60':m.avgMeal)+'<small>分钟/餐</small>') +
    mcard('日志事件数', (state.log||[]).length);
  $('btnSim').onclick = runSimCompare;
  $('simResult').classList.add('hidden');
}
function runSimCompare(){
  const cfgs = [
    {name:'全关（纯贴边 best-fit）', splitSeating:false, shiftSeating:false},
    {name:'开拆坐', splitSeating:true, shiftSeating:false},
    {name:'开移位', splitSeating:false, shiftSeating:true},
    {name:'全开（拆坐+移位）', splitSeating:true, shiftSeating:true}
  ];
  const rows = [];
  let bestName = null;
  cfgs.forEach(cfg => { rows.push({name:cfg.name, r: simulateDay(cfg)}); });
  const okRows = rows.filter(x => x.r);
  if(okRows.length){
    okRows.sort((a,b) => b.r.seated - a.r.seated || a.r.waitAvg - b.r.waitAvg || a.r.stillWaiting - b.r.stillWaiting);
    bestName = okRows[0].name;
  }
  let html = '<table class="sim-table"><tr><th>配置</th><th class="num-col">接待桌数</th><th class="num-col">平均等待</th><th class="num-col">排队滞留</th><th class="num-col">末态上座</th></tr>';
  rows.forEach(x => {
    if(!x.r){ html += '<tr><td>'+esc(x.name)+'</td><td colspan="4">样本不足（今日到店记录 &lt; 3 桌）</td></tr>'; return; }
    const best = x.name === bestName;
    html += '<tr'+(best?' class="current"':'')+'><td>'+esc(x.name)+(best?' ★':'')+'</td><td class="num-col">'+x.r.seated+'</td><td class="num-col">'+(x.r.waitAvg ? x.r.waitAvg+' 分钟' : '0')+'</td><td class="num-col">'+x.r.stillWaiting+'</td><td class="num-col">'+x.r.endOcc+'/'+x.r.totalSeats+'</td></tr>';
  });
  html += '</table>';
  if(bestName) html += '<p class="sim-note">★ 当前客流下综合最优：'+esc(bestName)+'</p>';
  html += '<p class="sim-note">仿真用今日真实到店序列 + 平均就餐时长 '+avgMealDuration()+' 分钟重放，纯内存计算，不改动营业数据。</p>';
  $('simResult').innerHTML = html;
  $('simResult').classList.remove('hidden');
}

/* ── 布局设置弹窗 ── */
function renderLayoutModal(){
  const el = $('layoutRows');
  el.innerHTML = state.layout.map((row, ri) =>
    '<div class="layout-row">' +
    '<input class="input" type="text" value="'+esc(row.label)+'" placeholder="排名称（如 E区/靠窗）" data-lbl="'+ri+'">' +
    '<input class="input small" type="number" min="1" max="40" value="'+row.seats+'" data-seats="'+ri+'">' +
    '<button type="button" class="btn btn-danger btn-sm" data-del="'+ri+'">删除</button>' +
    '</div>'
  ).join('');
  $('chkSplit').checked = !!state.splitSeating;
  $('chkShift').checked = !!state.shiftSeating;
  showModal('mLayout');
}
