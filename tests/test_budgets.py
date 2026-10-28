from pathlib import Path
import tempfile,shutil,subprocess,os,json,time,urllib.request,urllib.error,datetime,zoneinfo
source=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
 app=Path(tmp)/'app';shutil.copytree(source,app)
 (app/'no-network.cjs').write_text("global.fetch=async()=>{throw Error('offline-test')}")
 env=os.environ.copy();env.update(PORT='14176',APP_PASSWORD='budget-test-only');cookie=None
 def call(path,data=None,method=None,auth=True):
  r=urllib.request.Request('http://127.0.0.1:14176/app/fm/api/'+path,data=None if data is None else json.dumps(data).encode(),method=method,headers={'Content-Type':'application/json',**({'Cookie':cookie} if auth and cookie else {})})
  try:
   with urllib.request.urlopen(r) as x:return x.status,json.loads(x.read()),x.headers
  except urllib.error.HTTPError as e:return e.code,json.loads(e.read()),e.headers
 def start():
  global cookie
  p=subprocess.Popen(['node','--require','./no-network.cjs','server.js'],cwd=app,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for _ in range(100):
   try:call('session',auth=False);break
   except OSError:time.sleep(.02)
  _,_,h=call('login',{'password':'budget-test-only'},auth=False);cookie=h['Set-Cookie'].split(';')[0];return p
 p=start()
 try:
  data={'category':'日常消费','monthlyLimit':100,'warningThreshold':.9}
  assert call('budgets',data,auth=False)[0]==401
  st,b,_=call('budgets',data);assert st==201;ident=b['id']
  assert call('budgets',data)[0]==409
  for key,value in [('monthlyLimit',0),('monthlyLimit',-1),('warningThreshold',0),('warningThreshold',1.01),('category',' ')]:
   assert call('budgets/'+str(ident),{**data,key:value},'PUT')[0]==400
  assert call('budgets/99999',data,'PUT')[0]==404
  today=datetime.datetime.now(zoneinfo.ZoneInfo('Asia/Shanghai')).date();past=today.replace(day=1)-datetime.timedelta(days=1)
  for day,amount in [(today,80),(past,1000)]:
   assert call('transactions',{'occurredOn':day.isoformat(),'merchant':'月度预算测试','type':'expense','amount':amount,'category':'日常消费'})[0]==201
  b=call('budgets')[1]['budgets'][0];assert b['spent']==80
  assert call('budgets/'+str(ident),{**data,'monthlyLimit':200,'warningThreshold':.8},'PUT')[0]==200
 finally:p.terminate();p.wait()
 p=start()
 try:
  rows=call('budgets')[1]['budgets'];assert len(rows)==1 and rows[0]['monthly_limit']==200 and rows[0]['warning_threshold']==.8 and rows[0]['spent']==80
 finally:p.terminate();p.wait()
 print('PASS budgets: auth; create/edit; duplicate category; amount/threshold validation; missing ID; Shanghai current month excludes previous month; restart persistence')
