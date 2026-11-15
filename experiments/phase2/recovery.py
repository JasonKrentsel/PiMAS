#!/usr/bin/env python3
"""Build an evidence graph and propose recovery for one saved PiMAS trial.

This is offline analysis: it never modifies the task workspace or reruns an agent.
"""
from __future__ import annotations

import argparse
from collections import defaultdict, deque
from datetime import datetime
import json
from pathlib import Path
import posixpath
import sys


def read_jsonl(file: Path) -> list[dict]:
    if not file.exists():
        return []
    with file.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def load_trial(trial: Path) -> dict:
    state = trial / "agent" / "pimas"
    events = read_jsonl(state / "provenance.jsonl")
    summary_file = state / "summary.json"
    if summary_file.exists():
        summary = json.loads(summary_file.read_text(encoding="utf-8"))
    else:
        # Interrupted runs may have stage_end records but no summary.
        summary = {"artifacts": [e["artifact"] for e in events if e.get("type") == "stage_end"], "fault": None}
    if not summary.get("artifacts"):
        raise ValueError("No completed stage artifacts found in summary.json or provenance.jsonl")
    start = next((e for e in events if e.get("type") == "run_start"), {})
    return {"trial": str(trial), "summary": summary, "events": events,
            "calls": read_jsonl(state / "tool-calls.jsonl"),
            "cwd": (start.get("settings") or {}).get("workspaceCwd")}


def useful_path(value: str) -> bool:
    return "__pycache__" not in value and not value.endswith((".pyc", ".pyo"))


def normalize_path(value: object, cwd: str | None) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    value = value.removeprefix("@")
    if not value.startswith("/"):
        if not cwd:
            return None
        value = posixpath.join(cwd, value)
    return posixpath.normpath(value)


