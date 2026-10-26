"""Single-task, in-container PiMAS integration. The existing runner still owns grading."""
from __future__ import annotations

import argparse
import dataclasses
import json
import os
import threading
import time
from pathlib import Path

from .contracts import Harness
from .core import Invalid, load_benchmark, load_run, read_json, read_results, verify_packages, write_json
from .docker import DockerSession, _docker
from .runner import drive_harness, layout_for, run_benchmark

NODE = "/opt/pimas-node/bin/node"
LAUNCHER = "/opt/pimas/container/launch.mjs"
BRIDGE = "/opt/pimas/src/container-bridge.ts"
SMOKE = "/opt/pimas/container/smoke.mjs"


def resolve_image(image: str, base: str) -> str:
    """Never evaluate a moving tag or silently use a derivative of the wrong task."""
    inspected = _docker(["docker", "image", "inspect", image], timeout=60)
    value = json.loads(inspected.stdout)[0]
    if (value.get("Config", {}).get("Labels") or {}).get("org.pimas.task-base") != base:
        raise Invalid("PiMAS image does not declare the selected task's pinned base image")
    return value["Id"]


class ContainerSession(DockerSession):
    def __init__(self, *, image: str, task_id: str, state: Path, config: Path | None = None):
        self.state = Path(state).resolve()
        mounts = [(str(self.state), "/pimas-state", False)]
        if config is not None:
            mounts.append((str(Path(config).resolve()), "/pimas-config", True))
        if any("," in source for source, _, _ in mounts):
            raise Invalid("Docker bind source paths cannot contain commas")
        # Reserve one attempt. Never put an old conversation into a new task container.
        self.state.parent.mkdir(parents=True, exist_ok=True)
        self.state.mkdir(exist_ok=False)
        super().__init__(mounts=mounts)
        self.image = image
        self.task_id = task_id
        self.container_id = ""
        self.done = False
        self._timer: threading.Timer | None = None
        self._stop_lock = threading.Lock()
        self._group_stopped = False
        self.watchdog_error = ""

    def open(self, layout) -> None:
        super().open(dataclasses.replace(layout, image=self.image))
        container = self._container("main")
        if not container:
            raise Invalid("Task main container was not created")
        self.container_id = _docker(["docker", "inspect", "--format", "{{.Id}}", container], timeout=60).stdout.decode().strip()
        if not self.container_id:
            raise Invalid("Task container has no identity")
        write_json(self.state / "attempt.json", {"taskId": self.task_id, "attemptId": self.project,
                   "containerId": self.container_id, "imageId": self.image})

    def spawn_harness(self, harness: Harness) -> None:
        if any(key == "PIMAS_CONTAINER_ID" for key, _ in harness.env):
            raise Invalid("PIMAS_CONTAINER_ID is runner-owned")
        args = ["docker", "exec", "-i", "-w", "/app", "-e", f"PIMAS_CONTAINER_ID={self.container_id}"]
        for key, _ in harness.env:
            # Values go through the Docker client's environment, not its argv.
            args += ["-e", key]
        args += [self.container_id, NODE, LAUNCHER, *harness.command]
        super().spawn_harness(Harness(command=tuple(args), env=harness.env))

    def write(self, message: dict) -> None:
        if message.get("type") == "task":
            message = {**message, "attempt_id": self.project, "container_id": self.container_id}
        super().write(message)

    def read_line(self) -> str | None:
        line = super().read_line()
        if line:
            try:
                self.done = json.loads(line).get("type") == "done"
            except (ValueError, AttributeError):
                pass  # drive_harness owns protocol validation.
        return line

    def arm_deadline(self, deadline: float) -> None:
        super().arm_deadline(deadline)
        self._timer = threading.Timer(max(0.0, deadline - time.monotonic()), self._expire)
        self._timer.daemon = True
        self._timer.start()

    def _expire(self) -> None:
        try:
            self.stop_harness()
        except Exception as error:
            self.watchdog_error = str(error)

    def stop_harness(self) -> None:
        # Killing the host docker-exec client alone does not kill its container process.
        if self._timer:
            self._timer.cancel()
        with self._stop_lock:
            try:
                if self.container_id and not self._group_stopped:
                    script = (
                        "const fs=require('node:fs');const f='/pimas-state/harness.pid';"
                        "if(fs.existsSync(f)){const s=fs.readFileSync(f,'utf8');"
                        "if(!/^[1-9][0-9]*$/.test(s))throw Error('Invalid harness pid');"
                        "try{process.kill(-Number(s),'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}}"
                    )
                    _docker(["docker", "exec", self.container_id, NODE, "-e", script], timeout=15)
                    self._group_stopped = True
            finally:
                # Only a Docker CLI runs on the host in this mode, not an arbitrary host tree.
                proc = self.proc
                if proc is not None and proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=15)
                self._drain_harness_output(proc)
                (self.state / "harness-stderr.txt").write_text(self.stderr, encoding="utf-8")

    def grade(self):
        self.stop_harness()
        if not self.done:
            raise Invalid("In-container harness did not send done; agent attempt failed or exceeded its deadline")
        return super().grade()


