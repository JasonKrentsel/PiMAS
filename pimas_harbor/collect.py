"""Collect Harbor trial folders into one results table and a per-condition summary.

    python -m pimas_harbor.collect jobs/ --rows trials.csv --summary summary.csv --tool-calls tool_calls.csv

Expected layout: jobs/<condition>/<replicate job>/<trial>/. With the default
--condition-depth 1 the first folder names the condition and the next one the replicate.
Rows: one per trial. Tool calls: one per tool call, for finding what dominates run time.
Standard library only, so it also runs where Harbor is not installed.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import random
import statistics
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from pimas_harbor.provenance import read_events, run_status, session_usage, stage_summaries

# Verifier/fixture self-tests that pass for any submission (from T4-lite docs/TASKS.md).
# They are reported but excluded from the check fraction.
HEALTH_CHECKS: dict[str, set[str]] = {
    "ontology-kg-querying": {
        "test_verifier_runtime_is_hardened",
        "test_query_result_normalization_ignores_insignificant_trailing_zeroes",
    },
    "mvcc-lsm-compaction": {
        "test_visibility.py::test_reference_model_is_checked_by_independent_timeline_oracle",
        "test_visibility.py::test_crash_report_is_available_to_the_agent",
    },
    "layout-config-recreation": {"test_state.py::test_fixture_render_matches_visible_layout"},
    "satb-audio-transcription": {"test_outputs.py::test_oracle_exists_in_image"},
}

STAGES = ("research", "plan", "execute", "review", "correct", "solve")


def _task_short_name(task_name: str) -> str:
    return task_name.split("/")[-1]


def _is_health_check(task: str, name: str) -> bool:
    return any(name == check or name.endswith(check) for check in HEALTH_CHECKS.get(task, ()))


def check_counts(trial_dir: Path, task: str) -> tuple[int | None, int | None, str]:
    """(passed, total, source). CTRF first, then warranty-style trace_results.json."""
    ctrf = trial_dir / "verifier" / "ctrf.json"
    if ctrf.exists():
        tests = json.loads(ctrf.read_text())["results"]["tests"]
        counted = [test for test in tests if not _is_health_check(task, test["name"])]
        return sum(test["status"] == "passed" for test in counted), len(counted), "ctrf"
    trace = trial_dir / "verifier" / "trace_results.json"
    if trace.exists():
        cases = json.loads(trace.read_text()).get("cases", [])
        return sum(bool(case.get("passed")) for case in cases), len(cases), "trace"
    return None, None, "none"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def outside_changes(state: Path, cwd: str | None) -> int | None:
    """Container-wide changes outside the task working directory, from filesystem/changes.tsv(.gz)."""
    for name in ("changes.tsv.gz", "changes.tsv"):
        file = state / "filesystem" / name
        if not file.exists():
            continue
        opener = gzip.open if name.endswith(".gz") else open
        prefix = (cwd or "/app").rstrip("/") + "/"
        with opener(file, "rt", encoding="utf-8", errors="replace") as handle:
            return sum(1 for line in handle if "\t" in line and not line.split("\t", 1)[1].startswith(prefix))
    return None


def _seconds(timing: dict[str, Any] | None) -> float | None:


    if not timing or not timing.get("started_at") or not timing.get("finished_at"):
        return None
    start = datetime.fromisoformat(timing["started_at"])
    end = datetime.fromisoformat(timing["finished_at"])
    return (end - start).total_seconds()


def trial_row(result_file: Path, jobs_root: Path, condition_depth: int) -> dict[str, Any]:
    trial_dir = result_file.parent
    result = json.loads(result_file.read_text())
    task = _task_short_name(result.get("task_name", trial_dir.name))
    relative = trial_dir.relative_to(jobs_root).parts
    condition = "/".join(relative[:condition_depth]) if len(relative) > condition_depth else relative[0]
    replicate = relative[condition_depth] if len(relative) > condition_depth + 1 else None
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    reward = rewards.get("reward")
    exception = result.get("exception_info") or {}
    passed, total, source = check_counts(trial_dir, task)

    state = trial_dir / "agent" / "pimas"
    events = read_events(state / "provenance.jsonl")
    usage = session_usage(state / "sessions")
    info = _read_json(state / "run-info.json")
    filesystem = info.get("filesystem") or {}
    row: dict[str, Any] = {
        "condition": condition,
        "replicate": replicate,
        "task": task,
        "trial": result.get("trial_name", trial_dir.name),
        "agent": (result.get("agent_info") or {}).get("name"),
        "reward": reward,
        "checks_passed": passed,
        "checks_total": total,
        "check_fraction": (passed / total) if passed is not None and total else None,
        "check_source": source,
        "exception": exception.get("exception_type"),
        "agent_seconds": _seconds(result.get("agent_execution")),
        "verifier_seconds": _seconds(result.get("verifier")),
        "pimas_status": run_status(events),
        "input_tokens": usage["input"] + usage["cacheRead"],
        "cache_read_tokens": usage["cacheRead"],
        "output_tokens": usage["output"],
        "provenance_bytes": (state / "provenance.jsonl").stat().st_size if (state / "provenance.jsonl").exists() else None,
        "git_commit": (info.get("code") or {}).get("git_commit"),
        "git_dirty": (info.get("code") or {}).get("git_dirty"),
        "mode": (info.get("settings") or {}).get("mode"),
        "review": (info.get("settings") or {}).get("review"),
        "fs_created": filesystem.get("created"),
        "fs_modified": filesystem.get("modified"),
        "fs_deleted": filesystem.get("deleted"),
        "fs_changes_outside_cwd": outside_changes(state, info.get("workspace_cwd")),
        "run_snapshot_seconds": ((info.get("filesystem_start") or {}).get("scan_seconds") or 0) + (filesystem.get("scan_seconds") or 0)
        if filesystem else None,
    }
    stages = stage_summaries(events)
    row["tool_calls"] = sum(stage["tool_calls"] for stage in stages)
    overheads = [stage["tracking_overhead_ms"] for stage in stages if stage["tracking_overhead_ms"] is not None]
    row["stage_tracking_seconds"] = sum(overheads) / 1000 if overheads else None
    for name in STAGES:
        matching = [stage for stage in stages if stage["stage"] == name]
        row[f"{name}_runs"] = len(matching)
        row[f"{name}_status"] = ",".join(stage["status"] for stage in matching) or None
        row[f"{name}_seconds"] = sum((stage["latency_ms"] or 0) for stage in matching) / 1000 if matching else None
        row[f"{name}_tokens"] = sum(stage["input_tokens"] + stage["cache_read_tokens"] + stage["output_tokens"] for stage in matching) if matching else None
        row[f"{name}_tool_calls"] = sum(stage["tool_calls"] for stage in matching) if matching else None
    return row


def tool_call_rows(row: dict[str, Any], trial_dir: Path) -> list[dict[str, Any]]:
    """Full records from tool-calls.jsonl; falls back to the compact provenance events."""
    state = trial_dir / "agent" / "pimas"
    entries = read_events(state / "tool-calls.jsonl")
    if not entries:
        entries = [
            {"stageId": event["stageId"], **event["call"]}
            for event in read_events(state / "provenance.jsonl")
            if event.get("type") == "tool_call"
        ]
    rows = []
    for entry in entries:
        args = entry.get("args")
        command = args.get("command") if isinstance(args, dict) else None
        rows.append({
            "condition": row["condition"],
            "replicate": row["replicate"],
            "task": row["task"],
            "trial": row["trial"],
            "stage": entry.get("stageId"),
            "step": entry.get("stepId"),
            "tool": entry.get("tool"),
            "seconds": entry["durationMs"] / 1000 if isinstance(entry.get("durationMs"), (int, float)) else None,
            "is_error": entry.get("isError"),
            "started_at": entry.get("startedAt"),
            "command": command[:300] if isinstance(command, str) else None,
            "args_chars": len(json.dumps(args)) if args is not None else None,
            "output_chars": len(entry["output"]) if isinstance(entry.get("output"), str) else None,
        })
    return rows


def bootstrap_ci(values: list[float], samples: int = 2000, seed: int = 0) -> tuple[float | None, float | None]:
    if len(values) < 2:
        return None, None
    rng = random.Random(seed)
    means = sorted(statistics.fmean(rng.choices(values, k=len(values))) for _ in range(samples))
    return means[int(0.025 * samples)], means[int(0.975 * samples) - 1]


def summarize(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Per condition. Task-level means first average replicates within a task, so tasks weigh equally."""
    summary = []
    for condition in sorted({row["condition"] for row in rows}):
        group = [row for row in rows if row["condition"] == condition]
        graded = [row for row in group if row["reward"] is not None]
        by_task: dict[str, list[dict[str, Any]]] = {}
        for row in graded:
            by_task.setdefault(row["task"], []).append(row)
        task_pass = [statistics.fmean(float(row["reward"]) for row in task_rows) for task_rows in by_task.values()]
        task_checks = [
            statistics.fmean(row["check_fraction"] for row in task_rows if row["check_fraction"] is not None)
            for task_rows in by_task.values()
            if any(row["check_fraction"] is not None for row in task_rows)
        ]
        pass_low, pass_high = bootstrap_ci(task_pass)
        check_low, check_high = bootstrap_ci(task_checks)
        tokens = [row["input_tokens"] + row["output_tokens"] for row in group]
        summary.append({
            "condition": condition,
            "trials": len(group),
            "graded_trials": len(graded),
            "errored_trials": sum(row["exception"] is not None for row in group),
            "tasks": len(by_task),
            "pass_rate": statistics.fmean(task_pass) if task_pass else None,
            "pass_rate_ci_low": pass_low,
            "pass_rate_ci_high": pass_high,
            "check_fraction": statistics.fmean(task_checks) if task_checks else None,
            "check_fraction_ci_low": check_low,
            "check_fraction_ci_high": check_high,
            "tasks_always_pass": sum(value == 1 for value in task_pass),
            "tasks_sometimes_pass": sum(0 < value < 1 for value in task_pass),
            "mean_tokens_per_trial": statistics.fmean(tokens) if tokens else None,
            "mean_agent_seconds": statistics.fmean(row["agent_seconds"] for row in group if row["agent_seconds"] is not None)
            if any(row["agent_seconds"] is not None for row in group) else None,
        })
    return summary


