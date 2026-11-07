var editingAccountId = null;
const titles = {
  dashboard: '资产总览',
  investments: '金融投资',
  fx:'汇率管理',
  accounts: '资产账户',
  transactions: '收支流水',
  budgets: '预算预警',
  reports: '分析报告'
};

const state = {
  accounts: [],
  transactions: [],
  budgets: [],
  entryType: 'expense'
};

const money = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  maximumFractionDigits: 0
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (response.status === 401) {
    location.href = '/app/fm/login.html';
    throw new Error('登录已过期');
  }
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(window.hengziToastTimer);
  window.hengziToastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function switchView(name) {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `${name}View`));
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  document.getElementById('pageTitle').textContent = titles[name];
  document.querySelector('.top-actions').hidden=name!=='transactions';
  if(name==='investments')loadInvestments();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'dashboard') loadTrend();
  if (name === 'fx') loadFxManagement().catch(e=>showToast(e.message));
  if (name === 'accounts') loadAccounts();
  if (name === 'transactions') loadTransactions();
  if (name === 'budgets') loadBudgets();
  if(name==='reports')loadAssetAnalysis();
  if (name === 'reports') loadReport(document.querySelector('[data-period].active')?.dataset.period || 'month');
}

function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

async function loadSummary() {
  const summary = await api('/app/fm/api/summary');
  const values = document.querySelectorAll('#dashboardView .metric-value');
  values[0].textContent = money.format(summary.netWorth);
  values[1].textContent = money.format(summary.assets);
  values[2].textContent = money.format(summary.liabilities);
  values[3].textContent = money.format(summary.disposable);
  values[0].closest('.metric').querySelector('.metric-foot').textContent = '人民币 · 当前账户余额';
  values[1].closest('.metric').querySelector('.metric-foot').textContent = '按账户当前人民币价值汇总';
  values[2].closest('.metric').querySelector('.metric-foot').textContent = '按当前负债账户汇总';
  const foot = values[3].closest('.metric').querySelector('.metric-foot');
  foot.textContent = `人民币 · 收入 ${money.format(summary.income)} · 支出 ${money.format(summary.expense)}`;
}

function accountIcon(category) {
  if (category.includes('房产')) return ['房', ''];
  if (category.includes('股票') || category.includes('期权')) return ['股', 'blue'];
  if (category.includes('基金')) return ['基', 'amber'];
  if (category.includes('负债')) return ['贷', 'red'];
  if (category.includes('信用')) return ['卡', 'red'];
  return ['账', ''];
}

async function loadAccounts() {
  const payload = await api('/app/fm/api/accounts');
  state.accounts = payload.accounts;
  if(payload.fxWarning)showToast(payload.fxWarning);
  if(payload.fx?.stale)showToast(payload.fx.warning||'当前使用上次汇率估值');
  const tbody = document.querySelector('#accountsTable tbody');
  tbody.innerHTML = state.accounts.map(account => {
    const [label, tone] = accountIcon(account.category);
    const value = account.kind === 'liability' ? -account.value_cny : account.value_cny;
    return `<tr>
      <td><div class="account-cell"><i class="account-icon ${tone}"><span>${label}</span></i><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.note)}</small></div></div></td>
      <td><span class="tag ${account.kind === 'liability' ? 'warn' : ''}">${escapeHtml(account.category)}</span></td>
      <td>${escapeHtml(account.currency)}<br><small>${Number(account.original_value).toLocaleString('zh-CN')}</small></td>
      <td>${escapeHtml(account.update_method)}${account.fx_mode==='auto'&&account.fx_rate?`<br><small>汇率 ${Number(account.fx_rate).toFixed(6)} · ${escapeHtml(account.fx_updated_at||'')}</small>`:''}</td>
      <td class="num ${value < 0 ? 'down' : ''}">${money.format(value)}</td>
      <td class="num">${account.investment_linked?'<button class="btn" data-jump-investment>管理持仓</button>':`<button class="btn" data-edit-account="${account.id}">编辑</button>`}</td>
    </tr>`;
  }).join('');
  const assetTotal = state.accounts.filter(account => account.kind === 'asset').reduce((sum, account) => sum + account.value_cny, 0);
  const liabilityTotal = state.accounts.filter(account => account.kind === 'liability').reduce((sum, account) => sum + account.value_cny, 0);
  const propertyTotal = state.accounts.filter(a => a.kind === 'asset' && /房产|受限|债权/.test(a.category)).reduce((n,a)=>n+a.value_cny,0);
  const summaryValues = document.querySelectorAll('.accounts-summary strong');
  summaryValues[0].textContent = money.format(assetTotal - propertyTotal);
  summaryValues[1].textContent = money.format(propertyTotal);
  summaryValues[2].textContent = money.format(liabilityTotal);
  document.querySelectorAll('[data-edit-account]').forEach(btn=>btn.addEventListener('click',()=>openAccountEditor(Number(btn.dataset.editAccount))));
  document.querySelectorAll('[data-jump-investment]').forEach(b=>b.onclick=()=>switchView('investments'));
  applyAccountFilters();
  renderAllocation();
  fillAccountSelect();
}

function applyAccountFilters(){const keyword=document.getElementById('accountSearch').value.toLowerCase(),kind=document.getElementById('accountKindFilter')?.value||'全部类型';document.querySelectorAll('#accountsTable tbody tr').forEach((row,i)=>{const a=state.accounts[i],matches=kind==='全部类型'||(kind==='负债'?a?.kind==='liability':kind==='投资资产'?/股票|基金|投资/.test(a?.category||''):/现金|银行|支付/.test(a?.category||''));row.hidden=!row.textContent.toLowerCase().includes(keyword)||!matches;});}

function labelForType(type) {
  return { income: '收入', expense: '支出', transfer: '转账', trade: '证券交易', repayment: '还款' }[type] || type;
}

function renderTransactions() {
  const keyword = document.getElementById('transactionSearch').value.toLowerCase();
  const type = document.getElementById('transactionType').value;
  const visible = state.transactions.filter(row => {
    return (!keyword || `${row.merchant} ${row.note} ${row.category}`.toLowerCase().includes(keyword)) && (type === 'all' || row.type === type);
  });
  document.querySelector('#transactionsTable tbody').innerHTML = visible.map(row => {
    const signedClass = row.amount > 0 ? 'up' : row.type === 'transfer' ? '' : 'down';
    const detail = row.type === 'repayment' ? `本金 ${txMoney(row.principal_amount,row.currency)} · 利息 ${txMoney(row.interest_amount,row.currency)}` : row.note;
    return `<tr data-type="${row.type}">
      <td>${escapeHtml(row.occurred_on)}</td>
      <td><strong>${escapeHtml(row.merchant)}</strong><br><small>${escapeHtml(detail)}</small></td>
      <td>${escapeHtml(row.category)}</td>
      <td>${escapeHtml(row.account_name || '未指定')}</td>
      <td><span class="tag ${row.type === 'income' ? 'good' : ''}">${labelForType(row.type)}</span></td>
      <td class="num ${signedClass}">${row.type === 'transfer' ? '' : row.amount > 0 ? '+ ' : '- '}${txMoney(Math.abs(row.amount),row.currency)}</td>
    </tr>`;
  }).join('');
}

async function loadTransactions() {
  const payload = await api('/app/fm/api/transactions');
  state.transactions = payload.transactions;
  renderTransactions();
  const recent = document.getElementById('recentActivity');
  if (recent) {
    recent.innerHTML = state.transactions.filter(r=>r.type!=='transfer').slice(0, 3).map(row => `<div class="activity">
      <div class="activity-icon"><i data-lucide="receipt"></i></div>
      <div><strong>${escapeHtml(row.merchant)}</strong><small>${escapeHtml(row.account_name || '未指定')} · ${escapeHtml(row.category)}</small></div>
      <div class="activity-amount ${row.amount > 0 ? 'up' : 'down'}">${row.amount > 0 ? '+ ' : '- '}${txMoney(Math.abs(row.amount),row.currency)}<small>${escapeHtml(row.occurred_on)}</small></div>
    </div>`).join('');
    if (!state.transactions.length) recent.textContent='暂无流水';
    refreshIcons();
  }
}

function fillAccountSelect() {
  const select = document.getElementById('entryAccount');
  if (!select) return;
  select.innerHTML = '<option value="">未指定账户</option>' + state.accounts.map(account => `<option value="${account.id}">${escapeHtml(account.name)}</option>`).join('');
}

