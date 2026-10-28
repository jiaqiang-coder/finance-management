from pathlib import Path
import tempfile,shutil,subprocess,os,json,time,urllib.request,urllib.error,sqlite3
src=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as t:
 app=Path(t)/'app';shutil.copytree(src,app)
 # Deterministic official XML shape; provider failures can be injected without a production test endpoint.
 (app/'fetch-test.cjs').write_text("global.fetch=async()=>{if(require('fs').existsSync('FAIL_FX'))throw Error('offline');return {ok:true,text:async()=>`<gesmes:Envelope><Cube><Cube time='2026-10-28'><Cube currency='USD' rate='1.1'/><Cube rate='8.8' currency='HKD'/><Cube currency='CNY' rate='7.7'/></Cube></Cube></gesmes:Envelope>`}}")
 env=os.environ.copy();env.update(PORT='14175',APP_PASSWORD='integration-test-only')
 def start():
  p=subprocess.Popen(['node','--require','./fetch-test.cjs','server.js'],cwd=app,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for _ in range(100):
   try:urllib.request.urlopen('http://127.0.0.1:14175/app/fm/api/session');break
   except urllib.error.HTTPError:break
   except OSError:time.sleep(.02)
  return p
 cookie=None
 def call(path,data=None,method=None,auth=True):
  req=urllib.request.Request('http://127.0.0.1:14175/app/fm/api/'+path,data=json.dumps(data).encode() if data is not None else None,method=method,headers={'Content-Type':'application/json',**({'Cookie':cookie} if auth and cookie else {})})
  try:
   with urllib.request.urlopen(req) as r:return r.status,json.loads(r.read()),r.headers
  except urllib.error.HTTPError as e:return e.code,json.loads(e.read()),e.headers
 def login():
  global cookie
  _,_,h=call('login',{'password':'integration-test-only'},auth=False);cookie=h['Set-Cookie'].split(';')[0]
 p=start()
 try:
  login();assert call('fx',auth=False)[0]==401
  st,fx,_=call('fx');assert st==200 and abs(fx['rates']['USD']-7)<1e-10 and abs(fx['rates']['HKD']-.875)<1e-10
  body={'name':'美股账户','kind':'asset','currency':'USD','category':'股票','originalValue':100,'fxMode':'auto','valueCny':99999}
  st,a,_=call('accounts',body);assert st==201;ident=a['id']
  rows=call('accounts')[1]['accounts'];assert rows[0]['value_cny']==700
  body.update(name='港币账户',currency='HKD',originalValue=200)
  assert call('accounts/'+str(ident),body,'PUT')[0]==200
  rows=call('accounts')[1]['accounts'];assert len(rows)==1 and rows[0]['value_cny']==175 and rows[0]['original_value']==200
  bad={**body,'originalValue':-1};assert call('accounts/'+str(ident),bad,'PUT')[0]==400
  assert call('accounts/999999',body,'PUT')[0]==404
  assert len(call('fx/history')[1]['history'])==1
 finally:p.terminate();p.wait()
 # Force an overdue cache, restart with provider offline; verify historical data and value survive.
 with sqlite3.connect(app/'data/hengzi.db') as c:
  q=json.loads(c.execute('SELECT payload FROM fx_cache').fetchone()[0]);q['fetchedAt']=0;c.execute('UPDATE fx_cache SET payload=?',(json.dumps(q),))
 (app/'FAIL_FX').write_text('1');p=start()
 try:
  login();fx=call('fx')[1];assert fx['stale'] and fx['rates']['HKD']==.875
  rows=call('accounts')[1]['accounts'];assert rows[0]['name']=='港币账户' and rows[0]['value_cny']==175
  assert call('accounts/'+str(ident),body,'PUT')[0]==400
  body.update(fxMode='manual',valueCny=180)
  assert call('accounts/'+str(ident),body,'PUT')[0]==200
  assert call('accounts')[1]['accounts'][0]['value_cny']==180
 finally:p.terminate();p.wait()
 print('PASS: protected FX endpoints; official XML cross rates; USD create; HKD edit; server-calculated value; validation; history; restart persistence; provider failure cache; manual fallback')
