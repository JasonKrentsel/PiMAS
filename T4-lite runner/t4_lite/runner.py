"""Start a task, talk to an external harness, grade, and commit the result."""
from __future__ import annotations

import json
import re
import tempfile
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path

from .contracts import Harness
from .core import Invalid, create_run, load_run, read_results, record_result, summarize, write_json, sha256
from .docker import DEFAULT_EXEC_TIMEOUT, DockerSession, prepare_docker
from .grade import Grade, load_json, map_grade, parse_reward


@dataclass(frozen=True)
class TaskLayout:
    image: str
    cpus: float
    memory_mb: int
    agent_timeout: float
    verifier_image: str
    verifier_timeout: float
    verifier_cpus: float
    verifier_memory_mb: int
    verifier_env: dict
    collect: tuple
    compose: Path | None
    prompt: str
    artifacts: tuple


def tool_limit_for(profile: dict | None) -> float:
    return float((profile or {}).get("single_tool_elapsed_limit_seconds") or DEFAULT_EXEC_TIMEOUT)


def layout_for(benchmark, task: dict, profile: dict | None = None) -> TaskLayout:
    package = benchmark.root / task["package"]
    manifest = tomllib.loads((package / "task.toml").read_text(encoding="utf-8"))
    environment = manifest["environment"]
    compose = package / "environment" / "docker-compose.yaml"
    verifier = task["verifier"]
    verifier_env = verifier.get("environment") or {}
    artifacts = []
    for item in manifest.get("artifacts") or []:
        if isinstance(item, str):
            artifacts.append(item)
        else:
            artifacts.append({"source": item["source"], "service": item.get("service", "main")})
    verifier_timeout = max(float(verifier["timeout_sec"]),
                           float((profile or {}).get("verifier_timeout_floor_seconds") or 0))
    # CPU and memory are the frozen manifest resources. task.toml can disagree; the manifest wins.
    return TaskLayout(
        image=environment["docker_image"], cpus=task["resources"]["cpus"], memory_mb=task["resources"]["memory_mb"],
        agent_timeout=float(task["agent"]["timeout_sec"]), verifier_image=verifier_env["docker_image"],
        verifier_timeout=verifier_timeout, verifier_cpus=verifier_env.get("cpus", task["resources"]["cpus"]),
        verifier_memory_mb=verifier_env.get("memory_mb", task["resources"]["memory_mb"]),
        verifier_env=dict(verifier.get("env") or {}), collect=tuple(verifier.get("collect") or ()),
        compose=compose if compose.exists() else None, prompt=(package / "instruction.md").read_text(encoding="utf-8-sig"),
        artifacts=tuple(artifacts))


def images_for_tasks(benchmark, tasks, profile) -> list[str]:
    """Environment, verifier, and compose images for these tasks, once each."""
    images = []
    for task in tasks:
        layout = layout_for(benchmark, task, profile)
        images += [layout.image, layout.verifier_image]
        if layout.compose is not None:
            images += re.findall(r"^\s*image:\s*[\"']?([^\"'\s]+)", layout.compose.read_text(encoding="utf-8"),
                                 flags=re.MULTILINE)
    return list(dict.fromkeys(images))


def drive_harness(read_line, write, execute, task_message: dict,
                  tool_limit: float = DEFAULT_EXEC_TIMEOUT, deadline: float | None = None,
                  alive=None) -> str:
    """Speak one task to a harness. `execute` runs a command in the task container."""
    write(task_message)
    while True:
        if deadline is not None and time.monotonic() >= deadline:
            return "closed"
        line = read_line()
        if not line:
            return "closed"
        try:
            message = json.loads(line)
        except json.JSONDecodeError as error:
            raise Invalid("Harness sent invalid JSON") from error
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            raise Invalid("Harness message needs a type")
        if message["type"] == "done":
            return "done"
        if message["type"] != "exec":
            raise Invalid(f"Unknown harness message: {message['type']}")
        command = message.get("command")
        if not isinstance(command, str) or not command:
            raise Invalid("Harness exec needs a command")
        timeout = message["timeout"] if "timeout" in message else tool_limit
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
            raise Invalid("Harness exec timeout must be a positive number")
        requested = min(float(timeout), float(tool_limit))
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return "closed"
            requested = min(requested, remaining)
        background = bool(message.get("background", False))
        code, stdout, stderr = execute(command, requested, background)
        # A passed deadline or an exited harness ends the exchange; the attempt is still graded.
        if (deadline is not None and time.monotonic() >= deadline) or (alive is not None and not alive()):
            return "closed"
        try:
            write({"type": "exec_result", "exit_code": code, "stdout": stdout, "stderr": stderr})
        except (OSError, ValueError):  # the harness exited between the check and the write
            return "closed"


def _exception_notes(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}" if str(error) else type(error).__name__


