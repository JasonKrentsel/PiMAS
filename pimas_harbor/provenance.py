"""Read the PiMAS provenance.jsonl stream written by src/provenance.ts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def read_events(path: Path) -> list[dict[str, Any]]:
    """Events in order. A truncated last line from a killed run is skipped."""
    events: list[dict[str, Any]] = []
    if not path.exists():
        return events
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def stage_summaries(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per stage. Stages cut off by the agent deadline appear as `unfinished`."""
    finished = {
        event["artifact"]["id"]: event["artifact"]
        for event in events
        if event.get("type") == "stage_end"
    }
    calls: dict[str, int] = {}
    for event in events:
        if event.get("type") == "tool_call":
            calls[event["stageId"]] = calls.get(event["stageId"], 0) + 1
    rows = []
    for event in events:
        if event.get("type") != "stage_start":
            continue
        artifact = finished.get(event["id"])
        usage = (artifact or {}).get("usage") or {}
        rows.append({
            "id": event["id"],
            "stage": event["stage"],
            "status": artifact["status"] if artifact else "unfinished",
            "latency_ms": artifact["latencyMs"] if artifact else None,
            "input_tokens": usage.get("input", 0),
            "cache_read_tokens": usage.get("cacheRead", 0),
            "output_tokens": usage.get("output", 0),
            "tool_calls": calls.get(event["id"], 0),
            "changed_files": len(artifact["changedFiles"]) if artifact and artifact.get("changedFiles") is not None else None,
        })
    return rows


def run_status(events: list[dict[str, Any]]) -> str:
    for event in reversed(events):
        if event.get("type") == "run_end":
            return event["status"]
    return "unfinished" if events else "missing"


def session_usage(sessions_dir: Path) -> dict[str, int]:
    """Token totals from every Pi session transcript, including stages that never finished.

    Mirrors collectUsage in src/runtime.ts: message usage plus compaction/summary entries.
    """
    total = {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0}
    if not sessions_dir.is_dir():
        return total
    for file in sorted(sessions_dir.glob("*.jsonl")):
        for entry in read_events(file):
            if entry.get("type") == "message":
                message = entry.get("message") or {}
                usage = message.get("usage") if message.get("role") in ("assistant", "toolResult") else None
            else:
                usage = entry.get("usage")
            if not isinstance(usage, dict):
                continue
            for key in total:
                value = usage.get(key)
                if isinstance(value, (int, float)):
                    total[key] += int(value)
    return total
