"use strict";
/* ═══════════════════════════════════════════════════════════════
   app.js —— 交互 · 事件绑定 · 定时器 · 启动
   依赖 core.js（状态/算法）与 ui.js（渲染/弹窗）。
   ═══════════════════════════════════════════════════════════════ */

/* ========== 人数步进 ========== */
function getK(){ return Math.max(1, Math.min(20, parseInt($('seatK').textContent) || 1)); }
function setK(n){ $('seatK').textContent = Math.max(1, Math.min(20, n)); renderQuick(); }
function renderQuick(){
  const max = Math.min(10, maxRowSeats());
  const cur = getK();
  $('quickBtns').innerHTML = [1,2,3,4,5,6].slice(0, Math.max(3,max))
    .map(n => '<button type="button" class="quick-btn'+(n===cur?' on':'')+'" data-q="'+n+'">'+n+'</button>').join('');
}

/* ========== 来客入座 / 排队 ========== */
function openSeatModal(preK){
  setK(preK || 2);
  $('seatNote').value = '';
  showModal('mSeat');
}
function openQueueModal(preK){
  setK(preK || 2);
  $('seatNote').value = '';
  $('mSeat').querySelector('.modal-title').textContent = '⏳ 加入排队';
  $('btnSeatGo').textContent = '加入排队';
  $('btnSeatGo').dataset.mode = 'queue';
  showModal('mSeat');
}
function addToQueue(k, note){
  const qid = newId('q');
  state.queue.push({id:qid, size:k, note:note||'', since:Date.now()});
  logEvent('arrive', {size:k, note:note||''});
  logEvent('queue_join', {id:qid, size:k});
  save(); renderAll();
  toast('⏳ 已加入排队：'+k+' 人桌'+(note?'（'+note+'）':''));
}
function seatQueueItem(qid){
  const q = state.queue.find(x => x.id === qid);
  if(!q) return;
  if(startSelection(q.size, q.note, qid)) toast('为队列中的 '+q.size+' 人桌选位');
  else toast('暂无可坐位置，继续排队');
}

/* ========== 选位 / 入座 ========== */
function startSelection(k, note, queueId){
  const cands = candidatesFor(k);
  selection = {k, note: note||'', queueId: queueId||null, cands};
  if(cands.length === 0){
    selection = null;
    return false;
  }
  hideModal('mSeat'); hideModal('mNoFit');
  renderAll();
  return true;
}
function selectCandidate(rowId){
  if(!selection) return;
  const c = selection.cands.find(x => x.rowId === rowId);
  if(!c) return;
  const k = selection.k;
  const blockStart = c.start;                    // 贴边：从空块左端起坐
  const seats = [];
  for(let i=0;i<k;i++) seats.push(seatName(c.rowId, blockStart + i));
  $('cfInfo').innerHTML =
    '<b>'+selection.k+' 人桌</b>'+(selection.note?' · '+esc(selection.note):'')+
    '<br>位置：<b>'+esc(rowLabel(c.rowId))+' '+(blockStart+1)+'-'+(blockStart+k)+' 号</b>'+
    (c.len > k ? '（该空块共 '+c.len+' 座，贴边入座，剩余 '+ (c.len-k) +' 座保持完整）' : '');
  $('cfSeats').innerHTML = seats.map(s => '<span class="seat-chip">'+esc(s)+'</span>').join('');
  showModal('mConfirm');
}
function confirmSeat(){
  if(!selection) return;
  const k = selection.k, note = selection.note, queueId = selection.queueId;
  const c = selection.cands.find(x => x.rowId === selection.pendingRow);
  if(!c) return;
  hideModal('mConfirm');
  const pid = newId('p');
  const party = {id:pid, size:k, note:note, seatedAt:Date.now(), seatKeys:[]};
  for(let i=0;i<k;i++){
    const key = seatKey(c.rowId, c.start + i);
    state.seatStates[key] = {st:'occ', party:pid};
    party.seatKeys.push(key);
  }
  state.parties[pid] = party;
  logEvent('seated', {size:k, seats: party.seatKeys.slice(), queueId: queueId||null});
  if(!queueId) logEvent('arrive', {size:k, note:note});
  if(queueId){
    state.queue = state.queue.filter(q => q.id !== queueId);
  }
  selection = null;
  save(); renderAll();
  toast('✅ 已安排 '+k+' 人入座 '+rowLabel(c.rowId)+' '+(c.start+1)+'-'+(c.start+k)+' 号');
}