async function saveEntry() {
  const amount = document.getElementById('entryAmount').value.trim();
  const merchant = document.getElementById('entryMerchant').value.trim();
  if (!amount || !merchant) return showToast('请填写金额和交易方');
  await api('/app/fm/api/transactions', {
    method: 'POST',
    body: JSON.stringify({
      occurredOn: document.getElementById('entryDate').value,
      merchant,
      accountId: document.getElementById('entryAccount').value || null,
      currency: state.accounts.find(a=>a.id===Number(document.getElementById('entryAccount').value))?.currency || 'CNY',
      category: document.getElementById('entryCategory').value,
      type: state.entryType,
      amount: Number(amount),
      note: document.getElementById('entryNote').value
    })
  });
  document.getElementById('entryAmount').value = '';
  document.getElementById('entryMerchant').value = '';
  document.getElementById('entryNote').value = '';
  closeModal('addModal');
  await Promise.all([loadSummary(), loadTransactions(), loadBudgets()]);
  showToast('流水已保存到数据库');
  switchView('transactions');
}

function renderBudgets() {
  const container = document.querySelector('.budget-list');
  container.innerHTML = state.budgets.map(budget => {
    const ratio = budget.monthly_limit ? budget.spent / budget.monthly_limit : 0;
    const percent = Math.round(ratio * 100);
    const tone = ratio >= 1 ? 'danger' : ratio >= budget.warning_threshold ? 'warn' : '';
    const remaining = budget.monthly_limit - budget.spent;
    return `<article class="card budget-row">
      <div class="budget-name"><i><span>${escapeHtml(budget.category.slice(0, 1))}</span></i><div><strong>${escapeHtml(budget.category)}</strong><small>达到 ${Math.round(budget.warning_threshold * 100)}% 时提醒</small></div></div>
      <div><div class="budget-meta"><span>已用 ${money.format(budget.spent)}</span><span>${percent}%</span></div><div class="progress ${tone}"><span style="width:${Math.min(percent, 100)}%"></span></div><div class="budget-meta"><span>${ratio >= 1 ? `已超支 ${money.format(-remaining)}` : ratio >= budget.warning_threshold ? '已触发预警' : '状态正常'}</span><span>${remaining >= 0 ? `剩余 ${money.format(remaining)}` : '需复盘'}</span></div></div>
      <div class="budget-number"><strong>${money.format(budget.monthly_limit)}</strong><small>月度预算</small><button class="btn" data-edit-budget="${budget.id}">编辑</button></div>
    </article>`;
  }).join('');
  container.querySelectorAll('[data-edit-budget]').forEach(btn=>btn.addEventListener('click',()=>openBudgetSettings(Number(btn.dataset.editBudget))));
  if (!state.budgets.length) container.textContent='尚未设置预算，请点击预算设置新增';
  renderAlerts();
  const total = state.budgets.reduce((sum, item) => sum + item.monthly_limit, 0);
  const spent = state.budgets.reduce((sum, item) => sum + item.spent, 0);
  const metricValues = document.querySelectorAll('#budgetsView .metric-value');
  metricValues[0].textContent = money.format(total);
  metricValues[1].textContent = money.format(spent);
  metricValues[2].textContent = money.format(total - spent);
  metricValues[3].textContent = '—';
  document.querySelectorAll('#budgetsView .metric-foot').forEach((e,i)=>e.textContent=['按已设置分类预算汇总','按对应分类实际支出汇总','预算减去已使用金额','暂无预测数据'][i]);
}

async function loadBudgets() {
  const payload = await api('/app/fm/api/budgets');
  state.budgets = payload.budgets;
  renderBudgets();
}

const activeReportPeriod=()=>document.querySelector('[data-period].active')?.dataset.period||'month';
async function loadReport(period) {
  const currency=el('reportCurrency').value;
  const report = await api(`/app/fm/api/reports?period=${period}&currency=${currency}`);
  if(currency!==el('reportCurrency').value||period!==activeReportPeriod())return;
  const format=n=>txMoney(n,currency);
  document.getElementById('reportIncome').textContent = format(report.income);
  document.getElementById('reportExpense').textContent = format(report.expense);
  document.getElementById('reportRate').textContent = `${(report.savingsRate * 100).toFixed(1)}%`;
  document.getElementById('reportSubtitle').textContent = `${report.from} — ${report.to}`;
  document.getElementById('reportSavings').textContent='结余 '+format(report.savings);
  renderCashflowChart(report);
  const list = document.querySelector('#reportsView .bar-list');
  if (!report.categories.length) list.textContent='本期暂无支出';
  const max = Math.max(...report.categories.map(item => item.amount), 1);
  if (report.categories.length) list.innerHTML = report.categories.map(item => `<div class="bar-row"><span>${escapeHtml(item.category)}</span><div class="bar-track"><div class="bar" style="width:${Math.max(4, item.amount / max * 100)}%"></div></div><span class="num">${format(item.amount)}</span></div>`).join('');
}