def run_one(benchmark, folder: Path, *, task_id: str, image: str, config: Path,
            model: str, agent: str, profile: dict, env=()) -> dict:
    task = benchmark.task(task_id)
    verify_packages(benchmark)
    config = Path(config).resolve()
    if not config.is_dir() or not all((config / name).is_file() for name in ("models.json", "agents.json")):
        raise Invalid("Config directory must contain models.json and agents.json")
    image_id = resolve_image(image, layout_for(benchmark, task).image)
    integration = {"mode": "in-task-container", "task_id": task_id, "image_id": image_id,
                   "base_image": layout_for(benchmark, task).image, "agent_failure": "missing-done-is-error"}
    folder = Path(folder)
    state = folder / "attempts" / task_id
    existing = (folder / "run.json").exists()
    if existing:
        saved = load_run(benchmark, folder)
        if saved["profile"].get("pimas_container") != integration:
            raise Invalid("Existing run uses a different container image or integration profile")
        if state.exists() and task_id not in read_results(benchmark, folder):
            raise Invalid("An interrupted attempt already exists; refusing to launch its state in a fresh container")
    return run_benchmark(benchmark, folder, Harness(command=(BRIDGE, "--models", "/pimas-config/models.json",
                         "--agents", "/pimas-config/agents.json"), env=tuple(env)),
                         model=model, agent=agent, profile={**profile, "pimas_container": integration}, only=task_id,
                         session_factory=lambda: ContainerSession(image=image_id, task_id=task_id, state=state, config=config))


def smoke(benchmark, *, task_id: str, image: str, state: Path, implementation: bool = False) -> dict:
    task = benchmark.task(task_id)
    verify_packages(benchmark)
    layout = layout_for(benchmark, task)
    image_id = resolve_image(image, layout.image)
    session = ContainerSession(image=image_id, task_id=task_id, state=state)
    try:
        session.open(layout)
        session.spawn_harness(Harness(command=(SMOKE, "--implementation") if implementation else (SMOKE,)))
        deadline = time.monotonic() + 90
        session.arm_deadline(deadline)
        outcome = drive_harness(session.read_line, session.write, session.execute,
                                {"type": "task", "task_id": task_id, "cwd": "/app", "prompt":
                                 "Plan, implement, check, and independently review the native smoke fixture." if implementation
                                 else "Read the native smoke fixture and report."},
                                deadline=deadline, alive=session.harness_running)
        if outcome != "done":
            raise Invalid("Container smoke did not finish: " + session.stderr)
        session.stop_harness()
        checkpoint = read_json(session.state / "run/run.json")
        if checkpoint["orchestrator"]["status"] != "settled":
            raise Invalid("Smoke did not persist a settled orchestrator")
        if implementation:
            agents = checkpoint.get("agents", [])
            revision = checkpoint.get("workflow", {}).get("revision")
            if ([agent.get("role") for agent in agents] != ["planner", "executor", "reviewer"]
                    or any(agent.get("status") != "settled" for agent in agents)
                    or not checkpoint.get("workflow", {}).get("plan")
                    or not isinstance(revision, int) or revision < 1
                    or agents[2].get("review", {}).get("approved") is not True
                    or agents[2].get("review", {}).get("revision") != revision):
                raise Invalid("Implementation smoke did not persist current independent approval")
        return {"smoke": "passed", "task_id": task_id, "image_id": image_id, "state": str(session.state),
                "run_id": checkpoint["runId"], "graded": False,
                "workflow": "implementation" if implementation else "inspection"}
    finally:
        session.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Run PiMAS inside one task container")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("smoke", "run"):
        command = commands.add_parser(name)
        command.add_argument("--task", required=True)
        command.add_argument("--image", required=True, help="Locally built PiMAS derivative of this task image")
        if name == "smoke":
            command.add_argument("--state", type=Path, required=True, help="New host directory for smoke state")
            command.add_argument("--implementation", action="store_true", help="Exercise native execution, command timeout, and independent review without live inference")
        else:
            command.add_argument("folder", type=Path)
            command.add_argument("--config", type=Path, required=True)
            command.add_argument("--model", default="")
            command.add_argument("--agent", default="pimas-in-container")
            command.add_argument("--profile", type=Path, required=True)
            command.add_argument("--harness-env", action="append", default=[])
    args = parser.parse_args(argv)
    try:
        benchmark = load_benchmark()
        if args.command == "smoke":
            report = smoke(benchmark, task_id=args.task, image=args.image, state=args.state, implementation=args.implementation)
        else:
            env = []
            for key in args.harness_env:
                if key not in os.environ:
                    raise Invalid(f"Harness environment {key} is not set")
                env.append((key, os.environ[key]))
            report = run_one(benchmark, args.folder, task_id=args.task, image=args.image, config=args.config,
                             model=args.model, agent=args.agent, profile=read_json(args.profile), env=env)
        print(json.dumps(report, indent=2))
        return 0 if args.command == "smoke" or report["valid"] else 1
    except (Invalid, OSError, ValueError, KeyError, TypeError) as error:
        import sys
        print(f"Error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