def _write(path: Path | None, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    handle = path.open("w", newline="") if path else sys.stdout
    try:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    finally:
        if path:
            handle.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("jobs", type=Path, help="Folder containing Harbor job folders")
    parser.add_argument("--rows", type=Path, help="Per-trial CSV (default: stdout)")
    parser.add_argument("--summary", type=Path, help="Per-condition CSV")
    parser.add_argument("--tool-calls", type=Path, help="Per-tool-call CSV")
    parser.add_argument("--condition-depth", type=int, default=1, help="Path levels under JOBS that name a condition")
    args = parser.parse_args(argv)
    jobs_root = args.jobs.resolve()
    # Job folders also hold a job-level result.json; trials are the ones with an agent or verifier folder.
    trial_results = [
        result_file for result_file in sorted(jobs_root.rglob("result.json"))
        if (result_file.parent / "agent").exists() or (result_file.parent / "verifier").exists()
    ]
    rows = [trial_row(result_file, jobs_root, args.condition_depth) for result_file in trial_results]
    _write(args.rows, rows)
    if args.summary:
        _write(args.summary, summarize(rows))
    if args.tool_calls:
        _write(args.tool_calls, [
            call for row, result_file in zip(rows, trial_results) for call in tool_call_rows(row, result_file.parent)
        ])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