/* ========== 座位操作 ========== */
function openSeatOp(partyId){
  const p = state.parties[partyId];
  if(!p) return;
  $('mSeatOpTitle').textContent = '👥 '+p.size+' 人桌'+(p.split ? ' · 🔗 拆坐中' : '');
  let loc = '位置：'+p.seatKeys.map(k => { const [rid, i] = k.split('#'); return seatName(rid, parseInt(i)); }).join('、');
  if(p.split && p.parts) loc = '拆坐 🔗：'+p.parts.map(pp => rowLabel(pp.rowId)+' '+(pp.start+1)+'-'+(pp.end+1)+' 号').join(' + ');
  const flags = [];
  if(p.split) flags.push('拆坐中🔗');
  if(p.refuseShift) flags.push('拒过移位✗');
  if(p.refuseMerge) flags.push('拒过合并✗');
  if(p.dnd) flags.push('免打扰🚫');
  $('soInfo').innerHTML =
    '<div class="so-item"><span class="l">人数</span><span class="v">'+p.size+' 人</span></div>' +
    '<div class="so-item"><span class="l">入座</span><span class="v">'+fmtTime(p.seatedAt)+'</span></div>' +
    '<div class="so-item"><span class="l">已坐</span><span class="v">'+fmtDur(Date.now()-p.seatedAt)+'</span></div>' +
    '<div class="so-item"><span class="l">标记</span><span class="v">'+(flags.length?flags.join(' '):'—')+'</span></div>' +
    '<div class="so-item" style="grid-column:1/-1"><span class="l">位置</span><span class="v">'+esc(loc)+'</span></div>' +
    (p.note ? '<div class="so-item" style="grid-column:1/-1"><span class="l">备注</span><span class="v">'+esc(p.note)+'</span></div>' : '');
  let actions =
    '<button type="button" class="btn btn-danger" id="soLeave3">💺 离座（清理 '+state.cleanMin+' 分钟）</button>' +
    '<button type="button" class="btn btn-secondary" id="soLeave0">离座（立即空）</button>';
  if(p.split && !p.refuseMerge && candidatesFor(p.size).length){
    actions += '<button type="button" class="btn btn-secondary" id="soMerge">🔗 提议合并</button>';
  }
  actions += '<button type="button" class="btn btn-ghost" id="soDnd">'+(p.dnd?'🚫 取消免打扰':'🚫 标记免打扰')+'</button>';
  $('soActions').innerHTML = actions;
  showModal('mSeatOp');
  $('soLeave3').onclick = () => { leaveParty(partyId, state.cleanMin); };
  $('soLeave0').onclick = () => { leaveParty(partyId, 0); };
  const mg = $('soMerge');
  if(mg) mg.onclick = () => { hideModal('mSeatOp'); openMergeConfirm(p, bestCandidate(candidatesFor(p.size))); };
  const sd = $('soDnd');
  if(sd) sd.onclick = () => {
    p.dnd = !p.dnd;
    save(); hideModal('mSeatOp'); renderAll();
    toast(p.dnd ? '🚫 已标记免打扰，移位方案不再包含该桌' : '已取消免打扰');
  };
}
function leaveParty(partyId, cleanMin){
  const p = state.parties[partyId];
  if(!p) return;
  p.seatKeys.forEach(k => {
    state.seatStates[k] = cleanMin > 0
      ? {st:'clean', until: Date.now() + cleanMin*60000}
      : {st:'free'};
  });
  delete state.parties[partyId];
  logEvent('leave', {size:p.size, durationMs: Date.now()-p.seatedAt, cleanMin});
  hideModal('mSeatOp');
  save(); renderAll();
  toast('💺 客人离座'+(cleanMin>0 ? '，座位进入清理 '+cleanMin+' 分钟' : '，座位已空'));
}

