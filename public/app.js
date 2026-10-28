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
  importRows: [],
  importStep: 1,
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
  foot.textContent = `收入 ${money.format(summary.income)} · 支出 ${money.format(summary.expense)}`;
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
    const detail = row.type === 'repayment' ? `本金 ${money.format(row.principal_amount)} · 利息 ${money.format(row.interest_amount)}` : row.note;
    return `<tr data-type="${row.type}">
      <td>${escapeHtml(row.occurred_on)}</td>
      <td><strong>${escapeHtml(row.merchant)}</strong><br><small>${escapeHtml(detail)}</small></td>
      <td>${escapeHtml(row.category)}</td>
      <td>${escapeHtml(row.account_name || '未指定')}</td>
      <td><span class="tag ${row.type === 'income' ? 'good' : ''}">${labelForType(row.type)}</span></td>
      <td class="num ${signedClass}">${row.type === 'transfer' ? '' : row.amount > 0 ? '+ ' : '- '}${money.format(Math.abs(row.amount))}</td>
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
      <div class="activity-amount ${row.amount > 0 ? 'up' : 'down'}">${row.amount > 0 ? '+ ' : '- '}${money.format(Math.abs(row.amount))}<small>${escapeHtml(row.occurred_on)}</small></div>
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
      accountId: Number(document.getElementById('entryAccount').value),
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
      <div class="budget-number"><strong>${money.format(budget.monthly_limit)}</strong><small>月度预算</small></div>
    </article>`;
  }).join('');
  if (!state.budgets.length) container.textContent='尚未设置预算';
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

async function loadReport(period) {
  const report = await api(`/app/fm/api/reports?period=${period}`);
  document.getElementById('reportIncome').textContent = money.format(report.income);
  document.getElementById('reportExpense').textContent = money.format(report.expense);
  document.getElementById('reportRate').textContent = `${(report.savingsRate * 100).toFixed(1)}%`;
  document.getElementById('reportSubtitle').textContent = `${report.from} — ${report.to}`;
  document.getElementById('reportSavings').textContent='结余 '+money.format(report.savings);
  const list = document.querySelector('#reportsView .bar-list');
  if (!report.categories.length) list.textContent='本期暂无支出';
  const max = Math.max(...report.categories.map(item => item.amount), 1);
  if (report.categories.length) list.innerHTML = report.categories.map(item => `<div class="bar-row"><span>${escapeHtml(item.category)}</span><div class="bar-track"><div class="bar" style="width:${Math.max(4, item.amount / max * 100)}%"></div></div><span class="num">${money.format(item.amount)}</span></div>`).join('');
}

function renderImportStep() {
  document.querySelectorAll('[data-import-step]').forEach(panel => panel.classList.toggle('hidden', Number(panel.dataset.importStep) !== state.importStep));
  document.querySelectorAll('[data-step-indicator]').forEach(indicator => {
    const step = Number(indicator.dataset.stepIndicator);
    indicator.classList.toggle('active', step === state.importStep);
    indicator.classList.toggle('done', step < state.importStep);
  });
  document.getElementById('importPrev').disabled = state.importStep === 1;
  const next = document.getElementById('importNext');
  next.disabled = state.importStep === 1 && !state.importRows.length;
  next.textContent = state.importStep === 3 ? `确认导入 ${state.importRows.filter(row => !row.duplicate).length} 条` : '下一步';
  if (state.importStep === 3) renderImportReview();
}

function renderImportReview() {
  const review = document.querySelector('[data-import-step="3"]');
  const duplicates = state.importRows.filter(row => row.duplicate).length;
  review.querySelector('.review-box').innerHTML = `<div><span>有效记录</span><strong>${state.importRows.length - duplicates}</strong></div><div><span>重复记录</span><strong>${duplicates}</strong></div><div><span>需确认</span><strong>${state.importRows.filter(row => row.category === '待分类').length}</strong></div>`;
  review.querySelector('tbody').innerHTML = state.importRows.slice(0, 5).map(row => `<tr><td>${escapeHtml(row.occurredOn)}</td><td>${escapeHtml(row.merchant)}</td><td><span class="tag ${row.duplicate ? 'warn' : 'good'}">${row.duplicate ? '重复记录' : escapeHtml(row.category)}</span></td><td class="num ${row.amount < 0 ? 'down' : 'up'}">${money.format(row.amount)}</td></tr>`).join('');
}

async function chooseCsv() {
  const sample = '交易时间,交易对方,金额（元）,收/支,交易状态\n2026-10-28,盒马鲜生,286.40,支出,交易成功\n2026-10-27,余额宝收益,18.26,收入,交易成功\n2026-10-25,招商银行还款,8426.00,转账,交易成功';
  if (!state.accounts.length) await loadAccounts();
  const payload = await api('/app/fm/api/import/preview', { method: 'POST', body: JSON.stringify({ csv: sample, accountId: state.accounts.find(account => account.name.includes('支付宝'))?.id }) });
  state.importRows = payload.rows;
  document.getElementById('sampleChosen').classList.remove('hidden');
  document.getElementById('sampleChosen').innerHTML = `<strong>alipay_2026-10.csv</strong><div style="color:var(--muted);font-size:12px;margin-top:3px">检测到 ${payload.total} 条记录 · ${payload.duplicates} 条重复</div>`;
  renderImportStep();
}

async function commitImport() {
  const result = await api('/app/fm/api/import/commit', { method: 'POST', body: JSON.stringify({ filename: 'alipay_2026-10.csv', source: '支付宝', rows: state.importRows }) });
  closeModal('importModal');
  state.importRows = [];
  state.importStep = 1;
  document.getElementById('sampleChosen').classList.add('hidden');
  renderImportStep();
  await Promise.all([loadTransactions(), loadSummary(), loadBudgets()]);
  showToast(`已导入 ${result.imported} 条，跳过 ${result.duplicates} 条重复记录`);
  switchView('transactions');
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  document.querySelectorAll('[data-jump]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.jump)));
  document.getElementById('addBtn').addEventListener('click', () => openModal('addModal'));
  document.getElementById('importBtn').addEventListener('click', () => openModal('importModal'));
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
  document.getElementById('exportReport').addEventListener('click', () => showToast('PDF 报告将在生产部署阶段接入'));
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-period]').forEach(item => item.classList.toggle('active', item === button));
    loadReport(button.dataset.period).catch(error => showToast(error.message));
  }));
  document.getElementById('chooseSample').addEventListener('click', () => chooseCsv().catch(error => showToast(error.message)));
  document.getElementById('importPrev').addEventListener('click', () => { if (state.importStep > 1) { state.importStep--; renderImportStep(); } });
  document.getElementById('importNext').addEventListener('click', () => {
    if (state.importStep < 3) { state.importStep++; renderImportStep(); }
    else commitImport().catch(error => showToast(error.message));
  });
}

async function start() {
  const now=new Date();
  document.querySelector('.page-kicker').textContent=now.toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',weekday:'long'});
  document.getElementById('entryDate').value=now.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
  editingAccountId=null;
  setupAccountForm();
  bindEvents();
  refreshIcons();
  renderImportStep();
  await Promise.all([loadSummary(), loadAccounts(), loadTransactions(), loadBudgets()]);
  document.querySelector('.sync').textContent='已从服务器读取数据';
}

start().catch(error => { document.querySelector('.sync').textContent='数据加载失败，请重试'; showToast(error.message); });

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
