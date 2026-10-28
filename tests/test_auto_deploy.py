from pathlib import Path
import importlib.util
import io
import json
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).resolve().parents[1] / 'scripts/auto-deploy.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
SHA = 'a' * 40


def archive(extra=None):
    entries = {name: b'new ' + name.encode() for name in agent.FILES}
    entries['package.json'] = b'{"dependencies":{}}'
    entries.update(extra or {})
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w:gz') as tar:
        for name, body in entries.items():
            info = tarfile.TarInfo('repo-sha/' + name)
            info.size = len(body)
            tar.addfile(info, io.BytesIO(body))
    return out.getvalue()


class DeployTests(unittest.TestCase):
    def test_requires_current_main_success_and_latest_run(self):
        success = dict(head_sha=SHA, head_branch='main', event='push', status='completed', conclusion='success')
        self.assertEqual(agent.select_candidate(SHA, [success]), SHA)
        for delta in [dict(head_sha='b'*40), dict(head_branch='feature'), dict(event='pull_request'), dict(status='in_progress'), dict(conclusion='failure')]:
            self.assertIsNone(agent.select_candidate(SHA, [{**success, **delta}]))
        self.assertIsNone(agent.select_candidate(SHA, [{**success, 'conclusion':'failure'}, success]))

    def test_archive_cannot_overwrite_data_credentials_or_other_apps(self):
        release = agent.extract_release(archive({'data/hengzi.db': b'bad', '../caddy/Caddyfile': b'bad', '.env': b'bad'}))
        self.assertEqual(set(release), set(agent.FILES))
        with self.assertRaises(RuntimeError):
            agent.extract_release(archive({'package.json': b'{"dependencies":{"unexpected":"1"}}'}))

    def test_bad_mount_is_rejected(self):
        with patch.object(agent, 'docker', return_value='[]'):
            with self.assertRaises(RuntimeError):
                agent.check_mounts()

    def run_deployment(self, fail=False):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            app, state, backups = base/'app', base/'state', base/'backups'
            app.mkdir(); state.mkdir(); (app/'data').mkdir()
            original = {}
            for name in agent.FILES:
                f = app/name; f.parent.mkdir(exist_ok=True, parents=True)
                original[name] = ('old '+name).encode(); f.write_bytes(original[name])
            with sqlite3.connect(app/'data/hengzi.db') as db:
                db.execute('CREATE TABLE records(value TEXT)'); db.execute("INSERT INTO records VALUES ('preserved')")
            release = agent.extract_release(archive())
            calls = []
            def docker(*args):
                calls.append(args)
                return ''
            with patch.multiple(agent, APP=app, STATE=state, BACKUPS=backups), patch.object(agent, 'check_mounts'), patch.object(agent, 'docker', side_effect=docker), patch.object(agent, 'wait_healthy', side_effect=[False, True] if fail else [True]):
                if fail:
                    with self.assertRaises(RuntimeError): agent.deploy(SHA, release)
                    self.assertFalse((state/'deployed.json').exists())
                else:
                    agent.deploy(SHA, release)
                    self.assertEqual(json.loads((state/'deployed.json').read_text())['commit'], SHA)
            for name in agent.FILES:
                self.assertEqual((app/name).read_bytes(), original[name] if fail else release[name])
            with sqlite3.connect(app/'data/hengzi.db') as db:
                self.assertEqual(db.execute('SELECT value FROM records').fetchone()[0], 'preserved')
            self.assertEqual(len(list(backups.glob('*/hengzi.db'))), 1)
            self.assertTrue(all(call[1] == 'hengzi-fm' for call in calls))

    def test_success_preserves_database_and_only_restarts_hengzi(self):
        self.run_deployment()

    def test_failure_restores_code_preserves_database_and_commit_marker(self):
        self.run_deployment(fail=True)


if __name__ == '__main__':
    unittest.main()