/* ========== 无空位 · 方案卡 ========== */
const ICON_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
const ICON_SWAP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>';
function planCard(iconCls, iconSvg, title, desc, ctaId, ctaText){
  return '<div class="plan-card">' +
    '<span class="plan-icon '+iconCls+'">'+iconSvg+'</span>' +
    '<div><div class="plan-title">'+title+'</div><div class="plan-desc">'+desc+'</div></div>' +
    '<button type="button" class="btn btn-primary btn-sm plan-cta" id="'+ctaId+'">'+ctaText+'</button>' +
    '</div>';
}

/* ========== 事件绑定 ========== */
$('btnSeat').onclick = () => {
  $('btnSeatGo').textContent = '查看可选位置 →';
  $('btnSeatGo').dataset.mode = 'seat';
  $('mSeat').querySelector('.modal-title').textContent = '来客入座';
  openSeatModal(2);
};
$('btnQueue').onclick = () => openQueueModal(2);
$('seatDec').onclick = () => setK(getK() - 1);
$('seatInc').onclick = () => setK(getK() + 1);

$('btnSeatGo').onclick = () => {
  const k = getK(), note = $('seatNote').value.trim();
  if($('btnSeatGo').dataset.mode === 'queue'){
    addToQueue(k, note);
    hideModal('mSeat');
  }else{
    if(startSelection(k, note, null)){
      toast('找到 '+selection.cands.length+' 个可选位置');
    }else{
      $('nofitMsg').innerHTML = '<b>'+k+' 人桌</b>：当前所有空位都凑不出 '+k+' 个连续座位。';
      const plan = splitPlanFor(k);
      const box1 = $('splitPlanBox');
      if(plan){
        box1.innerHTML =
          planCard('link', ICON_LINK, '拆坐方案：'+k+' 人 = '+plan.parts.map(p=>p.size).join(' + '),
            plan.parts.map(p=>rowLabel(p.rowId)+' '+(p.start+1)+'-'+(p.end+1)+' 号').join('、') + ' · 出现大块后自动提议合并', 'btnSplitGo', '拆坐入座') +
          '<button type="button" class="btn btn-ghost btn-sm" id="btnSplitNo">暂不拆（加入排队）</button>';
        box1.classList.remove('hidden');
        $('btnSplitGo').onclick = () => {
          const plan2 = splitPlanFor(k);
          if(!plan2){ toast('位置已变化，请重试'); renderAll(); return; }
          hideModal('mNoFit');
          applySplitPlan(plan2, note);
        };
        $('btnSplitNo').onclick = () => {
          box1.classList.add('hidden');
          $('nofitMsg').innerHTML += '<br>可加入排队，空出大块后自动安排。';
        };
      }else{
        box1.classList.add('hidden');
      }
      const splan = shiftPlanFor(k);
      const box2 = $('shiftPlanBox');
      if(splan){
        box2.innerHTML =
          planCard('swap', ICON_SWAP, '移位拼座方案',
            splan.moves.map(m=>'移动 '+partyPosText(m.party)+'（'+m.party.size+' 人）→ '+rowLabel(m.to.rowId)+' '+(m.to.start+1)+'-'+(m.to.start+m.party.size)+' 号').join('；') +
            ' · 可空出 '+rowLabel(splan.block.rowId)+' '+(splan.block.start+1)+'-'+(splan.block.end+1)+' 号（'+splan.block.len+' 连座）', 'btnShiftGo', '移位拼座') +
          '<button type="button" class="btn btn-ghost btn-sm" id="btnShiftNo">暂时不</button>';
        box2.classList.remove('hidden');
        $('btnShiftGo').onclick = () => {
          const plan2 = shiftPlanFor(k);
          if(!plan2){ toast('位置已变化，请重试'); renderAll(); return; }
          openShiftConfirm(plan2, {kind:'arrival', k, note});
        };
        $('btnShiftNo').onclick = () => box2.classList.add('hidden');
      }else{
        box2.classList.add('hidden');
      }
      hideModal('mSeat');
      showModal('mNoFit');
    }
  }
};
$('btnNfQueue').onclick = () => {
  addToQueue(getK(), $('seatNote').value.trim());
  hideModal('mNoFit');
};

