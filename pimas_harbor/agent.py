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

The model is chosen by the agents file, not by ``-m``; ``-m`` only labels the run.
"""

from __future__ import annotations

import asyncio
import contextlib
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

    def _bridge_command(self, state: Path) -> tuple[list[str], Path]:
        root = Path(self._setting("PIMAS_ROOT", str(REPO_ROOT / "PiMAS"))).resolve()
        models = Path(self._setting("PIMAS_MODELS", str(REPO_ROOT / "config/pipeline/models.json"))).resolve()
        agents = Path(self._setting("PIMAS_AGENTS", str(REPO_ROOT / "config/pipeline/agents.json"))).resolve()
        command = [
            self._setting("PIMAS_NODE", "node"),
            "--import", "tsx",
            str(root / "src/pipeline-bridge.ts"),
            "--models", str(models),
            "--agents", str(agents),
            "--state", str(state),
            "--mode", self._setting("PIMAS_MODE", "pipeline"),
            "--max-corrections", self._setting("PIMAS_MAX_CORRECTIONS", "1"),
        ]
        if self._setting("PIMAS_REVIEW", "0") not in ("0", "false", "False"):
            command.append("--review")
        return command, root

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        state = self.logs_dir / "pimas"
        state.mkdir(parents=True, exist_ok=True)
        cwd = (await environment.exec("pwd", timeout_sec=30)).stdout or ""
        cwd = cwd.strip() or "/app"
        has_timeout = (await environment.exec("command -v timeout", timeout_sec=30)).return_code == 0

        command, root = self._bridge_command(state)
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
            self._populate(state, context)

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


class _Relay:
    """Runs the bridge's exec requests in the task container, concurrently, until `done`."""

    def __init__(self, process: asyncio.subprocess.Process, environment: BaseEnvironment, has_timeout: bool):
        self.process = process
        self.environment = environment
        self.has_timeout = has_timeout
        self.tasks: dict[int, asyncio.Task[None]] = {}
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
