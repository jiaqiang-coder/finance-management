from pathlib import Path
import tempfile,shutil,subprocess,os,urllib.request,urllib.error,json,time,secrets,sqlite3
src=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as t:
 app=Path(t)/'app';shutil.copytree(src,app);env=os.environ.copy();pw=secrets.token_urlsafe(24);env.update(PORT='14174',APP_PASSWORD=pw)
 def start():
  p=subprocess.Popen(['node','server.js'],cwd=app,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for _ in range(50):
   try:urllib.request.urlopen('http://127.0.0.1:14174/app/fm/api/session');break
   except urllib.error.HTTPError:break
   except OSError:time.sleep(.05)
  return p
 def call(path,data=None,cookie=None):
  req=urllib.request.Request('http://127.0.0.1:14174/app/fm/api/'+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json',**({'Cookie':cookie} if cookie else {})})
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
 print('PASS DB: fresh database empty; account/transaction saved; both survive process restart; SQLite integrity OK')
