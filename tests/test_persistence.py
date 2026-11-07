from pathlib import Path
import tempfile,shutil,subprocess,os,urllib.request,urllib.error,json,time,secrets,sqlite3
src=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as t:
 app=Path(t)/'app';shutil.copytree(src,app,ignore=shutil.ignore_patterns('.git','data','node_modules','qa-mobile.html'));env=os.environ.copy();pw=secrets.token_urlsafe(24);env.update(PORT='14174',APP_PASSWORD=pw)
 def start():
  p=subprocess.Popen(['node','server.js'],cwd=app,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for _ in range(50):
   try:urllib.request.urlopen('http://127.0.0.1:14174/app/fm/api/session');break
   except urllib.error.HTTPError:break
   except OSError:time.sleep(.05)
  return p
 def call(path,data=None,cookie=None,method=None):
  req=urllib.request.Request('http://127.0.0.1:14174/app/fm/api/'+path,method=method,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json',**({'Cookie':cookie} if cookie else {})})
  with urllib.request.urlopen(req) as r:return json.loads(r.read()),r.headers
 p=start()
 try:
  _,h=call('login',{'password':pw});cookie=h['Set-Cookie'].split(';')[0]
  assert call('accounts',cookie=cookie)[0]['accounts']==[]
  assert call('summary',cookie=cookie)[0]['assets']==0
  account=call('accounts',{'name':'持久化验证','kind':'asset','category':'银行存款','valueCny':1234},cookie)[0]['id']
  call('transactions',{'occurredOn':'2026-10-28','merchant':'验证流水','type':'income','amount':88,'accountId':account},cookie)
 finally:p.terminate();p.wait()
 p=start()
 try:
  _,h=call('login',{'password':pw});cookie=h['Set-Cookie'].split(';')[0]
  assert len(call('accounts',cookie=cookie)[0]['accounts'])==1
  assert call('summary',cookie=cookie)[0]['assets']==1234
  assert len(call('transactions',cookie=cookie)[0]['transactions'])==1
  with sqlite3.connect(app/'data/hengzi.db') as c:assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
 finally:p.terminate();p.wait()
 # Reproduce legacy data: selecting a debt category formerly retained default asset kind.
 with sqlite3.connect(app/'data/hengzi.db') as c:
  for name,category,value in [('信用卡旧数据','流动负债',200000),('房贷旧数据','长期负债',50000),('负债对冲基金','自定义资产',100)]:
   c.execute("INSERT INTO accounts(name,kind,category,currency,value_cny,original_value) VALUES (?,'asset',?,'CNY',?,?)",(name,category,value,value))
  c.execute("INSERT INTO daily_snapshots VALUES ('2020-01-01',1,'test',?)",('{"frozen":true}',))
 p=start()
 try:
  _,h=call('login',{'password':pw});cookie=h['Set-Cookie'].split(';')[0]
  summary=call('summary',cookie=cookie)[0]
  assert (summary['assets'],summary['liabilities'],summary['currentLiabilities'],summary['netWorth'])==(1334,250000,200000,-248666),summary
  for category in ['流动负债','长期负债']:
   try:call('accounts',{'name':'不允许错记','kind':'asset','category':category,'valueCny':200000},cookie);assert False
   except urllib.error.HTTPError as e:assert e.code==400
   try:call('accounts/'+str(account),{'name':'不允许错记','kind':'asset','category':category,'valueCny':200000},cookie,method='PUT');assert False
   except urllib.error.HTTPError as e:assert e.code==400
  assert call('summary',cookie=cookie)[0]['netWorth']==-248666
  with sqlite3.connect(app/'data/hengzi.db') as c:
   assert c.execute('SELECT COUNT(*) FROM account_kind_corrections').fetchone()[0]==2
   assert c.execute("SELECT payload FROM daily_snapshots WHERE day='2020-01-01'").fetchone()[0]=='{"frozen":true}'
   assert c.execute("SELECT kind FROM accounts WHERE name='负债对冲基金'").fetchone()[0]=='asset'
   assert c.execute("SELECT COUNT(*) FROM account_versions WHERE json_extract(payload,'$.kind')='liability'").fetchone()[0]>=2
 finally:p.terminate();p.wait()
 p=start()
 try:
  _,h=call('login',{'password':pw});cookie=h['Set-Cookie'].split(';')[0]
  assert call('summary',cookie=cookie)[0]['netWorth']==-248666
  with sqlite3.connect(app/'data/hengzi.db') as c:assert c.execute('SELECT COUNT(*) FROM account_kind_corrections').fetchone()[0]==2
 finally:p.terminate();p.wait()
 print('PASS DB: persistence; legacy current/long-term liabilities corrected with audit; net worth subtracts all debts; invalid classification rejected; snapshots preserved; restart idempotent')