const el=id=>document.getElementById(id);
const txMoney=(n,c='CNY')=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:c}).format(n);
const accountOptions=(first)=>'<option value="">'+first+'</option>'+state.accounts.map(a=>'<option value="'+a.id+'">'+escapeHtml(a.name)+'</option>').join('');
const jsonWrite=(method,body)=>({method,body:JSON.stringify(body)});
let csvDraft=null, csvBusy=false;
function resetCsvPreview(){
  csvDraft=null;
  el('importPreview').classList.add('hidden');
  el('importStatus').textContent='';
  el('confirmImport').disabled=true;
}
function lockCsv(busy){
  csvBusy=busy;
  for(const id of ['importFile','importAccount','previewImport'])el(id).disabled=busy;
  el('confirmImport').disabled=busy||!csvDraft;
}
async function handleCsv(commit){
  if(csvBusy||(commit&&!csvDraft))return;
  lockCsv(true);
  try{
    if(!commit){
      resetCsvPreview();
      const file=el('importFile').files[0];
      if(!file||!/\.csv$/i.test(file.name)||file.size>900000)throw Error('请选择不超过 900 KB 的 .csv 文件');
      const bytes=await file.arrayBuffer();
      let csv;try{csv=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}
      catch{csv=new TextDecoder('gb18030',{fatal:true}).decode(bytes)}
      const body={csv,accountId:el('importAccount').value,filename:file.name};
      const p=await api('/app/fm/api/import/preview',jsonWrite('POST',body));
      el('importStatus').textContent=p.total+' 条 · 可导入 '+p.importable+' 条 · 重复 '+p.duplicates+' 条。下方最多显示 20 条。';
      el('importPreview').querySelector('tbody').innerHTML=p.rows.map(r=>'<tr><td>'+escapeHtml(r.occurredOn)+'</td><td>'+escapeHtml(r.merchant)+'</td><td>'+txMoney(r.amount,r.currency)+'</td><td>'+(r.duplicate?'重复，跳过':'可导入')+'</td></tr>').join('');
      el('importPreview').classList.remove('hidden');
      if(p.importable)csvDraft=body;
    }else{
      const p=await api('/app/fm/api/import/commit',jsonWrite('POST',csvDraft));
      resetCsvPreview();el('importFile').value='';
      closeModal('importModal');
      showToast('已导入 '+p.imported+' 条，跳过 '+p.duplicates+' 条重复流水');
      refreshLedgerViews();
    }
  }catch(e){el('importStatus').textContent=e.message}
  finally{lockCsv(false)}
}
function refreshLedgerViews(){
  Promise.all([loadSummary(),loadTransactions(),loadBudgets()]).catch(()=>showToast('已保存，列表刷新失败，请刷新页面查看'));
}
const ledgerStatus=t=>{el('ledgerStatus').textContent=t};
function renderLedgerEditor(fields,old){
  const result=el('ledgerResult');
  const input=(label,key,value,attrs='')=>'<div class="field"><label>'+label+'<input class="input" name="'+key+'" value="'+escapeHtml(value??'')+'" '+attrs+'></label></div>';
  const option=(v,label,active)=>'<option value="'+v+'"'+(v===active?' selected':'')+'>'+label+'</option>';
  result.innerHTML='<form id="ledgerForm"><h3>'+(old?'核对修改':'核对新流水')+'</h3>'+
    (old?'<p>当前：'+escapeHtml(old.merchant)+' · '+txMoney(Math.abs(old.amount),old.currency)+' · '+escapeHtml(old.occurred_on)+'</p>':'')+
    '<div class="form-grid">'+input('交易摘要','merchant',fields.merchant,'required maxlength="120"')+input('日期','occurredOn',fields.occurredOn,'type="date" required')+
    '<div class="field"><label>类型<select name="type">'+option('expense','支出',fields.type)+option('income','收入',fields.type)+'</select></label></div>'+
    input('金额','amount',fields.amount,'type="number" min="0.01" step="0.01" required')+
    '<div class="field"><label>币种<select name="currency">'+['CNY','USD','HKD'].map(c=>option(c,c,fields.currency)).join('')+'</select></label></div>'+
    input('分类','category',fields.category,'maxlength="100"')+
    '<div class="field"><label>账户<select name="accountId">'+accountOptions('未指定账户')+'</select></label></div></div>'+
    '<div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" type="submit">'+(old?'确认修改':'保存流水')+'</button><button class="btn" type="button" id="ledgerCancel">取消</button></div></form>';
  const form=el('ledgerForm');
  form.elements.accountId.value=fields.accountId??'';
  el('ledgerCancel').onclick=()=>{result.textContent='';ledgerStatus('已取消，流水未变更')};
  form.onsubmit=async e=>{
    e.preventDefault();
    const btn=form.querySelector('[type=submit]');
    if(btn.disabled)return;
    btn.disabled=true;
    ledgerStatus('正在保存…');
    const data=Object.fromEntries(new FormData(form));
    if(old){
      data.note=old.note;data.principalAmount=old.principal_amount;data.interestAmount=old.interest_amount;
      data.version=JSON.stringify(['occurred_on','merchant','category','account_id','type','amount','expense_amount','principal_amount','interest_amount','currency','note'].map(k=>old[k]));
    }
    try{
      await api('/app/fm/api/transactions'+(old?'/'+old.id:''),jsonWrite(old?'PUT':'POST',data));
      if(form.isConnected){result.textContent='';el('ledgerText').value='';ledgerStatus(old?'流水已修改':'流水已保存')}
      refreshLedgerViews();
    }catch(e){if(form.isConnected)ledgerStatus(e.message)}
    finally{btn.disabled=false}
  };
}
function renderLedgerReply(p){
  const result=el('ledgerResult');
  if(p.mode==='unknown'){ledgerStatus('这句话没能识别。试试「昨天午饭花了 48 元」');return}
  ledgerStatus(p.source==='fallback'?'模型暂不可用，已用基础解析，请核对。':p.source==='local'?'当前使用基础解析。':'');
  if(p.mode==='create'){renderLedgerEditor(p.fields);return}
  const rows=p.rows;
  if(!rows.length){result.textContent='没有找到匹配的流水。';return}
  const edit=r=>renderLedgerEditor({occurredOn:r.occurred_on,merchant:r.merchant,category:r.category,type:r.type,amount:p.mode==='edit'?(p.amount??Math.abs(r.amount)):Math.abs(r.amount),currency:r.currency,accountId:r.account_id},r);
  if(p.mode==='edit'&&rows.length===1){edit(rows[0]);return}
  const count=p.totals.reduce((sum,x)=>sum+x.count,0);
  result.innerHTML='<h3>'+(p.mode==='edit'?'选择要修改的一笔':'查询结果 · '+count+' 笔')+'</h3>'+
    (p.mode==='query'?'<small>'+escapeHtml([p.fromDay?(p.fromDay===p.toDay?p.fromDay:p.fromDay+' — '+p.toDay):'全部日期',p.category].filter(Boolean).join(' · '))+'</small><p>'+p.totals.map(t=>labelForType(t.type)+' '+txMoney(t.amount,t.currency)).join(' · ')+'</p>':'')+
    (count>rows.length?'<small>仅显示最近 '+rows.length+' 笔，可补充日期缩小范围。</small>':'')+
    rows.map((r,i)=>'<div class="toolbar" style="margin-top:8px"><span>'+escapeHtml(r.occurred_on)+' · '+escapeHtml(r.merchant)+' · '+escapeHtml(r.account_name||'未指定账户')+' · '+txMoney(r.amount,r.currency)+'</span><button class="btn" data-ledger-edit="'+i+'" type="button">修改</button></div>').join('');
  result.querySelectorAll('[data-ledger-edit]').forEach(b=>b.onclick=()=>edit(rows[Number(b.dataset.ledgerEdit)]));
}
function bindLedger(){
  const text=el('ledgerText'), button=el('ledgerRun'), mic=el('ledgerMic');
  let revision=0,recognition=null;
  text.addEventListener('input',()=>{revision++;el('ledgerResult').textContent='';ledgerStatus('')});
  button.onclick=async()=>{
    if(button.disabled)return;
    const value=text.value.trim();
    if(!value){ledgerStatus('请先输入一句话或使用麦克风');return}
    const request=++revision;
    button.disabled=true;ledgerStatus('正在识别…');el('ledgerResult').textContent='';
    try{
      const p=await api('/app/fm/api/ledger/interpret',jsonWrite('POST',{text:value}));
      if(request===revision)renderLedgerReply(p);
    }catch(e){if(request===revision)ledgerStatus(e.message)}
    finally{button.disabled=false}
  };
  mic.onclick=()=>{
    if(recognition){recognition.stop();return}
    const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Recognition){ledgerStatus('当前浏览器不支持语音识别，可以直接输入文字。');return}
    try{
      recognition=new Recognition();recognition.lang='zh-CN';
      recognition.onresult=e=>{
        text.value=e.results[0][0].transcript.slice(0,500);
        text.dispatchEvent(new Event('input'));
        if(!button.disabled)button.click();
        else ledgerStatus('语音已转成文字，请点「处理这句话」。');
      };
      recognition.onerror=()=>ledgerStatus('没能完成语音识别，请检查麦克风权限，或直接输入文字。');
      recognition.onend=()=>{recognition=null;mic.querySelector('span').textContent='开始说话'};
      recognition.start();
      mic.querySelector('span').textContent='结束说话';
      ledgerStatus('正在听…');
    }catch{recognition=null;ledgerStatus('无法启动麦克风，可以直接输入文字。')}
  };
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  document.querySelectorAll('[data-jump]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.jump)));
  document.getElementById('addBtn').addEventListener('click', () => openModal('addModal'));
  el('importBtn').addEventListener('click',()=>{
    if(csvBusy)return;
    const previous=el('importAccount').value;
    el('importAccount').innerHTML=accountOptions('按 CSV 匹配 / 未指定');
    el('importAccount').value=previous||'';
    openModal('importModal');
  });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.close)));
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal(backdrop.id); }));
  document.querySelectorAll('[data-entry]').forEach(button => button.addEventListener('click', () => {
    state.entryType = button.dataset.entry;
    document.querySelectorAll('[data-entry]').forEach(item => item.classList.toggle('active', item === button));
  }));
  document.getElementById('saveEntry').addEventListener('click', () => saveEntry().catch(error => showToast(error.message)));
  document.getElementById('accountSearch').addEventListener('input', event => {
    const keyword = event.target.value.toLowerCase();
    document.querySelectorAll('#accountsTable tbody tr').forEach(row => row.hidden = !row.textContent.toLowerCase().includes(keyword));
  });
  document.getElementById('transactionSearch').addEventListener('input', renderTransactions);
  document.getElementById('transactionType').addEventListener('change', renderTransactions);
  document.getElementById('exportTransactions').addEventListener('click', () => { location.href = '/app/fm/api/export/transactions.csv'; });
  document.getElementById('exportReport').addEventListener('click', () => { location.href='/app/fm/api/export/report.csv?period='+activeReportPeriod(); });
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-period]').forEach(item => item.classList.toggle('active', item === button));
    loadReport(button.dataset.period).catch(error => showToast(error.message));
  }));
  for(const id of ['importFile','importAccount'])el(id).addEventListener('change',resetCsvPreview);
  el('reportCurrency').onchange=()=>loadReport(activeReportPeriod()).catch(e=>showToast(e.message));
  el('previewImport').onclick=()=>handleCsv(false);
  el('confirmImport').onclick=()=>handleCsv(true);
  bindLedger();
}

async function start() {
  const now=new Date();
  document.querySelector('.page-kicker').textContent=now.toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',weekday:'long'});
  document.getElementById('entryDate').value=now.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
  editingAccountId=null;
  setupAccountForm();
  setupBudgetForm();
  bindEvents();
  bindTrend();
  bindInvestments();
  document.querySelectorAll('[data-report-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-report-tab]').forEach(n=>n.classList.toggle('active',n===b));document.getElementById('assetAnalysisPanel').hidden=b.dataset.reportTab!=='assets';document.getElementById('cashAnalysisPanel').hidden=b.dataset.reportTab!=='cash';if(b.dataset.reportTab==='assets')loadAssetAnalysis();else loadReport(activeReportPeriod());});
  document.getElementById('accountKindFilter').addEventListener('change',applyAccountFilters);
  document.getElementById('accountSearch').addEventListener('input',applyAccountFilters);
  window.addEventListener('resize',()=>{if(document.getElementById('dashboardView').classList.contains('active'))renderTrend();});
  refreshIcons();
  await Promise.all([loadSummary(), loadAccounts(), loadTransactions(), loadBudgets(), loadTrend()]);
  document.querySelector('.sync').textContent='已从服务器读取数据';
}


