"""HTTP investment regressions against a temporary on-disk SQLite database."""
import json, os, secrets, shutil, socket, sqlite3, subprocess, tempfile, time, uuid
from pathlib import Path
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from zoneinfo import ZoneInfo

root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
 app=Path(tmp);shutil.copy(root/'server.js',app)
 (app/'fetch-test.cjs').write_text("""
 const fs=require('fs');global.fetch=async url=>{
 if(String(url).includes('ecb.europa.eu'))return {ok:true,text:async()=>`<Cube time='${new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})}'><Cube currency='USD' rate='1'/><Cube currency='HKD' rate='8'/><Cube currency='CNY' rate='7.1'/></Cube>`};
 const p=JSON.parse(fs.readFileSync('quotes.json','utf8'));if(p.fail)throw Error('offline');
 const u=new URL(url);if(u.pathname!=='/time_series'||u.searchParams.get('interval')!=='1day'||u.searchParams.get('adjust')!=='none')throw Error('unexpected quote request');return {ok:true,json:async()=>({meta:{symbol:u.searchParams.get('symbol'),exchange:u.searchParams.get('exchange'),currency:p.currency||'USD'},values:p.values||[{datetime:p.datetime,close:p.price}]})};};
 """)
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 env={**os.environ,'PORT':str(port),'APP_PASSWORD':secrets.token_urlsafe(24),'HENGZI_MARKET_API_KEY':'test-key-never-returned'}
 cookie='';proc=None
 today=datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
 now=datetime.now(timezone.utc).replace(microsecond=0)
 def quotes(**values):(app/'quotes.json').write_text(json.dumps(values))
 previous=(datetime.now(ZoneInfo('Asia/Shanghai')).date()-timedelta(days=1)).isoformat()
 quotes(values=[{'datetime':today,'close':'999'},{'datetime':previous,'close':'13'}])
 def call(path,body=None,method=None,expected=200,auth=True):
  request=Request(f'http://127.0.0.1:{port}/app/fm/api/'+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={'Content-Type':'application/json','Cookie':cookie if auth else ''})
  try:response=urlopen(request,timeout=10)
  except HTTPError as error:response=error
  with response:
   data=json.loads(response.read());assert response.status==expected,(path,response.status,data)
   assert 'test-key-never-returned' not in json.dumps(data)
   return data,response.headers
 def start():
  global proc,cookie
  proc=subprocess.Popen(['node','--require','./fetch-test.cjs','server.js'],cwd=app,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
  for _ in range(120):
   if proc.poll() is not None:raise AssertionError(proc.stderr.read().decode())
   try:call('session',expected=401);break
   except OSError:time.sleep(.025)
  _,h=call('login',{'password':env['APP_PASSWORD']});cookie=h['Set-Cookie'].split(';')[0]
 def stop():proc.terminate();proc.wait(timeout=5);proc.stderr.close()
 def event(kind,**fields):
  body={'type':kind,'day':today,'requestId':str(uuid.uuid4()),**fields};return body
 def book():return call('investments')[0]['books'][0]
 def record(body,expected=201):return call(f'investments/accounts/{ident}/events',body,expected=expected)[0]
 try:
  start();call('investments',expected=401,auth=False)
  old=call('accounts',{'name':'原有银行','kind':'asset','category':'银行存款','valueCny':100},expected=201)[0]['id']
  manual=call('accounts',{'name':'旧证券','kind':'asset','category':'股票','valueCny':999},expected=201)[0]['id']
  call('investments/accounts',{'name':'投资账户','existingAccountId':manual},expected=400)
  assert call('summary')[0]['assets']==1099
  ident=call('investments/accounts',{'name':'投资账户','existingAccountId':manual,'confirmReplace':True},expected=201)[0]['id']
  assert ident==manual and len(call('accounts')[0]['accounts'])==2
  call('accounts/'+str(ident),{'name':'非法覆盖'},method='PUT',expected=409)
  # Remove startup reference quote to exercise the no-FX rollback path.
  with sqlite3.connect(app/'data/hengzi.db') as db:db.execute('DELETE FROM fx_cache')
  # Missing FX must roll back the event and any newly created security.
  record(event('cash_opening',currency='USD',amount=1000),expected=400)
  assert not book()['events']
  with sqlite3.connect(app/'data/hengzi.db') as db:
   db.execute('INSERT INTO fx_cache VALUES(1,?)',(json.dumps({'rates':{'CNY':1,'USD':7.1,'HKD':.8875},'quotedAt':today,'fetchedAt':int(time.time()*1000),'stale':False}),))
  call('fx')
  record(event('cash_opening',currency='USD',amount=1000))
  security={'market':'US','exchange':'NASDAQ','symbol':'AAPL','name':'苹果','quantity':10,'price':10,'fee':0}
  record(event('opening',**security));assert book()['netValueCny']==7810
  assert call('summary')[0]['assets']==7910
  record(event('opening',**security),expected=400)
  buy=event('buy',**{**security,'quantity':5,'price':12,'fee':1})
  original=record(buy);assert record(buy)['repeated']
  record({**buy,'price':13},expected=409)
  b=book();assert b['cash']['USD']==939 and b['positions'][0]['quantity']==15
  assert len(b['events'])==3 and abs(b['positions'][0]['averageCost']-161/15)<1e-7
  sid=b['positions'][0]['id']
  call('investments/quotes',{'securityId':sid,'price':12,'quotedAt':now.isoformat()},method='PUT')
  assert book()['netValueCny']==7944.9
  sell=record(event('sell',**{**security,'quantity':6,'price':15,'fee':2}))
  b=book();assert b['cash']['USD']==1027 and b['positions'][0]['quantity']==9
  assert abs(b['realized']['USD']-23.6)<1e-8 and b['netValueCny']==8058.5
  record(event('sell',**{**security,'quantity':10}),expected=400)
  record(event('withdraw',currency='USD',amount=2000),expected=400)
  record(event('buy',**{**security,'quantity':1000}),expected=400)
  record(event('buy',**{**security,'price':-1}),expected=400)
  record({**event('buy',**security),'day':'2026-02-30'},expected=400)
  record({**event('buy',**security),'day':'2099-01-01'},expected=400)
  assert len(book()['events'])==4
  call('investments/events/'+str(original['id'])+'/void',{},expected=409)
  call('investments/events/'+str(sell['id'])+'/void',{})
  assert book()['cash']['USD']==939 and book()['positions'][0]['quantity']==15
  # Undoing an opening does not delete its audit row, and re-recording is supported.
  call('investments/events/'+str(original['id'])+'/void',{})
  assert book()['netValueCny']==7952
  # Provider updates and failures: always preserve the last verified quote.
  result=call('investments/quotes/refresh',{})[0];assert result['updated']==1
  assert book()['positions'][0]['price']==13 and book()['positions'][0]['quoteDate']==previous
  call('investments/quotes/refresh',{},expected=429)
  assert not call('transactions')[0]['transactions']  # buys and funding aren't household expenses
  stop();quotes(fail=True);start()
  b=book();assert b['positions'][0]['quantity']==10 and b['cash']['USD']==1000
  previous_quote=book()['positions'][0]['quoteDate']
  result=call('investments/quotes/refresh',{})[0];assert result['updated']==0 and '尚未更新' in result['message']
  assert book()['positions'][0]['quoteDate']==previous_quote and book()['netValueCny']>0
  assert book()['positions'][0]['price']==13
  call('investments/quotes',{'securityId':sid,'price':1,'quotedAt':'2020-01-01T00:00:00Z'},method='PUT',expected=400)
  assert call('summary')[0]['assets']==book()['netValueCny']+100
  with sqlite3.connect(app/'data/hengzi.db') as db:
   assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
   assert db.execute('SELECT COUNT(*) FROM investment_events WHERE voided=1').fetchone()[0]==2
  # Edits are account-scoped correction events: cash and realised gains remain intact.
  before=book();edit={'name':'自定义 <苹果>','quantity':12,'averageCost':11,'expectedVersion':before['version'],'requestId':str(uuid.uuid4())}
  route=f'investments/accounts/{ident}/holdings/{sid}'
  call(route,edit,method='PUT',expected=401,auth=False)
  corrected=call(route,edit,method='PUT')[0]
  assert call(route,edit,method='PUT')[0]['repeated']
  after=book();assert after['cash']==before['cash'] and after['realized']==before['realized']
  assert after['positions'][0]['name']=='自定义 <苹果>' and after['positions'][0]['quantity']==12
  assert after['positions'][0]['cost']==132 and after['netValueCny']==8207.6
  assert after['events'][-1]['type']=='adjustment'
  following=record(event('sell',**{**security,'quantity':2,'price':13,'fee':1}))
  assert book()['realized']['USD']==before['realized']['USD']+3
  assert book()['positions'][0]['quantity']==10 and book()['cash']['USD']==1025
  call('investments/events/'+str(following['id'])+'/void',{})
  assert book()['positions'][0]['quantity']==12 and book()['cash']==before['cash']
  call(route,{**edit,'requestId':str(uuid.uuid4()),'quantity':99},method='PUT',expected=409)
  invalid={**edit,'expectedVersion':after['version'],'requestId':str(uuid.uuid4()),'quantity':-1}
  call(route,invalid,method='PUT',expected=400)
  call(route,{**invalid,'quantity':1.1234567},method='PUT',expected=400)
  assert book()['positions'][0]['quantity']==12
  # The same security in another account must retain its own name, quantity and cost.
  other=call('investments/accounts',{'name':'第二投资账户'},expected=201)[0]['id']
  call(f'investments/accounts/{other}/events',event('opening',**{**security,'quantity':2}),expected=201)
  second=next(b for b in call('investments')[0]['books'] if b['id']==other)
  assert second['positions'][0]['name']=='苹果' and second['positions'][0]['quantity']==2
  stop();start();assert book()['positions'][0]['quantity']==12
  assert book()['positions'][0]['name']=='自定义 <苹果>'
  call('investments/events/'+str(corrected['id'])+'/void',{})
  assert book()['positions'][0]['quantity']==10 and book()['positions'][0]['name']=='苹果'
  # An ABA-style stale form (edit then undo) is still rejected by the version guard.
  call(route,{**edit,'requestId':str(uuid.uuid4())},method='PUT',expected=409)
  zero={**edit,'name':'已核对清零','quantity':0,'averageCost':0,'expectedVersion':book()['version'],'requestId':str(uuid.uuid4())}
  zero_id=call(route,zero,method='PUT')[0]['id'];assert book()['positions'][0]['quantity']==0
  assert book()['cash']==before['cash']
  call('investments/events/'+str(zero_id)+'/void',{})
  assert book()['positions'][0]['quantity']==10
  # Base account and preexisting values survive additive migration and restart.
  assert any(a['id']==old and a['value_cny']==100 for a in call('accounts')[0]['accounts'])
 finally:
  if proc and proc.poll() is None:stop()
print('PASS investments: auth, explicit account linkage, migration, FX rollback, weighted costs, cash, sell P&L, idempotency, validation, undo audit, quotes, failed-provider retention and restart persistence')
