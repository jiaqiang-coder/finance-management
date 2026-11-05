var editingAccountId = null;
const titles = {
  dashboard: '资产总览',
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
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'dashboard') loadTrend();
  if (name === 'fx') loadFxManagement().catch(e=>showToast(e.message));
  if (name === 'accounts') loadAccounts();
  if (name === 'transactions') loadTransactions();
  if (name === 'budgets') loadBudgets();
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
  values[0].closest('.metric').querySelector('.metric-foot').textContent = '暂无历史估值，暂不计算月度变化';
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
      <td class="num"><button class="btn" data-edit-account="${account.id}">编辑</button></td>
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
  renderAllocation();
  fillAccountSelect();
}

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
function renderTrend(){
  if(!trendData)return;
  const currency=trendElement('trendCurrency').value,metric=trendElement('trendMetric').value;
  const format=value=>trendFormat(value,currency);
  const {points,detail,today,firstDay}=trendData;
  trendElement('trendToday').textContent='今日（未结算）：'+format(today.totals[currency]?.[metric]);
  const chart=trendElement('trendChart');
  const values=points.map(point=>point.totals[currency]?.[metric]);
  const available=values.filter(Number.isFinite);
  if(!available.length){
    chart.textContent=points.length?'暂无可用的折算汇率，未绘制这些日期。':'从 '+firstDay+' 开始记录，等待首个日终快照。';
  }else{
    const min=Math.min(...available),max=Math.max(...available),span=max-min;
    const xy=(v,i)=>[22+596*(points.length===1?.5:i/(points.length-1)),span===0?75:20+110*(max-v)/span];
    let paths=[],segment=[];
    const dots=values.map((v,i)=>{
      if(!Number.isFinite(v)){if(segment.length)paths.push(segment);segment=[];return '';}
      const [x,y]=xy(v,i);segment.push(`${x},${y}`);
      return `<circle cx="${x}" cy="${y}" r="4" fill="#346b9d"><title>${escapeHtml(points[i].day)} · ${escapeHtml(format(v))}</title></circle>`;
    });
    if(segment.length)paths.push(segment);
    chart.innerHTML=`<svg viewBox="0 0 640 155" role="img" aria-label="日终趋势，详细金额可按日期选择" style="width:100%;max-height:220px"><path d="M22 20V138H618" stroke="#ccd3cc" fill="none"/>${paths.map(p=>`<polyline points="${p.join(' ')}" stroke="#346b9d" stroke-width="2" fill="none"/>`).join('')}${dots.join('')}</svg><div class="toolbar"><span>${escapeHtml(points[0].day)}</span><span>${escapeHtml(points.at(-1).day)}</span></div>`;
  }
  const panel=trendElement('trendDetail');
  if(!detail){panel.textContent='';return;}
  const change=points.find(point=>point.day===detail.day)?.changes?.[currency]?.[metric];
  const usd=detail.fx?.rates.USD;
  const rows=detail.items.filter(item=>metric==='netWorth'||item.kind===(metric==='assets'?'asset':'liability'));
  panel.innerHTML=`<p><strong>${escapeHtml(detail.day)} 日终：${escapeHtml(format(detail.totals[currency]?.[metric]))}</strong></p>
    <p>${change?`较前日 ${escapeHtml(format(change.delta))} · 汇率影响 ${escapeHtml(format(change.fxImpact))} · 其他变动 ${escapeHtml(format(change.otherChange))}`:'暂无可比较的上一日金额'}</p>
    <p class="metric-foot">参考报价日：${escapeHtml(detail.fx?.quotedAt||'无')}。手动估值或无法匹配前日汇率的账户，其人民币估值变动计入其他变动；美元口径另包含人民币折美元的汇率影响。</p>
    <ul>${rows.map(item=>{
      const sign=metric==='netWorth'&&item.kind==='liability'?-1:1;
      const amount=currency==='CNY'?sign*item.value_cny:usd>0?sign*item.value_cny/usd:null;
      return `<li>${escapeHtml(item.name)} · ${escapeHtml(String(item.original_value))} ${escapeHtml(item.currency)} → ${escapeHtml(format(amount))}${item.fx_updated_at?' · 估值汇率日 '+escapeHtml(item.fx_updated_at):item.fx_mode==='manual'?' · 手动估值':''}</li>`;
    }).join('')}</ul>`;
}

start().catch(error => { document.querySelector('.sync').textContent='数据加载失败，请重试'; showToast(error.message); });
