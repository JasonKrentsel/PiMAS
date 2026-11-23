"""Snapshot a task and run a test through a separate Harbor Docker environment."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shlex
import time
import uuid
from pathlib import Path, PurePosixPath
from typing import Any, Callable

MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_OUTPUT = 100_000
TRANSFER_TIMEOUT = 300
MAX_BATCH_SECONDS = 900


async def _sample_memory(env: Any, metrics: dict[str, Any]) -> None:
    """Sample Docker's reported working set; this is not a kernel high-water mark."""
    try:
        listing = await env._run_docker_compose_command(['ps', '-q', 'main'], timeout_sec=15)
        container = (listing.stdout or '').strip().splitlines()[0]
        peak = 0.0
        while True:
            process = await asyncio.create_subprocess_exec('docker', 'stats', '--no-stream', '--format', '{{.MemUsage}}', container,
                                                           stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            try:
                output, _ = await asyncio.wait_for(process.communicate(), 15)
            except BaseException:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
                raise
            match = re.search(r'([\d.]+)\s*([KMGT]?i?B)', output.decode(errors='replace').split('/')[0], re.I)
            if match:
                units = {'b': 1, 'kb': 1000, 'mb': 1000**2, 'gb': 1000**3, 'tb': 1000**4,
                         'kib': 1024, 'mib': 1024**2, 'gib': 1024**3, 'tib': 1024**4}
                peak = max(peak, float(match.group(1)) * units[match.group(2).lower()])
                metrics['sampled_peak_memory_bytes'] = int(peak)
            await asyncio.sleep(1)
    except (IndexError, OSError, ValueError, RuntimeError):
        metrics['memory_unavailable'] = True


async def _main_image(env: Any) -> str:
    listing = await env._run_docker_compose_command(['ps', '-q', 'main'], timeout_sec=15)
    ids = (listing.stdout or '').split()
    if len(ids) != 1:
        raise RuntimeError('Could not identify exactly one main container')
    process = await asyncio.create_subprocess_exec('docker', 'inspect', '--format', '{{.Image}}', ids[0],
                                                   stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        output, error = await asyncio.wait_for(process.communicate(), 20)
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise
    if process.returncode or not output.strip():
        raise RuntimeError(f'Cannot inspect task image: {error.decode(errors="replace")[-1000:]}')
    return output.decode().strip()


def _path(value: str) -> str:
    path = PurePosixPath(value)
    if not path.is_absolute() or '..' in path.parts or str(path) == '/':
        raise ValueError(f"Snapshot path must be an absolute non-root path: {value!r}")
    resolved = str(path)
    if resolved == '/tmp' or any(resolved == p or resolved.startswith(p + '/') for p in ('/proc', '/sys', '/dev', '/run', '/logs', '/tmp/.pimas')):
        raise ValueError(f"Snapshot path is a runtime or Harbor path: {resolved}")
    return resolved


def _hash_file(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _configuration(raw: str) -> dict[str, Any]:
    value = json.loads(raw or '{}')
    if not isinstance(value, dict) or set(value) - {'paths', 'exclude', 'exports', 'max_bytes'}:
        raise ValueError('Verifier config accepts paths, exclude, exports, max_bytes')
    paths = value.get('paths', [])
    exclude = value.get('exclude', [])
    exports = value.get('exports', [])
    max_bytes = value.get('max_bytes', MAX_ARCHIVE_BYTES)
    if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
        raise ValueError('paths must be a list of absolute paths')
    if not isinstance(exclude, list) or not all(isinstance(p, str) and p and not p.startswith('-') for p in exclude):
        raise ValueError('exclude must be a list of tar exclusion patterns')
    if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or not 0 < max_bytes <= MAX_ARCHIVE_BYTES:
        raise ValueError(f'max_bytes must be between 1 and {MAX_ARCHIVE_BYTES}')
    if not isinstance(exports, list):
        raise ValueError('exports must be a list')
    for item in exports:
        if not isinstance(item, dict) or set(item) - {'service', 'export', 'path', 'import', 'target_service'}:
            raise ValueError('Each export accepts service, export, path, import, target_service')
        if not all(isinstance(item.get(k), str) and item[k] for k in ('export', 'path', 'import')):
            raise ValueError('Each export needs export, path, and import strings')
        _path(item['path'])
        if not all(item.get(k) is None or isinstance(item[k], str) for k in ('service', 'target_service')):
            raise ValueError('Service names must be strings')
    return {'paths': [_path(p) for p in paths], 'exclude': exclude, 'exports': exports, 'max_bytes': max_bytes}


def _check_compose(environment_dir: Path) -> None:
    """Reject compose configurations that might share host resources with the source."""
    files = [environment_dir / n for n in ('docker-compose.yaml', 'docker-compose.yml', 'compose.yaml', 'compose.yml')]
    files = [p for p in files if p.exists()]
    if not files:
        return
    import yaml
    for file in files:
        data = yaml.safe_load(file.read_text()) or {}
        if not isinstance(data, dict) or any(data.get(x) for x in ('include', 'extends')):
            raise ValueError('Unsupported compose definition for independent verification')
        for group in ('volumes', 'networks'):
            for config in (data.get(group) or {}).values():
                if config and (config.get('external') or config.get('name') or config.get('driver_opts')):
                    raise ValueError(f'Compose {group} uses shared or external resources')
        for service in (data.get('services') or {}).values():
            if any(service.get(x) for x in ('container_name', 'ports', 'privileged', 'extends', 'volumes_from', 'devices')):
                raise ValueError('Compose service uses host/shared resources')
            if service.get('network_mode') or service.get('pid') or service.get('ipc'):
                raise ValueError('Compose service uses shared namespaces')
            for mount in service.get('volumes') or []:
                if isinstance(mount, dict):
                    if mount.get('type') != 'volume' or not mount.get('source'):
                        raise ValueError('Compose bind or anonymous mounts are unsupported')
                elif isinstance(mount, str):
                    source = mount.split(':', 1)[0]
                    if ':' not in mount or source.startswith(('.', '/', '~', '$')):
                        raise ValueError('Compose bind or anonymous mounts are unsupported')
                else:
                    raise ValueError('Unsupported compose mount')


def harbor_environment(source: Any, session_id: str) -> Any:
    from harbor.environments.factory import EnvironmentFactory
    from harbor.models.environment_type import EnvironmentType
    if str(source.type().value) != 'docker':
        raise ValueError('On-demand verification currently requires Harbor Docker')
    if getattr(source, 'extra_docker_compose_paths', []):
        raise ValueError('Compose overlays are unsupported for independent verification')
    _check_compose(source.environment_dir)
    return EnvironmentFactory.create_environment(
        type=EnvironmentType.DOCKER, environment_dir=source.environment_dir,
        environment_name=source.environment_name, session_id=session_id,
        trial_paths=source.trial_paths, task_env_config=source.task_env_config,
        logger=source.logger, auto_mounting=False, auto_mounts=[], mounts=[],
        network_policy=source.network_policy,
    )


class VerificationManager:
    def __init__(self, source: Any, state: Path, cwd: str, *, config: str = '', offline: bool = False,
                 factory: Callable[[Any, str], Any] = harbor_environment):
        self.source = source
        self.state = state / 'verification'
        self.cwd = cwd
        self.config = _configuration(config)
        self.offline = offline
        self.factory = factory
        self.previous: Any = None
        self.lock = asyncio.Lock()
        self.count = 0

    async def _checked(self, env: Any, command: str, *, timeout: int = TRANSFER_TIMEOUT, service: str | None = None) -> Any:
        if service is None:
            result = await env.exec(command, timeout_sec=timeout)
        else:
            result = await env.service_exec(command, service=service, timeout_sec=timeout)
        if result.return_code != 0:
            raise RuntimeError(f'Command failed ({result.return_code}): {(result.stderr or result.stdout or "")[-2000:]}')
        return result

    async def verify(self, request: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            self.count += 1
            run_id = f'{self.count:03d}-{uuid.uuid4().hex[:8]}'
            folder = self.state / run_id
            folder.mkdir(parents=True, exist_ok=True)
            began = time.monotonic()
            result: dict[str, Any] = {'id': run_id, 'status': 'inconclusive', 'request': request, 'metrics': {}}
            env = None
            memory_task: asyncio.Task[None] | None = None
            archive_remote = f'/tmp/.pimas-verifier-{uuid.uuid4().hex}.tar.gz'
            archive = folder / 'snapshot.tar.gz'
            exports: list[tuple[dict[str, Any], Path]] = []
            try:
                tests = request.get('tests')
                # Keep the single-command wire format for existing callers and the smoke test.
                if tests is None:
                    tests = [{'command': request.get('command'), 'timeout': request.get('timeout')}]
                if not isinstance(tests, list) or not tests:
                    raise ValueError('No test commands were provided')
                for test in tests:
                    if not isinstance(test, dict) or not isinstance(test.get('command'), str) or not test['command'].strip():
                        raise ValueError('Every test needs a non-empty command')
                    timeout = test.get('timeout')
                    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 1 <= timeout <= 3600:
                        raise ValueError('Invalid test timeout')
                self.cwd = _path(self.cwd)
                if self.previous is not None:
                    # Keep the task image: Harbor's stop(delete=True) also removes local images.
                    await self.previous._run_docker_compose_command(['down', '--volumes', '--remove-orphans'], timeout_sec=60)
                    await asyncio.wait_for(self.previous.stop(delete=False), 60)
                    self.previous = None
                requested_paths = request.get('paths') or []
                if not isinstance(requested_paths, list) or len(requested_paths) > 8 or not all(isinstance(p, str) for p in requested_paths):
                    raise ValueError('At most eight additional absolute paths may be requested')
                paths = list(dict.fromkeys([self.cwd, *self.config['paths'], *(_path(p) for p in requested_paths)]))
                if any(path != self.cwd and self.cwd.startswith(path + '/') for path in paths):
                    raise ValueError('An additional snapshot path cannot contain the working directory')
                await self._checked(self.source, f'test -d {shlex.quote(self.cwd)} && test ! -L {shlex.quote(self.cwd)}', timeout=30)
                for path in paths:
                    found = await self.source.exec(f'test -e {shlex.quote(path)} || test -L {shlex.quote(path)}', timeout_sec=30)
                    if found.return_code:
                        raise ValueError(f'Snapshot path does not exist: {path}')
                export_bytes = 0
                for i, item in enumerate(self.config['exports']):
                    await self._checked(self.source, item['export'], service=item.get('service'))
                    target = folder / f'export-{i}'
                    await asyncio.wait_for(self.source.service_download_file(item['path'], target, service=item.get('service')), TRANSFER_TIMEOUT)
                    export_bytes += target.stat().st_size
                    if export_bytes > self.config['max_bytes']:
                        raise ValueError('Database export exceeds snapshot size limit')
                    exports.append((item, target))
                # A requested path may have been excluded on the first attempt. Drop exclusions
                # on explicit retries so a missing file is actually included.
                exclusions = [] if requested_paths or self.config['paths'] else self.config['exclude']
                flags = ' '.join('--exclude=' + shlex.quote(p) for p in exclusions)
                operands = ' '.join(shlex.quote(p.lstrip('/')) for p in paths)
                snapshot_start = time.monotonic()
                await self._checked(self.source, f'tar -czf {shlex.quote(archive_remote)} {flags} -C / {operands}')
                size_result = await self._checked(self.source, f'wc -c < {shlex.quote(archive_remote)}', timeout=30)
                size = int((size_result.stdout or '').strip())
                if size + export_bytes > self.config['max_bytes']:
                    raise ValueError(f'Snapshot and exports are {size + export_bytes} bytes; limit is {self.config["max_bytes"]}')
                await asyncio.wait_for(self.source.download_file(archive_remote, archive), TRANSFER_TIMEOUT)
                archive_hash = _hash_file(archive)
                export_hashes = [{'path': item['path'], 'service': item.get('service'), 'sha256': _hash_file(target)} for item, target in exports]
                identity = hashlib.sha256(json.dumps({'archive': archive_hash, 'exports': export_hashes}, sort_keys=True).encode()).hexdigest()
                result['snapshot'] = {'paths': paths, 'exclude': exclusions, 'bytes': size, 'export_bytes': export_bytes,
                                      'archive_sha256': archive_hash, 'exports': export_hashes, 'sha256': identity}
                result['metrics']['snapshot_seconds'] = round(time.monotonic() - snapshot_start, 3)
                session_id = f'{self.source.session_id}__pimas_verify_{uuid.uuid4().hex[:8]}'
                result['environment'] = {'session_id': session_id}
                env = self.factory(self.source, session_id)
                self.previous = env
                start = time.monotonic()
                await asyncio.wait_for(env.start(force_build=False), TRANSFER_TIMEOUT)
                result['metrics']['startup_seconds'] = round(time.monotonic() - start, 3)
                if hasattr(self.source, '_run_docker_compose_command'):
                    original_image = await _main_image(self.source)
                    verifier_image = await _main_image(env)
                    result['environment']['source_image'] = original_image
                    result['environment']['verifier_image'] = verifier_image
                    if original_image != verifier_image:
                        raise ValueError('Source and verifier main container images differ')
                memory_task = asyncio.create_task(_sample_memory(env, result['metrics']))
                if self.offline:
                    from pimas_harbor.agent import _Offline
                    disconnected = _Offline(env)
                    try:
                        await disconnected.start()
                    except BaseException:
                        await disconnected.restore()
                        raise
                await asyncio.wait_for(env.upload_file(archive, archive_remote), TRANSFER_TIMEOUT)
                # Restore the same filesystem and exported state before each test.
                outside = [p for p in paths if p != self.cwd and not p.startswith(self.cwd + '/')]
                cleanup = ''.join(f' && rm -rf -- {shlex.quote(p)}' for p in outside)
                batch_start = time.monotonic()
                outcomes: list[dict[str, Any]] = []
                result['tests'] = outcomes
                async def run_test(test: dict[str, Any]) -> tuple[Any, float]:
                    await self._checked(env, f'mkdir -p {shlex.quote(self.cwd)} && find {shlex.quote(self.cwd)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {{}} +{cleanup} && tar -xzf {shlex.quote(archive_remote)} -C /')
                    for item, target in exports:
                        service = item.get('target_service')
                        await self._checked(env, f'mkdir -p {shlex.quote(str(PurePosixPath(item["path"]).parent))}', service=service)
                        if service:
                            await env._run_docker_compose_command(['cp', str(target), f'{service}:{item["path"]}'], timeout_sec=TRANSFER_TIMEOUT)
                        else:
                            await asyncio.wait_for(env.upload_file(target, item['path']), TRANSFER_TIMEOUT)
                        await self._checked(env, item['import'], service=service)
                    health = await self._checked(env, "command -v timeout >/dev/null && python3 -I -c 'import unittest; suite = unittest.TestSuite([unittest.FunctionTestCase(lambda: None)]); result = unittest.TextTestRunner(verbosity=2).run(suite); raise SystemExit(not result.wasSuccessful())'", timeout=15)
                    health_output = (health.stdout or '') + '\n' + (health.stderr or '')
                    if not re.search(r'Ran 1 test in [\d.]+s\s*\n\s*OK\b', health_output):
                        raise RuntimeError('Verifier health check returned an incomplete or unexpected result')
                    remaining = int(MAX_BATCH_SECONDS - (time.monotonic() - batch_start))
                    if remaining < 1:
                        raise TimeoutError('Not run: verification batch time limit reached.')
                    timeout = min(int(test['timeout']), remaining)
                    test_start = time.monotonic()
                    wrapped = f'timeout -k 5 {timeout} bash -c {shlex.quote(test["command"])}'
                    response = await env.exec(wrapped, cwd=self.cwd, timeout_sec=timeout + 30)
                    return response, round(time.monotonic() - test_start, 3)
                for test in tests:
                    outcome = {**test, 'status': 'inconclusive'}
                    outcomes.append(outcome)
                    if time.monotonic() - batch_start >= MAX_BATCH_SECONDS:
                        outcome['reason'] = 'Not run: verification batch time limit reached.'
                        continue
                    try:
                        remaining = MAX_BATCH_SECONDS - (time.monotonic() - batch_start)
                        response, duration = await asyncio.wait_for(run_test(test), timeout=remaining)
                        outcome.update(duration_seconds=duration, exit_code=response.return_code,
                                       stdout=(response.stdout or '')[-MAX_OUTPUT:], stderr=(response.stderr or '')[-MAX_OUTPUT:])
                        if response.return_code in (124, 125, 126, 127, 137):
                            outcome['reason'] = 'Test timed out or could not be started; inspect the output.'
                        else:
                            outcome['status'] = 'completed'
                    except asyncio.CancelledError:
                        outcome['reason'] = 'Verification cancelled.'
                        raise
                    except asyncio.TimeoutError:
                        outcome['reason'] = 'A setup, test, or batch time limit was reached.'
                    except Exception as error:
                        outcome['reason'] = f'{type(error).__name__}: {error}'
                result['metrics']['test_seconds'] = round(time.monotonic() - batch_start, 3)
                if all(outcome['status'] == 'completed' for outcome in outcomes):
                    result['status'] = 'completed'
                else:
                    result['reason'] = 'One or more test results are inconclusive.'
                if len(outcomes) == 1 and 'exit_code' in outcomes[0]:
                    result['test'] = {key: outcomes[0][key] for key in ('exit_code', 'stdout', 'stderr')}
            except asyncio.CancelledError:
                result['reason'] = 'Verification cancelled'
                raise
            except Exception as error:
                result['reason'] = f'{type(error).__name__}: {error}'
            finally:
                try:
                    await self.source.exec(f'rm -f {shlex.quote(archive_remote)}', timeout_sec=30)
                except Exception:
                    pass
                if memory_task:
                    memory_task.cancel()
                    await asyncio.gather(memory_task, return_exceptions=True)
                if env is not None:
                    try:
                        # Keep Harbor's compose configuration alive for later cleanup.
                        await env._run_docker_compose_command(['stop'], timeout_sec=60)
                    except Exception as error:
                        result['status'] = 'inconclusive'
                        result['reason'] = f'Could not stop verifier: {error}'
                result['metrics']['total_seconds'] = round(time.monotonic() - began, 3)
                (folder / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
                archive.unlink(missing_ok=True)
                for target in folder.glob('export-*'):
                    target.unlink(missing_ok=True)
            return result
