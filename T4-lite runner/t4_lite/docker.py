"""Docker command lines and the container session the runner drives."""
from __future__ import annotations

import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

from .core import Invalid

DEFAULT_EXEC_TIMEOUT = 900
ARTIFACT_COPY_TIMEOUT_SEC = 300
CLEANUP_TIMEOUT_SEC = 300


def task_command(*, name: str, image: str, cpus: float, memory_mb: int, mounts=()) -> list[str]:
    args = ["docker", "run", "-d", "--name", name, "--cpus", str(cpus), "--memory", f"{int(memory_mb)}m",
            "--entrypoint", "sleep"]
    for source, target, readonly in mounts:
        args += ["--mount", f"type=bind,source={source},target={target}" + (",readonly" if readonly else "")]
    return [*args, image, "infinity"]


def compose_override(image: str, cpus: float, memory_mb: int, mounts=()) -> str:
    """Image, manifest CPU and memory, and a command that keeps `main` running.

    A python image with no CMD exits as soon as `docker compose up -d` has no terminal.
    The payments and live-database-cutover entrypoints ignore a passed command and wait themselves.
    """
    text = (
        "services:\n"
        "  main:\n"
        f"    image: \"{image}\"\n"
        f"    cpus: {cpus:g}\n"
        f"    mem_limit: {int(memory_mb)}m\n"
        "    command: [\"sleep\", \"infinity\"]\n"
    )
    if mounts:
        text += "    volumes:\n"
        for source, target, readonly in mounts:
            text += (f"      - type: bind\n        source: {json.dumps(str(source))}\n"
                     f"        target: {json.dumps(target)}\n        read_only: {str(readonly).lower()}\n")
    return text


def artifact_origin(artifact) -> tuple[str, str]:
    if isinstance(artifact, str):
        return "main", artifact
    return artifact.get("service", "main"), artifact["source"]


def _archive_target(path: str) -> tuple[str, str]:
    """Container path to archive, and the verifier directory that receives the tar.

    `/app` is the directory itself. Streaming `/app/.` into `/app` copies its
    contents. Streaming `/app` into `/app` would nest a second `app` directory.
    """
    path = path.rstrip("/")
    if path == "/app":
        return "/app/.", "/app"
    return path, path.rpartition("/")[0] or "/"


def stream_copy_commands(container: str, verifier: str, path: str) -> tuple[list[str], list[str]]:
    """`docker cp` argv pair. Stdout of the first is stdin of the second."""
    source, parent = _archive_target(path)
    return (
        ["docker", "cp", f"{container}:{source}", "-"],
        ["docker", "cp", "-", f"{verifier}:{parent}"],
    )


