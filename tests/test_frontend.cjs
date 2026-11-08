const fs=require('fs'),vm=require('vm'),assert=require('assert');
const nodes=new Map();const node=()=>({querySelectorAll(){return []},textContent:'',innerHTML:'',closest(){return this},querySelector(){return this},value:''});
const get=s=>{if(!nodes.has(s))nodes.set(s,node());return nodes.get(s)};
const lists=new Map();const many=s=>{if(!lists.has(s))lists.set(s,Array.from({length:s.includes('accounts-summary')?3:4},node));return lists.get(s)};
const context={console,Intl,Date,document:{querySelector:get,querySelectorAll:many,getElementById:get},window:{},fetch:async()=>{throw Error('Unexpected network')}};
vm.createContext(context);let s=fs.readFileSync('public/app.js','utf8').replace(/start\(\)\.catch\([\s\S]*?\);\n/,'');vm.runInContext(s,context);
vm.runInContext(`state.accounts=[];state.budgets=[];renderAllocation();renderBudgets();`,context);
assert.match(get('assetAllocation').innerHTML,/暂无资产/);assert.match(get('#dashboardView .alert-list').innerHTML,/暂无预算预警/);
assert.equal(many('#budgetsView .metric-value')[0].textContent,'¥0');assert.equal(many('#budgetsView .metric-value')[3].textContent,'—');
vm.runInContext(`state.accounts=[{kind:'asset',category:'银行存款',value_cny:2500}];renderAllocation();state.budgets=[{category:'日常',monthly_limit:100,spent:95,warning_threshold:.9}];renderBudgets();`,context);
assert.match(get('assetAllocation').innerHTML,/2,500/);assert.match(get('assetAllocation').innerHTML,/100.0%/);assert.match(get('#dashboardView .alert-list').innerHTML,/95%/);
console.log('PASS UI: empty asset allocation and budgets; genuine asset amount/proportion; genuine budget alert; no fixed forecast');
(async()=>{
context.__calls=[];
vm.runInContext(`closeModal=()=>{};showToast=()=>{};loadAccounts=async()=>{};loadSummary=async()=>{};`,context);
for(const [id,val] of Object.entries({accountFxMode:'manual',accountName:'真实账户',accountValue:'1234.5',accountOriginal:'1234.5',accountKind:'asset',accountCategory:'银行存款',accountCurrency:'CNY',accountNote:''}))get(id).value=val;
get('accountForm').reset=()=>{};get('saveAccountBtn').disabled=false;
vm.runInContext(`api=async(url,opt)=>{__calls.push({url,...JSON.parse(opt.body)});return {id:1};};`,context);
await vm.runInContext(`saveAccount({preventDefault(){}})`,context);
assert.equal(context.__calls.length,1);assert.equal(context.__calls[0].url,'/app/fm/api/accounts');assert.equal(context.__calls[0].valueCny,1234.5);assert.equal(get('saveAccountBtn').disabled,false);
get('accountName').value=' ';await vm.runInContext(`saveAccount({preventDefault(){}})`,context);assert.equal(context.__calls.length,1);assert.match(get('accountError').textContent,/账户名称/);
get('accountName').value='失败测试';vm.runInContext(`api=async()=>{throw Error('网络失败')}`,context);await vm.runInContext(`saveAccount({preventDefault(){}})`,context);assert.equal(get('accountError').textContent,'网络失败');assert.equal(get('saveAccountBtn').disabled,false);
get('saveAccountBtn').disabled=true;await vm.runInContext(`saveAccount({preventDefault(){}})`,context);assert.equal(get('saveAccountBtn').disabled,true);
console.log('PASS account form: valid payload; whitespace rejected; request error shown; retry enabled; duplicate submission blocked');
context.__calls=[];get('saveBudgetBtn').disabled=false;
for(const [id,val] of Object.entries({budgetCategory:'交通出行',budgetLimit:'500',budgetThreshold:'80'}))get(id).value=val;
vm.runInContext(`loadBudgets=async()=>{};editingBudgetId=null;api=async(url,opt)=>{__calls.push({url,method:opt.method,...JSON.parse(opt.body)});return {id:2}};`,context);
await vm.runInContext(`saveBudget({preventDefault(){}})`,context);assert.equal(context.__calls[0].method,'POST');assert.equal(context.__calls[0].warningThreshold,.8);
vm.runInContext(`editingBudgetId=2`,context);get('budgetLimit').value='600';await vm.runInContext(`saveBudget({preventDefault(){}})`,context);assert.equal(context.__calls[1].url,'/app/fm/api/budgets/2');assert.equal(context.__calls[1].method,'PUT');
get('budgetLimit').value='0';await vm.runInContext(`saveBudget({preventDefault(){}})`,context);assert.equal(context.__calls.length,2);
get('budgetLimit').value='600';vm.runInContext(`api=async()=>{throw Error('预算保存失败')}`,context);await vm.runInContext(`saveBudget({preventDefault(){}})`,context);assert.equal(get('budgetError').textContent,'预算保存失败');assert.equal(get('saveBudgetBtn').disabled,false);
console.log('PASS budget form: create/edit payload, percent conversion, invalid amount blocked, failure shown and retry enabled');
context.__calls=[];
context.TextDecoder=TextDecoder;
for(const id of ['importFile','importAccount','importPreview','confirmImport','previewImport']){
  get(id).classList={add(){},remove(){}};
}
const csv='日期,交易方,金额,类型\n2026-11-05,测试咖啡,12.50,支出\n';
get('importFile').files=[{name:'账单.csv',size:Buffer.byteLength(csv),arrayBuffer:async()=>new TextEncoder().encode(csv)}];
get('importAccount').value='3';
vm.runInContext(`refreshLedgerViews=()=>{};api=async(url,opt)=>{
  __calls.push({url,...JSON.parse(opt.body)});
  return url.endsWith('preview')?{total:1,duplicates:0,importable:1,rows:[{occurredOn:'2026-11-05',merchant:'<咖啡>',amount:-12.5,currency:'CNY'}]}:{imported:1,duplicates:0};
};`,context);
await vm.runInContext('handleCsv(false)',context);
assert.equal(context.__calls[0].csv,csv);
assert.equal(context.__calls[0].accountId,'3');
assert.match(get('importPreview').innerHTML,/&lt;咖啡&gt;/);
assert.equal(get('confirmImport').disabled,false);
await vm.runInContext('handleCsv(true)',context);
assert.equal(context.__calls[1].url,'/app/fm/api/import/commit');
assert.equal(get('confirmImport').disabled,true);

context.__calls=[];
context.Event=Event;
get('ledgerForm').elements={accountId:{value:''}};
const ledger=get('ledgerText'), mic=get('ledgerMic'), run=get('ledgerRun');
ledger.addEventListener=(_,listener)=>{ledger.oninput=listener};
ledger.dispatchEvent=()=>ledger.oninput();
mic.querySelector=()=>get('micLabel');
let preview;
run.click=()=>{preview=run.onclick()};
context.window.SpeechRecognition=class{
  start(){context._speech=this}
  stop(){this.onend()}
};
vm.runInContext(`api=async(url,opt)=>{
  __calls.push({url,...JSON.parse(opt.body)});
  return {mode:'create',source:'local',fields:{merchant:'午饭',amount:48,occurredOn:'2026-11-05',currency:'CNY',type:'expense'}};
};bindLedger();`,context);
mic.onclick();
assert.equal(context._speech.lang,'zh-CN');
context._speech.onresult({results:[[{transcript:'今天午饭花了48元'}]]});
context._speech.onend();
await preview;
assert.equal(ledger.value,'今天午饭花了48元');
assert.equal(context.__calls.length,1);
assert.equal(context.__calls[0].url,'/app/fm/api/ledger/interpret');
assert.match(get('ledgerResult').innerHTML,/核对新流水.*保存流水/);
get('ledgerCancel').onclick();
assert.match(get('ledgerStatus').textContent,/流水未变更/);
console.log('PASS UI: real CSV file decoding, preview before upload confirmation, speech callback and review before save');
})().catch(e=>{console.error(e);process.exitCode=1});