$('btnCfGo').onclick = confirmSeat;
$('btnSelCancel').onclick = () => { selection = null; renderAll(); };
$('btnShGo').onclick = () => { if(shiftCtx) executeShiftPlan(shiftCtx.plan, shiftCtx.beneficiary); };

/* 全局点击委托：data-close（关弹窗）/ data-q（快捷人数） */
document.addEventListener('click', e => {
  const dc = e.target.closest('[data-close]');
  if(dc){
    const m = dc.closest('.modal');
    if(m) hideModal(m.id);
    return;
  }
  const q = e.target.closest('[data-q]');
  if(q){ setK(parseInt(q.dataset.q, 10)); return; }
});

/* 方案条：点候选方案 */
$('candChips').addEventListener('click', e => {
  const chip = e.target.closest('[data-cand]');
  if(chip && selection){
    selection.pendingRow = chip.dataset.cand;
    selectCandidate(chip.dataset.cand);
  }
});

/* 排队面板：安排入座 / 移位拼座 / 移出 */
$('qlist').addEventListener('click', e => {
  const s = e.target.closest('[data-qseat]');
  if(s){ seatQueueItem(s.dataset.qseat); return; }
  const sh = e.target.closest('[data-qshift]');
  if(sh){
    const q = state.queue.find(x => x.id === sh.dataset.qshift);
    if(q){
      const plan = shiftPlanFor(q.size);
      if(plan) openShiftConfirm(plan, {kind:'queue', qid:q.id, k:q.size, note:q.note});
      else toast('暂无可行的移位方案');
    }
    return;
  }
  const d = e.target.closest('[data-qdrop]');
  if(d){
    const q0 = state.queue.find(q => q.id === d.dataset.qdrop);
    state.queue = state.queue.filter(q => q.id !== d.dataset.qdrop);
    if(q0) logEvent('queue_drop', {id: q0.id, size: q0.size});
    save(); renderAll();
    toast('已移出排队');
  }
});

/* 移位确认：这桌拒绝 */
$('shInfo').addEventListener('click', e => {
  const b = e.target.closest('[data-shift-refuse]');
  if(!b) return;
  const p = state.parties[b.dataset.shiftRefuse];
  if(p) p.refuseShift = true;
  hideModal('mShift'); hideModal('mNoFit');
  shiftCtx = null;
  logEvent('shift_refuse', {size: p ? p.size : 0});
  save(); renderAll();
  toast('已记录该桌拒绝移位，不再提议它');
});

/* 座位图点击 */
$('seatmap').addEventListener('click', e => {
  const seat = e.target.closest('.seat');
  if(!seat) return;
  const key = seat.dataset.key;
  const rowId = key.split('#')[0], idx = parseInt(key.split('#')[1]);
  const st = state.seatStates[key];
  if(selection){
    const cand = selection.cands.find(x => x.rowId === rowId && idx >= x.start && idx <= x.end);
    if(cand){ selection.pendingRow = cand.rowId; selectCandidate(cand.rowId); }
    return;
  }
  if(st && st.st === 'occ'){
    openSeatOp(st.party);
  }else if(st && st.st === 'clean'){
    $('mSeatOpTitle').textContent = '🧹 清理中';
    $('soInfo').innerHTML = '<div class="so-item" style="grid-column:1/-1"><span class="l">清理中</span><span class="v">'+seatName(rowId, idx)+' · 剩余 '+fmtDur(Math.max(0, st.until - Date.now()))+'</span></div>';
    $('soActions').innerHTML =
      '<button type="button" class="btn btn-primary" id="soClean">完成清理（变空）</button>';
    showModal('mSeatOp');
    $('soClean').onclick = () => {
      state.seatStates[key] = {st:'free'};
      logEvent('clean_done', {key});
      save(); hideModal('mSeatOp'); renderAll();
      toast('🧹 '+seatName(rowId, idx)+' 已清理完毕');
    };
  }
});

