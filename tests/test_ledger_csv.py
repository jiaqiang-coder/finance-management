import csv, io, json, os, secrets, shutil, socket, subprocess, tempfile, time
from datetime import datetime
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from zoneinfo import ZoneInfo

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
    app = Path(tmp)
    shutil.copy(root / 'server.js', app)
    env = {k: v for k, v in os.environ.items() if not k.startswith('HENGZI_AI_') and k != 'APP_PASSWORD'}
    refused = subprocess.run(['node', 'server.js'], cwd=app, env=env, capture_output=True, timeout=4)
    assert refused.returncode == 1 and b'APP_PASSWORD' in refused.stderr
    assert not (app / 'data').exists()

    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    password = secrets.token_urlsafe(24)
    env.update(APP_PASSWORD=password, PORT=str(port))
    proc = subprocess.Popen(['node', 'server.js'], cwd=app, env=env, stdout=subprocess.DEVNULL)
    cookie = ''

    def call(path, body=None, method=None, expected=200):
        req = Request(f'http://127.0.0.1:{port}/app/fm/api/{path}',
                      data=None if body is None else json.dumps(body, ensure_ascii=False).encode(),
                      method=method, headers={'Content-Type': 'application/json', 'Cookie': cookie})
        try:
            response = urlopen(req, timeout=5)
        except HTTPError as exc:
            response = exc
        with response:
            raw = response.read()
            assert response.status == expected, (path, response.status, raw)
            return (raw if path.endswith('.csv') or '.csv?' in path else json.loads(raw)), response.headers

    try:
        for attempt in range(100):
            try:
                call('session', expected=401)
                break
            except OSError:
                if attempt == 99:
                    raise
                time.sleep(.05)
        call('export/transactions.csv', expected=401)
        call('ledger/interpret', {'text': '昨天午饭花了48元'}, expected=401)
        call('login', {'password': 'incorrect'}, expected=401)
        _, headers = call('login', {'password': password})
        cookie = headers['Set-Cookie'].split(';')[0]
        today = datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
        def interpret(text):
            return call('ledger/interpret', {'text': text})[0]
        def transactions():
            return call('transactions')[0]['transactions']
        draft = interpret('今天午饭花了48.25元')
        assert draft['mode'] == 'create' and draft['fields']['amount'] == 48.25
        assert not transactions()
        call('transactions', draft['fields'], expected=201)
        income = interpret('今天收了300美元稿费')['fields']
        assert income['type'] == 'income' and income['currency'] == 'USD'
        call('transactions', income, expected=201)
        draft = interpret('把今天那笔午饭改成58元')
        assert draft['mode'] == 'edit' and len(draft['rows']) == 1 and draft['amount'] == 58
        old = draft['rows'][0]
        keys = 'occurred_on merchant category account_id type amount expense_amount principal_amount interest_amount currency note'.split()
        version = json.dumps([old[k] for k in keys], separators=(',', ':'), ensure_ascii=False)
        update = {'occurredOn': today, 'merchant': '午饭', 'category': '餐饮', 'type': 'expense',
                  'amount': 58, 'currency': 'CNY', 'version': version}
        call(f"transactions/{old['id']}", update, method='PUT')
        call(f"transactions/{old['id']}", update, method='PUT', expected=409)
        assert interpret('本月餐饮花了多少')['totals'][0]['amount'] == 58
        assert interpret('今天收支明细')['totals'] == [
            {'currency':'CNY','type':'expense','count':1,'amount':58},
            {'currency':'USD','type':'income','count':1,'amount':300}]

        text = f'日期,交易方,金额,类型,币种,备注\r\n{today},"=测试,店",2.25,支出,HKD,"含""引号""\r\n第二行"\r\n'
        payload = {'csv': text + text.split('\r\n', 1)[1], 'filename': '账单.csv'}
        assert call('import/preview', payload)[0]['importable'] == 2
        assert len(transactions()) == 2
        invalid = {'csv': text + '2026-02-30,坏日期,4,支出,HKD,\r\n'}
        call('import/commit', invalid, expected=400)
        assert len(transactions()) == 2
        assert call('import/commit', payload, expected=201)[0] == {'imported': 2, 'duplicates': 0}
        assert call('import/commit', payload, expected=201)[0] == {'imported': 0, 'duplicates': 2}
        raw, headers = call('export/transactions.csv')
        assert headers['Content-Disposition'].startswith('attachment') and headers['Cache-Control']=='no-store'
        csv_text = raw.decode('utf-8-sig')
        rows = list(csv.DictReader(io.StringIO(csv_text, newline='')))
        assert len(rows) == 4 and any(r['交易方'] == "'=测试,店" and r['备注'] == '含"引号"\r\n第二行' for r in rows)
        assert call('import/preview', {'csv': csv_text})[0]['duplicates'] == 4
        report, _ = call('export/report.csv?period=month')
        parsed = list(csv.DictReader(io.StringIO(report.decode('utf-8-sig'))))
        assert {r['币种'] for r in parsed} == {'CNY','USD','HKD'}
        assert call('reports?period=month&currency=USD')[0]['income'] == 300
        assert call('reports?period=month')[0]['income'] == 0
    finally:
        proc.terminate()
        proc.wait(timeout=5)

print('PASS password gate, authenticated ledger preview/create/query/edit, stale-write protection, CSV round-trip/deduplication/validation and currency-separated reports')
