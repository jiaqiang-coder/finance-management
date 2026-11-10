from pathlib import Path
import tempfile,shutil,subprocess,os,urllib.request,urllib.error,json,time,secrets,sqlite3,uuid
src=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as t:
 app=Path(t)/'app';shutil.copytree(src,app,ignore=shutil.ignore_patterns('.git','data','node_modules','qa-mobile.html'))
 password=secrets.token_urlsafe(24);env=os.environ.copy();env.update(PORT='14182',APP_PASSWORD=password)
 for k in ['HENGZI_AI_MODEL','HENGZI_AI_API_KEY','HENGZI_AI_CHAT_URL']:env.pop(k,None)
 cookie=None
 def start():
  p=subprocess.Popen(['node','--require','./tests/ai_provider_fixture.cjs','server.js'],cwd=app,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for _ in range(100):
   try:urllib.request.urlopen('http://127.0.0.1:14182/app/fm/api/session')
   except urllib.error.HTTPError:break
   except OSError:time.sleep(.05)
  return p
 def call(path,data=None,method=None,auth=True,expected=200):
  req=urllib.request.Request('http://127.0.0.1:14182/app/fm/api/'+path,method=method,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json',**({'Cookie':cookie} if auth and cookie else {})})
  try:
   with urllib.request.urlopen(req,timeout=15) as r:status=r.status;result=json.loads(r.read());headers=r.headers
  except urllib.error.HTTPError as e:status=e.code;result=json.loads(e.read());headers=e.headers
  assert status==expected,(path,status,expected,result)
  return result,headers
 def send(text,thread=None,request_id=None):
  if thread is None:thread=call('assistant/threads',{},expected=201)[0]['id']
  request_id=request_id or str(uuid.uuid4())
  call('assistant/threads/'+thread+'/messages',{'content':text,'requestId':request_id},expected=202)
  return thread,request_id
 def finish(thread):
  for _ in range(100):
   r=call('assistant/threads/'+thread+'/messages')[0]
   if not any(m['status']=='processing' for m in r['messages']):return r
   time.sleep(.05)
  raise AssertionError('analysis did not finish')
 p=start()
 try:
  for endpoint in ['config','threads','reports']:
   call('assistant/'+endpoint,auth=False,expected=401)
  _,h=call('login',{'password':password});cookie=h['Set-Cookie'].split(';')[0]
  assert call('assistant/config')[0]['configured'] is False
  thread=call('assistant/threads',{},expected=201)[0]['id']
  call('assistant/threads/'+thread+'/messages',{'content':'测试','requestId':str(uuid.uuid4())},expected=503)
  config={'url':'https://ai.example.test/v1/chat/completions','model':'test-model','key':'test-provider-secret-key','shareData':True}
  call('assistant/config',{**config,'shareData':False},method='PUT',expected=400)
  for url in ['http://ai.example.test/v1/chat/completions','https://internal.test/api','https://localhost/api','https://user:pass@ai.example.test/api','https://ai.example.test/api?key=abc']:
   call('assistant/config',{**config,'url':url},method='PUT',expected=400)
  saved=call('assistant/config',config,method='PUT')[0]
  assert saved['configured'] and saved['hasKey'] and 'key' not in saved
  with sqlite3.connect(app/'data/hengzi.db') as c:assert config['key'] not in c.execute('SELECT payload FROM ai_settings').fetchone()[0]
  call('assistant/config/test',{})
  call('assistant/config',{**config,'url':'https://other.example.test/v1/chat/completions','key':''},method='PUT',expected=400)
  call('assistant/config',{**config,'key':''},method='PUT')
  cash=call('accounts',{'name':'测试现金','kind':'asset','category':'银行存款','valueCny':100000},expected=201)[0]['id']
  call('accounts',{'name':'测试负债','kind':'liability','category':'流动负债','valueCny':20000},expected=201)
  call('transactions',{'occurredOn':'2026-11-08','merchant':'咖啡店','category':'其他','type':'expense','amount':30,'currency':'CNY'},expected=201)
  call('transactions',{'occurredOn':'2026-11-08','merchant':'港币支出','category':'其他','type':'expense','amount':99,'currency':'HKD'},expected=201)
  thread,request=send('多轮资产体检')
  result=finish(thread);answer=result['messages'][-1]
  assert answer['status']=='complete' and '80,000' in answer['content'] and '下一步' in answer['content'],answer
  assert [d['name'] for d in answer['details']]==['financial_diagnosis','accounts']
  assert answer['run']['phase']=='complete' and answer['run']['report'] and answer['run']['checks']
  call('assistant/threads/'+thread+'/messages',{'content':'多轮资产体检','requestId':request})
  assert len(call('assistant/threads/'+thread+'/messages')[0]['messages'])==2
  report=call('assistant/reports',{'messageId':answer['id']},expected=201)[0]['id']
  assert call('assistant/reports',{'messageId':answer['id']},expected=201)[0]['id']==report
  thread,_=send('人民币收支');r=finish(thread);d=r['messages'][-1]['details'][0]['data'];assert len(d['rows'])==1 and d['rows'][0]['currency']=='CNY'
  thread,_=send('现金方案，每月必要开支3万元');r=finish(thread);v=next(d['data'] for d in r['messages'][-1]['details'] if d['name']=='reserve_scenarios');assert v['cash']==100000 and v['coverageMonths']==3.33 and v['scenarios'][0]['remainingCash']==10000 and v['scenarios'][1]['shortfall']==80000,v
  for text in ['持仓','预算','趋势']:
   thread,_=send(text);r=finish(thread);assert r['messages'][-1]['details'][0]['ok'],r
  thread,_=send('修改流水');r=finish(thread);assert len(r['actions'])==1
  action=r['actions'][0];tx_id=action['entityId']
  with sqlite3.connect(app/'data/hengzi.db') as c:assert c.execute('SELECT amount FROM transactions WHERE id=?',(tx_id,)).fetchone()[0]==-30
  call('assistant/actions/'+action['id'],{'decision':'confirm'})
  call('assistant/actions/'+action['id'],{'decision':'confirm'})
  with sqlite3.connect(app/'data/hengzi.db') as c:assert c.execute('SELECT amount,expense_amount,category FROM transactions WHERE id=?',(tx_id,)).fetchone()==(-35.5,35.5,'餐饮')
  thread,_=send('修改账户分类');r=finish(thread);action=r['actions'][0]
  call('accounts/'+str(cash),{'name':'测试现金','kind':'asset','category':'银行存款','valueCny':110000},method='PUT')
  call('assistant/actions/'+action['id'],{'decision':'confirm'},expected=409)
  call('assistant/actions/'+action['id'],{'decision':'cancel'})
  with sqlite3.connect(app/'data/hengzi.db') as c:assert c.execute('SELECT category FROM accounts WHERE id=?',(cash,)).fetchone()[0]=='银行存款'
  old=call('assistant/reports/'+report)[0];assert old['details'][0]['data']['summary']['netWorth']==80000
  for text in ['认证失败','限流','超时','损坏响应']:
   thread,_=send(text);assert finish(thread)['messages'][-1]['status']=='failed'
  for text in ['工具越权','无效参数']:
   thread,_=send(text);r=finish(thread);assert r['messages'][-1]['details'][0]['ok'] is False
  with sqlite3.connect(app/'data/hengzi.db') as c:assert c.execute('SELECT COUNT(*) FROM accounts').fetchone()[0]==2
  with sqlite3.connect(app/'data/hengzi.db') as c:
   c.execute('INSERT OR REPLACE INTO fx_cache VALUES(1,?)',(json.dumps({'rates':{'CNY':1,'USD':7,'HKD':.9},'quotedAt':'2026-11-10','fetchedAt':int(time.time()*1000),'stale':False}),))
  first_book=call('investments/accounts',{'name':'股票账户甲'},expected=201)[0]['id']
  second_book=call('investments/accounts',{'name':'股票账户乙'},expected=201)[0]['id']
  def opening(book,**values):
   call('investments/accounts/'+str(book)+'/events',{'type':'opening','day':'2026-11-08','requestId':str(uuid.uuid4()),'fee':0,**values},expected=201)
  opening(first_book,market='CN',exchange='SSE',symbol='510300',name='指数ETF',quantity=1000,price=4)
  opening(second_book,market='CN',exchange='SSE',symbol='510300',name='指数ETF',quantity=500,price=4)
  opening(second_book,market='US',exchange='NASDAQ',symbol='AAPL',name='苹果',quantity=10,price=200)
  thread,_=send('我的股票持仓有没有风险');r=finish(thread);m=r['messages'][-1];d=m['run']['diagnosis']
  assert m['status']=='complete' and m['run']['domain']=='portfolio',m
  assert [x['name'] for x in m['details']]==['portfolio_diagnosis']
  assert len(d['holdings'])==2 and d['holdings'][0]['symbol']=='AAPL' and d['holdings'][0]['weightPct']==70,d
  assert next(f['value'] for f in d['facts'] if f['id']=='securities_shock_20')==-4000
  assert 'property_value' not in [f['id'] for f in d['facts']] and '房产' not in json.dumps(d,ensure_ascii=False)
  assert len(m['run']['report']['priorities'])>=3 and len(m['run']['report']['comparisons'])>=2
  thread,_=send('股票持仓风险，错用资产工具测试');r=finish(thread);m=r['messages'][-1]
  assert m['status']=='complete' and any(not x['ok'] and x['name']=='asset_summary' for x in m['details']),m
  assert all('assets' not in x.get('data',{}) for x in m['details'])
  thread,_=send('股票持仓风险，错误依据测试');r=finish(thread);m=r['messages'][-1]
  assert m['status']=='complete' and any('事实编号' in x for x in m['run']['checks'])
  thread,_=send('股票持仓风险，一直无效');r=finish(thread);assert r['messages'][-1]['status']=='failed'
  thread,_=send('输出截断测试');r=finish(thread);assert r['messages'][-1]['status']=='complete' and '接续内容' in r['messages'][-1]['content']
  thread,_=send('持续截断测试');r=finish(thread);assert r['messages'][-1]['status']=='partial'
  call('assistant/reports',{'messageId':r['messages'][-1]['id']},expected=400)
  call('assistant/config',{**config,'model':'deepseek-flash','url':'https://api.deepseek.com/chat/completions'},method='PUT')
  for question in ['我的股票持仓有没有风险','继续分析我的持仓风险','AAPL有没有风险','那你建议怎么调整']:
   thread,_=send(question,thread if question.startswith(('继续','那')) else None);r=finish(thread)
   assert r['messages'][-1]['status']=='complete' and r['messages'][-1]['run']['domain']=='portfolio',r
   assert 'fixture-private-reasoning' not in json.dumps(r),r
 finally:p.terminate();p.wait()
 p=start()
 try:
  _,h=call('login',{'password':password});cookie=h['Set-Cookie'].split(';')[0]
  assert call('assistant/config')[0]['configured']
  assert call('assistant/reports/'+report)[0]['content']==old['content']
  assert call('assistant/threads')[0]['threads']
 finally:p.terminate();p.wait()
 print('PASS AI: auth, encrypted configuration, endpoint guards, actual tool loop, exact arithmetic, currency isolation, request idempotency, report snapshots, confirmation-only writes, stale conflict, provider failures and restart persistence')