get('trendCurrency').value='USD';
get('trendMetric').value='assets';
vm.runInContext(`trendData={
  firstDay:'2026-11-05',
  points:[{day:'2026-11-05',totals:{CNY:{assets:72000},USD:{assets:10000}},changes:null},
    {day:'2026-11-06',totals:{CNY:{assets:71000},USD:{assets:10000}},changes:{CNY:{assets:{delta:-1000,fxImpact:-1000,otherChange:0}}}}],
  today:{totals:{USD:null}},
  detail:{day:'2026-11-06',totals:{CNY:{assets:71000},USD:{assets:10000}},fx:{quotedAt:'2026-11-06',rates:{USD:7.1}},
    items:[{name:'<账户>',kind:'asset',original_value:10000,currency:'USD',value_cny:71000}]}
};renderTrend();`,context);
assert.match(get('trendToday').textContent,/暂无数据/);
assert.match(get('trendChart').innerHTML,/<svg/);
assert.match(get('trendDetail').innerHTML,/10,000/);
assert.match(get('trendDetail').innerHTML,/&lt;账户&gt;/);
get('trendCurrency').value='CNY';
vm.runInContext('renderTrend()',context);
assert.match(get('trendDetail').innerHTML,/汇率影响.*1,000/);
console.log('PASS trend UI: currency switch, FX attribution, missing live quote and safe account display');