function renderAllocation() {
 const groups={};
 for(const a of state.accounts.filter(a=>a.kind==='asset'))groups[a.category]=(groups[a.category]||0)+Number(a.value_cny);
 const total=Object.values(groups).reduce((n,v)=>n+v,0);
 const e=document.getElementById('assetAllocation');
 e.innerHTML=total>0?Object.entries(groups).map(([k,v])=>`<div class="legend-row"><span>${escapeHtml(k)}</span><span>${money.format(v)} · ${(v/total*100).toFixed(1)}%</span></div>`).join(''):'暂无资产，请先添加账户';
}
function renderAlerts() {
 const e=document.querySelector('#dashboardView .alert-list');
 const list=state.budgets.filter(b=>b.monthly_limit>0 && b.spent/b.monthly_limit>=b.warning_threshold);
 e.innerHTML=list.length?list.map(b=>`<div class="alert-item"><div><strong>${escapeHtml(b.category)}预算已使用 ${Math.round(b.spent/b.monthly_limit*100)}%</strong><p>剩余 ${money.format(b.monthly_limit-b.spent)}</p></div></div>`).join(''):'暂无预算预警';
}

function setupAccountForm() {
 const modal=document.createElement('div');
 modal.id='accountModal'; modal.className='modal-backdrop';
 modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true'); modal.setAttribute('aria-labelledby','accountModalTitle');
 modal.innerHTML=`<div class="modal"><div class="modal-head"><h2 id="accountModalTitle">新增账户</h2><button class="close" data-close="accountModal" aria-label="关闭">×</button></div>
 <form id="accountForm"><div class="modal-body"><div class="form-grid">
 <div class="field full"><label for="accountName">账户名称</label><input class="input" id="accountName" required maxlength="100" placeholder="例如：工资银行卡"></div>
 <div class="field"><label for="accountKind">账户性质</label><select id="accountKind"><option value="asset">资产</option><option value="liability">负债</option></select></div>
 <div class="field"><label for="accountCategory">分类</label><select id="accountCategory"><option>银行存款</option><option>支付账户</option><option>房产</option><option>股票</option><option>基金</option><option>受限资产</option><option>债权</option><option>长期负债</option><option>流动负债</option><option>其他</option></select></div>
 <div class="field"><label for="accountCurrency">币种</label><select id="accountCurrency"><option>CNY</option><option>USD</option><option>HKD</option></select></div>
 <div class="field"><label for="accountOriginal">原币金额</label><input class="input" id="accountOriginal" type="number" min="0" step="0.01" required value="0"></div>
 <div class="field full"><label for="accountFxMode">折算方式</label><select id="accountFxMode"><option value="auto">官方每日汇率自动折算</option><option value="manual">手动填写人民币价值</option></select><small id="accountFxStatus" role="status"></small></div><div class="field full"><label for="accountValue">人民币价值</label><input class="input" id="accountValue" type="number" min="0" step="0.01" required value="0"><small>资产和负债均填写正数。自动模式由服务器按官方参考汇率折算。</small></div>
 <div class="field full"><label for="accountNote">备注</label><input class="input" id="accountNote" maxlength="500"></div>
 <p id="accountError" role="alert" style="color:#aa5144"></p>
 </div></div><div class="modal-foot"><button type="button" class="btn" data-close="accountModal">取消</button><button class="btn primary" type="submit" id="saveAccountBtn">保存账户</button></div></form></div>`;
 document.body.appendChild(modal);
 document.getElementById('addAccountBtn').addEventListener('click',()=>{editingAccountId=null;document.getElementById('accountForm').reset();document.getElementById('accountModalTitle').textContent='新增账户';document.getElementById('accountError').textContent='';openModal('accountModal');updateAccountFx().catch(e=>showToast(e.message));document.getElementById('accountName').focus();});
 for(const id of ['accountOriginal','accountCurrency','accountFxMode'])document.getElementById(id).addEventListener(id==='accountOriginal'?'input':'change',()=>updateAccountFx().catch(e=>showToast(e.message)));
 document.getElementById('refreshFxBtn').addEventListener('click',refreshFxManagement);
 document.getElementById('accountForm').addEventListener('submit',saveAccount);
}
async function saveAccount(event) {
 event.preventDefault();
 const btn=document.getElementById('saveAccountBtn'),error=document.getElementById('accountError');
 if(btn.disabled)return;
 const name=document.getElementById('accountName').value.trim();
 const valueCny=Number(document.getElementById('accountValue').value), originalValue=Number(document.getElementById('accountOriginal').value);
 if(!name || !Number.isFinite(valueCny) || valueCny<0 || !Number.isFinite(originalValue) || originalValue<0){error.textContent='请填写账户名称和有效的非负金额';return;}
 btn.disabled=true;error.textContent='';
 try {
  await api('/app/fm/api/accounts'+(editingAccountId===null?'':'/'+editingAccountId),{method:editingAccountId===null?'POST':'PUT',body:JSON.stringify({name,kind:document.getElementById('accountKind').value,category:document.getElementById('accountCategory').value,currency:document.getElementById('accountCurrency').value,fxMode:document.getElementById('accountFxMode').value,valueCny,originalValue,updateMethod:'手动更新',note:document.getElementById('accountNote').value.trim()})});
  closeModal('accountModal');document.getElementById('accountForm').reset();
  await Promise.all([loadAccounts(),loadSummary()]);showToast('账户已保存到数据库');
 } catch(e){error.textContent=e.message;showToast(e.message);} finally{btn.disabled=false;}
}

function openAccountEditor(id){
 const a=state.accounts.find(a=>a.id===id);if(!a)return;
 editingAccountId=id;document.getElementById('accountModalTitle').textContent='编辑账户';
 const categorySelect=document.getElementById('accountCategory');if(!Array.from(categorySelect.options).some(o=>o.value===a.category)){const option=document.createElement('option');option.value=a.category;option.textContent=a.category;categorySelect.appendChild(option);}
 const fields={accountName:a.name,accountKind:a.kind,accountCategory:a.category,accountCurrency:a.currency,accountOriginal:a.original_value,accountValue:a.value_cny,accountNote:a.note,accountFxMode:a.fx_mode||'manual'};
 for(const [key,value] of Object.entries(fields))document.getElementById(key).value=value;
 document.getElementById('accountError').textContent='';openModal('accountModal');updateAccountFx().catch(e=>showToast(e.message));
}

