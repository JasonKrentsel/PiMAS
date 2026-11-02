"""Harbor agent that runs the PiMAS pipeline on the host and its tools in the task container.

Usage (from the repository root, with Harbor installed):

    PYTHONPATH=. harbor run -d terminal-bench/terminal-bench@4.0.0 \
        --agent pimas_harbor.agent:PimasAgent -m Qwen/Qwen3.8-27B \
        --ae PIMAS_MODE=pipeline --ae PIMAS_REVIEW=0

Configuration comes from agent environment variables (``--ae KEY=VALUE``) or the host
environment:

    PIMAS_ROOT             PiMAS checkout (default: ../PiMAS beside this package)
    PIMAS_MODELS           Pi models.json (default: config/pipeline/models.json)
    PIMAS_AGENTS           role profiles  (default: config/pipeline/agents.json)
    PIMAS_MODE             pipeline | single (default: pipeline)
    PIMAS_REVIEW           1 to add the reviewer stage (default: 0)
    PIMAS_MAX_CORRECTIONS  executor corrections after a rejection (default: 1)
    PIMAS_NODE             node executable (default: node)
    PIMAS_SNAPSHOT_ROOT    directory tracked for per-stage file changes (default: /; "none" disables)
    PIMAS_RUN_SNAPSHOT     0 skips the whole-container manifests before and after the run (default: 1)
    PIMAS_CONDITIONS       directory of per-task condition files, <task>.json, giving replayed stage
                           outputs and at most one fault (default: none). A task without a file fails.
    PIMAS_OFFLINE          1 disconnects the task container from its networks while the agent works, so
                           it cannot fetch the upstream fix; they are reconnected for grading. Docker
                           environments only; a container that still reaches the internet fails the trial.

Everything a trial produces is under its ``agent/pimas/`` folder; see pimas_harbor/README.md.

The model is chosen by the agents file, not by ``-m``; ``-m`` only labels the run.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import shlex
import signal
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from pimas_harbor.provenance import read_events, run_status, session_usage, stage_summaries
from pimas_harbor.records import RunFilesystem, code_identity, now, snapshot_config, write_run_info

REPO_ROOT = Path(__file__).resolve().parent.parent
# Margin on top of the in-container `timeout` so Harbor's own exec timeout fires last.
EXEC_TIMEOUT_MARGIN_SECONDS = 30
SHUTDOWN_GRACE_SECONDS = 20


class PimasAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "pimas"

    def version(self) -> str:
        return "0.1.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        # Nothing is installed in the task container; the agent runs on the host.
        pass

    def _setting(self, key: str, default: str) -> str:
        value = self._get_env(key)
        return value if value not in (None, "") else default

    def _settings(self) -> dict[str, str]:
        return {
            "mode": self._setting("PIMAS_MODE", "pipeline"),
            "review": self._setting("PIMAS_REVIEW", "0"),
            "max_corrections": self._setting("PIMAS_MAX_CORRECTIONS", "1"),
            "snapshot_root": self._setting("PIMAS_SNAPSHOT_ROOT", "/"),
            "run_snapshot": self._setting("PIMAS_RUN_SNAPSHOT", "1"),
            "conditions": self._setting("PIMAS_CONDITIONS", ""),
            "offline": self._setting("PIMAS_OFFLINE", "0"),
        }

    def _condition_file(self) -> Path | None:
        """This trial's condition file; the trial directory is named <task>__<suffix>."""
        directory = self._settings()["conditions"]
        if not directory:
            return None
        task = self.logs_dir.parent.name.rsplit("__", 1)[0]
        file = Path(directory).resolve() / f"{task}.json"
        if not file.is_file():
            # Never fall back to an unfaulted run inside a fault condition.
            raise FileNotFoundError(f"No condition file for task {task}: {file}")
        return file

    def _paths(self) -> tuple[Path, Path, Path]:
        root = Path(self._setting("PIMAS_ROOT", str(REPO_ROOT / "PiMAS"))).resolve()
        models = Path(self._setting("PIMAS_MODELS", str(REPO_ROOT / "config/pipeline/models.json"))).resolve()
        agents = Path(self._setting("PIMAS_AGENTS", str(REPO_ROOT / "config/pipeline/agents.json"))).resolve()
        return root, models, agents

    def _bridge_command(self, state: Path) -> tuple[list[str], Path]:
        root, models, agents = self._paths()
        settings = self._settings()
        command = [
            self._setting("PIMAS_NODE", "node"),
            "--import", "tsx",
            str(root / "src/pipeline-bridge.ts"),
            "--models", str(models),
            "--agents", str(agents),
            "--state", str(state),
            "--mode", settings["mode"],
            "--max-corrections", settings["max_corrections"],
            "--snapshot-root", settings["snapshot_root"],
        ]
        if settings["review"] not in ("0", "false", "False"):
            command.append("--review")
        condition = self._condition_file()
        if condition:
            command += ["--condition", str(condition)]
        return command, root

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        state = self.logs_dir / "pimas"
        state.mkdir(parents=True, exist_ok=True)
        (state / "instruction.md").write_text(instruction)
        cwd = (await environment.exec("pwd", timeout_sec=30)).stdout or ""
        cwd = cwd.strip() or "/app"
        has_timeout = (await environment.exec("command -v timeout", timeout_sec=30)).return_code == 0

        command, root = self._bridge_command(state)
        _, models, agents = self._paths()
        settings = self._settings()
        info: dict[str, Any] = {
            "schema_version": 1,
            "agent": {"name": self.name(), "version": self.version()},
            "model_label": self.model_name,
            "harbor_session_id": self.session_id,
            "harbor_context_id": str(self.context_id) if self.context_id else None,
            "started_at": now(),
            "code": code_identity(root),
            "settings": settings,
            "condition": _file_identity(self._condition_file()),
            "bridge_command": command,
            "config": snapshot_config(state, models, agents),
            "workspace_cwd": cwd,
            "container_has_timeout": has_timeout,
        }
        # Written before the run so a killed trial still identifies its code and configuration.
        write_run_info(state, info)
        filesystem = RunFilesystem(environment, state) if settings["run_snapshot"] != "0" else None
        if filesystem:
            try:
                info["filesystem_start"] = await filesystem.start()
            except Exception as error:  # noqa: BLE001 - tracking must not stop the task attempt
                info["filesystem_start"] = {"ok": False, "error": f"{type(error).__name__}: {error}"}

        offline = _Offline(environment) if settings["offline"] not in ("0", "false", "False") else None
        if offline:
            try:
                info["network"] = await offline.start()
            except Exception as error:
                # Never let an offline condition run online; put back whatever was disconnected.
                info["network"] = {"error": f"{type(error).__name__}: {error}", **await offline.restore()}
                write_run_info(state, info)
                raise
            write_run_info(state, info)

        stderr = (state / "bridge-stderr.txt").open("ab")
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=root,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
            start_new_session=True,
            limit=64 * 1024 * 1024,
        )
        relay = _Relay(process, environment, has_timeout)
        finished = False
        try:
            await relay.send({"type": "task", "prompt": instruction, "cwd": cwd})
            await relay.serve()
            finished = True
        finally:
            await relay.close()
            await _stop(process, finished)
            stderr.close()
            info["bridge_exit_code"] = process.returncode
            info["bridge_finished"] = finished
            info["bridge_status"] = relay.done_status
            info["agent_finished_at"] = now()
            if offline:
                # Before anything else: grading needs the network back (it reinstalls the package).
                info["network"].update(await offline.restore())
            if filesystem:
                try:
                    info["filesystem"] = await filesystem.finish()
                except Exception as error:  # noqa: BLE001 - keep the trial's other records
                    info["filesystem"] = {"error": f"{type(error).__name__}: {error}"}
            info["finished_at"] = now()
            write_run_info(state, info)
            self._populate(state, context)
        if relay.done_status in (None, "error"):
            # A pipeline that never ran (bad config, missing tool) must not be graded as a model failure.
            raise RuntimeError(f"PiMAS bridge ended with status {relay.done_status!r}; see {state / 'bridge-stderr.txt'}")

    def _populate(self, state: Path, context: AgentContext) -> None:
        events = read_events(state / "provenance.jsonl")
        usage = session_usage(state / "sessions")
        context.n_input_tokens = usage["input"] + usage["cacheRead"]
        context.n_cache_tokens = usage["cacheRead"]
        context.n_output_tokens = usage["output"]
        context.metadata = {
            "pimas_status": run_status(events),
            "pimas_stages": stage_summaries(events),
        }

    def populate_context_post_run(self, context: AgentContext) -> None:
        self._populate(self.logs_dir / "pimas", context)


