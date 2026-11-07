const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'hengzi.db');
const PORT = Number(process.env.PORT || 4173);
const BASE_PATH = '/app/fm';
const APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD?.trim() ||
    crypto.createHash('sha256').update(APP_PASSWORD.trim()).digest('hex') === '8469ff5c7f8b5aa893c75bc11b0b1571042b0ca5412fb64eb3df82b1348779a7') {
  console.error('Set APP_PASSWORD to a private password; the old development password is not allowed.');
  process.exit(1);
}
const sessions = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('asset','liability')),
    category TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'CNY',
    value_cny REAL NOT NULL DEFAULT 0,
    original_value REAL NOT NULL DEFAULT 0,
    update_method TEXT NOT NULL DEFAULT 'manual',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_on TEXT NOT NULL,
    merchant TEXT NOT NULL,
    category TEXT NOT NULL,
    account_id INTEGER,
    type TEXT NOT NULL CHECK(type IN ('income','expense','transfer','trade','repayment')),
    amount REAL NOT NULL,
    expense_amount REAL NOT NULL DEFAULT 0,
    principal_amount REAL NOT NULL DEFAULT 0,
    interest_amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'CNY',
    note TEXT NOT NULL DEFAULT '',
    external_id TEXT,
    fingerprint TEXT UNIQUE,
    import_batch_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL UNIQUE,
    monthly_limit REAL NOT NULL,
    warning_threshold REAL NOT NULL DEFAULT 0.9,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    source TEXT NOT NULL,
    total_rows INTEGER NOT NULL,
    imported_rows INTEGER NOT NULL,
    duplicate_rows INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS valuations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    valued_on TEXT NOT NULL,
    value_cny REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );
