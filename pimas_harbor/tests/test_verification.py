import asyncio
import io
import json
import shlex
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from pimas_harbor.verification.manager import VerificationManager, _check_compose


def result(stdout='', stderr='', return_code=0):
    return SimpleNamespace(stdout=stdout, stderr=stderr, return_code=return_code)


class Source:
    session_id = 'trial-source'
    def __init__(self):
        self.files = {'/app/code.py': b'answer = 42\n', '/app/test_code.py': b'assert answer == 42\n', '/opt/fixture': b'fixture'}
        self.archives = {}
    async def exec(self, command, timeout_sec=None):
        words = shlex.split(command)
        if command.startswith('test -d '):
            return result(return_code=0 if any(p.startswith(words[2] + '/') for p in self.files) else 1)
        if command.startswith('test -e '):
            path = words[2]
            return result(return_code=0 if any(p == path or p.startswith(path + '/') for p in self.files) else 1)
        if command.startswith('tar -czf '):
            remote = words[2]
            paths = words[words.index('/') + 1:]
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w:gz') as tar:
                for name, content in self.files.items():
                    if any(name.lstrip('/') == p or name.lstrip('/').startswith(p + '/') for p in paths):
                        entry = tarfile.TarInfo(name.lstrip('/'))
                        entry.size = len(content)
                        tar.addfile(entry, io.BytesIO(content))
            self.archives[remote] = output.getvalue()
            return result()
        if command.startswith('wc -c '):
            return result(str(len(self.archives[words[-1]])))
        if command.startswith('rm -f '):
            self.archives.pop(words[-1], None)
            return result()
        raise AssertionError(command)
    async def download_file(self, source, target):
        Path(target).write_bytes(self.archives[source])

    async def service_exec(self, command, service=None, timeout_sec=None):
        self.export_command = (service, command)
        return result()

    async def service_download_file(self, source, target, service=None):
        Path(target).write_bytes(b'consistent database dump')


class Verifier:
    def __init__(self, name):
        self.name = name
        self.events = []
        self.files = {'/app/deleted.py': b'old baseline'}
        self.archive = b''
        self.test_exit = 0
    async def start(self, force_build):
        self.events.append('start')
    async def upload_file(self, source, target):
        self.archive = Path(source).read_bytes()
    async def exec(self, command, cwd=None, timeout_sec=None):
        if command.startswith('mkdir -p '):
            self.events.append('restore')
            self.files = {k: v for k, v in self.files.items() if not k.startswith('/app/')}
            with tarfile.open(fileobj=io.BytesIO(self.archive), mode='r:gz') as tar:
                for member in tar.getmembers():
                    self.files['/' + member.name] = tar.extractfile(member).read()
            return result()
        if command.startswith('command -v timeout'):
            self.events.append('health')
            return result(stderr='Ran 1 test in 0.000s\n\nOK\n')
        if command.startswith('timeout -k'):
            self.events.append('test')
            assert cwd == '/app'
            assert '/app/test_code.py' in self.files
            return result('test output', return_code=self.test_exit)
        raise AssertionError(command)
    async def _run_docker_compose_command(self, command, timeout_sec=None):
        self.events.append(' '.join(command))
        if command[0] == 'cp':
            self.database_dump = Path(command[1]).read_bytes()
        return result()
    async def service_exec(self, command, service=None, timeout_sec=None):
        self.events.append(f'{service}:{command}')
        return result()
    async def stop(self, delete):
        self.events.append(f'cleanup:{delete}')