var formFx=null,formFxPending=null,fxFormSequence=0;
async function updateAccountFx(){
 const seq=++fxFormSequence,c=document.getElementById('accountCurrency').value,mode=document.getElementById('accountFxMode').value;
 const input=document.getElementById('accountValue'),status=document.getElementById('accountFxStatus');input.readOnly=mode==='auto';
 if(mode==='manual'){status.textContent='使用手动填写值，不随每日汇率变化';return;}
 const amount=Number(document.getElementById('accountOriginal').value);
 if(c==='CNY'){input.value=Number.isFinite(amount)?amount:0;status.textContent='人民币无需换汇';return;}
 status.textContent='正在获取官方汇率…';
 try{
  if(!formFx||formFx.stale||new Date(formFx.fetchedAt).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})!==new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})){if(!formFxPending)formFxPending=api('/app/fm/api/fx').finally(()=>{formFxPending=null;});formFx=await formFxPending;}
  if(seq!==fxFormSequence)return;
  if(formFx.stale)throw Error(formFx.warning||'汇率更新失败，可选择手动折算');
  input.value=(amount*formFx.rates[c]).toFixed(2);status.textContent=`1 ${c} = ${formFx.rates[c].toFixed(6)} CNY；报价日期 ${formFx.quotedAt}；${formFx.source}`;
 }catch(e){if(seq===fxFormSequence)status.textContent=e.message;}
}
async function loadFxManagement(){
 const status=document.getElementById('fxStatus');status.textContent='正在同步官方数据…';
 try{
  const fx=await api('/app/fm/api/fx');formFx=fx;
  status.textContent=`${fx.stale?'同步异常，保留旧报价：'+(fx.warning||''):'已同步'}；官方报价日期 ${fx.quotedAt}；最近获取 ${new Date(fx.fetchedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）`;
  document.getElementById('fxRates').innerHTML=['USD','HKD'].map(c=>`<p><strong>1 ${c} = ${Number(fx.rates[c]).toFixed(6)} CNY</strong></p>`).join('');
 }catch(e){status.textContent=e.message;}
 const history=await api('/app/fm/api/fx/history');
 document.getElementById('fxHistory').innerHTML=history.history.length?`<table><thead><tr><th>报价日期</th><th>USD/CNY</th><th>HKD/CNY</th></tr></thead><tbody>${history.history.map(r=>`<tr><td>${escapeHtml(r.quoted_on)}</td><td>${Number(r.usd_cny).toFixed(6)}</td><td>${Number(r.hkd_cny).toFixed(6)}</td></tr>`).join('')}</tbody></table>`:'暂无记录';
 document.getElementById('fxJobs').innerHTML=history.jobs.length?history.jobs.map(j=>`<p>${escapeHtml(j.day)} · ${escapeHtml({running:'进行中',failed:'失败',success:'成功'}[j.status]||j.status)} · ${escapeHtml(j.message||'')}</p>`).join(''):'暂无自动同步记录';
}
async function refreshFxManagement(){
 const btn=document.getElementById('refreshFxBtn');if(btn.disabled)return;btn.disabled=true;
 try{const fx=await api('/app/fm/api/fx',{method:'POST',body:'{}'});formFx=fx;await Promise.all([loadAccounts(),loadSummary()]);await loadFxManagement();showToast(fx.stale?(fx.warning||'同步失败，保留原值'):'汇率已同步，自动折算账户已更新');}catch(e){document.getElementById('fxStatus').textContent=e.message;showToast(e.message);}finally{btn.disabled=false;}
}

var editingBudgetId=null;
function setupBudgetForm(){
 const modal=document.createElement('div');modal.id='budgetModal';modal.className='modal-backdrop';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','budgetModalTitle');
 modal.innerHTML=`<div class="modal"><div class="modal-head"><h2 id="budgetModalTitle">预算设置</h2><button class="close" data-close="budgetModal" aria-label="关闭">×</button></div><form id="budgetForm"><div class="modal-body"><div class="field"><label for="budgetChoice">选择预算</label><select id="budgetChoice"></select></div><div class="field"><label for="budgetCategory">消费分类</label><input class="input" id="budgetCategory" list="budgetCategories" required maxlength="100" placeholder="与流水分类保持一致"><datalist id="budgetCategories"><option value="日常消费"><option value="居住"><option value="交通出行"><option value="其他"></datalist></div><div class="field"><label for="budgetLimit">月度预算（人民币元）</label><input class="input" id="budgetLimit" type="number" min="0.01" step="0.01" required></div><div class="field"><label for="budgetThreshold">预警阈值（%）</label><input class="input" id="budgetThreshold" type="number" min="1" max="100" step="1" value="90" required></div><p id="budgetError" role="alert" style="color:#aa5144"></p><small>预算按北京时间自然月统计。达到设定阈值时在总览中提醒。</small></div><div class="modal-foot"><button class="btn" type="button" data-close="budgetModal">取消</button><button class="btn primary" type="submit" id="saveBudgetBtn">保存预算</button></div></form></div>`;
 document.body.appendChild(modal);
 document.getElementById('budgetSettingsBtn').addEventListener('click',()=>openBudgetSettings(null));
 document.getElementById('budgetChoice').addEventListener('change',e=>populateBudget(e.target.value?Number(e.target.value):null));
 document.getElementById('budgetForm').addEventListener('submit',saveBudget);
}
function populateBudget(id){
 const b=state.budgets.find(b=>b.id===id);editingBudgetId=b?b.id:null;
 document.getElementById('budgetChoice').value=b?String(b.id):'';
 document.getElementById('budgetCategory').value=b?b.category:'';
 document.getElementById('budgetLimit').value=b?b.monthly_limit:'';
 document.getElementById('budgetThreshold').value=b?Math.round(b.warning_threshold*100):90;
 document.getElementById('budgetError').textContent='';
}
async function openBudgetSettings(id){
 try{await loadBudgets();document.getElementById('budgetChoice').innerHTML='<option value="">新增分类预算</option>'+state.budgets.map(b=>`<option value="${b.id}">${escapeHtml(b.category)}</option>`).join('');populateBudget(id);openModal('budgetModal');}catch(e){showToast(e.message);}
}
async function saveBudget(event){
 event.preventDefault();const btn=document.getElementById('saveBudgetBtn'),error=document.getElementById('budgetError');if(btn.disabled)return;
 const category=document.getElementById('budgetCategory').value.trim(),monthlyLimit=Number(document.getElementById('budgetLimit').value),warningThreshold=Number(document.getElementById('budgetThreshold').value)/100;
 if(!category||!Number.isFinite(monthlyLimit)||monthlyLimit<=0||!Number.isFinite(warningThreshold)||warningThreshold<.01||warningThreshold>1){error.textContent='请填写分类、正数预算及1%至100%的阈值';return;}
 btn.disabled=true;error.textContent='';try{
  await api('/app/fm/api/budgets'+(editingBudgetId===null?'':'/'+editingBudgetId),{method:editingBudgetId===null?'POST':'PUT',body:JSON.stringify({category,monthlyLimit,warningThreshold})});
  closeModal('budgetModal');await loadBudgets();showToast('预算已保存到数据库');
 }catch(e){error.textContent=e.message;showToast(e.message);}finally{btn.disabled=false;}
}