def graph_for(run: dict) -> dict:
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    edge_keys: set[tuple] = set()
    warnings: set[str] = set()
    artifacts = {a["id"]: a for a in run["summary"].get("artifacts", [])}

    def node(key: str, kind: str, **fields):
        nodes.setdefault(key, {"id": key, "kind": kind, **fields})

    def edge(source: str, target: str, relation: str, evidence: str):
        item = (source, target, relation, evidence)
        if item not in edge_keys:
            edge_keys.add(item)
            edges.append({"from": source, "to": target, "relation": relation, "evidence": evidence})

    for aid, artifact in artifacts.items():
        node(f"stage:{aid}", "stage", stage=artifact.get("stage"), status=artifact.get("status"))
        for parent in artifact.get("parents") or []:
            node(f"stage:{parent}", "stage")
            edge(f"stage:{parent}", f"stage:{aid}", "stage_input", "artifact.parents")

    research = artifacts.get("research", {})
    facts = (research.get("content") or {}).get("facts") or []
    for fact in facts:
        node(f"fact:{fact['id']}", "fact", claim=fact.get("claim"), evidence=fact.get("evidence"))
        edge("stage:research", f"fact:{fact['id']}", "produces", "research.content.facts")

    plan = artifacts.get("plan", {})
    steps = (plan.get("content") or {}).get("steps") or []
    for step in steps:
        sid = step["id"]
        node(f"plan:{sid}", "plan_step", action=step.get("action"), check=step.get("check"))
        edge("stage:plan", f"plan:{sid}", "produces", "plan.content.steps")
        for fact in step.get("uses") or []:
            node(f"fact:{fact}", "fact")
            edge(f"fact:{fact}", f"plan:{sid}", "declared_fact_use", "plan.content.steps[].uses")
        for dependency in step.get("dependsOnSteps") or []:
            node(f"plan:{dependency}", "plan_step")
            edge(f"plan:{dependency}", f"plan:{sid}", "declared_step_dependency", "plan.content.steps[].dependsOnSteps")

    calls = run["calls"]
    for call in calls:
        stage, sid, cid = call.get("stageId"), call.get("stepId"), call.get("toolCallId")
        if not stage or not cid:
            warnings.add("A tool record lacks a stage or tool-call ID.")
            continue
        key = f"call:{stage}:{cid}"
        node(key, "tool_call", stageId=stage, stepId=sid, tool=call.get("tool"),
             startedAt=call.get("startedAt"), isError=call.get("isError"))
        owner = f"step:{stage}:{sid}" if sid else f"stage:{stage}"
        if sid:
            node(owner, "execution_step", stageId=stage, stepId=sid)
            if f"plan:{sid}" in nodes:
                edge(f"plan:{sid}", owner, "execution_of", "tool-calls.jsonl.stepId")
        edge(owner, key, "contains_call", "tool-calls.jsonl")

    # Track observed file versions by segment. Direct reads can be matched to the
    # latest previous segment that changed the exact path; bash is deliberately opaque.
    operations: list[tuple[str, int, dict]] = []
    for aid, artifact in artifacts.items():
        if artifact.get("stage") not in ("execute", "correct", "solve"):
            continue
        segments = artifact.get("stepFileChanges")
        if segments is None:
            warnings.add(f"{aid} has no per-step file changes.")
        for index, segment in enumerate(segments or []):
            sid = segment.get("stepId")
            if sid:
                node(f"step:{aid}:{sid}", "execution_step", stageId=aid, stepId=sid)
                if f"plan:{sid}" in nodes:
                    edge(f"plan:{sid}", f"step:{aid}:{sid}", "execution_of", "stepFileChanges.stepId")
            change = segment.get("fileChanges")
            if change is None or change.get("truncated"):
                warnings.add(f"{aid} has missing or truncated file changes.")
            operations.append((segment.get("endedAt") or "", 1,
                               {"stage": aid, "sid": sid, "index": index, "change": change}))
    for call in calls:
        if call.get("tool") in ("read", "edit"):
            args = call.get("args")
            path = normalize_path(args.get("path") if isinstance(args, dict) else None, run["cwd"])
            if path and useful_path(path):
                operations.append((call.get("startedAt") or "", 0, {"call": call, "path": path}))
        if call.get("tool") == "bash":
            warnings.add("Shell commands may read or write files that cannot be inferred from arguments.")

    writers: dict[str, tuple[str, str]] = {}
    for _, kind, data in sorted(operations, key=lambda item: (item[0], item[1])):
        if kind == 0:
            call, path = data["call"], data["path"]
            previous = writers.get(path)
            if previous:
                edge(previous[1], f"call:{call['stageId']}:{call['toolCallId']}", "observed_file_read", "direct read/edit path; prior step manifest")
                sid = call.get("stepId")
                if sid and previous[0] != f"step:{call['stageId']}:{sid}":
                    edge(previous[0], f"step:{call['stageId']}:{sid}", "prior_file_read", path)
            continue
        change = data["change"] or {}
        sid, aid, index = data["sid"], data["stage"], data["index"]
        owner = f"step:{aid}:{sid}" if sid else f"stage:{aid}"
        for action in ("created", "modified", "deleted"):
            for raw_path in change.get(action) or []:
                path = normalize_path(raw_path, run["cwd"])
                if not path or not useful_path(path):
                    continue
                version = f"file:{aid}:{index}:{path}"
                node(version, "file_change", path=path, change=action, stageId=aid, stepId=sid)
                edge(owner, version, "changes_file", "stepFileChanges")
                previous = writers.get(path)
                if previous and previous[0] != owner:
                    edge(previous[0], owner, "shared_file", path)
                writers[path] = (owner, version)

    # A declaration about a plan step also describes how executions of those
    # steps relate. This is needed when the seed is an executed tool or file.
    for step in steps:
        for dependency in step.get("dependsOnSteps") or []:
            for aid in artifacts:
                source, target = f"step:{aid}:{dependency}", f"step:{aid}:{step['id']}"
                if source in nodes and target in nodes:
                    edge(source, target, "declared_execution_dependency", "plan.content.steps[].dependsOnSteps")

    warnings.update({
        "Fact citations and step tags are agent-declared and can omit dependencies.",
        "File manifests record changes, not complete file reads or reversible step snapshots.",
        "All findings are supplied as context to the planner and executor, including uncited facts.",
    })
    return {"trial": run["trial"], "nodes": list(nodes.values()), "edges": edges, "warnings": sorted(warnings)}