/* 重置今日 */
$('btnReset').onclick = () => {
  if(!confirm('重置今日：清空所有占用 / 清理中 / 排队（保留布局设置）。确定？')) return;
  state.seatStates = {}; state.parties = {}; state.queue = [];
  logEvent('reset', {});
  ensureAllSeats();
  save(); renderAll();
  toast('🔄 已重置今日营业状态');
};

/* 布局设置 */
$('btnLayout').onclick = renderLayoutModal;
$('btnLayoutSave').onclick = saveLayout;
$('btnAddRow').onclick = () => {
  const n = state.layout.length + 1;
  const name = ($('addName').value || '').trim() || ('第'+n+'排');
  const cnt = Math.max(1, Math.min(40, parseInt($('addCount').value) || 8));
  state.layout.push({id:newId('r'), label:name, seats:cnt});
  $('addName').value = ''; $('addCount').value = '';
  renderLayoutModal();
};
$('btnDemo').onclick = () => {
  if(!confirm('恢复演示布局将重置全部状态（含占用和排队），确定？')) return;
  state.layout = demoLayout(); state.seatStates = {}; state.parties = {}; state.queue = [];
  ensureAllSeats(); save(); hideModal('mLayout'); renderAll();
  toast('已恢复演示布局');
};
$('layoutRows').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if(!del) return;
  const ri = parseInt(del.dataset.del);
  if(state.layout.length <= 1){ toast('至少保留一排'); return; }
  state.layout.splice(ri, 1);
  renderLayoutModal();
});
$('layoutRows').addEventListener('input', e => {
  const lbl = e.target.closest('[data-lbl]');
  if(lbl){ state.layout[parseInt(lbl.dataset.lbl)].label = lbl.value.trim() || ('第'+(parseInt(lbl.dataset.lbl)+1)+'排'); }
  const seats = e.target.closest('[data-seats]');
  if(seats){
    const n = Math.max(1, Math.min(40, parseInt(seats.value) || 1));
    state.layout[parseInt(seats.dataset.seats)].seats = n;
  }
});
function saveLayout(){
  // 重新生成座位状态，保留原 key 的状态
  const next = {};
  const keys = new Set();
  state.layout.forEach(row => { for(let i=0;i<row.seats;i++) keys.add(seatKey(row.id, i)); });
  let lost = 0;
  for(const k in state.seatStates){
    if(keys.has(k)) next[k] = state.seatStates[k];
    else if(state.seatStates[k].st === 'occ') lost++;
  }
  for(const k of keys) if(!next[k]) next[k] = {st:'free'};
  // 桌引用了被删座位 → 释放该桌
  for(const pid in state.parties){
    const p = state.parties[pid];
    p.seatKeys = p.seatKeys.filter(k => keys.has(k));
    if(p.seatKeys.length === 0) delete state.parties[pid];
  }
  state.seatStates = next;
  state.splitSeating = $('chkSplit').checked;
  state.shiftSeating = $('chkShift').checked;
  save(); hideModal('mLayout'); renderAll();
  toast(lost ? '布局已保存（'+lost+' 个被删座位上的客人已释放，请重新安排）' : '布局已保存');
}

/* 统计 */
$('btnStats').onclick = () => { renderStatsModal(); showModal('mStats'); };

/* ========== 定时器：清理倒计时 / 排队时长 ========== */
setInterval(() => {
  let changed = false;
  for(const k in state.seatStates){
    const st = state.seatStates[k];
    if(st.st === 'clean' && st.until <= Date.now()){
      state.seatStates[k] = {st:'free'};
      changed = true;
    }
  }
  if(changed){ save(); renderAll(); return; }
  // 只更新倒计时文本
  document.querySelectorAll('.seat.st-clean').forEach(n => {
    const key = n.dataset.key;
    if(!key) return;
    const st = state.seatStates[key];
    if(st && st.st === 'clean') n.textContent = fmtDur(Math.max(0, st.until - Date.now()));
  });
}, 1000);
setInterval(() => { renderQueue(); }, 10000);

/* ========== 启动 ========== */
ensureAllSeats();
save();
renderAll();
