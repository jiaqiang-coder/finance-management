const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');
db.exec("CREATE TABLE investment_daily_sync(day TEXT PRIMARY KEY,status TEXT,attempts INTEGER,attempted_ms INTEGER);CREATE TABLE investment_events(id INTEGER,security_id INTEGER,voided INTEGER);INSERT INTO investment_events VALUES(1,1,0)");
let calls=0,failed=false;
const context=vm.createContext({db,Date,process:{env:{HENGZI_MARKET_API_KEY:'test'}},shanghaiDay:ms=>new Date(ms).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),invRefreshQuotes:async()=>{calls++;return {failed:failed?1:0}}});
const source=fs.readFileSync('server.js','utf8');
vm.runInContext(source.slice(source.indexOf('async function invDailyQuotes'),source.indexOf('setInterval(()=>invDailyQuotes')),context);
const run=time=>context.invDailyQuotes(Date.parse(time));
(async()=>{
 await run('2026-11-07T09:59:00+08:00');assert.equal(calls,0);
 await run('2026-11-07T10:00:00+08:00');assert.equal(calls,1);
 await run('2026-11-07T15:00:00+08:00');assert.equal(calls,1);
 // Recreating the worker with the same persistent job store still skips the completed day.
 vm.runInContext(source.slice(source.indexOf('async function invDailyQuotes'),source.indexOf('setInterval(()=>invDailyQuotes')),context);
 await run('2026-11-07T20:00:00+08:00');assert.equal(calls,1);
 failed=true;await run('2026-11-08T10:00:00+08:00');assert.equal(calls,2);
 await run('2026-11-08T10:59:00+08:00');assert.equal(calls,2);
 await run('2026-11-08T11:00:00+08:00');await run('2026-11-08T12:00:00+08:00');assert.equal(calls,4);
 await run('2026-11-08T13:00:00+08:00');assert.equal(calls,4);
 failed=false;await run('2026-11-09T14:00:00+08:00');assert.equal(calls,5);
 db.exec('DELETE FROM investment_events');await run('2026-11-10T14:00:00+08:00');assert.equal(calls,5);
 console.log('PASS daily close schedule: 10:00 Shanghai boundary, one success/day, restart skip, hourly retries capped at three, late recovery and empty-book skip');
})().catch(e=>{console.error(e);process.exitCode=1});