def seconds(start: str, end: str) -> float | None:
    try:
        return max(0.0, (datetime.fromisoformat(end.replace("Z", "+00:00")) -
                         datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds())
    except (ValueError, TypeError, AttributeError):
        return None


def recovery_for(run: dict, graph: dict, kind: str, identifier: str | None) -> dict:
    artifacts = {a["id"]: a for a in run["summary"].get("artifacts", [])}
    nodes = {n["id"]: n for n in graph["nodes"]}
    edges = graph["edges"]
    warnings = list(graph["warnings"])
    seeds: set[str] = set()
    affected_stages: set[str] = set()
    invalidate_all = False
    targets = []
    if kind == "fault":
        spec = ((run["summary"].get("fault") or {}).get("spec") or {})
        target = spec.get("target") or {}
        injections = [e["injection"] for e in run["events"] if e.get("type") == "fault"]
        if not target or not injections:
            raise ValueError("No recorded fault target and fired fault events; select --fact, --step or --tool-call instead")
        if target.get("kind") in ("fact", "step", "stage"):
            targets.append((target["kind"], target.get("id") or target.get("stage")))
        else:
            for injection in injections:
                if injection.get("toolCallId"):
                    targets.append(("tool", injection["toolCallId"]))
                elif injection.get("stageId"):
                    targets.append(("stage", injection["stageId"]))
                else:
                    raise ValueError("A fault event lacks both tool-call and stage identity")
    else:
        targets.append((kind, identifier))

    for target_kind, value in targets:
        if target_kind in ("fact", "step"):
            key = f"{'fact' if target_kind == 'fact' else 'plan'}:{value}"
            if key not in nodes:
                raise ValueError(f"Unknown {target_kind}: {value}")
            seeds.add(key)
            if target_kind == "fact":
                affected_stages.add("plan")
                invalidate_all = True  # both planner and executor saw the whole findings object
        elif target_kind == "stage":
            key = f"stage:{value}"
            if key not in nodes:
                raise ValueError(f"Unknown stage: {value}")
            affected_stages.add(value)
            seeds.add(key)
            invalidate_all = True
        elif target_kind == "tool":
            matches = [n for n in nodes.values() if n["kind"] == "tool_call" and n["id"].endswith(f":{value}")]
            if len(matches) != 1:
                raise ValueError(f"Tool-call ID is missing or ambiguous: {value}")
            call = matches[0]
            sid, stage = call.get("stepId"), call["stageId"]
            if sid:
                seeds.add(f"step:{stage}:{sid}")
            else:
                affected_stages.add(stage)
                invalidate_all = True
                warnings.append(f"Faulty call in {stage} has no step; the whole downstream context needs reassessment.")
        else:
            raise ValueError(f"Unsupported target kind: {target_kind}")

    # Traverse only fine-grained dependencies. Stage edges express whole-prompt
    # context, and are reported separately so the candidate is not mistaken for proof.
    traversable = {"declared_fact_use", "declared_step_dependency", "declared_execution_dependency",
                   "execution_of", "prior_file_read", "shared_file"}
    adjacency: dict[str, list[dict]] = defaultdict(list)
    for e in edges:
        if e["relation"] in traversable:
            adjacency[e["from"]].append(e)
    found = set(seeds)
    reasons: dict[str, list[dict]] = defaultdict(list)
    queue = deque(sorted(seeds))
    while queue:
        source = queue.popleft()
        for e in adjacency[source]:
            reasons[e["to"]].append({"from": source, "relation": e["relation"], "evidence": e["evidence"]})
            if e["to"] not in found:
                found.add(e["to"])
                queue.append(e["to"])

    execution = [n for n in nodes.values() if n["kind"] == "execution_step"]
    candidate = {n["id"] for n in execution if n["id"] in found}
    if any(target_kind == "step" and not any(n["stepId"] == value for n in execution)
           for target_kind, value in targets):
        invalidate_all = True
        warnings.append("The selected plan step has no recorded execution tag; all observed steps need reassessment.")
    if any(kind == "stage" for kind, _ in targets):
        # A whole-stage failure has no finer-grained localization.
        candidate.update(n["id"] for n in execution)
    # Stage parents describe broad context. Report those downstream stages even
    # when the fine-grained candidate selects only a subset of their steps.
    if any(kind == "fact" for kind, _ in targets):
        affected_stages.add("plan")
    stage_queue = deque(affected_stages)
    while stage_queue:
        parent = stage_queue.popleft()
        for aid, artifact in artifacts.items():
            if parent in (artifact.get("parents") or []) and aid not in affected_stages:
                affected_stages.add(aid)
                stage_queue.append(aid)
    # Conservative fallback includes all later observed step segments, even when
    # they don't touch the same file. Stage-level changes invalidate all execution.
    conservative = set(candidate)
    for artifact in artifacts.values():
        if artifact.get("stage") not in ("execute", "correct", "solve"):
            continue
        order = [seg.get("stepId") for seg in artifact.get("stepFileChanges") or [] if seg.get("stepId")]
        order.extend(c.get("stepId") for c in run["calls"] if c.get("stageId") == artifact["id"] and c.get("stepId"))
        keys = [f"step:{artifact['id']}:{sid}" for sid in order]
        indexes = [i for i, key in enumerate(keys) if key in candidate]
        if invalidate_all:
            conservative.update(keys)
        elif indexes:
            conservative.update(keys[min(indexes):])
    if candidate:
        # Later correction rounds consume the entire earlier execution report.
        executed = list(artifacts)
        first = min((executed.index(nodes[key]["stageId"]) for key in candidate
                     if nodes[key]["stageId"] in executed), default=len(executed))
        conservative.update(n["id"] for n in execution if n["stageId"] in executed
                            and executed.index(n["stageId"]) > first)
    # Corrections and review depend on the execution report as a whole.
    if candidate or conservative or invalidate_all:
        affected_stages.update(a["id"] for a in artifacts.values() if a.get("stage") in ("review", "correct"))
    elapsed: dict[str, float] = defaultdict(float)
    timed: set[str] = set()
    for artifact in artifacts.values():
        for segment in artifact.get("stepFileChanges") or []:
            if segment.get("stepId"):
                key = f"step:{artifact['id']}:{segment['stepId']}"
                duration = seconds(segment.get("startedAt"), segment.get("endedAt"))
                if duration is not None:
                    elapsed[key] += duration
                    timed.add(key)
    def describe(keys: set[str]) -> list[dict]:
        return [{"id": key, "stageId": nodes[key]["stageId"], "stepId": nodes[key]["stepId"],
                 "observedSeconds": round(elapsed[key], 2) if key in timed else None, "reasons": reasons.get(key, [])}
                for key in sorted(keys) if key in nodes]
    return {"targets": [{"kind": k, "id": v} for k, v in targets],
            "stages_to_reassess": sorted(affected_stages),
            "evidence_based_candidate": describe(candidate),
            "conservative_steps": describe(conservative),
            "candidate_observed_seconds": round(sum(elapsed[k] for k in candidate), 2) if candidate <= timed else None,
            "conservative_observed_seconds": round(sum(elapsed[k] for k in conservative), 2) if conservative <= timed else None,
            "limitations": warnings + ["Elapsed times are historical step durations, not predicted rerun cost; missing timings are null.",
                                       "This report does not restore files, rerun agents, or verify the result."]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trial", type=Path, help="trial directory containing agent/pimas")
    targets = parser.add_mutually_exclusive_group()
    targets.add_argument("--fact", metavar="ID", help="invalid research fact, e.g. F3")
    targets.add_argument("--step", metavar="ID", help="invalid plan step, e.g. S2")
    targets.add_argument("--tool-call", metavar="ID", help="invalid tool-call ID")
    targets.add_argument("--fault", action="store_true", help="use all recorded injections of the run's fault")
    args = parser.parse_args()
    try:
        run = load_trial(args.trial)
        graph = graph_for(run)
        selection = next(((kind, value) for kind, value in (("fact", args.fact), ("step", args.step),
                          ("tool", args.tool_call), ("fault", args.fault)) if value), None)
        result = {"graph": graph}
        if selection:
            result["recovery"] = recovery_for(run, graph, *selection)
        json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
        print()
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"recovery: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