def _docker(args: list[str], timeout: float | None = None, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    # subprocess.run raises TimeoutExpired before it inspects returncode, including when check is false.
    try:
        completed = subprocess.run(args, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise Invalid(f"Docker command timed out: {args[0:4]}") from error
    except FileNotFoundError as error:
        raise Invalid("Docker is not on PATH") from error
    if check and completed.returncode != 0:
        detail = completed.stderr.decode(errors="replace")[-2000:]
        raise Invalid(detail or f"Docker command failed: {' '.join(args[:6])}")
    return completed


def prepare_docker(images, run=None) -> None:
    """Require a live daemon, then inspect each image once and pull any that are missing."""
    docker = run or _docker
    docker(["docker", "version"])
    for image in dict.fromkeys(images):
        if docker(["docker", "image", "inspect", image], check=False).returncode != 0:
            docker(["docker", "pull", image])


def _pipe_docker(src_cmd: list[str], dst_cmd: list[str],
                 timeout: float = ARTIFACT_COPY_TIMEOUT_SEC) -> tuple[int, int]:
    """Run `src | dst` and return both exit codes. TimeoutExpired kills both."""
    procs = [subprocess.Popen(src_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)]
    try:
        procs.append(subprocess.Popen(dst_cmd, stdin=procs[0].stdout,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        procs[0].stdout.close()
        end = time.monotonic() + timeout
        return tuple(proc.wait(timeout=max(0.0, end - time.monotonic())) for proc in procs)
    finally:
        for proc in procs:
            if proc.poll() is None:
                proc.kill()
                proc.wait()


class DockerSession:
    """One task container, a host harness process, then a verifier container."""

    def __init__(self, *, mounts=()) -> None:
        self.mounts = tuple(mounts)
        self.work: Path | None = None
        self.layout = None
        self.project = ""
        self.task_name = ""
        self.verifier_name = ""
        self.proc: subprocess.Popen[str] | None = None
        self.stderr = ""
        self.copy_failures: list[str] = []
        self.deadline: float | None = None
        self._compose: list[str] = []
        self._cleanup: list[list[str]] = []
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._readers: list[threading.Thread] = []

    def open(self, layout) -> None:
        self.layout = layout
        self.work = Path(tempfile.mkdtemp(prefix="t4-"))
        self.project = f"t4{uuid.uuid4().hex[:10]}"
        if layout.compose:
            self._open_compose(layout)
        else:
            self.task_name = f"{self.project}-task"
            _docker(task_command(name=self.task_name, image=layout.image, cpus=layout.cpus,
                                 memory_mb=layout.memory_mb, mounts=self.mounts))
            self._cleanup.append(["docker", "rm", "-f", self.task_name])

    def _open_compose(self, layout) -> None:
        # The override pins the manifest image and supplies sleep infinity because some mains (heat-pump) inherit python and exit.
        override = self.work / "override.yml"
        override.write_text(compose_override(layout.image, layout.cpus, layout.memory_mb, self.mounts), encoding="utf-8")
        self._compose = ["docker", "compose", "-p", self.project, "-f", str(layout.compose), "-f", str(override)]
        self._cleanup.append([*self._compose, "down", "--volumes"])
        _docker([*self._compose, "up", "-d"])

    def spawn_harness(self, harness) -> None:
        kwargs: dict = {}
        # Windows kills the tree with taskkill /T. Other platforms signal the new session.
        if sys.platform != "win32":
            kwargs["start_new_session"] = True
        self.proc = subprocess.Popen(
            list(harness.command), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", env={**os.environ, **dict(harness.env)}, **kwargs)
        proc = self.proc

        def read_stderr() -> None:
            try:
                self.stderr = proc.stderr.read()
            except (OSError, ValueError):
                pass

        def read_stdout() -> None:
            try:
                for line in proc.stdout:
                    self._lines.put(line)
            except (OSError, ValueError):
                pass
            finally:
                self._lines.put(None)

        self._readers = [threading.Thread(target=target, daemon=True) for target in (read_stderr, read_stdout)]
        for reader in self._readers:
            reader.start()

    def arm_deadline(self, deadline: float) -> None:
        self.deadline = deadline

    def read_line(self) -> str | None:
        if self.proc is None:
            return None
        timeout = None
        if self.deadline is not None:
            timeout = self.deadline - time.monotonic()
            if timeout <= 0:
                return None
        try:
            line = self._lines.get(timeout=timeout)
        except queue.Empty:
            return None
        return line or None

    def write(self, message: dict) -> None:
        if self.proc is None or self.proc.stdin is None:
            raise Invalid("Harness is not running")
        self.proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def exec_args(self, command: str, timeout: float, background: bool) -> list[str]:
        # -k 10 follows TERM with KILL so a command that ignores TERM still returns.
        inner = command if background else f"timeout -k 10 {max(1, int(timeout))} sh -c {_quote(command)}"
        if self.layout.compose:
            prefix, container = [*self._compose, "exec", "-T"], "main"
        else:
            prefix, container = ["docker", "exec"], self.task_name
        return [*prefix, *(["-d"] if background else []), "-w", "/app", container, "sh", "-c", inner]

    def execute(self, command: str, timeout: float, background: bool) -> tuple[int, str, str]:
        args = self.exec_args(command, timeout, background)
        completed = _docker(args, timeout=None if background else timeout + 30, check=False)
        return completed.returncode, completed.stdout.decode(errors="replace"), completed.stderr.decode(errors="replace")

    def grade(self) -> tuple[bytes | None, bytes | None, bytes | None, bytes]:
        """Run the verifier. Raw reward, ctrf, and trace bytes (None when absent), then the log."""
        self.stop_harness()
        for item in self.layout.collect:
            self._service_exec(item["service"], item["command"], float(item.get("timeout_sec") or 60))
        self.verifier_name = f"{self.project}-verifier"
        args = ["docker", "run", "-d", "--name", self.verifier_name,
                "--cpus", str(self.layout.verifier_cpus), "--memory", f"{int(self.layout.verifier_memory_mb)}m",
                "--entrypoint", "sleep"]
        for key, value in self.layout.verifier_env.items():
            args.extend(["-e", f"{key}={value}"])
        args.extend([self.layout.verifier_image, "infinity"])
        _docker(args)
        self._cleanup.append(["docker", "rm", "-f", self.verifier_name])
        # Harbor mounts /logs/verifier writable for every uid; live-database-cutover's verifier logs there as
        # `postgres`. Verifiers that run agent code as `nobody` chmod it to 700 themselves first.
        _docker(["docker", "exec", self.verifier_name, "sh", "-c",
                 "mkdir -p /app /logs/verifier && chmod 777 /logs/verifier"])
        for artifact in self.layout.artifacts:
            self._copy_artifact(artifact)
        limit = max(1, int(self.layout.verifier_timeout))
        completed = _docker(["docker", "exec", self.verifier_name, "timeout", str(limit), "bash", "/tests/test.sh"],
                            timeout=limit + 60, check=False)
        log = completed.stdout + b"\n" + completed.stderr
        return (self._copy_out("/logs/verifier/reward.txt"), self._copy_out("/logs/verifier/ctrf.json"),
                self._copy_out("/logs/verifier/trace_results.json"), log)

    def _copy_artifact(self, artifact) -> None:
        service, path = artifact_origin(artifact)
        container = self._container(service)
        if not container:
            self.copy_failures.append(path)
            return
        _source, parent = _archive_target(path)
        _docker(["docker", "exec", self.verifier_name, "mkdir", "-p", parent], check=False)
        src_cmd, dst_cmd = stream_copy_commands(container, self.verifier_name, path)
        try:
            src_rc, dst_rc = _pipe_docker(src_cmd, dst_cmd)
        except subprocess.TimeoutExpired:
            self.copy_failures.append(path)
            return
        if src_rc != 0 or dst_rc != 0:
            self.copy_failures.append(path)

    def _container(self, service: str) -> str | None:
        if self.layout.compose:
            identity = _docker([*self._compose, "ps", "-q", service], check=False)
            container = identity.stdout.decode().strip()
            return container or None
        return self.task_name if service == "main" else None

    def _service_exec(self, service: str, command: str, timeout: float) -> None:
        if self.layout.compose:
            args = [*self._compose, "exec", "-T"]
            if service == "main":
                args.extend(["-w", "/app"])
            args.extend([service, "sh", "-c", command])
        else:
            args = ["docker", "exec", self.task_name, "sh", "-c", command]
        _docker(args, timeout=timeout + 30, check=False)

    def _copy_out(self, path: str) -> bytes | None:
        """File bytes from the verifier, `b""` for an empty file, None when it is absent."""
        destination = self.work / "out" / Path(path).name
        destination.parent.mkdir(parents=True, exist_ok=True)
        copied = _docker(["docker", "cp", f"{self.verifier_name}:{path}", str(destination)], check=False)
        if copied.returncode != 0 or not destination.is_file():
            return None
        return destination.read_bytes()

    def harness_running(self) -> bool:
        proc = self.proc
        return proc is not None and proc.poll() is None

    def stop_harness(self) -> None:
        proc = self.proc
        try:
            if proc is not None and proc.poll() is None:
                self._terminate_tree(proc)
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired as error:
                    raise Invalid("Harness did not exit after the agent timeout") from error
        finally:
            self._drain_harness_output(proc)

    def _drain_harness_output(self, proc: subprocess.Popen | None) -> None:
        for reader in self._readers:
            reader.join(timeout=5)
        if proc is not None:
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    pipe.close()
                except (OSError, ValueError):
                    pass

    def _terminate_tree(self, proc: subprocess.Popen) -> None:
        """Kill the harness and its children. On Windows, taskkill /T is the whole tree."""
        if proc.stdin is not None:
            try:
                proc.stdin.close()
            except Exception:
                pass
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            if proc.poll() is None:
                proc.kill()
            return
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            proc.kill()

    def close(self) -> None:
        """Stop the harness; containers and the temp directory are removed even if that raises."""
        try:
            self.stop_harness()
        finally:
            self._remove_task_resources()

    def _remove_task_resources(self) -> None:
        """Run every cleanup command (newest first), delete the temp dir, then raise if any failed."""
        failures: list[str] = []
        for args in reversed(self._cleanup):
            try:
                _docker(args, timeout=CLEANUP_TIMEOUT_SEC, check=False)
            except Exception as error:
                failures.append(str(error))
        self._cleanup.clear()
        work, self.work = self.work, None
        if work is not None:
            shutil.rmtree(work, ignore_errors=True)
        if failures:
            raise Invalid("Docker cleanup failed: " + "; ".join(failures))


def _quote(command: str) -> str:
    return "'" + command.replace("'", "'\"'\"'") + "'"
