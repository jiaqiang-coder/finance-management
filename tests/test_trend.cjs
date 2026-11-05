const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(':memory:');
let now=Date.parse('2026-11-05T10:00:00+08:00');
db.function('unixepoch',_arg=>now/1000);
class Clock extends Date {
  constructor(...args){super(...(args.length?args:[now]));}
  static now(){return now;}
}
db.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY,name TEXT,kind TEXT,category TEXT,currency TEXT,original_value REAL,value_cny REAL,fx_mode TEXT,fx_rate REAL,fx_updated_at TEXT);
  CREATE TABLE fx_cache(id INTEGER PRIMARY KEY,payload TEXT);
  INSERT INTO accounts VALUES(1,'USD','asset','现金','USD',10000,72000,'auto',7.2,'2026-11-05');
  INSERT INTO accounts VALUES(2,'贷款','liability','贷款','CNY',10000,10000,'manual',NULL,NULL);`);
function quote(rate,quotedAt){
  db.prepare('INSERT INTO fx_cache VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
    .run(JSON.stringify({rates:{USD:rate,HKD:.9},quotedAt,fetchedAt:now}));
}
quote(7.2,'2026-11-05');
const source=fs.readFileSync('server.js','utf8');
const trend=source.slice(source.indexOf('// Record the state actually saved'),source.indexOf('function parseCookies'));
const context=vm.createContext({db,Date:Clock,console,shanghaiDay:ms=>new Clock(ms??now).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),setInterval:()=>({unref(){}})});
vm.runInContext(trend,context);
const read=(day='')=>vm.runInContext('readTrend(30,'+JSON.stringify(day)+')',context);
assert.equal(read().points.length,0);
assert.equal(read().firstDay,'2026-11-05');
// An update exactly at midnight belongs to the next day, even after missed jobs.
now=Date.parse('2026-11-06T00:00:00+08:00');
quote(7.1,'2026-11-06');
db.exec("UPDATE accounts SET value_cny=71000,fx_rate=7.1,fx_updated_at='2026-11-06' WHERE id=1");
now=Date.parse('2026-11-07T01:00:00+08:00');
quote(7,'2026-11-07');
db.exec("UPDATE accounts SET value_cny=70000,fx_rate=7 WHERE id=1");
let r=read('2026-11-05');
assert.equal(r.points.length,2);
assert.equal(r.detail.items[0].value_cny,72000);
assert.equal(r.points[0].totals.CNY.netWorth,62000);
assert.equal(r.points[1].totals.USD.assets,10000);
assert.equal(r.points[1].changes.CNY.assets.delta,-1000);
assert.equal(r.points[1].changes.CNY.assets.fxImpact,-1000);
assert.equal(r.points[1].changes.USD.assets.fxImpact,0);
assert.equal(r.today.totals.CNY.assets,70000);
db.exec('DELETE FROM accounts WHERE id=1');
assert.equal(read('2026-11-05').detail.items[0].value_cny,72000);
assert.equal(read().today.totals.CNY.assets,0);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_snapshots').get().n,2);
assert.equal(vm.runInContext('totalsFor([],null).USD',context),null);
console.log('PASS: day-one baseline, midnight boundary, missed cut recovery, immutable snapshots, USD/CNY attribution, missing quote and tombstones');