def run_task(benchmark, folder: Path, task: dict, harness: Harness, session) -> str:
    try:
        meta = load_run(benchmark, folder)
        profile = meta["profile"]
        layout = layout_for(benchmark, task, profile)
        session.open(layout)
        session.spawn_harness(harness)
        deadline = time.monotonic() + layout.agent_timeout
        session.arm_deadline(deadline)
        drive_harness(session.read_line, session.write, session.execute,
                      {"type": "task", "task_id": task["id"], "cwd": "/app", "prompt": layout.prompt},
                      tool_limit=tool_limit_for(profile), deadline=deadline,
                      alive=session.harness_running)
        finished_in_time = time.monotonic() < deadline
        reward_raw, ctrf_raw, trace_raw, log = session.grade()
        reward = parse_reward(reward_raw.decode("utf-8", "replace")) if reward_raw is not None else None
        grade = map_grade(task, reward=reward, ctrf=load_json(ctrf_raw), trace=load_json(trace_raw))
        return _commit(benchmark, folder, task, grade, log, session, finished_in_time,
                       reward_raw=reward_raw, ctrf_raw=ctrf_raw, trace_raw=trace_raw)
    except Exception as error:
        try:
            session.stop_harness()
        except Exception:
            pass
        return _commit_error(benchmark, folder, task, error, session)
    finally:
        try:
            session.close()
        except Exception:
            pass


def _commit_error(benchmark, folder, task, error, session) -> str:
    grade = Grade("error", None, {}, {}, _exception_notes(error))
    return _commit(benchmark, folder, task, grade, b"", session, True)


def _commit(benchmark, folder, task, grade, log, session, finished_in_time: bool,
            reward_raw: bytes | None = None, ctrf_raw: bytes | None = None, trace_raw: bytes | None = None) -> str:
    notes = [grade.notes]
    if not finished_in_time and grade.status in {"pass", "fail"}:
        notes.append("Harness exceeded the agent timeout")
    if session.copy_failures:
        notes.append("Failed to copy: " + ", ".join(session.copy_failures))
    # The verifier's own reward.txt is the native result. None means the file was absent; empty is still stored.
    files = [("native_result", "reward.txt", reward_raw),
             ("verifier", "verifier-output.json",
              json.dumps({"log": log.decode("utf-8", "replace")}, indent=2, ensure_ascii=False).encode()),
             ("verifier", "ctrf.json", ctrf_raw),
             ("verifier", "trace_results.json", trace_raw),
             ("harness_stderr", "harness-stderr.txt", session.stderr.encode() if session.stderr else None)]
    meta = load_run(benchmark, folder)
    with tempfile.TemporaryDirectory(prefix=".incoming-", dir=folder) as temporary:
        stage = Path(temporary)
        evidence = []
        for kind, name, data in files:
            if data is not None:
                (stage / name).write_bytes(data)
                evidence.append({"kind": kind, "path": name, "sha256": sha256(stage / name)})
        result = {"schema_version": 1, "run_id": meta["run_id"], "benchmark_sha256": meta["benchmark_sha256"],
                  "profile_sha256": meta["profile_sha256"], "task_id": task["id"], "source_ref": task["source"]["ref"],
                  "status": grade.status, "reward": grade.reward, "checks": grade.checks, "health": grade.health,
                  "evidence": evidence, "notes": "\n".join(note for note in notes if note)}
        write_json(stage / "result.json", result)
        return record_result(benchmark, folder, stage / "result.json")


def run_benchmark(benchmark, folder: Path, harness: Harness, *, model: str | None = None, agent: str | None = None,
                  profile: dict | None = None, only: str | None = None, session_factory=DockerSession,
                  ensure_docker=None) -> dict:
    folder = Path(folder)
    if only:
        benchmark.task(only)
    existing = (folder / "run.json").exists()
    if existing:
        active_profile = load_run(benchmark, folder)["profile"]
        done = read_results(benchmark, folder)
    else:
        if not model or not agent or profile is None:
            raise Invalid("A new run needs a model, an agent label, and a profile")
        active_profile = profile
        done = {}
    pending = [task for task in benchmark.tasks if (not only or task["id"] == only) and task["id"] not in done]
    # Docker must answer before any task is committed. One failure here leaves the ledger untouched.
    if pending:
        images = images_for_tasks(benchmark, pending, active_profile)
        (ensure_docker or prepare_docker)(images)
    if not existing:
        create_run(benchmark, folder, model=model, agent=agent, profile=profile)
    # One task at a time. The profile's task_concurrency is stored on the run and is not applied.
    # run_task commits an error and returns; this loop does not commit again.
    for task in pending:
        run_task(benchmark, folder, task, harness, session_factory())
    return summarize(benchmark, read_results(benchmark, folder))
