"""Frozen benchmark, immutable result storage, and scoring."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
TERMINAL = {"pass", "fail", "error", "blocked", "quarantined", "cancelled"}
CHECK_STATES = {"pass", "fail", "skipped", "not_run"}


class Invalid(ValueError):
    """Invalid benchmark, evidence, or result contract."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Invalid(message)


def _object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path: Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8-sig"), object_pairs_hook=_object,
                      parse_constant=lambda x: (_ for _ in ()).throw(Invalid(f"Invalid JSON number: {x}")))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def safe_path(root: Path, relative: str) -> Path:
    require(isinstance(relative, str) and bool(relative), "Empty evidence/package path")
    part = PurePosixPath(relative)
    require(not part.is_absolute() and ".." not in part.parts and "\\" not in relative
            and ":" not in relative, f"Unsafe relative path: {relative}")
    target = root.joinpath(*part.parts)
    require(target.resolve().is_relative_to(root.resolve()), f"Path escapes root: {relative}")
    return target


def write_json(path: Path, data: Any) -> None:
    """Atomic replacement; uncommitted temporary files are never read as results."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def sync_directory(path: Path) -> None:
    if os.name == "posix":
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


@dataclass(frozen=True)
class Benchmark:
    root: Path
    manifest: dict
    digest: str

    @property
    def tasks(self) -> list[dict]:
        return self.manifest["tasks"]

    def task(self, ident: str) -> dict:
        found = [t for t in self.tasks if t["id"] == ident]
        require(len(found) == 1, f"Task is outside this benchmark: {ident}")
        return found[0]


def load_benchmark(root: Path = ROOT) -> Benchmark:
    root = Path(root)
    path = root / "benchmark/manifest.json"
    digest = sha256(path)
    require(digest == (root / "benchmark/manifest.sha256").read_text().strip(), "Manifest checksum mismatch")
    data = read_json(path)
    require(data.get("schema_version") == 1, "Unsupported manifest schema")
    tasks = data["tasks"]
    require(len(tasks) == data["task_count"] > 0, "Wrong task count")
    require(len({t["id"] for t in tasks}) == len(tasks), "Duplicate tasks")
    for task in tasks:
        require(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", task["id"]) is not None, "Invalid task ID")
        require(task["checks"], f"No checks for {task['id']}")
        for key in ("checks", "health_checks"):
            require(len({c["id"] for c in task[key]}) == len(task[key]), "Duplicate check IDs")
        safe_path(root, task["package"])
    require(sum(len(t["checks"]) for t in tasks) == data["check_count"], "Wrong check denominator")
    return Benchmark(root, data, digest)


def verify_packages(benchmark: Benchmark) -> dict:
    count = 0
    for task in benchmark.tasks:
        package = safe_path(benchmark.root, task["package"])
        actual = {p.relative_to(package).as_posix() for p in package.rglob("*") if p.is_file()}
        require(actual == set(task["files"]), f"Package file list changed: {task['id']}")
        for relative, expected in task["files"].items():
            path = safe_path(package, relative)
            require(not path.is_symlink() and sha256(path) == expected,
                    f"Package file changed: {task['id']}/{relative}")
            count += 1
    return {"tasks": len(benchmark.tasks), "verified_files": count, "benchmark_sha256": benchmark.digest}


def create_run(benchmark: Benchmark, folder: Path, *, model: str, agent: str, profile: dict) -> dict:
    require(bool(model.strip()) and bool(agent.strip()), "Model and agent identifiers are required")
    require(isinstance(profile, dict) and profile.get("schema_version") == 1, "Invalid public execution profile")
    forbidden = {"api_key", "authorization", "password", "secret", "access_token"}
    def public(value):
        if isinstance(value, dict):
            require(not any(k.lower() in forbidden for k in value), "Keep credentials out of the execution profile")
            for child in value.values(): public(child)
        elif isinstance(value, list):
            for child in value: public(child)
    public(profile)
    metadata = {"schema_version": 1, "run_id": str(uuid.uuid4()), "benchmark_sha256": benchmark.digest,
                "benchmark": f"{benchmark.manifest['name']}@{benchmark.manifest['version']}",
                "created_at": datetime.now(timezone.utc).isoformat(), "model": model, "agent": agent,
                "profile": profile, "profile_sha256": fingerprint(profile)}
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=False)
    write_json(folder / "run.json", metadata)
    (folder / "run.sha256").write_text(sha256(folder / "run.json") + "\n", encoding="ascii")
    (folder / "results").mkdir()
    return metadata


def load_run(benchmark: Benchmark, folder: Path) -> dict:
    require(sha256(Path(folder) / "run.json") == (Path(folder) / "run.sha256").read_text().strip(), "Run metadata was modified")
    meta = read_json(Path(folder) / "run.json")
    require(meta.get("schema_version") == 1, "Unsupported run schema")
    require(meta.get("benchmark_sha256") == benchmark.digest, "Run belongs to another benchmark revision")
    require(meta.get("profile_sha256") == fingerprint(meta["profile"]), "Run profile was modified")
    require(isinstance(meta.get("run_id"), str) and meta["run_id"], "Missing run ID")
    return meta


def validate_result(benchmark: Benchmark, meta: dict, result: dict) -> dict:
    allowed = {"schema_version", "run_id", "benchmark_sha256", "profile_sha256", "task_id", "source_ref",
               "status", "reward", "checks", "health", "evidence", "usage", "timing_seconds", "notes"}
    require(isinstance(result, dict) and not set(result) - allowed, "Unknown result fields")
    require(result.get("schema_version") == 1, "Unsupported result schema")
    for key in ("run_id", "benchmark_sha256", "profile_sha256"):
        require(result.get(key) == meta[key], f"Result {key} mismatch")
    task = benchmark.task(result.get("task_id", ""))
    require(result.get("source_ref") == task["source"]["ref"], "Task version mismatch")
    require(result.get("status") in TERMINAL, "Invalid task status")
    valid = result["status"] in {"pass", "fail"}
    if valid:
        reward = result.get("reward")
        require(type(reward) in (int, float) and reward in (0, 1), "Reward must be binary, not a boolean")
        require((reward == 1) == (result["status"] == "pass"), "Status and native reward disagree")
    else:
        require(result.get("reward") is None, "Infrastructure/excluded results cannot carry a reward")
        require(isinstance(result.get("notes"), str) and result["notes"].strip(), "Invalid results need a reason")
    checks, health = result.get("checks"), result.get("health")
    require(isinstance(checks, dict) and isinstance(health, dict), "checks and health must be objects")
    expected = {c["id"] for c in task["checks"]}
    expected_health = {c["id"] for c in task["health_checks"]}
    require(set(checks) <= expected and set(health) <= expected_health, "Unknown check IDs")
    require(all(v in CHECK_STATES for v in checks.values()), "Invalid check status")
    require(all(v in CHECK_STATES for v in health.values()), "Invalid health-check status")
    if valid:
        require(set(checks) == expected, "Incomplete check catalog: cannot shrink the denominator")
        require(set(health) == expected_health, "Missing health evidence")
        # A verifier that rejects the submission at bootstrap runs nothing, its self-tests included.
        bootstrap = result["status"] == "fail" and all(v == "not_run" for v in checks.values())
        require(all(v == "pass" or (bootstrap and v == "not_run") for v in health.values()),
                "Verifier health failure")
    evidence = result.get("evidence")
    require(isinstance(evidence, list) and evidence, "Evidence is required")
    paths = []
    for entry in evidence:
        require(isinstance(entry, dict) and set(entry) == {"kind", "path", "sha256"}, "Invalid evidence entry")
        require(isinstance(entry["kind"], str) and entry["kind"], "Evidence kind required")
        require(isinstance(entry["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]), "Invalid evidence hash")
        safe_path(Path("."), entry["path"])
        require(entry["path"] not in {"result.json", "commit.json"}, "Evidence path is reserved")
        paths.append(entry["path"])
    require(len(paths) == len(set(paths)), "Duplicate evidence paths")
    if valid:
        require({"native_result", "verifier"} <= {e["kind"] for e in evidence}, "Native result and verifier evidence required")
    for key in ("usage", "timing_seconds"):
        values = result.get(key, {})
        require(isinstance(values, dict), f"{key} must be an object")
        for value in values.values():
            require(value is None or (type(value) in (int, float) and math.isfinite(value) and value >= 0),
                    f"{key} values must be nonnegative finite numbers or null")
    return result


def verify_evidence(folder: Path, result: dict) -> None:
    for entry in result["evidence"]:
        path = safe_path(folder, entry["path"])
        require(path.is_file() and not path.is_symlink(), f"Missing/unsafe evidence: {entry['path']}")
        require(sha256(path) == entry["sha256"], f"Evidence hash mismatch: {entry['path']}")


def read_commit(folder: Path) -> dict:
    require(read_json(folder / "commit.json").get("result_sha256") == sha256(folder / "result.json"), "Committed result was modified")
    return read_json(folder / "result.json")


def record_result(benchmark: Benchmark, run: Path, source: Path) -> str:
    """Commit one whole evidence bundle atomically; a competing writer cannot replace it."""
    run, source = Path(run), Path(source)
    meta = load_run(benchmark, run)
    result = validate_result(benchmark, meta, read_json(source))
    verify_evidence(source.parent, result)
    target = run / "results" / result["task_id"]
    if target.exists():
        previous = read_commit(target)
        require(previous == result, "Task already committed; overwriting or best-of selection is forbidden")
        verify_evidence(target, previous)
        return "already_recorded"
    stage = Path(tempfile.mkdtemp(prefix=".pending-", dir=run / "results"))
    try:
        for entry in result["evidence"]:
            dest = safe_path(stage, entry["path"])
            dest.parent.mkdir(parents=True, exist_ok=True)
            with safe_path(source.parent, entry["path"]).open("rb") as incoming, dest.open("wb") as handle:
                shutil.copyfileobj(incoming, handle)
                handle.flush()
                os.fsync(handle.fileno())
        verify_evidence(stage, result)
        write_json(stage / "result.json", result)
        write_json(stage / "commit.json", {"result_sha256": sha256(stage / "result.json")})
        try:
            os.rename(stage, target)
        except OSError:
            if target.exists() and read_commit(target) == result:
                verify_evidence(target, result)
                return "already_recorded"
            raise
        sync_directory(target.parent)
        return "recorded"
    finally:
        if stage.exists():
            require(stage.resolve().is_relative_to((run / "results").resolve()) and stage.name.startswith(".pending-"), "Unsafe temporary cleanup target")
            shutil.rmtree(stage)


def read_results(benchmark: Benchmark, run: Path) -> dict[str, dict]:
    meta = load_run(benchmark, run)
    result = {}
    for folder in sorted((Path(run) / "results").iterdir()):
        if folder.name.startswith(".pending-"):
            continue
        require(folder.is_dir(), f"Unexpected result entry: {folder.name}")
        benchmark.task(folder.name)
        item = validate_result(benchmark, meta, read_commit(folder))
        require(item["task_id"] == folder.name, "Result stored under the wrong task")
        verify_evidence(folder, item)
        result[folder.name] = item
    return result


def summarize(benchmark: Benchmark, results: dict[str, dict]) -> dict:
    require(set(results) <= {t["id"] for t in benchmark.tasks}, "Unexpected tasks")
    rows = []
    for task in benchmark.tasks:
        item = results.get(task["id"], {})
        rows.append({"task_id": task["id"], "category": task["category"], "status": item.get("status", "pending"),
                     "checks_passed": sum(v == "pass" for v in item.get("checks", {}).values()),
                     "checks_total": len(task["checks"]), "notes": item.get("notes", "")})
    counts = {status: sum(row["status"] == status for row in rows) for status in sorted(TERMINAL | {"pending"})}
    valid = all(row["status"] in {"pass", "fail"} for row in rows)
    passed = sum(row["checks_passed"] for row in rows)
    return {"benchmark": f"{benchmark.manifest['name']}@{benchmark.manifest['version']}",
            "benchmark_sha256": benchmark.digest, "valid": valid, "complete": counts["pending"] == 0,
            "coverage": {"recorded_tasks": len(results), "valid_tasks": counts["pass"] + counts["fail"],
                         "total_tasks": len(rows)}, "counts": counts,
            "task_pass_percent": 100 * counts["pass"] / len(rows) if valid else None,
            "verification_pass_percent": 100 * passed / benchmark.manifest["check_count"] if valid else None,
            "checks": {"passed_recorded": passed, "total": benchmark.manifest["check_count"]},
            "tasks": rows}