let trendData, trendRequest=0;
const trendElement=id=>document.getElementById(id);
const trendFormat=(value,currency)=>value==null?'暂无数据':new Intl.NumberFormat('zh-CN',{style:'currency',currency,maximumFractionDigits:2}).format(value);
function bindTrend(){
  for(const id of ['trendCurrency','trendMetric'])trendElement(id)?.addEventListener('change',renderTrend);
  trendElement('trendDays')?.addEventListener('change',()=>loadTrend());
  trendElement('trendDate')?.addEventListener('change',event=>loadTrend(event.target.value));
}
async function loadTrend(day){
  const chart=trendElement('trendChart');
  if(!chart)return;
  const request=++trendRequest;
  try{
    const params=new URLSearchParams({days:trendElement('trendDays').value});
    if(day)params.set('day',day);
    const payload=await api('/app/fm/api/trend?'+params);
    if(request!==trendRequest)return;
    trendData=payload;
    const date=trendElement('trendDate');
    date.innerHTML=payload.points.map(point=>`<option value="${escapeHtml(point.day)}">${escapeHtml(point.day)}</option>`).join('');
    date.value=payload.detail?.day||'';
    trendElement('trendDateLabel').hidden=!payload.points.length;
    renderTrend();
  }catch(error){
    if(request!==trendRequest)return;
    trendData=null;
    chart.textContent='趋势加载失败：'+error.message;
    trendElement('trendToday').textContent='';
    trendElement('trendDetail').textContent='';
    trendElement('trendDateLabel').hidden=true;
  }
}
function changeClass(value,invert=false){if(!Number.isFinite(value)||Math.abs(value)<.005)return 'change-neutral';return (invert?-value:value)>0?'change-positive':'change-negative';}
function changeText(value,currency='CNY'){if(!Number.isFinite(value))return '暂无可比数据';if(Math.abs(value)<.005)return '— 无变化';return (value>0?'+':'−')+trendFormat(Math.abs(value),currency);}
function renderTrend(){
 if(!trendData)return;
 const currency=trendElement('trendCurrency').value,metric=trendElement('trendMetric').value,format=value=>trendFormat(value,currency),{points,detail,today,firstDay}=trendData;
 trendElement('trendToday').textContent='今日（未结算）：'+format(today.totals[currency]?.[metric]);
 const chart=trendElement('trendChart'),values=points.map(p=>p.totals[currency]?.[metric]),available=values.filter(Number.isFinite);
 if(!available.length){chart.innerHTML='<div class="trend-empty">'+escapeHtml(points.length?'缺少可用折算汇率，请先检查汇率管理。':'从 '+firstDay+' 开始记录，等待首个日终快照。')+'</div>';}
 else{
  const w=Math.max(280,Math.round(chart.getBoundingClientRect?.().width||640)),h=280,left=78,right=22,top=28,bottom=37,low=Math.min(...available),high=Math.max(...available),padding=Math.max((high-low)*.14,Math.abs(high)*.005,1),min=low-padding,max=high+padding;
  const x=i=>left+(w-left-right)*(points.length===1?.5:i/(points.length-1)),y=v=>top+(h-top-bottom)*(max-v)/(max-min);
  let grid='',labels='',paths=[],segment=[],dots='';
  for(let j=0;j<5;j++){const value=min+(max-min)*j/4,yy=y(value),unit=Math.max(Math.abs(min),Math.abs(max))>=1e8?1e8:Math.max(Math.abs(min),Math.abs(max))>=1e4?1e4:1,precision=Math.max(0,Math.min(5,Math.ceil(-Math.log10((max-min)/4/unit)))),label=new Intl.NumberFormat('zh-CN',{minimumFractionDigits:precision,maximumFractionDigits:precision}).format(value/unit)+(unit===1e8?'亿':unit===1e4?'万':'');grid+=`<line x1="${left}" x2="${w-right}" y1="${yy}" y2="${yy}" stroke="#e5e9ed"/><text x="${left-10}" y="${yy+4}" text-anchor="end" fill="#68777f" font-size="12">${label}</text>`;}
  const ticks=Math.min(points.length,w<450?3:5);for(let j=0;j<ticks;j++){const i=ticks===1?0:Math.round(j*(points.length-1)/(ticks-1));labels+=`<text x="${x(i)}" y="${h-10}" text-anchor="${ticks===1?'middle':j===0?'start':j===ticks-1?'end':'middle'}" fill="#68777f" font-size="12">${escapeHtml(points[i].day.slice(5).replace('-','/'))}</text>`;}
  values.forEach((v,i)=>{if(!Number.isFinite(v)){if(segment.length)paths.push(segment);segment=[];return;}segment.push(`${x(i)},${y(v)}`);dots+=`<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#fff" stroke="#19775f" stroke-width="2"/><circle cx="${x(i)}" cy="${y(v)}" r="14" fill="transparent" role="button" tabindex="0" data-trend-day="${points[i].day}" aria-label="${points[i].day} ${escapeHtml(format(v))}"><title>${points[i].day} · ${escapeHtml(format(v))}</title></circle>`;});if(segment.length)paths.push(segment);
  chart.innerHTML=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="日终资产趋势，纵轴金额，横轴日期"><text x="${left}" y="15" fill="#68777f" font-size="12">金额 · ${currency}</text>${grid}${paths.map(p=>`<polyline points="${p.join(' ')}" stroke="#19775f" stroke-width="2.5" fill="none"/>`).join('')}${dots}${labels}</svg>`;
  chart.querySelectorAll('[data-trend-day]').forEach(node=>{const select=()=>loadTrend(node.dataset.trendDay);node.onclick=select;node.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}};node.onfocus=node.onmouseenter=()=>{const i=points.findIndex(p=>p.day===node.dataset.trendDay);const r=trendElement('trendReadout');if(r)r.textContent=node.dataset.trendDay+' · '+format(values[i]);};});
 }
 const panel=trendElement('trendDetail');if(!detail){panel.textContent='';return;}
 const change=points.find(p=>p.day===detail.day)?.changes?.[currency]?.[metric],invert=metric==='liabilities',usd=detail.fx?.rates.USD;
 const rows=detail.items.filter(i=>metric==='netWorth'||i.kind===(metric==='assets'?'asset':'liability'));
 panel.innerHTML=`<div class="change-grid">${[['较前日',change?.delta],['汇率影响',change?.fxImpact],['其他变动',change?.otherChange]].map(([label,v])=>`<div><span>${label}</span><strong class="${changeClass(v,invert)}">${escapeHtml(changeText(v,currency))}</strong></div>`).join('')}</div><details class="snapshot-details"><summary>${detail.day} 日终 ${escapeHtml(format(detail.totals[currency]?.[metric]))} · 查看账户明细和估值口径</summary><div class="table-wrap"><table class="snapshot-table"><thead><tr><th>账户</th><th>原币金额</th><th class="num">折算价值</th></tr></thead><tbody>${rows.map(item=>{const sign=metric==='netWorth'&&item.kind==='liability'?-1:1,amount=currency==='CNY'?sign*item.value_cny:usd>0?sign*item.value_cny/usd:null;return `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(String(item.original_value))} ${escapeHtml(item.currency)}</td><td class="num">${escapeHtml(format(amount))}</td></tr>`;}).join('')}</tbody></table></div><p class="investment-small">参考报价日：${escapeHtml(detail.fx?.quotedAt||'无')}。手动估值与不可比账户变化计入其他变动，其他变动不等于投资收益。今日实时值不计入日终曲线。</p></details>`;
 const headline=document.querySelector('#dashboardView .metric .metric-foot'),last=points.at(-1);if(headline&&last?.totals.CNY&&today.totals.CNY){const diff=today.totals.CNY.netWorth-last.totals.CNY.netWorth;headline.innerHTML=`<span class="${changeClass(diff)}">${escapeHtml(changeText(diff))}</span> · 较最近日终`;}
}
let assetAnalysisData=null;
async function loadAssetAnalysis(){
 const panel=document.getElementById('assetAnalysisPanel');if(!panel)return;
 try{assetAnalysisData=await api('/app/fm/api/trend?days=30');renderAssetAnalysis();}catch(e){panel.textContent='资产分析加载失败：'+e.message;}
}
function renderAssetAnalysis(){
 const panel=document.getElementById('assetAnalysisPanel'),data=assetAnalysisData;if(!panel||!data)return;
 const first=data.points[0],last=data.points.at(-1),delta=first?.totals.CNY&&last?.totals.CNY?last.totals.CNY.netWorth-first.totals.CNY.netWorth:null;
 const assets=state.accounts.filter(a=>a.kind==='asset'),total=assets.reduce((n,a)=>n+a.value_cny,0),groups={};for(const a of assets)groups[a.category]=(groups[a.category]||0)+a.value_cny;
 const cash=assets.filter(a=>/银行|现金|支付/.test(a.category)).reduce((n,a)=>n+a.value_cny,0),debt=state.accounts.filter(a=>a.kind==='liability').reduce((n,a)=>n+a.value_cny,0);
 panel.innerHTML=`<div class="investment-summary"><article class="card investment-stat"><span class="metric-label">区间期初净资产</span><strong>${first?.totals.CNY?money.format(first.totals.CNY.netWorth):'—'}</strong><small>${first?.day||'等待日终快照'}</small></article><article class="card investment-stat"><span class="metric-label">区间期末净资产</span><strong>${last?.totals.CNY?money.format(last.totals.CNY.netWorth):'—'}</strong><small>${last?.day||'等待日终快照'}</small></article><article class="card investment-stat"><span class="metric-label">已记录区间净变动</span><strong class="${changeClass(delta)}">${changeText(delta)}</strong><small>近 30 天实际可用日终 · 不等于投资收益</small></article></div><div class="analysis-pair"><article class="card section-card"><h2>当前资产配置</h2>${Object.entries(groups).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="investment-bar-row"><span>${escapeHtml(k)}</span><div class="investment-bar"><span style="width:${total?v/total*100:0}%"></span></div><span class="num">${total?(v/total*100).toFixed(1):'0'}%</span></div>`).join('')||'<p class="empty-state">暂无资产账户</p>'}</article><article class="card section-card"><h2>流动性与负债</h2><div class="investment-cash-row"><span>银行、现金与支付账户</span><span>${money.format(cash)}</span></div><div class="investment-cash-row"><span>负债合计</span><span>${money.format(debt)}</span></div><div class="investment-cash-row"><span>负债 / 总资产</span><span>${total?(debt/total*100).toFixed(1)+'%':'—'}</span></div><p class="investment-small">投资账户内现金在金融投资页单独展示，不据此推算家庭安全垫；受限资产按账户分类识别。</p></article></div><article class="card section-card" style="margin:24px 0"><h2>币种分布</h2><p class="investment-small">投资账户为人民币汇总账户，内部币种敞口请进入金融投资查看现金与持仓，不能按账户报表币种推断。</p>${['CNY','USD','HKD'].map(c=>`<div class="investment-cash-row"><span>${c} 非投资资产</span><span>${money.format(assets.filter(a=>!a.investment_linked&&a.currency===c).reduce((n,a)=>n+a.value_cny,0))}</span></div>`).join('')}</article>`;
}
function renderCashflowChart(report){
 const node=document.getElementById('cashflowChart');if(!node)return;
 const rows=report.daily||[];const out=document.getElementById('cashflowOutflow');if(out)out.textContent='实际现金流出 '+txMoney(report.cash_outflow||0,report.currency)+'；其中消费及利息 '+txMoney(report.expense,report.currency)+'。';
 if(!rows.length){node.innerHTML='<p class="empty-state">本期暂无该币种流水</p>';return;}
 const w=Math.max(280,Math.round(node.getBoundingClientRect?.().width||640)),h=260,l=70,r=15,t=25,b=40,max=Math.max(1,...rows.flatMap(x=>[x.income,x.expense])),step=(w-l-r)/rows.length,bw=Math.min(18,step*.3);let s='';
 for(let i=0;i<5;i++){const v=max*i/4,y=h-b-(h-t-b)*i/4;s+=`<line x1="${l}" x2="${w-r}" y1="${y}" y2="${y}" stroke="#e5e9ed"/><text x="${l-8}" y="${y+4}" text-anchor="end" font-size="12" fill="#68777f">${new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(v)}</text>`;}
 rows.forEach((row,i)=>{const mid=l+step*(i+.5);[row.income,row.expense].forEach((v,j)=>{const height=(h-t-b)*v/max;s+=`<rect x="${mid+(j?1:-bw-1)}" y="${h-b-height}" width="${bw}" height="${height}" fill="${j?'#acb7bd':'#19775f'}"><title>${row.day} ${j?'支出':'收入'} ${escapeHtml(txMoney(v,report.currency))}</title></rect>`;});if(i===0||i===rows.length-1||i===Math.floor(rows.length/2))s+=`<text x="${mid}" y="${h-12}" text-anchor="${i===0?'start':i===rows.length-1?'end':'middle'}" fill="#68777f" font-size="12">${row.day.slice(5)}</text>`;});
 node.innerHTML=`<p class="investment-small">收入（绿） · 支出（灰） · ${report.currency}</p><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="本期每日收支金额，横轴日期，纵轴金额"><text x="${l}" y="14" font-size="12" fill="#68777f">金额 · ${report.currency}</text>${s}</svg>`;
}

let investmentData=null,investmentRequest=0,investmentRequestId=null,investmentBusy=false;
const investmentTypes={opening:'期初持仓',buy:'买入',sell:'卖出',cash_opening:'期初现金',deposit:'入金',withdraw:'出金'};
function investmentBooks(){const id=Number(el('investmentAccount').value);return (investmentData?.books||[]).filter(b=>!id||b.id===id);}
function investmentTab(name){document.querySelectorAll('[data-invest-tab]').forEach(b=>b.classList.toggle('active',b.dataset.investTab===name));document.querySelectorAll('[data-invest-panel]').forEach(p=>p.hidden=p.dataset.investPanel!==name);}
async function loadInvestments(){
 const request=++investmentRequest;try{
  const result=await api('/app/fm/api/investments');if(request!==investmentRequest)return;
  investmentData=result;const select=el('investmentAccount'),prior=select.value;select.innerHTML='<option value="">全部账户</option>'+result.books.map(b=>`<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');select.value=result.books.some(b=>String(b.id)===prior)?prior:result.books.length===1?String(result.books[0].id):'';renderInvestments();
 }catch(e){if(request===investmentRequest)el('investmentStatus').textContent='投资数据加载失败：'+e.message;}
}
function renderInvestments(){
 if(!investmentData)return;const books=investmentBooks(),complete=books.every(b=>b.complete),sum=k=>books.reduce((n,b)=>n+(b[k]||0),0),positions=books.flatMap(b=>b.positions.map(p=>({...p,bookId:b.id,bookName:b.name}))),held=positions.filter(p=>p.quantity>0);
 const status=[books.length?`已读取 ${books.length} 个账户；数据保存在服务器。`:'先新建投资账户，或关联现有股票资产，避免重复统计。',investmentData.providerConfigured?'行情服务已配置，每 15 分钟更新；实际覆盖与延迟取决于数据订阅。':'未配置自动行情；录入价格只作参考，可在持仓行维护报价。',...books.filter(b=>!b.complete).map(b=>b.name+' 缺少 '+b.missing.join('、')+'；保留资产总览上次估值。'),...(books.some(b=>b.fx.stale)?['汇率未同步或已过期，请检查汇率管理。']:[]),investmentData.latestJob?.message||''];el('investmentStatus').textContent=status.filter(Boolean).join('\n');
 for(const [id,key] of [['investmentNet','netValueCny'],['investmentUnrealized','unrealizedCny'],['investmentRealized','realizedCny']]){const n=complete?sum(key):null;el(id).textContent=n===null?'—':id==='investmentNet'?money.format(n):changeText(n);el(id).className=id==='investmentNet'?'':changeClass(n);}
 const total=complete?sum('netValueCny'):0,allocation=held.slice().sort((a,b)=>(b.marketValueCny||0)-(a.marketValueCny||0)).map(p=>{const percentage=total>0&&p.marketValueCny!==null?p.marketValueCny/total*100:null;return `<div class="investment-bar-row"><span>${escapeHtml(p.name)}</span><div class="investment-bar"><span style="width:${Math.min(100,percentage||0)}%"></span></div><span class="num">${percentage===null?'—':percentage.toFixed(1)+'%'}</span></div>`;}).join('');el('investmentAllocation').innerHTML=allocation||'<p class="empty-state">暂无持仓。先录入期初现金与股票，再记录后续成交。</p>';el('investmentRisk').innerHTML=allocation||'<p class="empty-state">暂无持仓数据</p>';
 el('investmentCash').innerHTML=books.map(b=>`<p class="investment-small">${escapeHtml(b.name)}</p>${Object.entries(b.cash).map(([c,v])=>`<div class="investment-cash-row"><span>${c}</span><span>${txMoney(v,c)}</span></div>`).join('')}`).join('')||'<p class="empty-state">尚未建立账户</p>';
 const rows=document.querySelector('#investmentHoldings tbody');rows.innerHTML=held.map(p=>`<tr><td>${escapeHtml(p.name)}<br><small>${escapeHtml(p.symbol)} · ${escapeHtml(p.exchange)}<br>${escapeHtml(p.bookName)}</small></td><td>${p.quantity.toLocaleString('zh-CN',{maximumFractionDigits:6})}</td><td>${txMoney(p.averageCost,p.currency)} / ${p.price===null?'—':txMoney(p.price,p.currency)}<br><small>${escapeHtml(p.quoteSource||'暂无报价')}<br>${escapeHtml(p.quoteDate||'')}</small></td><td class="num">${p.marketValueCny===null?'—':money.format(p.marketValueCny)}<br><span class="${changeClass(p.unrealizedCny)}">${changeText(p.unrealizedCny)}</span></td><td><div class="investment-quote"><button class="btn" data-invest-buy="${p.id}" data-book="${p.bookId}">买</button><button class="btn" data-invest-sell="${p.id}" data-book="${p.bookId}">卖</button><button class="btn" data-invest-quote="${p.id}">报价</button></div></td></tr>`).join('')||'<tr><td colspan="5" class="empty-state">暂无持仓，请添加期初股票或记录买入</td></tr>';
 document.querySelectorAll('[data-invest-buy],[data-invest-sell]').forEach(b=>b.onclick=()=>{el('investmentAccount').value=b.dataset.book;const id=Number(b.dataset.investBuy||b.dataset.investSell),p=positions.find(p=>p.id===id&&p.bookId===Number(b.dataset.book));openInvestmentEvent(b.dataset.investBuy?'buy':'sell',p);});document.querySelectorAll('[data-invest-quote]').forEach(b=>b.onclick=()=>openInvestmentQuote(positions.find(p=>p.id===Number(b.dataset.investQuote))));
 const events=books.flatMap(b=>b.events.map((e,i)=>({...e,bookName:b.name,last:i===b.events.length-1,security:b.positions.find(p=>p.id===e.security_id)}))).sort((a,b)=>b.day.localeCompare(a.day)||b.id-a.id);
 document.querySelector('#investmentRecords tbody').innerHTML=events.map(e=>`<tr><td>${e.day}<br><small>${escapeHtml(e.bookName)}</small></td><td>${investmentTypes[e.type]}<br>${escapeHtml(e.security?.name||e.currency)}</td><td>${e.security?`${e.quantity} 股 / ${txMoney(e.price,e.currency)}<br><small>费用 ${txMoney(e.fee,e.currency)}</small>`:txMoney(e.amount,e.currency)}</td><td>${e.last?`<button class="btn" data-invest-void="${e.id}">撤销最近记录</button>`:'—'}</td></tr>`).join('')||'<tr><td colspan="4" class="empty-state">暂无交易记录</td></tr>';
 document.querySelectorAll('[data-invest-void]').forEach(b=>b.onclick=async()=>{if(investmentBusy||!confirm('确认撤销这笔记录并回算持仓和现金？历史日终快照保留。'))return;investmentBusy=true;b.disabled=true;try{await api('/app/fm/api/investments/events/'+b.dataset.investVoid+'/void',{method:'POST'});await refreshInvestments();showToast('已撤销并回算');}catch(e){showToast(e.message);}finally{investmentBusy=false;b.disabled=false;}});
}
function investmentEventFields(){
 const type=el('investmentEventType').value,isCash=['cash_opening','deposit','withdraw'].includes(type);el('investmentSecurityFields').hidden=isCash;el('investmentCashFields').hidden=!isCash;el('investmentFee').disabled=type==='opening';if(type==='opening')el('investmentFee').value='0';
 el('investmentEventNote').textContent=type==='opening'?'期初持仓只建立数量与成本，不重复扣现金；历史费用请计入平均成本。录入价格是参考价，不是实时行情。':isCash?'期初现金仅建立初始余额；入金、出金不作为投资收益，也不自动改动外部银行余额。跨账户转账请同步核对另一账户。':'记录券商已成交结果。买入扣减原币现金，卖出增加现金并确认盈亏；本版不支持卖空或融资。';
 investmentRequestId=crypto.randomUUID();
}
function openInvestmentEvent(type,p){
 const id=Number(el('investmentAccount').value);if(!id){showToast('请先选择一个投资账户');return;}
 el('investmentEventPanel').hidden=false;el('investmentCreatePanel').hidden=true;el('investmentEventType').value=type;el('investmentEventDay').value=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});el('investmentEventDay').max=el('investmentEventDay').value;el('investmentEventError').textContent='';
 el('investmentSymbol').value=p?.symbol||'';el('investmentSecurityName').value=p?.name||'';el('investmentQuantity').value='';el('investmentPrice').value=p?.price??'';el('investmentFee').value='0';if(p)el('investmentMarket').value=p.market+':'+p.exchange;investmentEventFields();
}
async function refreshInvestments(){await loadInvestments();await Promise.all([loadAccounts(),loadSummary(),loadTrend()]);if(el('reportsView').classList.contains('active'))await loadAssetAnalysis();}
async function saveInvestmentEvent(event){
 event.preventDefault();if(investmentBusy)return;const accountId=Number(el('investmentAccount').value),error=el('investmentEventError');error.textContent='';if(!accountId){error.textContent='请先选择投资账户';return;}
 const type=el('investmentEventType').value,[market,exchange]=el('investmentMarket').value.split(':'),isCash=['cash_opening','deposit','withdraw'].includes(type),body={type,day:el('investmentEventDay').value,requestId:investmentRequestId||crypto.randomUUID()};
 if(isCash)Object.assign(body,{currency:el('investmentCashCurrency').value,amount:Number(el('investmentCashAmount').value)});else Object.assign(body,{market,exchange,symbol:el('investmentSymbol').value.trim().toUpperCase(),name:el('investmentSecurityName').value.trim(),quantity:Number(el('investmentQuantity').value),price:Number(el('investmentPrice').value),fee:type==='opening'?0:Number(el('investmentFee').value)});
 investmentBusy=true;el('investmentEventSave').disabled=true;let saved=false;
 try{await api('/app/fm/api/investments/accounts/'+accountId+'/events',{method:'POST',body:JSON.stringify(body)});saved=true;el('investmentEventPanel').hidden=true;investmentRequestId=null;await refreshInvestments();showToast('已保存，持仓、现金和账户估值已更新');}
 catch(e){if(saved)showToast('记录已保存，刷新失败，请重新加载页面');else error.textContent=e.message;}finally{investmentBusy=false;el('investmentEventSave').disabled=false;}
}
function openInvestmentQuote(p){
 let panel=el('investmentQuotePanel');if(panel)panel.remove();panel=document.createElement('article');panel.id='investmentQuotePanel';panel.className='card section-card investment-section';panel.innerHTML=`<h2>维护参考报价 · ${escapeHtml(p.name)}</h2><form id="investmentQuoteForm"><div class="form-grid" style="margin-top:18px"><div class="field"><label for="investmentQuotePrice">每股价格（${p.currency}）</label><input id="investmentQuotePrice" type="number" min="0.000001" step="any" required value="${p.price??''}"></div><div class="field"><label for="investmentQuoteTime">报价时间（浏览器本地时区）</label><input id="investmentQuoteTime" type="datetime-local" required></div></div><p id="investmentQuoteError" class="field-error" role="alert"></p><div class="toolbar-right" style="margin-top:18px"><button class="btn" type="button" id="investmentQuoteCancel">取消</button><button class="btn primary" id="investmentQuoteSave">保存参考报价</button></div></form>`;
 document.querySelector('[data-invest-panel="holdings"]').prepend(panel);const now=new Date();el('investmentQuoteTime').value=new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,16);el('investmentQuoteCancel').onclick=()=>panel.remove();
 el('investmentQuoteForm').onsubmit=async e=>{e.preventDefault();if(investmentBusy)return;investmentBusy=true;el('investmentQuoteSave').disabled=true;try{const date=new Date(el('investmentQuoteTime').value);if(!Number.isFinite(+date))throw Error('请填写有效时间');await api('/app/fm/api/investments/quotes',{method:'PUT',body:JSON.stringify({securityId:p.id,price:Number(el('investmentQuotePrice').value),quotedAt:date.toISOString()})});panel.remove();await refreshInvestments();showToast('报价已更新；持股数量与现金保持不变');}catch(e){if(el('investmentQuoteError'))el('investmentQuoteError').textContent=e.message;else showToast(e.message);}finally{investmentBusy=false;if(el('investmentQuoteSave'))el('investmentQuoteSave').disabled=false;}};
}
function bindInvestments(){
 document.querySelectorAll('[data-invest-tab]').forEach(b=>b.onclick=()=>investmentTab(b.dataset.investTab));el('investmentAccount').onchange=()=>{el('investmentEventPanel').hidden=true;const panel=el('investmentQuotePanel');if(panel)panel.remove();renderInvestments();};
 el('investmentCreate').onclick=()=>{el('investmentCreatePanel').hidden=false;el('investmentEventPanel').hidden=true;el('investmentExisting').innerHTML='<option value="">创建新账户</option>'+state.accounts.filter(a=>a.kind==='asset'&&!a.investment_linked).map(a=>`<option value="${a.id}">${escapeHtml(a.name)} · ${money.format(a.value_cny)}</option>`).join('');el('investmentReplace').checked=false;el('investmentCreateError').textContent='';};
 el('investmentCreateClose').onclick=()=>el('investmentCreatePanel').hidden=true;el('investmentEventClose').onclick=()=>el('investmentEventPanel').hidden=true;el('investmentOpening').onclick=()=>openInvestmentEvent('opening');el('investmentTrade').onclick=()=>openInvestmentEvent('buy');el('investmentEventType').onchange=investmentEventFields;el('investmentEventForm').onsubmit=saveInvestmentEvent;
 el('investmentEventForm').addEventListener('input',()=>{investmentRequestId=crypto.randomUUID();});
 el('investmentCreateForm').onsubmit=async e=>{e.preventDefault();if(investmentBusy)return;investmentBusy=true;el('investmentCreateSave').disabled=true;try{const r=await api('/app/fm/api/investments/accounts',{method:'POST',body:JSON.stringify({name:el('investmentName').value.trim(),existingAccountId:el('investmentExisting').value?Number(el('investmentExisting').value):null,confirmReplace:el('investmentReplace').checked})});el('investmentCreatePanel').hidden=true;await refreshInvestments();el('investmentAccount').value=String(r.id);renderInvestments();openInvestmentEvent('cash_opening');showToast('账户已建立，请核对期初现金和股票');}catch(e){el('investmentCreateError').textContent=e.message;}finally{investmentBusy=false;el('investmentCreateSave').disabled=false;}};
 el('investmentRefresh').onclick=async()=>{if(investmentBusy)return;investmentBusy=true;el('investmentRefresh').disabled=true;try{const r=await api('/app/fm/api/investments/quotes/refresh',{method:'POST'});await refreshInvestments();showToast(r.message);}catch(e){showToast(e.message);}finally{investmentBusy=false;el('investmentRefresh').disabled=false;}};
}

start().catch(error => { document.querySelector('.sync').textContent='数据加载失败，请重试'; showToast(error.message); });
