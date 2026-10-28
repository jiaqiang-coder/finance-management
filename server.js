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
const APP_PASSWORD = process.env.APP_PASSWORD || 'hengzi-demo';
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
 db.exec('BEGIN');try{for(const c of ['USD','HKD'])db.prepare("UPDATE accounts SET value_cny=ROUND(original_value*?,2),fx_rate=?,fx_updated_at=? WHERE fx_mode='auto' AND currency=?").run(fx.rates[c],fx.rates[c],fx.quotedAt,c);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return fx;
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

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
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

function monthRange(period) {
  if (period === 'week') return ['2026-10-22', '2026-10-28'];
  return ['2026-10-01', '2026-10-31'];
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
    WHERE occurred_on BETWEEN '2026-10-01' AND '2026-10-31'
  `).get();
  return {
    assets: totals.assets,
    liabilities: totals.liabilities,
    netWorth: totals.assets - totals.liabilities,
    income: cashflow.income,
    expense: cashflow.expense,
    disposable: cashflow.income - cashflow.expense
  };
}

function getReport(period = 'month') {
  const [from, to] = monthRange(period);
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(expense_amount), 0) AS expense,
      COALESCE(SUM(CASE WHEN type IN ('expense','repayment') THEN -amount ELSE 0 END), 0) AS cash_outflow
    FROM transactions WHERE occurred_on BETWEEN ? AND ?
  `).get(from, to);
  const categories = db.prepare(`
    SELECT category, ROUND(SUM(expense_amount), 2) AS amount
    FROM transactions
    WHERE occurred_on BETWEEN ? AND ? AND expense_amount > 0
    GROUP BY category ORDER BY amount DESC
  `).all(from, to);
  const savings = totals.income - totals.expense;
  return { period, from, to, ...totals, savings, savingsRate: totals.income ? savings / totals.income : 0, categories };
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(field.trim()); field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows.shift().map(header => header.replace(/^\uFEFF/, ''));
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function normalizeImportRow(row, accountId) {
  const pick = (...keys) => keys.map(key => row[key]).find(value => value !== undefined && value !== '') || '';
  const dateText = pick('交易时间', '日期', 'date', '交易日期').slice(0, 10).replaceAll('/', '-');
  const merchant = pick('交易对方', '商品说明', '交易方', 'merchant') || '未命名交易';
  const amountRaw = pick('金额（元）', '金额', 'amount').replace(/[¥￥,$]/g, '');
  const direction = pick('收/支', '类型', 'type');
  const absolute = Math.abs(Number(amountRaw) || 0);
  const type = /收入|收款|income/i.test(direction) ? 'income' : /转账|还款|transfer/i.test(direction) ? 'transfer' : 'expense';
  const amount = type === 'income' ? absolute : -absolute;
  const category = type === 'transfer' ? '账户转账' : type === 'income' ? '其他收入' : '待分类';
  const fingerprint = crypto.createHash('sha256').update([dateText, merchant, amount, accountId].join('|')).digest('hex');
  const duplicate = Boolean(db.prepare(`
    SELECT 1 FROM transactions
    WHERE fingerprint = ?
       OR (occurred_on = ? AND merchant = ? AND amount = ? AND COALESCE(account_id, 0) = COALESCE(?, 0))
  `).get(fingerprint, dateText || '2026-10-28', merchant, amount, accountId));
  return { occurredOn: dateText || '2026-10-28', merchant, category, accountId, type, amount, expenseAmount: type === 'expense' ? absolute : 0, currency: 'CNY', note: pick('备注', '交易状态', 'note'), fingerprint, duplicate };
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
  if (pathname === '/api/fx/history' && req.method === 'GET') return json(res,200,{history:db.prepare('SELECT * FROM fx_history ORDER BY quoted_on DESC LIMIT 90').all(),jobs:db.prepare('SELECT * FROM fx_jobs ORDER BY day DESC LIMIT 7').all(),schedule:'每天北京时间 01:10 自动同步；服务器停机后恢复会补跑当天任务'});
  if (pathname === '/api/fx' && ['GET','POST'].includes(req.method)) {
    try {const fx=req.method==='POST'?await revalueAccounts(true):await getFx();return json(res,200,fx);}
    catch(e){return json(res,503,{error:e.message});}
  }
  if (pathname === '/api/summary' && req.method === 'GET') {
    let warning=null;try{await revalueAccounts();}catch(e){warning=e.message;}
    return json(res,200,{...getSummary(),fxWarning:warning});
  }
  if (pathname === '/api/accounts' && req.method === 'GET') {
    let fx=null,warning=null;try{fx=await revalueAccounts();}catch(e){warning=e.message;}
    return json(res,200,{accounts:db.prepare('SELECT * FROM accounts ORDER BY kind,value_cny DESC').all(),fx,fxWarning:warning});
  }
  if ((pathname==='/api/accounts' && req.method==='POST') || (/^\/api\/accounts\/\d+$/.test(pathname) && req.method==='PUT')) {
    const id=req.method==='PUT'?Number(pathname.split('/').pop()):null;
    if(id!==null&&!db.prepare('SELECT id FROM accounts WHERE id=?').get(id))return json(res,404,{error:'账户不存在'});
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
  if (pathname === '/api/transactions' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.occurredOn || !body.merchant || !['income', 'expense', 'transfer', 'trade', 'repayment'].includes(body.type)) return json(res, 400, { error: '流水字段不完整' });
    const amountAbs = Math.abs(Number(body.amount) || 0);
    if (!amountAbs) return json(res, 400, { error: '金额必须大于 0' });
    const amount = body.type === 'income' ? amountAbs : -amountAbs;
    const expenseAmount = body.type === 'expense' ? amountAbs : body.type === 'repayment' ? Number(body.interestAmount) || 0 : 0;
    const fingerprint = crypto.createHash('sha256').update([body.occurredOn, body.merchant, amount, Date.now()].join('|')).digest('hex');
    const result = db.prepare(`
      INSERT INTO transactions (occurred_on, merchant, category, account_id, type, amount, expense_amount, principal_amount, interest_amount, currency, note, fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(body.occurredOn, body.merchant, body.category || '其他', body.accountId || null, body.type, amount, expenseAmount, Number(body.principalAmount) || 0, Number(body.interestAmount) || 0, body.currency || 'CNY', body.note || '', fingerprint);
    return json(res, 201, { id: Number(result.lastInsertRowid) });
  }
  if (pathname === '/api/budgets' && req.method === 'GET') {
    const budgets = db.prepare(`
      SELECT b.*, COALESCE(SUM(t.expense_amount), 0) AS spent
      FROM budgets b LEFT JOIN transactions t ON t.category = b.category AND t.occurred_on BETWEEN '2026-10-01' AND '2026-10-31'
      GROUP BY b.id ORDER BY b.monthly_limit DESC
    `).all();
    return json(res, 200, { budgets });
  }
  if (pathname.startsWith('/api/budgets/') && req.method === 'PUT') {
    const id = Number(pathname.split('/').pop());
    const body = await readBody(req);
    db.prepare('UPDATE budgets SET monthly_limit = ?, warning_threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Number(body.monthlyLimit), Number(body.warningThreshold || .9), id);
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/reports' && req.method === 'GET') return json(res, 200, getReport(searchParams.get('period') || 'month'));
  if (pathname === '/api/import/preview' && req.method === 'POST') {
    const body = await readBody(req);
    const rows = parseCsv(body.csv || '').map(row => normalizeImportRow(row, Number(body.accountId) || null));
    return json(res, 200, { rows, total: rows.length, duplicates: rows.filter(row => row.duplicate).length, importable: rows.filter(row => !row.duplicate).length });
  }
  if (pathname === '/api/import/commit' && req.method === 'POST') {
    const body = await readBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    let imported = 0, duplicates = 0;
    const batch = db.prepare('INSERT INTO import_batches (filename, source, total_rows, imported_rows, duplicate_rows) VALUES (?, ?, ?, 0, 0)').run(body.filename || 'import.csv', body.source || '通用 CSV', rows.length);
    const insert = db.prepare(`INSERT OR IGNORE INTO transactions (occurred_on, merchant, category, account_id, type, amount, expense_amount, currency, note, fingerprint, import_batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const exists = row.duplicate || db.prepare(`
          SELECT 1 FROM transactions
          WHERE fingerprint = ?
             OR (occurred_on = ? AND merchant = ? AND amount = ? AND COALESCE(account_id, 0) = COALESCE(?, 0))
        `).get(row.fingerprint, row.occurredOn, row.merchant, Number(row.amount), row.accountId || null);
        if (exists) { duplicates++; continue; }
        const result = insert.run(row.occurredOn, row.merchant, row.category, row.accountId || null, row.type, Number(row.amount), Number(row.expenseAmount) || 0, row.currency || 'CNY', row.note || '', row.fingerprint, Number(batch.lastInsertRowid));
        result.changes ? imported++ : duplicates++;
      }
      db.prepare('UPDATE import_batches SET imported_rows = ?, duplicate_rows = ? WHERE id = ?').run(imported, duplicates, Number(batch.lastInsertRowid));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return json(res, 201, { imported, duplicates, batchId: Number(batch.lastInsertRowid) });
  }
  if (pathname === '/api/export/transactions.csv' && req.method === 'GET') {
    const rows = db.prepare(`SELECT t.occurred_on, t.merchant, t.category, COALESCE(a.name,''), t.type, t.amount, t.expense_amount, t.note FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id ORDER BY t.occurred_on DESC`).all();
    const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const csv = '\uFEFF日期,交易方,分类,账户,类型,现金金额,计入支出,备注\n' + rows.map(row => Object.values(row).map(escape).join(',')).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="hengzi-transactions.csv"' });
    return res.end(csv);
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
  if (APP_PASSWORD === 'hengzi-demo') console.log('开发登录密码：hengzi-demo（可通过 APP_PASSWORD 修改）');
});