`);

function seed() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count;
  if (existing) return;
  const insertAccount = db.prepare(`
    INSERT INTO accounts (name, kind, category, currency, value_cny, original_value, update_method, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const accounts = [
    ['上海自住房', 'asset', '房产', 'CNY', 5200000, 5200000, '手动估值', '最近估值 2026-10-01'],
    ['A股 · 中信证券', 'asset', '股票', 'CNY', 1142680, 1142680, '行情更新', '8 个持仓'],
    ['美股 · IBKR', 'asset', '股票 / 期权', 'USD', 962440, 135200, '行情更新', '含期权 3 份'],
    ['基金组合', 'asset', '基金', 'CNY', 842630, 842630, '净值更新', '场内外共 12 只'],
    ['支付宝余额', 'asset', '支付账户', 'CNY', 26380, 26380, '账单导入', '最近同步今天'],
    ['招商银行', 'asset', '银行存款', 'CNY', 408000, 408000, '账单导入', '工资与日常结算'],
    ['公积金账户', 'asset', '受限资产', 'CNY', 284210, 284210, '手动更新', '每月计提'],
    ['对外贷款', 'asset', '债权', 'CNY', 180000, 180000, '还款计划', '剩余本金'],
    ['房贷 · 建设银行', 'liability', '长期负债', 'CNY', 2274600, 2274600, '还款计划', '剩余 218 期'],
    ['招商信用卡', 'liability', '流动负债', 'CNY', 9180, 9180, '账单导入', '4 天后还款']
  ];
  for (const row of accounts) insertAccount.run(...row);

  const accountIds = Object.fromEntries(db.prepare('SELECT id, name FROM accounts').all().map(row => [row.name, row.id]));
  const insertTransaction = db.prepare(`
    INSERT INTO transactions
      (occurred_on, merchant, category, account_id, type, amount, expense_amount, principal_amount, interest_amount, currency, note, fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const transactions = [
    ['2026-10-28', '盒马鲜生', '日常消费', accountIds['支付宝余额'], 'expense', -286.4, 286.4, 0, 0, 'CNY', '家庭采购'],
    ['2026-10-27', '基金分红', '投资收入', accountIds['招商银行'], 'income', 1248, 0, 0, 0, 'CNY', '红利指数基金'],
    ['2026-10-25', '建设银行房贷', '居住', accountIds['招商银行'], 'repayment', -12160, 3950, 8210, 3950, 'CNY', '本金与利息拆分'],
    ['2026-10-24', '招商信用卡还款', '账户转账', accountIds['招商银行'], 'transfer', -8426, 0, 0, 0, 'CNY', '不计入收支'],
    ['2026-10-22', '房屋租金', '居住', accountIds['招商银行'], 'expense', -5200, 5200, 0, 0, 'CNY', '人才公寓'],
    ['2026-10-15', '工资收入', '工资', accountIds['招商银行'], 'income', 42800, 0, 0, 0, 'CNY', '十月工资'],
    ['2026-10-12', '滴滴出行', '交通出行', accountIds['支付宝余额'], 'expense', -86, 86, 0, 0, 'CNY', ''],
    ['2026-10-08', '家庭聚餐', '日常消费', accountIds['招商信用卡'], 'expense', -868, 868, 0, 0, 'CNY', '']
  ];
  for (const row of transactions) {
    const fingerprint = crypto.createHash('sha256').update([row[0], row[1], row[5], row[3]].join('|')).digest('hex');
    insertTransaction.run(...row, fingerprint);
  }

  const insertBudget = db.prepare('INSERT INTO budgets (category, monthly_limit, warning_threshold) VALUES (?, ?, ?)');
  [['居住', 19000, .9], ['日常消费', 8000, .9], ['交通出行', 3000, .9], ['其他', 1500, .9]].forEach(row => insertBudget.run(...row));
}
// 演示数据初始化已禁用


// Daily official ECB reference rates. Existing accounts keep manual valuation mode.
for(const [name,type] of [['fx_mode',"TEXT NOT NULL DEFAULT 'manual'"],['fx_rate','REAL'],['fx_updated_at','TEXT']]){
 if(!db.prepare('PRAGMA table_info(accounts)').all().some(c=>c.name===name))db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS fx_cache(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS fx_history(quoted_on TEXT PRIMARY KEY,usd_cny REAL NOT NULL,hkd_cny REAL NOT NULL,fetched_at TEXT NOT NULL,source TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS fx_jobs(day TEXT PRIMARY KEY,status TEXT NOT NULL,attempted_at TEXT NOT NULL,message TEXT);`);
let fxPending=null,lastFxAttempt=0;
const FX_SOURCE='欧洲中央银行 ECB';
function shanghaiDay(ms=Date.now()){return new Date(ms).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});}
function cachedFx(){const row=db.prepare('SELECT payload FROM fx_cache WHERE id=1').get();return row?JSON.parse(row.payload):null;}
function parseEcb(xml){
 const date=xml.match(/\btime\s*=\s*["'](\d{4}-\d{2}-\d{2})["']/)?.[1],rates={};
 for(const tag of xml.matchAll(/<(?:\w+:)?Cube\b[^>]*>/g)){
  const c=tag[0].match(/\bcurrency\s*=\s*["']([A-Z]{3})["']/)?.[1];
  const v=tag[0].match(/\brate\s*=\s*["']([0-9.]+)["']/)?.[1];if(c&&v)rates[c]=Number(v);
 }
 if(!date||!['USD','HKD','CNY'].every(k=>Number.isFinite(rates[k])&&rates[k]>0))throw Error('官方汇率内容不完整');
 return {quotedAt:date,rates:{CNY:1,USD:rates.CNY/rates.USD,HKD:rates.CNY/rates.HKD}};
}
async function getFx(force=false){
 const cached=cachedFx();if(cached&&shanghaiDay(cached.fetchedAt)===shanghaiDay()&&!force)return cached;
 if(fxPending)return fxPending;
 if(Date.now()-lastFxAttempt<60000){if(cached)return {...cached,stale:true,warning:'刷新频率受限，请稍后重试'};throw Error('汇率暂不可用，请稍后重试或选择手动折算');}
 lastFxAttempt=Date.now();
 fxPending=(async()=>{try{
  const response=await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('官方接口暂不可用');
  const parsed=parseEcb(await response.text()),prev=cachedFx();
  if(prev&&parsed.quotedAt<prev.quotedAt)throw Error('官方返回较旧报价，保留现有汇率');
  const value={...parsed,source:FX_SOURCE,sourceUrl:'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',frequency:'每日同步；周末及休市日沿用最近交易日参考汇率',fetchedAt:Date.now(),stale:false};
  db.exec('BEGIN');try{
   db.prepare('INSERT INTO fx_cache(id,payload) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(value));
   db.prepare('INSERT INTO fx_history VALUES (?,?,?,?,?) ON CONFLICT(quoted_on) DO UPDATE SET usd_cny=excluded.usd_cny,hkd_cny=excluded.hkd_cny,fetched_at=excluded.fetched_at').run(value.quotedAt,value.rates.USD,value.rates.HKD,new Date(value.fetchedAt).toISOString(),FX_SOURCE);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return value;
 }catch(e){if(cached){const fallback={...cached,stale:true,warning:'官方同步失败，保留上次报价',lastAttemptAt:Date.now()};db.prepare('UPDATE fx_cache SET payload=? WHERE id=1').run(JSON.stringify(fallback));return fallback;}throw Error('无法取得官方汇率，请稍后重试或选择手动折算');}finally{fxPending=null;}})();return fxPending;
}
async function revalueAccounts(force=false){
 if(!force&&!db.prepare("SELECT id FROM accounts WHERE fx_mode='auto' AND currency!='CNY' LIMIT 1").get())return null;
 const fx=await getFx(force);if(fx.stale)return fx;
 db.exec('BEGIN');try{for(const c of ['USD','HKD'])db.prepare("UPDATE accounts SET value_cny=ROUND(original_value*?,2),fx_rate=?,fx_updated_at=? WHERE fx_mode='auto' AND currency=?").run(fx.rates[c],fx.rates[c],fx.quotedAt,c);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}invSyncAll();return fx;
}
async function accountInput(b){
 const mode=b.fxMode||'manual',currency=b.currency||'CNY';
 if(typeof b.name!=='string'||!b.name.trim()||!['asset','liability'].includes(b.kind)||!['CNY','USD','HKD'].includes(currency)||!['auto','manual'].includes(mode))throw Error('账户名称、性质、币种或折算模式无效');
 const original=b.originalValue===undefined?Number(b.valueCny):b.originalValue;
 if(typeof original!=='number'||!Number.isFinite(original)||original<0)throw Error('原币金额无效');
 let value=b.valueCny,rate=null,quoted=null;
 if(mode==='auto'){if(currency==='CNY'){value=original;rate=1;}else{const fx=await getFx();if(fx.stale)throw Error('当前无法更新官方汇率，请重试或选择手动折算');rate=fx.rates[currency];value=Math.round(original*rate*100)/100;quoted=fx.quotedAt;}}
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error('人民币价值无效');
 return {name:b.name.trim(),kind:b.kind,category:String(b.category||'其他'),currency,value,original,mode,rate,quoted,note:String(b.note||'')};
}
async function dailyFx(){
 const day=shanghaiDay(),clock=new Date().toLocaleTimeString('en-GB',{timeZone:'Asia/Shanghai',hour12:false});
 if(clock<'01:10:00'||db.prepare('SELECT day FROM fx_jobs WHERE day=?').get(day))return;
 db.prepare('INSERT INTO fx_jobs VALUES (?,?,?,?)').run(day,'running',new Date().toISOString(),'');
 try{const fx=await revalueAccounts(true);db.prepare('UPDATE fx_jobs SET status=?,message=? WHERE day=?').run(fx.stale?'failed':'success',fx.warning||'同步成功',day);}catch(e){db.prepare('UPDATE fx_jobs SET status=?,message=? WHERE day=?').run('failed',e.message,day);}
}
setInterval(()=>dailyFx().catch(()=>{}),60000).unref();

// Record the state actually saved before each Shanghai midnight.
const DAY_MS = 86400000;
const dayStart = day => Date.parse(day + 'T00:00:00+08:00');
const changeDay = (day, offset) => shanghaiDay(dayStart(day) + offset * DAY_MS);
const stampSql = "CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER)";
function accountVersionJson(prefix) {
  return "json_object(" + ['name','kind','category','currency','original_value','value_cny','fx_mode','fx_rate','fx_updated_at']
    .map(key => "'"+key+"',"+prefix+key).join(',') + ")";
}
db.exec('BEGIN IMMEDIATE');
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trend_config(id INTEGER PRIMARY KEY CHECK(id=1), first_day TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account_versions(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, recorded_ms INTEGER NOT NULL, payload TEXT);
    CREATE INDEX IF NOT EXISTS account_versions_lookup ON account_versions(account_id, recorded_ms DESC, id DESC);
    CREATE TABLE IF NOT EXISTS fx_versions(id INTEGER PRIMARY KEY, recorded_ms INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS daily_snapshots(day TEXT PRIMARY KEY, cutoff_ms INTEGER NOT NULL, generated_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS version_account_insert AFTER INSERT ON accounts BEGIN
      INSERT INTO account_versions(account_id,recorded_ms,payload) VALUES(NEW.id,${stampSql},${accountVersionJson('NEW.')});
    END;
    CREATE TRIGGER IF NOT EXISTS version_account_update AFTER UPDATE ON accounts
    WHEN ${accountVersionJson('NEW.')} IS NOT ${accountVersionJson('OLD.')} BEGIN
      INSERT INTO account_versions(account_id,recorded_ms,payload) VALUES(NEW.id,${stampSql},${accountVersionJson('NEW.')});
    END;
    CREATE TRIGGER IF NOT EXISTS version_account_delete AFTER DELETE ON accounts BEGIN
      INSERT INTO account_versions(account_id,recorded_ms,payload) VALUES(OLD.id,${stampSql},NULL);
    END;
    CREATE TRIGGER IF NOT EXISTS version_fx_insert AFTER INSERT ON fx_cache BEGIN
      INSERT INTO fx_versions(recorded_ms,payload) VALUES(${stampSql},NEW.payload);
    END;
    CREATE TRIGGER IF NOT EXISTS version_fx_update AFTER UPDATE ON fx_cache
    WHEN json_extract(NEW.payload,'$.fetchedAt') IS NOT json_extract(OLD.payload,'$.fetchedAt') BEGIN
      INSERT INTO fx_versions(recorded_ms,payload) VALUES(${stampSql},NEW.payload);
    END;
  `);
  if (db.prepare('INSERT OR IGNORE INTO trend_config VALUES(1,?)').run(shanghaiDay()).changes) {
    db.exec(`INSERT INTO account_versions(account_id,recorded_ms,payload)
      SELECT id,${stampSql},${accountVersionJson('')} FROM accounts;
      INSERT INTO fx_versions(recorded_ms,payload) SELECT ${stampSql},payload FROM fx_cache;`);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
const firstTrendDay = db.prepare('SELECT first_day FROM trend_config WHERE id=1').get().first_day;
const moneyCents = value => Math.round(value * 100);
function totalsFor(items, usdRate, value = item => item.value_cny) {
  let assets=0, liabilities=0;
  for (const item of items) {
    if (item.kind === 'asset') assets += moneyCents(value(item));
    else liabilities += moneyCents(value(item));
  }
  const totals = (a,l) => ({ assets:a/100, liabilities:l/100, netWorth:(a-l)/100 });
  return {CNY:totals(assets,liabilities),USD:usdRate>0?totals(Math.round(assets/usdRate),Math.round(liabilities/usdRate)):null};
}
function snapshotAt(cutoff) {
  const items=db.prepare(`SELECT account_id,payload FROM (
    SELECT account_id,payload,ROW_NUMBER() OVER(PARTITION BY account_id ORDER BY recorded_ms DESC,id DESC) AS seq
    FROM account_versions WHERE recorded_ms < ?
  ) WHERE seq=1 AND payload IS NOT NULL ORDER BY account_id`).all(cutoff)
    .map(row=>({id:row.account_id,...JSON.parse(row.payload)}));
  const quote=db.prepare('SELECT payload FROM fx_versions WHERE recorded_ms < ? ORDER BY recorded_ms DESC,id DESC LIMIT 1').get(cutoff);
  const fx=quote?JSON.parse(quote.payload):null;
  return {items,fx,totals:totalsFor(items,fx?.rates.USD)};
}
function closeTrendDays(now=Date.now()) {
  const today=shanghaiDay(now);
  const last=db.prepare('SELECT MAX(day) AS day FROM daily_snapshots').get().day;
  for(let day=last?changeDay(last,1):firstTrendDay;day<today;day=changeDay(day,1)){
    const cutoff=dayStart(changeDay(day,1));
    db.prepare('INSERT OR IGNORE INTO daily_snapshots VALUES(?,?,?,?)')
      .run(day,cutoff,new Date(now).toISOString(),JSON.stringify(snapshotAt(cutoff)));
  }
}
function trendChanges(previous,current) {
  const old=new Map(previous.items.map(item=>[item.id,item]));
  // Comparable auto-valued positions use the previous applied rate. Manual
  // valuations and positions without a comparable rate remain in the other component.
  const counter=totalsFor(current.items,previous.fx?.rates.USD,item=>{
    const prior=old.get(item.id);
    return item.fx_mode==='auto' && prior?.fx_mode==='auto' && prior.currency===item.currency &&
      item.currency!=='CNY' && prior.fx_rate>0 && item.fx_rate>0
      ?item.original_value*prior.fx_rate:item.value_cny;
  });
  return Object.fromEntries(['CNY','USD'].map(currency=>[currency,
    !previous.totals[currency]||!current.totals[currency]?null:
    Object.fromEntries(['assets','liabilities','netWorth'].map(metric=>{
      const a=moneyCents(previous.totals[currency][metric]),b=moneyCents(current.totals[currency][metric]);
      const c=moneyCents(counter[currency][metric]);
      return [metric,{delta:(b-a)/100,fxImpact:(b-c)/100,otherChange:(c-a)/100}];
    }))]));
}
function readTrend(days,selectedDay){
  closeTrendDays();
  const today=shanghaiDay();
  const rows=db.prepare('SELECT day,payload FROM daily_snapshots WHERE day>=? ORDER BY day').all(changeDay(today,-days-1));
  let prev=null;
  const points=rows.map(row=>{
    const current=JSON.parse(row.payload);
    const changes=prev&&changeDay(prev.day,1)===row.day?trendChanges(prev,current):null;
    prev={...current,day:row.day};
    return {day:row.day,totals:current.totals,quoteDate:current.fx?.quotedAt??null,changes};
  }).filter(point=>point.day>=changeDay(today,-days));
  const detail=selectedDay?rows.find(row=>row.day===selectedDay):rows.at(-1);
  return {firstDay:firstTrendDay,points,detail:detail?{day:detail.day,...JSON.parse(detail.payload)}:null,
    today:{day:today,totals:snapshotAt(Date.now()+1).totals}};
}
function runTrendCut(){
  try { closeTrendDays(); } catch (error) { console.error('日终快照失败',error.message); }
}
runTrendCut();
setInterval(runTrendCut,60000).unref();


function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function isAuthenticated(req) {
  const token = parseCookies(req).hz_session;
  return token && sessions.has(token);
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 2_500_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    let size=0;
    req.on('data', chunk => {
      size+=Buffer.byteLength(chunk);
      if (size > limit) {reject(new Error('请求体过大'));return}
      body += chunk;
    });
    req.on('end', () => {
      if(size>limit)return;
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('JSON 格式无效')); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function currentBudgetMonth(){
 const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});const [y,m]=today.split('-').map(Number);return [today.slice(0,7)+'-01',today.slice(0,7)+'-'+String(new Date(Date.UTC(y,m,0)).getUTCDate()).padStart(2,'0')];
}

function shiftDay(day, n) {
  return new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
}
function monthRange(period) {
  if(period!=='week')return currentBudgetMonth();
  const day=shanghaiDay(), weekday=new Date(day+'T00:00:00Z').getUTCDay();
  const monday=shiftDay(day,-((weekday+6)%7));
  return [monday,shiftDay(monday,6)];
}

function getSummary() {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN kind = 'asset' THEN value_cny ELSE 0 END), 0) AS assets,
      COALESCE(SUM(CASE WHEN kind = 'liability' THEN value_cny ELSE 0 END), 0) AS liabilities
    FROM accounts
  `).get();
  const cashflow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(expense_amount), 0) AS expense
    FROM transactions
    WHERE occurred_on BETWEEN ? AND ? AND currency='CNY'
  `).get(...currentBudgetMonth());
  return {
    assets: totals.assets,
    liabilities: totals.liabilities,
    netWorth: totals.assets - totals.liabilities,
    income: cashflow.income,
    expense: cashflow.expense,
    disposable: cashflow.income - cashflow.expense
  };
}

function getReport(period = 'month', currency = 'CNY') {
  const [from, to] = monthRange(period);
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(expense_amount), 0) AS expense,
      COALESCE(SUM(CASE WHEN type IN ('expense','repayment') THEN -amount ELSE 0 END), 0) AS cash_outflow
    FROM transactions WHERE occurred_on BETWEEN ? AND ? AND currency=?
  `).get(from, to,currency);
  const categories = db.prepare(`
    SELECT category, ROUND(SUM(expense_amount), 2) AS amount
    FROM transactions
    WHERE occurred_on BETWEEN ? AND ? AND currency=? AND expense_amount > 0
    GROUP BY category ORDER BY amount DESC
  `).all(from, to,currency);
  const savings = totals.income - totals.expense;
  const daily=db.prepare(`SELECT occurred_on AS day,SUM(CASE WHEN type='income' THEN amount ELSE 0 END) AS income,SUM(expense_amount) AS expense FROM transactions WHERE occurred_on BETWEEN ? AND ? AND currency=? GROUP BY occurred_on ORDER BY occurred_on`).all(from,to,currency);
  return { period, from, to, currency, ...totals, savings, savingsRate: totals.income ? savings / totals.income : 0, categories,daily };
}

const csvHeaders = ['日期','交易方','分类','账户','类型','现金金额','计入支出','币种','本金','利息','备注'];
const txTypes = ['income','expense','transfer','trade','repayment'];
const txCurrencies = ['CNY','USD','HKD'];
function validTxDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const date = new Date(s+'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0,10)===s;
}

function csvInput(body) {
  if (typeof body.csv !== 'string' || body.csv.length > 900000) throw Error('请选择不超过 900 KB 的 CSV 文件');
  const table = [];
  let row=[], field='', quoted=false, ended=false;
  const cell=()=>{row.push(field);field='';ended=false};
  const line=()=>{cell();if(row.some(x=>x.trim()))table.push(row);row=[]};
  const csv=body.csv.replace(/^\uFEFF/,'');
  for(let i=0;i<csv.length;i++){
    const c=csv[i];
    if(quoted){
      if(c==='"'){if(csv[i+1]==='"'){field+='"';i++}else{quoted=false;ended=true}}
      else field+=c;
    }else if(c===',')cell();
    else if(c==='\n'||c==='\r'){if(c==='\r'&&csv[i+1]==='\n')i++;line()}
    else if(c==='"'&&!field&&!ended)quoted=true;
    else if(ended||c==='"')throw Error('CSV 引号格式错误');
    else field+=c;
  }
  if(quoted)throw Error('CSV 引号未闭合');
  line();
  const dates=['日期','交易日期','交易时间','date'], amounts=['现金金额','金额（元）','金额(元)','金额','amount'], directions=['类型','收/支','收支','收支类型','type'];
  const headerIndex=table.findIndex(r=>dates.some(k=>r.some(v=>v.trim()===k))&&amounts.some(k=>r.some(v=>v.trim()===k))&&directions.some(k=>r.some(v=>v.trim()===k)));
  if(headerIndex<0)throw Error('未找到日期、金额及收支类型表头');
  const headers=table[headerIndex].map(x=>x.trim());
  const own=headers.join(',')===csvHeaders.join(',');
  const records=table.slice(headerIndex+1);
  if(!records.length||records.length>5000)throw Error('请导入 1 至 5000 条流水');
  const accounts=db.prepare('SELECT id,name FROM accounts').all();
  const override=body.accountId==null||body.accountId===''?null:accounts.find(a=>a.id===Number(body.accountId));
  if(override===undefined)throw Error('所选账户不存在');
  const count=db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE occurred_on=? AND merchant=? AND category=? AND account_id IS ? AND type=? AND amount=? AND expense_amount=? AND principal_amount=? AND interest_amount=? AND currency=? AND note=?');
  const used=new Map();
  const map={收入:'income',收款:'income',支出:'expense',转账:'transfer',不计收支:'transfer',不计入收支:'transfer',证券交易:'trade',还款:'repayment'};
  return records.map((r,i)=>{
    const fail=msg=>{throw Error('第 '+(headerIndex+i+2)+' 条 CSV 记录：'+msg)};
    if(r.length===headers.length+1&&!r.at(-1).trim())r.pop();
    if(r.length!==headers.length)fail('字段数量与表头不一致');
    const pick=(...keys)=>keys.map(k=>r[headers.indexOf(k)]).find(v=>v?.trim())??'';
    const clean=v=>own?v.replace(/^'(?=(?:\s*[=+@-]|['\t\r\n]))/,''):v.trim();
    const m=pick(...dates).trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?=$|[ T])/);
    const day=m?[m[1],m[2].padStart(2,'0'),m[3].padStart(2,'0')].join('-'):'';
    if(!validTxDay(day))fail('日期无效');
    const status=pick('交易状态','当前状态').trim();
    if(/关闭|失败|退款|撤销|取消|待支付|待付款|处理中/.test(status))fail('账单状态为「'+status+'」，请先移除未完成或退款的记录');
    const direction=pick(...directions).trim();
    const type=map[direction]||direction.toLowerCase();
    if(!txTypes.includes(type))fail('不支持的收支类型');
    const decimal=(value,optional=false)=>{
      const v=value.trim().replace(/^[¥￥$]/,'').replaceAll(',','');
      if(!v&&optional)return 0;
      if(!/^[+-]?\d+(?:\.\d{1,2})?$/.test(v)||!Number.isSafeInteger(Math.round(Number(v)*100)))fail('金额无效');
      return Number(v);
    };
    const raw=decimal(pick(...amounts));
    if(!raw)fail('金额不能为零');
    const amount=headers.includes('现金金额')?raw:(type==='income'?1:-1)*Math.abs(raw);
    if((type==='income'&&amount<0)||(['expense','repayment'].includes(type)&&amount>0))fail('金额正负与收支类型不一致');
    const expense=pick('计入支出');
    const principal=decimal(pick('本金'),true), interest=decimal(pick('利息'),true);
    const expenseAmount=expense?decimal(expense):(type==='expense'?Math.abs(amount):type==='repayment'?interest:0);
    if(Math.min(expenseAmount,principal,interest)<0)fail('支出、本金和利息不能为负数');
    const currency=pick('币种','currency').trim().toUpperCase()||'CNY';
    if(!txCurrencies.includes(currency))fail('仅支持 CNY、USD、HKD');
    const name=clean(pick('账户','account'));
    const matches=name?accounts.filter(a=>a.name===name):[];
    if(!override&&name&&matches.length!==1)fail('无法唯一匹配账户「'+name+'」，请先建立账户或指定导入账户');
    const accountId=override?.id??matches[0]?.id??null;
    const merchant=clean(pick('交易方','交易对方','商品说明','merchant'))||'未命名交易';
    const category=clean(pick('分类','category'))||(type==='income'?'其他收入':type==='transfer'?'账户转账':'待分类');
    const note=clean(pick('备注','note'));
    const values=[day,merchant,category,accountId,type,amount,expenseAmount,principal,interest,currency,note];
    const key=JSON.stringify(values);
    let remaining=used.get(key)??count.get(...values).n;
    const duplicate=remaining>0;
    used.set(key,Math.max(0,remaining-1));
    return {occurredOn:day,merchant,category,accountId,type,amount,currency,duplicate,values};
  });
}

function downloadCsv(res, filename, headers, rows) {
  const encode=x=>{
    let v=String(x??'');
    if(typeof x==='string'&&/^(?:\s*[=+@-]|['\t\r\n])/.test(v))v="'"+v;
    return '"'+v.replaceAll('"','""')+'"';
  };
  const csv='\uFEFF'+headers.join(',')+'\r\n'+rows.map(r=>r.map(encode).join(',')).join('\r\n');
  res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="'+filename+'"','Cache-Control':'no-store'});
  return res.end(csv);
}

function localLedgerIntent(text,today) {
  const keywordGroups={餐饮:/餐饮|午饭|晚饭|早饭|吃饭|咖啡|早餐|晚餐|午餐|奶茶|外卖/,交通:/打车|地铁|公交|交通|停车/,工资:/工资|薪水/,稿费:/稿费/};
  const category=Object.keys(keywordGroups).find(k=>keywordGroups[k].test(text))||'';
  const date=text.match(/\d{4}-\d{2}-\d{2}/)?.[0]||(/前天/.test(text)?shiftDay(today,-2):/昨天|昨晚/.test(text)?shiftDay(today,-1):/今天|今晚/.test(text)?today:'');
  const period=/上周/.test(text)?'lastWeek':/这周|本周/.test(text)?'week':/本月|这个月/.test(text)?'month':'';
  const mode=/改成|改为|修改/.test(text)?'edit':/多少|查询|明细|查看|^查/.test(text)?'query':/收入|到账|收了|收到|花|支付|买|付了|支出|赚/.test(text)?'create':'unknown';
  const amount=mode==='edit'?text.match(/(?:改成|改为)\s*(\d+(?:\.\d{1,2})?)(?![\d.])/)?.[1]:text.match(/(?<![\d.])(\d+(?:\.\d{1,2})?)\s*(?:美元|港币|港元|人民币|元|块|USD|HKD|CNY)/i)?.[1];
  const keyword=text.match(/午饭|晚饭|早饭|吃饭|咖啡|早餐|晚餐|午餐|奶茶|外卖|打车|地铁|公交|停车|工资|稿费/)?.[0]||'';
  return {mode,date,period,category,keyword,merchant:keyword,type:/收入|到账|收了|收到|赚/.test(text)?'income':/支出|花|支付|买|付了/.test(text)?'expense':'',
    amount:amount?Number(amount):null,currency:/美元|USD/i.test(text)?'USD':/港币|港元|HKD/i.test(text)?'HKD':/人民币|元|块|CNY/i.test(text)?'CNY':'',
    accountName:''};
}

async function ledgerIntent(text,today) {
  const model=process.env.HENGZI_AI_MODEL, key=process.env.HENGZI_AI_API_KEY;
  if(model&&key){
    try{
      const url=new URL(process.env.HENGZI_AI_CHAT_URL||'https://api.openai.com/v1/chat/completions');
      if(url.protocol!=='https:')throw Error('HTTPS required');
      const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[
        {role:'system',content:'将用户的一句中文记账指令解析为单个 JSON 对象。今天（上海时间）是 '+today+'。字段 mode(create/query/edit/unknown), date(YYYY-MM-DD 或空), period(week/lastWeek/month 或空), type(income/expense 或空), amount(正数或 null；修改时为新金额), currency(CNY/USD/HKD 或空), merchant(摘要), category(分类), keyword(匹配已有记录的简短摘要；修改时填写), accountName(用户明确指定的账户名称或空)。不要编造金额、账号、币种；不确定意图时 unknown。只做单笔新增、按时间分类查询、或修改单笔金额。'},
        {role:'user',content:text}],response_format:{type:'json_object'}})});
      if(!response.ok)throw Error('AI unavailable');
      const data=JSON.parse((await response.json()).choices[0].message.content);
      if(!['create','query','edit','unknown'].includes(data.mode))throw Error('Invalid mode');
      const clean=k=>typeof data[k]==='string'?data[k].trim().slice(0,120):'';
      return {mode:data.mode,date:validTxDay(data.date)?data.date:'',period:['week','lastWeek','month'].includes(data.period)?data.period:'',
        type:['income','expense'].includes(data.type)?data.type:'',amount:typeof data.amount==='number'&&Number.isFinite(data.amount)&&data.amount>0?data.amount:null,
        currency:txCurrencies.includes(data.currency)?data.currency:'',merchant:clean('merchant'),category:clean('category'),keyword:clean('keyword'),accountName:clean('accountName'),source:'ai'};
    }catch{ return {...localLedgerIntent(text,today),source:'fallback'} }
  }
  return {...localLedgerIntent(text,today),source:'local'};
}

async function ledgerPreview(text) {
  const today=shanghaiDay(), p=await ledgerIntent(text,today);
  if(p.date&&!validTxDay(p.date))throw Error('日期无效，请重新输入');
  const accounts=db.prepare('SELECT id,name,currency FROM accounts ORDER BY id').all();
  const matches=accounts.filter(a=>p.accountName?a.name===p.accountName:text.includes(a.name));
  const account=matches.length===1?matches[0]:null;
  const fields={occurredOn:p.date||today,merchant:p.merchant,category:p.category,type:p.type||'expense',amount:p.amount,currency:p.currency||account?.currency||'CNY',accountId:account?.id??null};
  if(p.mode==='create')return {mode:p.mode,fields,source:p.source};
  if(!['query','edit'].includes(p.mode))return {mode:'unknown',source:p.source};
  if(p.mode==='edit'&&!p.keyword&&!p.date)throw Error('请说清要改哪一天、哪笔流水');
  const condition=["t.type IN ('income','expense')"], params=[];
  const filter=(sql,...values)=>{condition.push(sql);params.push(...values)};
  let fromDay=p.date,toDay=p.date;
  if(p.date)filter('t.occurred_on = ?',p.date);
  else if(p.period){
    let [from,to]=monthRange(p.period==='month'?'month':'week');
    if(p.period==='lastWeek'){from=shiftDay(from,-7);to=shiftDay(to,-7)}
    fromDay=from;toDay=to;
    filter('t.occurred_on BETWEEN ? AND ?',from,to);
  }
  if(p.mode==='query'&&p.type)filter('t.type = ?',p.type);
  if(p.mode==='edit'&&p.keyword)filter('(instr(t.merchant,?)>0 OR instr(t.note,?)>0)',p.keyword,p.keyword);
  if(p.mode==='query'&&p.category)filter('t.category = ?',p.category);
  else if(p.mode==='query'&&p.keyword)filter('(instr(t.merchant,?)>0 OR instr(t.note,?)>0)',p.keyword,p.keyword);
  if(p.mode==='query'&&p.currency)filter('t.currency = ?',p.currency);
  if(account)filter('t.account_id = ?',account.id);
  const where=condition.join(' AND ');
  const rows=db.prepare('SELECT t.*,a.name AS account_name FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id WHERE '+where+' ORDER BY t.occurred_on DESC,t.id DESC LIMIT 30').all(...params);
  const totals=db.prepare('SELECT t.currency,t.type,COUNT(*) AS count,ROUND(SUM(ABS(t.amount)),2) AS amount FROM transactions t WHERE '+where+' GROUP BY t.currency,t.type').all(...params);
  return {mode:p.mode,rows,totals,fromDay,toDay,category:p.category,amount:p.amount,source:p.source};
}

// Investment book: append-only business events, weighted-average cost, no broker execution.
db.exec(`
 CREATE TABLE IF NOT EXISTS investment_books(account_id INTEGER PRIMARY KEY REFERENCES accounts(id));
 CREATE TABLE IF NOT EXISTS investment_securities(id INTEGER PRIMARY KEY,market TEXT NOT NULL,symbol TEXT NOT NULL,name TEXT NOT NULL,currency TEXT NOT NULL,exchange TEXT NOT NULL,UNIQUE(market,symbol,exchange));
 CREATE TABLE IF NOT EXISTS investment_events(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES investment_books(account_id),security_id INTEGER REFERENCES investment_securities(id),type TEXT NOT NULL,day TEXT NOT NULL,quantity REAL NOT NULL DEFAULT 0,price REAL NOT NULL DEFAULT 0,fee REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL,amount REAL NOT NULL DEFAULT 0,request_id TEXT NOT NULL UNIQUE,request_body TEXT NOT NULL,voided INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS investment_quotes(security_id INTEGER PRIMARY KEY REFERENCES investment_securities(id),price REAL NOT NULL,quoted_at TEXT NOT NULL,source TEXT NOT NULL,received_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS investment_quote_jobs(id INTEGER PRIMARY KEY,attempted_at TEXT NOT NULL,updated INTEGER NOT NULL,message TEXT NOT NULL);
`);
const invRound=n=>Math.round((n+Number.EPSILON)*100)/100;
const invPrecision=n=>Math.round(n*1e8)/1e8;
const invMarkets={US:{currency:'USD',exchanges:['NASDAQ','NYSE','AMEX']},HK:{currency:'HKD',exchanges:['HKEX']},CN:{currency:'CNY',exchanges:['SSE','SZSE']}};
function invError(message,status=400){const e=Error(message);e.status=status;throw e;}
function invNumber(n,label,positive=false){if(typeof n!=='number'||!Number.isFinite(n)||n<0||(positive&&n===0)||n>1e10)invError(label+'无效');return n;}
function invBook(accountId){if(!Number.isSafeInteger(accountId)||!db.prepare('SELECT account_id FROM investment_books WHERE account_id=?').get(accountId))invError('请选择投资账户');}
function invReplay(accountId){
 const events=db.prepare('SELECT * FROM investment_events WHERE account_id=? AND voided=0 ORDER BY day,id').all(accountId),positions=new Map(),cash={CNY:0,USD:0,HKD:0},realized={CNY:0,USD:0,HKD:0},fees={CNY:0,USD:0,HKD:0};
 for(const e of events){
  const c=e.currency;
  if(['cash_opening','deposit','withdraw'].includes(e.type)){cash[c]=invRound(cash[c]+(e.type==='withdraw'?-e.amount:e.amount));if(cash[c]<0)invError(c+'现金不足');continue;}
  const p=positions.get(e.security_id)||{security_id:e.security_id,quantity:0,cost:0,realized:0,fees:0};
  if(e.type==='opening'){
   if(positions.has(e.security_id))invError('该股票已有记录，请记录买入；勿重复添加期初');
   p.cost=e.quantity*e.price;p.quantity=e.quantity;
  }else if(e.type==='buy'){
   const pay=invRound(e.quantity*e.price+e.fee);if(pay>cash[c])invError(c+'现金不足，请先记录入金或核对期初现金');
   cash[c]=invRound(cash[c]-pay);p.cost=invPrecision(p.cost+e.quantity*e.price+e.fee);p.quantity=invPrecision(p.quantity+e.quantity);
  }else if(e.type==='sell'){
   if(e.quantity>p.quantity+1e-8)invError('卖出数量超过持仓，不支持卖空');
   const proceeds=invRound(e.quantity*e.price-e.fee);if(proceeds<0)invError('卖出费用超过成交金额');
   const removed=p.quantity?invPrecision(p.cost*e.quantity/p.quantity):0,gain=invRound(proceeds-removed);
   p.cost=invPrecision(p.cost-removed);p.quantity=invPrecision(p.quantity-e.quantity);if(p.quantity<1e-8){p.quantity=0;p.cost=0;}
   cash[c]=invRound(cash[c]+proceeds);p.realized=invRound(p.realized+gain);realized[c]=invRound(realized[c]+gain);
  }
  p.fees=invRound(p.fees+e.fee);fees[c]=invRound(fees[c]+e.fee);positions.set(e.security_id,p);
 }
 return {events,positions:[...positions.values()],cash,realized,fees};
}
function invRates(){const q=cachedFx();return {rates:{CNY:1,...(q?.rates||{})},quotedAt:q?.quotedAt||null,stale:!q||q.stale||Date.now()-q.fetchedAt>3*DAY_MS};}
function invValuation(accountId){
 const book=invReplay(accountId),fx=invRates(),missing=new Set();
 const converted=(amount,c)=>{if(!amount)return 0;const r=fx.rates[c];if(!(r>0)){missing.add(c);return 0;}return amount*r;};
 let marketValue=0,unrealized=0;
 const positions=book.positions.map(p=>{
  const s=db.prepare('SELECT * FROM investment_securities WHERE id=?').get(p.security_id),q=db.prepare('SELECT * FROM investment_quotes WHERE security_id=?').get(p.security_id);
  const market=q?p.quantity*q.price:null,delta=market===null?null:market-p.cost;
  if(p.quantity>0&&!q)missing.add(s.symbol+'报价');
  if(market!==null)marketValue+=converted(market,s.currency);if(delta!==null)unrealized+=converted(delta,s.currency);
  return {...s,...p,averageCost:p.quantity?p.cost/p.quantity:0,price:q?.price??null,quoteDate:q?.quoted_at??null,quoteSource:q?.source??null,marketValue:market,marketValueCny:market===null?null:(fx.rates[s.currency]>0?invRound(market*fx.rates[s.currency]):null),unrealized:delta,unrealizedCny:delta===null?null:(fx.rates[s.currency]>0?invRound(delta*fx.rates[s.currency]):null)};
 });
 const cashValue=Object.entries(book.cash).reduce((n,[c,v])=>n+converted(v,c),0),realized=Object.entries(book.realized).reduce((n,[c,v])=>n+converted(v,c),0);
 return {accountId,positions,cash:book.cash,realized:book.realized,fees:book.fees,events:book.events,fx,complete:missing.size===0,missing:[...missing],netValueCny:missing.size?null:invRound(marketValue+cashValue),cashValueCny:missing.size?null:invRound(cashValue),unrealizedCny:missing.size?null:invRound(unrealized),realizedCny:missing.size?null:invRound(realized)};
}
function invSync(accountId,strict=false){
 const v=invValuation(accountId);if(!v.complete){if(strict)invError('缺少 '+v.missing.join('、')+'，请先在汇率页面同步或维护报价');return v;}
 // Linked account is CNY reporting only; existing manual account must be explicitly converted.
 db.prepare("UPDATE accounts SET currency='CNY',original_value=?,value_cny=?,fx_mode='manual',fx_rate=1,update_method='持仓计算',updated_at=CURRENT_TIMESTAMP WHERE id=? AND value_cny IS NOT ?").run(v.netValueCny,v.netValueCny,accountId,v.netValueCny);
 return v;
}
function invSyncAll(){for(const b of db.prepare('SELECT account_id FROM investment_books').all())invSync(b.account_id);}
function invOverview(){
 const books=db.prepare('SELECT a.id,a.name FROM investment_books b JOIN accounts a ON a.id=b.account_id ORDER BY a.id').all().map(a=>({...invValuation(a.id),id:a.id,name:a.name}));
 return {books,providerConfigured:Boolean(process.env.HENGZI_MARKET_API_KEY),quoteSchedule:'配置 Twelve Data 后每 15 分钟刷新；市场权限与报价时延取决于数据订阅',latestJob:db.prepare('SELECT * FROM investment_quote_jobs ORDER BY id DESC LIMIT 1').get()||null};
}
function invAtomic(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
function invSaveEvent(accountId,b){
 invBook(accountId);
 if(typeof b.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(b.requestId))invError('缺少有效请求编号，请刷新后重试');
 const requestBody=JSON.stringify(b),existing=db.prepare('SELECT id,account_id,request_body,voided FROM investment_events WHERE request_id=?').get(b.requestId);
 if(existing){if(existing.voided)invError('这笔记录已撤销，请用新请求重新录入',409);if(existing.account_id!==accountId||existing.request_body!==requestBody)invError('请求编号已用于另一笔记录',409);return {id:existing.id,repeated:true};}
 if(!['opening','buy','sell','cash_opening','deposit','withdraw'].includes(b.type)||!validTxDay(b.day)||b.day>shanghaiDay())invError('记录类型或日期无效，不能录入未来成交');
 const latest=db.prepare('SELECT day FROM investment_events WHERE account_id=? AND voided=0 ORDER BY day DESC,id DESC LIMIT 1').get(accountId);
 if(latest&&b.day<latest.day)invError('请按日期顺序录入；补录旧记录前先撤销后续记录');
 let currency=b.currency,security=null,quantity=0,price=0,fee=0,amount=0;
 if(['cash_opening','deposit','withdraw'].includes(b.type)){
  if(!txCurrencies.includes(currency))invError('币种无效');amount=invRound(invNumber(b.amount,'现金金额',true));if(!amount)invError('现金金额至少 0.01');
  if(b.type==='cash_opening'&&db.prepare("SELECT id FROM investment_events WHERE account_id=? AND currency=? AND voided=0 AND type!='opening' LIMIT 1").get(accountId,currency))invError('该币种已有记录，后续资金请使用入金或出金');
 }else{
  const market=invMarkets[b.market],symbol=typeof b.symbol==='string'?b.symbol.trim().toUpperCase():'',name=typeof b.name==='string'?b.name.trim():'';
  if(!market||!market.exchanges.includes(b.exchange)||!symbol||symbol.length>24||!/^[A-Z0-9.\-]+$/.test(symbol)||!name||name.length>80)invError('股票市场、交易所、代码或名称无效');
  currency=market.currency;quantity=invNumber(b.quantity,'数量',true);price=invNumber(b.price,'价格',true);fee=invRound(invNumber(b.fee??0,'费用'));
  if(quantity<.000001||Math.abs(quantity*1e6-Math.round(quantity*1e6))>1e-4||quantity*price>1e12)invError('数量最多六位小数，成交金额过大');
  if(b.type==='opening'&&fee!==0)invError('期初成本已包含历史费用，请将费用设为 0');
  security=db.prepare('SELECT * FROM investment_securities WHERE market=? AND symbol=? AND exchange=?').get(b.market,symbol,b.exchange);
  if(!security){const r=db.prepare('INSERT INTO investment_securities(market,symbol,name,currency,exchange) VALUES (?,?,?,?,?)').run(b.market,symbol,name,currency,b.exchange);security={id:Number(r.lastInsertRowid)};}
  // A trade price is a clearly labelled reference only, never a fabricated live quote.
  if(!db.prepare('SELECT security_id FROM investment_quotes WHERE security_id=?').get(security.id))db.prepare('INSERT INTO investment_quotes VALUES (?,?,?,?,?)').run(security.id,price,b.day+'T00:00:00+08:00','录入价格参考（非行情）',new Date().toISOString());
 }
 const row=db.prepare('INSERT INTO investment_events(account_id,security_id,type,day,quantity,price,fee,currency,amount,request_id,request_body) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(accountId,security?.id??null,b.type,b.day,quantity,price,fee,currency,amount,b.requestId,requestBody);
 invSync(accountId,true);return {id:Number(row.lastInsertRowid)};
}
let invQuotePending=null,invLastAttempt=0;
async function invRefreshQuotes(){
 const key=process.env.HENGZI_MARKET_API_KEY;if(!key)invError('未配置行情服务。请在服务器设置 HENGZI_MARKET_API_KEY；可先维护参考报价',503);
 if(invQuotePending)return invQuotePending;if(Date.now()-invLastAttempt<60000)invError('行情刚刷新过，请一分钟后重试',429);invLastAttempt=Date.now();
 invQuotePending=(async()=>{let updated=0;const errors=[];
  const securities=db.prepare('SELECT DISTINCT s.* FROM investment_securities s JOIN investment_events e ON e.security_id=s.id WHERE e.voided=0').all();
  for(const s of securities){try{
   const u=new URL('https://api.twelvedata.com/quote');u.search=new URLSearchParams({symbol:s.symbol,exchange:s.exchange,apikey:key,timezone:'UTC'});
   const response=await fetch(u,{signal:AbortSignal.timeout(10000)}),q=await response.json(),price=Number(q.close);
   if(!response.ok||q.status==='error'||!Number.isFinite(price)||price<=0||q.currency!==s.currency||q.exchange!==s.exchange||String(q.symbol).toUpperCase()!==s.symbol)throw Error('报价未通过证券、币种或价格校验');
   const raw=String(q.datetime||''),ms=Date.parse(raw.includes('T')?(raw.endsWith('Z')?raw:raw+'Z'):raw.replace(' ','T')+'Z');
   if(!Number.isFinite(ms)||ms>Date.now()+300000)throw Error('报价时间无效');
   const prior=db.prepare('SELECT * FROM investment_quotes WHERE security_id=?').get(s.id);if(prior&&ms<Date.parse(prior.quoted_at))throw Error('较旧报价已忽略');
   db.prepare('INSERT INTO investment_quotes VALUES (?,?,?,?,?) ON CONFLICT(security_id) DO UPDATE SET price=excluded.price,quoted_at=excluded.quoted_at,source=excluded.source,received_at=excluded.received_at').run(s.id,price,new Date(ms).toISOString(),'Twelve Data（时延取决权限）',new Date().toISOString());updated++;
  }catch{errors.push(s.symbol+'：刷新失败，保留原报价');}}
  invAtomic(invSyncAll);const message=errors.join('；')||(securities.length?'报价已更新':'暂无证券需要更新');db.prepare('INSERT INTO investment_quote_jobs(attempted_at,updated,message) VALUES (?,?,?)').run(new Date().toISOString(),updated,message);return {updated,message};
 })().finally(()=>{invQuotePending=null;});return invQuotePending;
}
setInterval(()=>{if(process.env.HENGZI_MARKET_API_KEY)invRefreshQuotes().catch(()=>{});},15*60000).unref();
async function investmentApi(req,res,pathname){
 if(!pathname.startsWith('/api/investments'))return false;
 try{
  if(pathname==='/api/investments'&&req.method==='GET'){invSyncAll();json(res,200,invOverview());return true;}
  if(pathname==='/api/investments/accounts'&&req.method==='POST'){
   const b=await readBody(req),name=typeof b.name==='string'?b.name.trim():'';
   if(!name||name.length>100)invError('请填写投资账户名称');
   const id=invAtomic(()=>{
    let id;if(b.existingAccountId){
     const a=db.prepare('SELECT * FROM accounts WHERE id=?').get(Number(b.existingAccountId));
     if(!a||a.kind!=='asset'||b.confirmReplace!==true)invError('关联现有资产需确认改为持仓计算');
     if(db.prepare('SELECT account_id FROM investment_books WHERE account_id=?').get(a.id))invError('账户已关联');id=a.id;
     db.prepare("UPDATE accounts SET name=?,category='股票投资',currency='CNY',fx_mode='manual',value_cny=0,original_value=0,update_method='持仓计算' WHERE id=?").run(name,id);
    }else{id=Number(db.prepare("INSERT INTO accounts(name,kind,category,currency,value_cny,original_value,update_method) VALUES (?,'asset','股票投资','CNY',0,0,'持仓计算')").run(name).lastInsertRowid);}
    db.prepare('INSERT INTO investment_books VALUES (?)').run(id);return id;
   });json(res,201,{id});return true;
  }
  const events=pathname.match(/^\/api\/investments\/accounts\/(\d+)\/events$/);
  if(events&&req.method==='POST'){const b=await readBody(req),result=invAtomic(()=>invSaveEvent(Number(events[1]),b));json(res,201,result);return true;}
  const undo=pathname.match(/^\/api\/investments\/events\/(\d+)\/void$/);
  if(undo&&req.method==='POST'){
   invAtomic(()=>{const e=db.prepare('SELECT * FROM investment_events WHERE id=? AND voided=0').get(Number(undo[1]));if(!e)invError('记录不存在或已撤销',404);
    const last=db.prepare('SELECT id FROM investment_events WHERE account_id=? AND voided=0 ORDER BY day DESC,id DESC LIMIT 1').get(e.account_id);if(last.id!==e.id)invError('只能撤销该账户最近一笔，请先撤销后续记录',409);
    db.prepare('UPDATE investment_events SET voided=1 WHERE id=?').run(e.id);invSync(e.account_id,true);
   });json(res,200,{ok:true});return true;
  }
  if(pathname==='/api/investments/quotes/refresh'&&req.method==='POST'){json(res,200,await invRefreshQuotes());return true;}
  if(pathname==='/api/investments/quotes'&&req.method==='PUT'){
   const b=await readBody(req),id=Number(b.securityId),price=invNumber(b.price,'参考价',true),ms=Date.parse(b.quotedAt);
   if(!db.prepare('SELECT id FROM investment_securities WHERE id=?').get(id)||!Number.isFinite(ms)||ms>Date.now()+300000)invError('证券或报价时间无效');
   const old=db.prepare('SELECT quoted_at FROM investment_quotes WHERE security_id=?').get(id);if(old&&ms<Date.parse(old.quoted_at))invError('报价早于已保存时间');
   invAtomic(()=>{db.prepare('INSERT INTO investment_quotes VALUES (?,?,?,?,?) ON CONFLICT(security_id) DO UPDATE SET price=excluded.price,quoted_at=excluded.quoted_at,source=excluded.source,received_at=excluded.received_at').run(id,price,new Date(ms).toISOString(),'手动参考报价',new Date().toISOString());invSyncAll();});json(res,200,{ok:true});return true;
  }
  json(res,404,{error:'投资接口不存在'});return true;
 }catch(e){json(res,e.status||400,{error:e.message});return true;}
}

function sendStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function api(req, res, pathname, searchParams) {
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (!safeEqual(body.password || '', APP_PASSWORD)) return json(res, 401, { error: '密码错误' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { createdAt: Date.now() });
    res.setHeader('Set-Cookie', `hz_session=${token}; HttpOnly; SameSite=Strict; Secure; Path=/app/fm; Max-Age=86400`);
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/session' && req.method === 'GET') return json(res, isAuthenticated(req) ? 200 : 401, { authenticated: isAuthenticated(req) });
  if (!isAuthenticated(req)) return json(res, 401, { error: '请先登录' });

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).hz_session;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'hz_session=; HttpOnly; SameSite=Strict; Secure; Path=/app/fm; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if(await investmentApi(req,res,pathname))return;
  if (pathname === '/api/fx/history' && req.method === 'GET') return json(res,200,{history:db.prepare('SELECT * FROM fx_history ORDER BY quoted_on DESC LIMIT 90').all(),jobs:db.prepare('SELECT * FROM fx_jobs ORDER BY day DESC LIMIT 7').all(),schedule:'每天北京时间 01:10 自动同步；服务器停机后恢复会补跑当天任务'});
  if (pathname === '/api/fx' && ['GET','POST'].includes(req.method)) {
    try {const fx=req.method==='POST'?await revalueAccounts(true):await getFx();return json(res,200,fx);}
    catch(e){return json(res,503,{error:e.message});}
  }
  if (pathname === '/api/trend' && req.method === 'GET') {
    const days=Number(searchParams.get('days')||30);
    if (![7,30,90].includes(days)) return json(res,400,{error:'请选择 7、30 或 90 天'});
    invSyncAll();
    return json(res,200,readTrend(days,searchParams.get('day')));
  }
  if (pathname === '/api/summary' && req.method === 'GET') {
    let warning=null;try{await revalueAccounts();}catch(e){warning=e.message;}
    invSyncAll();
    return json(res,200,{...getSummary(),fxWarning:warning});
  }
  if (pathname === '/api/accounts' && req.method === 'GET') {
    let fx=null,warning=null;try{fx=await revalueAccounts();}catch(e){warning=e.message;}
    invSyncAll();
    return json(res,200,{accounts:db.prepare('SELECT a.*, b.account_id IS NOT NULL AS investment_linked FROM accounts a LEFT JOIN investment_books b ON b.account_id=a.id ORDER BY kind,value_cny DESC').all(),fx,fxWarning:warning});
  }
  if ((pathname==='/api/accounts' && req.method==='POST') || (/^\/api\/accounts\/\d+$/.test(pathname) && req.method==='PUT')) {
    const id=req.method==='PUT'?Number(pathname.split('/').pop()):null;
    if(id!==null&&!db.prepare('SELECT id FROM accounts WHERE id=?').get(id))return json(res,404,{error:'账户不存在'});
    if(id!==null&&db.prepare('SELECT account_id FROM investment_books WHERE account_id=?').get(id))return json(res,409,{error:'该账户由持仓计算，请在金融投资中维护现金和交易'});
    let a;try{a=await accountInput(await readBody(req));}catch(e){return json(res,400,{error:e.message});}
    if(id===null){
      const result=db.prepare('INSERT INTO accounts(name,kind,category,currency,value_cny,original_value,update_method,note,fx_mode,fx_rate,fx_updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(a.name,a.kind,a.category,a.currency,a.value,a.original,a.mode==='auto'?'自动汇率':'手动更新',a.note,a.mode,a.rate,a.quoted);
      return json(res,201,{id:Number(result.lastInsertRowid)});
    }
    db.prepare('UPDATE accounts SET name=?,kind=?,category=?,currency=?,value_cny=?,original_value=?,update_method=?,note=?,fx_mode=?,fx_rate=?,fx_updated_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(a.name,a.kind,a.category,a.currency,a.value,a.original,a.mode==='auto'?'自动汇率':'手动更新',a.note,a.mode,a.rate,a.quoted,id);
    return json(res,200,{ok:true,id});
  }
  if (pathname === '/api/transactions' && req.method === 'GET') {
    const type = searchParams.get('type');
    const query = `SELECT t.*, a.name AS account_name FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id ${type && type !== 'all' ? 'WHERE t.type = ?' : ''} ORDER BY t.occurred_on DESC, t.id DESC LIMIT 500`;
    return json(res, 200, { transactions: type && type !== 'all' ? db.prepare(query).all(type) : db.prepare(query).all() });
  }
  if ((pathname==='/api/transactions'&&req.method==='POST')||(/^\/api\/transactions\/\d+$/.test(pathname)&&req.method==='PUT')) {
    const body=await readBody(req), id=req.method==='PUT'?Number(pathname.split('/').pop()):null;
    const merchant=typeof body.merchant==='string'?body.merchant.trim():'';
    const category=typeof body.category==='string'?body.category.trim():'';
    const note=typeof body.note==='string'?body.note:'';
    const currency=body.currency||'CNY', amountAbs=Number(body.amount);
    const accountId=body.accountId==null||body.accountId===''?null:Number(body.accountId);
    const principal=Number(body.principalAmount||0), interest=Number(body.interestAmount||0);
    if(!validTxDay(body.occurredOn)||!merchant||merchant.length>120||category.length>100||note.length>2000||!txTypes.includes(body.type)||!txCurrencies.includes(currency))return json(res,400,{error:'请填写有效日期、摘要、类型和币种'});
    if(![amountAbs,principal,interest].every(n=>Number.isFinite(n)&&n>=0&&n<=1e12&&Math.abs(n*100-Math.round(n*100))<.001)||!amountAbs)return json(res,400,{error:'金额必须为正数，最多两位小数'});
    if(accountId!==null&&(!Number.isSafeInteger(accountId)||!db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId)))return json(res,400,{error:'所选账户不存在'});
    const amount=body.type==='income'?amountAbs:-amountAbs;
    const expense=body.type==='expense'?amountAbs:body.type==='repayment'?interest:0;
    const values=[body.occurredOn,merchant,category||'其他',accountId,body.type,amount,expense,principal,interest,currency,note];
    if(id!==null){
      const old=db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
      if(!old)return json(res,404,{error:'流水不存在'});
      if(!['income','expense'].includes(old.type)||!['income','expense'].includes(body.type))return json(res,400,{error:'这里仅支持修改收入和支出'});
      const fields=['occurred_on','merchant','category','account_id','type','amount','expense_amount','principal_amount','interest_amount','currency','note'];
      if(JSON.stringify(fields.map(k=>old[k]))!==body.version)return json(res,409,{error:'这笔流水已更新，请重新查询后修改'});
      db.prepare('UPDATE transactions SET occurred_on=?,merchant=?,category=?,account_id=?,type=?,amount=?,expense_amount=?,principal_amount=?,interest_amount=?,currency=?,note=? WHERE id=?').run(...values,id);
      return json(res,200,{id});
    }
    const result=db.prepare('INSERT INTO transactions(occurred_on,merchant,category,account_id,type,amount,expense_amount,principal_amount,interest_amount,currency,note,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(...values,crypto.randomUUID());
    return json(res,201,{id:Number(result.lastInsertRowid)});
  }
  if(pathname==='/api/ledger/interpret'&&req.method==='POST'){
    const body=await readBody(req);
    const text=typeof body.text==='string'?body.text.trim():'';
    if(!text||text.length>500)return json(res,400,{error:'请输入 1 至 500 字的记账指令'});
    try{return json(res,200,await ledgerPreview(text))}catch(e){return json(res,400,{error:e.message})}
  }
  if (pathname === '/api/budgets' && req.method === 'GET') {
    const budgets = db.prepare(`
      SELECT b.*, COALESCE(SUM(t.expense_amount), 0) AS spent
      FROM budgets b LEFT JOIN transactions t ON t.category = b.category AND t.occurred_on BETWEEN ? AND ? AND t.currency='CNY'
      GROUP BY b.id ORDER BY b.monthly_limit DESC
    `).all(...currentBudgetMonth());
    return json(res, 200, { budgets });
  }
  if ((pathname==='/api/budgets' && req.method==='POST') || (/^\/api\/budgets\/\d+$/.test(pathname) && req.method==='PUT')) {
    const id=req.method==='PUT'?Number(pathname.split('/').pop()):null;
    const existing=id===null?null:db.prepare('SELECT * FROM budgets WHERE id=?').get(id);
    if(id!==null&&!existing)return json(res,404,{error:'预算不存在'});
    const b=await readBody(req),category=typeof b.category==='string'?b.category.trim():existing?.category;
    const threshold=b.warningThreshold===undefined?.9:b.warningThreshold;
    if(!category||category.length>100||typeof b.monthlyLimit!=='number'||!Number.isFinite(b.monthlyLimit)||b.monthlyLimit<=0||typeof threshold!=='number'||!Number.isFinite(threshold)||threshold<.01||threshold>1)return json(res,400,{error:'请填写分类、正数月度预算和1%至100%的预警阈值'});
    const conflict=db.prepare('SELECT id FROM budgets WHERE category=?').get(category);
    if(conflict&&conflict.id!==id)return json(res,409,{error:'该分类已有预算，请编辑现有预算'});
    if(id===null){const result=db.prepare('INSERT INTO budgets(category,monthly_limit,warning_threshold) VALUES (?,?,?)').run(category,b.monthlyLimit,threshold);return json(res,201,{id:Number(result.lastInsertRowid)});}
    db.prepare('UPDATE budgets SET category=?,monthly_limit=?,warning_threshold=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(category,b.monthlyLimit,threshold,id);
    return json(res,200,{ok:true,id});
  }
  if (pathname === '/api/reports' && req.method === 'GET') return json(res, 200, getReport(searchParams.get('period')==='week'?'week':'month',txCurrencies.includes(searchParams.get('currency'))?searchParams.get('currency'):'CNY'));
  if (['/api/import/preview','/api/import/commit'].includes(pathname) && req.method==='POST') {
    let body, rows;
    try{body=await readBody(req);rows=csvInput(body)}catch(e){return json(res,400,{error:e.message})}
    const duplicates=rows.filter(r=>r.duplicate).length, importable=rows.length-duplicates;
    if(pathname.endsWith('/preview'))return json(res,200,{total:rows.length,duplicates,importable,rows:rows.slice(0,20).map(({values,...r})=>r)});
    db.exec('BEGIN');
    try{
      const batch=db.prepare('INSERT INTO import_batches(filename,source,total_rows,imported_rows,duplicate_rows) VALUES (?,?,?,?,?)').run(String(body.filename||'import.csv').slice(0,200),'CSV',rows.length,importable,duplicates);
      const insert=db.prepare('INSERT INTO transactions(occurred_on,merchant,category,account_id,type,amount,expense_amount,principal_amount,interest_amount,currency,note,fingerprint,import_batch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for(const row of rows)if(!row.duplicate)insert.run(...row.values,crypto.randomUUID(),Number(batch.lastInsertRowid));
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e}
    return json(res,201,{imported:importable,duplicates});
  }
  if (pathname==='/api/export/transactions.csv' && req.method==='GET'){
    const rows=db.prepare(`SELECT t.occurred_on,t.merchant,t.category,COALESCE(a.name,'') AS account,t.type,t.amount,t.expense_amount,t.currency,t.principal_amount,t.interest_amount,t.note FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id ORDER BY t.occurred_on DESC,t.id DESC`).all();
    return downloadCsv(res,'hengzi-transactions.csv',csvHeaders,rows.map(Object.values));
  }
  if(pathname==='/api/export/report.csv'&&req.method==='GET'){
    const period=searchParams.get('period')==='week'?'week':'month';
    const [from,to]=monthRange(period);
    const rows=db.prepare(`SELECT currency,category,ROUND(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),2) AS income,ROUND(SUM(expense_amount),2) AS expense FROM transactions WHERE occurred_on BETWEEN ? AND ? GROUP BY currency,category ORDER BY currency,category`).all(from,to);
    return downloadCsv(res,'hengzi-report-'+period+'.csv',['起始日期','结束日期','币种','分类','收入','支出'],rows.map(r=>[from,to,...Object.values(r)]));
  }
  return json(res, 404, { error: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === BASE_PATH) { res.writeHead(308, { Location: BASE_PATH + '/' }); return res.end(); }
  if (!url.pathname.startsWith(BASE_PATH + '/')) return json(res, 404, { error: 'Not found' });
  url.pathname = url.pathname.slice(BASE_PATH.length);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname, url.searchParams);
    if (url.pathname === '/' && !isAuthenticated(req)) {
      res.writeHead(302, { Location: BASE_PATH + '/login.html' });
      return res.end();
    }
    if (url.pathname === '/login.html' && isAuthenticated(req)) {
      res.writeHead(302, { Location: BASE_PATH + '/' });
      return res.end();
    }
    if (sendStatic(req, res, url.pathname)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message || '服务器错误' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  dailyFx().catch(()=>{});
  console.log(`衡资已启动：http://127.0.0.1:${PORT}`);

});