class VerificationTest(unittest.IsolatedAsyncioTestCase):
    async def test_snapshots_relevant_files_and_cleans_old_container_on_next_request(self):
        source = Source()
        containers = []
        def factory(_source, name):
            container = Verifier(name)
            containers.append(container)
            return container
        with tempfile.TemporaryDirectory() as tmp:
            manager = VerificationManager(source, Path(tmp), '/app', factory=factory)
            request = {'command': 'python3 -m unittest test_code', 'timeout': 10}
            first = await manager.verify(request)
            self.assertEqual(first['status'], 'completed')
            self.assertEqual(first['test']['exit_code'], 0)
            self.assertEqual(containers[0].files, {'/app/code.py': b'answer = 42\n', '/app/test_code.py': b'assert answer == 42\n'})
            self.assertIn('stop', containers[0].events)
            self.assertNotIn('down --volumes --remove-orphans', containers[0].events)
            source.files['/app/code.py'] = b'answer = 43\n'
            second = await manager.verify({**request, 'paths': ['/opt/fixture']})
            self.assertEqual(second['status'], 'completed')
            self.assertNotEqual(first['snapshot']['sha256'], second['snapshot']['sha256'])
            self.assertEqual(containers[1].files['/opt/fixture'], b'fixture')
            self.assertEqual(containers[1].files['/app/code.py'], b'answer = 43\n')
            self.assertIn('down --volumes --remove-orphans', containers[0].events)
            self.assertIn('cleanup:False', containers[0].events)
            self.assertFalse(list(Path(tmp).rglob('snapshot.tar.gz')))
            self.assertEqual(len(list(Path(tmp).rglob('result.json'))), 2)

    async def test_failures_missing_paths_and_timeouts_are_not_passes(self):
        source = Source()
        containers = []
        def factory(_source, name):
            env = Verifier(name)
            env.test_exit = 124
            containers.append(env)
            return env
        with tempfile.TemporaryDirectory() as tmp:
            manager = VerificationManager(source, Path(tmp), '/app', factory=factory)
            missing = await manager.verify({'command': 'pytest', 'timeout': 10, 'paths': ['/not-found']})
            self.assertEqual(missing['status'], 'inconclusive')
            self.assertEqual(len(containers), 0)
            invalid = await manager.verify({'command': 'pytest', 'timeout': 10, 'paths': ['/proc/self']})
            self.assertEqual(invalid['status'], 'inconclusive')
            timed = await manager.verify({'command': 'pytest', 'timeout': 10})
            self.assertEqual(timed['status'], 'inconclusive')
            self.assertEqual(timed['test']['exit_code'], 124)
            self.assertIn('stop', containers[0].events)

    async def test_snapshot_size_limit_is_enforced_before_download(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = VerificationManager(Source(), Path(tmp), '/app', config=json.dumps({'max_bytes': 1}), factory=lambda *_: self.fail('must not start'))
            reply = await manager.verify({'command': 'pytest', 'timeout': 10})
            self.assertEqual(reply['status'], 'inconclusive')
            self.assertIn('limit', reply['reason'])

    async def test_all_failed_commands_run_in_one_verifier_from_restored_snapshot(self):
        source = Source()
        containers = []
        class BatchVerifier(Verifier):
            async def exec(self, command, cwd=None, timeout_sec=None):
                if command.startswith('timeout -k'):
                    self.events.append('test')
                    self.assert_clean()
                    index = self.events.count('test')
                    self.files['/app/code.py'] = b'modified by test'
                    return result(f'result {index}', return_code=[1, 124, 0][index - 1])
                return await super().exec(command, cwd=cwd, timeout_sec=timeout_sec)
            def assert_clean(self):
                if self.files['/app/code.py'] != b'answer = 42\n':
                    raise AssertionError('Previous test modified the next test snapshot')
        def factory(_source, name):
            env = BatchVerifier(name)
            containers.append(env)
            return env
        tests = [
            {'stageId': 'execute', 'toolCallId': f'test-{index}', 'command': f'pytest test_{index}.py', 'timeout': 10}
            for index in range(3)
        ]
        with tempfile.TemporaryDirectory() as tmp:
            manager = VerificationManager(source, Path(tmp), '/app', factory=factory)
            reply = await manager.verify({'tests': tests})
            self.assertEqual(reply['status'], 'inconclusive')
            self.assertEqual([row['status'] for row in reply['tests']], ['completed', 'inconclusive', 'completed'])
            self.assertEqual([row['exit_code'] for row in reply['tests']], [1, 124, 0])
            self.assertEqual(len(containers), 1)
            self.assertEqual(containers[0].events.count('restore'), 3)
            self.assertEqual(containers[0].events.count('test'), 3)
            self.assertEqual(containers[0].events.count('stop'), 1)

    async def test_batch_limit_lists_every_unrun_command(self):
        containers = []
        def factory(_source, name):
            env = Verifier(name)
            containers.append(env)
            return env
        tests = [{'command': f'pytest test_{index}.py', 'timeout': 10} for index in range(2)]
        with tempfile.TemporaryDirectory() as tmp:
            manager = VerificationManager(Source(), Path(tmp), '/app', factory=factory)
            with patch('pimas_harbor.verification.manager.MAX_BATCH_SECONDS', 0):
                reply = await manager.verify({'tests': tests})
            self.assertEqual(reply['status'], 'inconclusive')
            self.assertEqual(len(reply['tests']), 2)
            self.assertTrue(all('Not run' in test['reason'] for test in reply['tests']))
            self.assertNotIn('test', containers[0].events)

    async def test_database_export_is_restored_to_separate_service(self):
        source = Source()
        containers = []
        def factory(_source, name):
            env = Verifier(name)
            containers.append(env)
            return env
        config = {'exports': [{'service': 'db', 'export': 'dump database', 'path': '/tmp/db.dump',
                               'target_service': 'db', 'import': 'restore database'}]}
        with tempfile.TemporaryDirectory() as tmp:
            manager = VerificationManager(source, Path(tmp), '/app', config=json.dumps(config), factory=factory)
            reply = await manager.verify({'command': 'pytest', 'timeout': 10})
            self.assertEqual(reply['status'], 'completed', reply)
            self.assertEqual(source.export_command, ('db', 'dump database'))
            self.assertEqual(containers[0].database_dump, b'consistent database dump')
            self.assertIn('db:restore database', containers[0].events)
            self.assertEqual(reply['snapshot']['exports'][0]['service'], 'db')
            self.assertFalse(list(Path(tmp).rglob('export-*')))

    def test_compose_rejects_shared_resources(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'docker-compose.yaml'
            file.write_text('services:\n  main:\n    volumes:\n      - /host/data:/data\n')
            with self.assertRaisesRegex(ValueError, 'bind'):
                _check_compose(Path(tmp))
            file.write_text('services:\n  main:\n    volumes:\n      - data:/data\n  db:\n    image: postgres\nvolumes:\n  data: {}\n')
            _check_compose(Path(tmp))


class DockerSmokeTest(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(__import__('os').environ.get('PIMAS_DOCKER_SMOKE') == '1', 'set PIMAS_DOCKER_SMOKE=1 for a real Harbor Docker smoke test')
    async def test_real_container_rechecks_test_after_simulated_false_failure(self):
        from harbor.environments.factory import EnvironmentFactory
        from harbor.models.environment_type import EnvironmentType
        from harbor.models.task.config import EnvironmentConfig
        from harbor.models.trial.paths import TrialPaths
        import uuid
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_dir = root / 'environment'
            env_dir.mkdir()
            (env_dir / 'Dockerfile').write_text('FROM python:3.12-slim\nWORKDIR /app\n')
            trial = root / 'trial'
            trial.mkdir()
            source = EnvironmentFactory.create_environment(
                type=EnvironmentType.DOCKER, environment_dir=env_dir, environment_name='pimas-verifier-smoke',
                session_id=f'pimas-smoke-{uuid.uuid4().hex[:8]}', trial_paths=TrialPaths(trial),
                task_env_config=EnvironmentConfig(cpus=1, memory_mb=512, workdir='/app'), auto_mounts=[], auto_mounting=False)
            manager = None
            try:
                await source.start(force_build=False)
                seed = await source.exec("printf 'import unittest\\nclass T(unittest.TestCase):\\n def test_pass(self): self.assertTrue(True)\\n def test_failure(self): self.fail(\"expected failure\")\\n' > /app/test_pass.py", timeout_sec=20)
                self.assertEqual(seed.return_code, 0)
                manager = VerificationManager(source, trial, '/app')
                # Simulates a tool that reported failure; the real task file is correct.
                actual = await manager.verify({'tests': [
                    {'command': 'sleep 2; python3 -m unittest -v test_pass.T.test_pass', 'timeout': 20},
                    {'command': 'python3 -m unittest -v test_pass.T.test_failure', 'timeout': 20},
                ]})
                self.assertEqual(actual['status'], 'completed', actual)
                self.assertEqual([test['exit_code'] for test in actual['tests']], [0, 1], actual)
                self.assertIn('OK', actual['tests'][0]['stderr'])
                self.assertIn('expected failure', actual['tests'][1]['stderr'])
                print('Real-container verifier measurements:', json.dumps({'snapshot': actual['snapshot'], 'metrics': actual['metrics']}))
            finally:
                if manager and manager.previous:
                    await manager.previous._run_docker_compose_command(['down', '--volumes', '--remove-orphans'])
                    await manager.previous.stop(delete=False)
                await source.stop(delete=False)


if __name__ == '__main__':
    unittest.main()