def _file_identity(file: Path | None) -> dict[str, str] | None:
    if file is None:
        return None
    return {"file": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}


class _Relay:
    """Runs the bridge's exec requests in the task container, concurrently, until `done`."""

    def __init__(self, process: asyncio.subprocess.Process, environment: BaseEnvironment, has_timeout: bool):
        self.process = process
        self.environment = environment
        self.has_timeout = has_timeout
        self.tasks: dict[int, asyncio.Task[None]] = {}
        self.done_status: str | None = None
        self.write_lock = asyncio.Lock()

    async def send(self, message: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        async with self.write_lock:
            if self.process.stdin.is_closing():
                return
            self.process.stdin.write((json.dumps(message) + "\n").encode())
            with contextlib.suppress(ConnectionResetError, BrokenPipeError):
                await self.process.stdin.drain()

    async def serve(self) -> None:
        assert self.process.stdout is not None
        while line := await self.process.stdout.readline():
            message = json.loads(line)
            kind = message.get("type")
            if kind == "exec":
                request_id = int(message["id"])
                self.tasks[request_id] = asyncio.create_task(self._exec(request_id, message))
            elif kind == "cancel":
                task = self.tasks.pop(int(message["id"]), None)
                if task:
                    task.cancel()
            elif kind == "done":
                self.done_status = str(message.get("status"))
                return
            else:
                raise RuntimeError(f"Unexpected bridge message: {kind!r}")

    async def _exec(self, request_id: int, message: dict[str, Any]) -> None:
        command = str(message["command"])
        timeout = message.get("timeout")
        harbor_timeout = None
        if timeout is not None:
            seconds = max(1, int(timeout))
            # Kill inside the container too; stopping only the docker exec client leaves the process running.
            if self.has_timeout:
                command = f"timeout -k 5 {seconds} bash -c {shlex.quote(command)}"
            harbor_timeout = seconds + EXEC_TIMEOUT_MARGIN_SECONDS
        try:
            result = await self.environment.exec(command, timeout_sec=harbor_timeout)
            reply = {"exit_code": result.return_code, "stdout": result.stdout or "", "stderr": result.stderr or ""}
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - report environment failures to the tool, not the trial
            # Harbor's docker environment reports its exec timeout as RuntimeError("Command timed out ...").
            timed_out = isinstance(error, asyncio.TimeoutError) or "timed out" in str(error).lower()
            reply = {
                "exit_code": 124 if timed_out else 1,
                "stdout": "",
                "stderr": f"Environment exec failed: {type(error).__name__}: {error}",
            }
        finally:
            self.tasks.pop(request_id, None)
        await self.send({"type": "exec_result", "id": request_id, **reply})

    async def close(self) -> None:
        for task in list(self.tasks.values()):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        self.tasks.clear()


# Succeeds only if the container can resolve a name or reach a public address.
OFFLINE_PROBE = "timeout 8 bash -c 'exec 3<>/dev/tcp/pypi.org/443' || timeout 8 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'"


class _Offline:
    """Disconnects the task's main container from its docker networks, and later reconnects them."""

    def __init__(self, environment: BaseEnvironment):
        self.environment = environment
        self.container = ""
        self.networks: dict[str, list[str]] = {}

    async def start(self) -> dict[str, Any]:
        from harbor.environments.docker.docker import _sanitize_docker_compose_project_name

        project = _sanitize_docker_compose_project_name(self.environment.session_id)
        found = (await _docker("ps", "-q", "--filter", f"label=com.docker.compose.project={project}",
                               "--filter", "label=com.docker.compose.service=main")).split()
        if len(found) != 1:
            raise RuntimeError(f"expected one main container in compose project {project}, found {len(found)}")
        self.container = found[0]
        attached = json.loads(await _docker("inspect", "-f", "{{json .NetworkSettings.Networks}}", self.container))
        for name, endpoint in attached.items():
            await _docker("network", "disconnect", name, self.container)
            self.networks[name] = [alias for alias in endpoint.get("Aliases") or [] if not self.container.startswith(alias)]
        probe = await self.environment.exec(OFFLINE_PROBE, timeout_sec=60)
        if probe.return_code == 0:
            raise RuntimeError("the container still reaches the internet")
        return {"offline": True, "container": self.container, "disconnected": list(self.networks),
                "probe_exit_code": probe.return_code}

    async def restore(self) -> dict[str, Any]:
        restored, errors = [], []
        for name, aliases in self.networks.items():
            try:
                await _docker("network", "connect", *[f"--alias={alias}" for alias in aliases], name, self.container)
                restored.append(name)
            except Exception as error:  # noqa: BLE001 - record it; grading then runs offline and is flagged
                errors.append(f"{name}: {error}")
        return {"reconnected": restored, "reconnect_errors": errors}


async def _docker(*args: str) -> str:
    process = await asyncio.create_subprocess_exec(
        "docker", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await process.communicate()
    if process.returncode:
        raise RuntimeError(f"docker {' '.join(args)} failed: {err.decode().strip()}")
    return out.decode()


async def _stop(process: asyncio.subprocess.Process, finished: bool) -> None:
    """Let the bridge write its summary, then make sure nothing is left running."""
    if finished:
        # The summary is written before `done`; give the process a moment to exit on its own.
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(process.wait(), 5)
    if process.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        if process.stdin and not process.stdin.is_closing():
            process.stdin.close()
        os.killpg(process.pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), SHUTDOWN_GRACE_SECONDS)
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()