// Narrow value ranges must retain distinct monetary tick labels at large balances.
vm.runInContext(`trendData.points=[{day:'2026-11-05',totals:{CNY:{assets:14000}}},{day:'2026-11-06',totals:{CNY:{assets:14020}}}];trendData.detail=null;renderTrend();`,context);
const ticks=[...get('trendChart').innerHTML.matchAll(/text-anchor="end"[^>]*>([^<]+)<\/text>/g)].map(m=>m[1]);
assert.equal(new Set(ticks.slice(0,5)).size,5);
assert.equal(vm.runInContext("changeClass(0)",context),'change-neutral');
assert.equal(vm.runInContext("changeClass(-1,true)",context),'change-positive');
console.log('PASS chart: distinct large-balance tick labels; zero neutral; decreasing liabilities favourable');

const pie=vm.runInContext(`investmentPieData([{complete:true,cashValueCny:50,positions:[{id:1,name:'苹果',symbol:'AAPL',quantity:2,marketValueCny:100}]},{complete:true,cashValueCny:0,positions:[{id:1,name:'苹果',symbol:'AAPL',quantity:1,marketValueCny:50}]}])`,context);
assert.equal(pie.total,200);assert.equal(pie.items.length,2);assert.equal(pie.items.find(x=>x.key==='1').value,150);assert.equal(pie.items.find(x=>x.key==='cash').value,50);
assert.equal(vm.runInContext('investmentPieData([{complete:false,cashValueCny:100,positions:[]}]).complete',context),false);
assert.equal(vm.runInContext('investmentPieData([]).total',context),0);
const singles=vm.runInContext(`investmentPieData([{complete:true,cashValueCny:0,positions:[{id:1,name:'单一持仓',symbol:'ONE',quantity:1,marketValueCny:100}]}])`,context);
assert.equal(singles.items.length,1);assert.equal(singles.items[0].value/singles.total,1);
console.log('PASS allocation: cross-account security aggregation, cash inclusion, missing valuation guard, empty and single holding');

const grouped=vm.runInContext(`investmentPieData([{complete:true,cashValueCny:10,positions:Array.from({length:8},(_,i)=>({id:i+1,name:'股票'+i,symbol:'S'+i,quantity:1,marketValueCny:10}))}])`,context);
assert.equal(grouped.total,90);assert.equal(grouped.items.find(p=>p.key==='other').value,20);
vm.runInContext("state.accounts=[{kind:'asset',category:'很长的股票资产分类',value_cny:100},{kind:'asset',category:'零余额分类',value_cny:0}];renderAllocation()",context);
assert.match(get('assetAllocation').innerHTML,/allocation-name.*很长的股票资产分类/);
assert.doesNotMatch(get('assetAllocation').innerHTML,/零余额分类|legend-row/);
vm.runInContext("state.budgets=[{category:'超支分类',monthly_limit:100,spent:125,warning_threshold:.9}];renderAlerts()",context);
assert.match(get('#dashboardView .alert-list').innerHTML,/125% 已使用/);assert.match(get('#dashboardView .alert-list').innerHTML,/超支 ¥25/);assert.match(get('#dashboardView .alert-list').innerHTML,/aria-valuenow="100"/);
console.log('PASS dashboard: zero rows omitted, independent row layout, overspend status and bounded progress; pie grouping preserves totals');
// Direct labels stay visible without selecting a segment, including tiny slices.
vm.runInContext(`renderInvestmentPie([{complete:true,cashValueCny:9999,positions:[{id:1,name:'超长名称测试股票基金',symbol:'TEST',quantity:1,marketValueCny:1}]}])`,context);
assert.match(get('investmentAllocation').innerHTML,/pie-direct-name/);
assert.match(get('investmentAllocation').innerHTML,/超长名称测试股…/);
assert.match(get('investmentAllocation').innerHTML,/&lt;0.1%/);
assert.match(get('investmentAllocation').innerHTML,/账户现金<\/tspan>/);
assert.match(get('investmentAllocation').innerHTML,/viewBox="0 0 420 280"/);
for(const values of [[1],[99,1],[1,1,1,1,1,1,1,93],[90,1,1,1,1,1,1,4]]){
 const labels=vm.runInContext(`investmentPieLabels({total:100,items:${JSON.stringify(values.map(value=>({value})))}})`,context);
 for(const right of [false,true]){const side=labels.filter(p=>p.right===right).sort((a,b)=>a.labelY-b.labelY);for(let i=0;i<side.length;i++){assert(side[i].labelY>=28&&side[i].labelY<=248);if(i)assert(side[i].labelY-side[i-1].labelY>=30);}}
}
console.log('PASS pie direct labels: visible names and proportions, tiny slices, long names and collision spacing');

assert.match(vm.runInContext('aiText("<script>alert(1)</script> **明确依据**")',context),/&lt;script&gt;/);
assert.doesNotMatch(vm.runInContext('aiText("<img src=x onerror=alert(1)>")',context),/<img/);
assert.match(vm.runInContext('aiText("**明确依据**")',context),/<strong>明确依据<\/strong>/);
console.log('PASS assistant UI: model text is escaped before limited bold formatting');
