#!/usr/bin/env python3
"""Pull only the current main commit after its trusted push CI succeeds."""
import datetime
from contextlib import closing
import fcntl
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

REPO = 'jiaqiang-coder/finance-management'
APP = Path('/opt/hengzi-app')
STATE = Path('/opt/hengzi-deploy')
BACKUPS = Path('/opt/hengzi-backups')
FILES = ('server.js', 'public/app.js', 'public/index.html', 'public/login.html')
CONTAINER = 'hengzi-fm'


def log(message):
    print(datetime.datetime.now(datetime.timezone.utc).isoformat(), message, flush=True)


def request(url, limit=16_000_000, timeout=25):
    req = urllib.request.Request(url, headers={'User-Agent': 'hengzi-deploy/1', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        body = response.read(limit + 1)
        if len(body) > limit:
            raise RuntimeError('Download exceeds size limit')
        return body


def github(path):
    return json.loads(request('https://api.github.com/repos/' + REPO + '/' + path))


def select_candidate(head, runs):
    if not re.fullmatch(r'[a-f0-9]{40}', head):
        raise RuntimeError('Invalid commit SHA')
    for run in runs:
        if (run.get('head_sha') == head and run.get('head_branch') == 'main'
                and run.get('event') == 'push' and run.get('status') == 'completed'
                and run.get('conclusion') == 'success'):
            return head
        # The latest run for this commit must pass; do not fall back to an older success.
        if run.get('head_sha') == head:
            return None
    return None


def extract_release(archive):
    result = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        for member in tar:
            name = member.name.split('/', 1)[1] if '/' in member.name else ''
            if name not in (*FILES, 'package.json'):
                continue
            if not member.isfile() or member.size > 2_000_000 or name in result:
                raise RuntimeError('Invalid release member: ' + name)
            result[name] = tar.extractfile(member).read()
    if any(name not in result for name in (*FILES, 'package.json')):
        raise RuntimeError('Release is missing required application files')
    package = json.loads(result['package.json'])
    if package.get('dependencies'):
        raise RuntimeError('New npm runtime dependencies require a deployment configuration update')
    for name in FILES:
        result[name].decode('utf-8')
    return {name: result[name] for name in FILES}


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('Docker operation failed: ' + args[0])
    return result.stdout


def check_mounts():
    mounts = json.loads(docker('inspect', CONTAINER, '--format', '{{json .Mounts}}'))
    mapping = {m['Destination']: m['Source'] for m in mounts if m['Type'] == 'bind'}
    if mapping.get('/app') != str(APP) or mapping.get('/app/data') != str(APP / 'data'):
        raise RuntimeError('Unexpected application/data mount; refusing deployment')


def healthy(expected_js=None):
    try:
        login = request('http://127.0.0.1:4173/app/fm/login.html', timeout=2)
        if b'password' not in login:
            return False
        if expected_js is not None:
            actual = request('http://127.0.0.1:4173/app/fm/app.js', timeout=2)
            if hashlib.sha256(actual).digest() != hashlib.sha256(expected_js).digest():
                return False
        try:
            request('http://127.0.0.1:4173/app/fm/api/summary', timeout=2)
            return False
        except urllib.error.HTTPError as error:
            return error.code == 401
    except (OSError, urllib.error.URLError):
        return False


def wait_healthy(expected_js=None):
    for _ in range(20):
        if healthy(expected_js):
            return True
        time.sleep(1)
    return False


def deploy(sha, release):
    check_mounts()
    if not (APP / 'data/hengzi.db').is_file():
        raise RuntimeError('Persistent database is missing')
    BACKUPS.mkdir(parents=True, exist_ok=True, mode=0o700)
    BACKUPS.chmod(0o700)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = BACKUPS / (stamp + '-' + sha[:12])
    backup.mkdir(mode=0o700)
    for name in FILES:
        target = backup / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(APP / name, target)
    docker('stop', CONTAINER)
    try:
        with closing(sqlite3.connect('file:' + str(APP / 'data/hengzi.db') + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(backup / 'hengzi.db')) as dest:
                source.backup(dest)
        # Write within the existing mount, preserving its directory inode and all data/config.
        for name, body in release.items():
            target = APP / name
            target.write_bytes(body)
            target.chmod(0o644)
        docker('start', CONTAINER)
        if not wait_healthy(release['public/app.js']):
            raise RuntimeError('New version failed health checks')
    except Exception:
        docker('stop', CONTAINER)
        for name in FILES:
            shutil.copy2(backup / name, APP / name)
        docker('start', CONTAINER)
        if not wait_healthy():
            log('ROLLBACK NEEDS ATTENTION; database backup: ' + str(backup))
        # Never overwrite a database that could contain new user records.
        raise
    state = {'commit': sha, 'deployed_at': stamp, 'backup': str(backup)}
    temporary = STATE / 'deployed.tmp'
    temporary.write_text(json.dumps(state, indent=2))
    temporary.replace(STATE / 'deployed.json')
    log('DEPLOYED ' + sha)


def main():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / 'lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log('Another deployment is running; skipped')
            return
        head = github('git/ref/heads/main')['object']['sha']
        statefile = STATE / 'deployed.json'
        if statefile.exists() and json.loads(statefile.read_text()).get('commit') == head:
            log('UP TO DATE ' + head)
            return
        runs = github('actions/workflows/ci.yml/runs?branch=main&event=push&per_page=5').get('workflow_runs', [])
        if not select_candidate(head, runs):
            log('WAITING: current main has no successful push CI: ' + head)
            return
        archive = request('https://codeload.github.com/' + REPO + '/tar.gz/' + head)
        release = extract_release(archive)
        # Recheck after download; a newer push must get its own successful CI.
        if github('git/ref/heads/main')['object']['sha'] != head:
            log('Main changed during download; skipped')
            return
        deploy(head, release)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        log('FAILED: ' + str(error))
        raise SystemExit(1)
