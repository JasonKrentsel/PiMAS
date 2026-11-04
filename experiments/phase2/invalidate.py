"""Starting point for dependency-aware recovery on saved runs: which work a fault invalidates, and what redoing
only that would cost. Reads one run's agent/pimas/ folder; needs only the standard library and no model.

Usage: python3 -I invalidate.py <trial-dir>...   (e.g. ../../jobs/phase1/research-wrong/*/)

The fault's identity comes from the run's own records, as Phase 2 allows. The invalid mark spreads
fact -> plan steps that cite it -> later steps that changed the same files. Steps record no step-to-step
dependencies, so shared files stand in for them. Step minutes come from each step's start and end times.
"""
import json
import pathlib
import sys
from datetime import datetime


def load(trial: pathlib.Path) -> dict:
    run = trial / "agent/pimas"
    summary = json.loads((run / "summary.json").read_text())
    events = [json.loads(line) for line in (run / "provenance.jsonl").open()]
    return {"summary": summary, "artifacts": {a["id"]: a for a in summary["artifacts"]},
            "injections": [e["injection"] for e in events if e["type"] == "fault"]}


def step_files(execute: dict) -> dict:
    """Files each executor step created or modified, without Python's bytecode caches."""
    files = {}
    for seg in execute.get("stepFileChanges") or []:
        if seg["stepId"]:
            changes = seg["fileChanges"]
            files.setdefault(seg["stepId"], set()).update(
                f for f in changes["created"] + changes["modified"] if "__pycache__" not in f)
    return files


def step_minutes(execute: dict) -> dict:
    minutes = {}
    for seg in execute.get("stepFileChanges") or []:
        if seg["stepId"]:
            span = (iso(seg["endedAt"]) - iso(seg["startedAt"])) / 60
            minutes[seg["stepId"]] = minutes.get(seg["stepId"], 0) + span
    return minutes


def iso(stamp: str) -> float:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def invalidate(run: dict) -> tuple[set, list]:
    """The executor steps to redo, and the earlier stages to redo with them."""
    target = run["summary"]["fault"]["spec"]["target"]
    steps = run["artifacts"]["plan"]["content"]["steps"] if "plan" in run["artifacts"] else []
    order = [s["id"] for s in steps]
    if target["kind"] == "stage":                       # a whole stage wrong or lost: it and everything after it
        return set(order), ["research", "plan"][["research", "plan"].index(target["stage"]):]
    if target["kind"] == "fact":
        bad = {s["id"] for s in steps if target["id"] in s.get("uses", [])}
    elif target["kind"] == "step":
        bad = {target["id"]}
    else:                                               # a tool result: the steps it was delivered in
        bad = {i["stepId"] for i in run["injections"] if i.get("stepId")}
    files = step_files(run["artifacts"].get("execute", {}))
    for sid in order:                                   # later steps that touched a bad step's files
        if sid not in bad and any(order.index(b) < order.index(sid) and files.get(b, set()) & files.get(sid, set())
                                  for b in bad):
            bad.add(sid)
    return bad, []


def main() -> None:
    for trial in map(pathlib.Path, sys.argv[1:]):
        run = load(trial)
        if not run["injections"]:
            print(f"{trial.name}: fault never fired")
            continue
        bad, stages = invalidate(run)
        execute = run["artifacts"].get("execute", {})
        minutes = step_minutes(execute)
        # A replayed stage took no time here; cost a rerun of it from control-full's runs of the same task.
        redo = sum(run["artifacts"][s]["latencyMs"] for s in stages if s in run["artifacts"]) / 60000
        redo += sum(minutes.get(s, 0) for s in bad)
        total = sum(a["latencyMs"] for a in run["artifacts"].values()) / 60000
        print(f"{trial.name}: redo steps {sorted(bad) or '-'}{' after redoing ' + ' and '.join(stages) if stages else ''}; "
              f"about {redo:.1f} of this run's {total:.1f} agent minutes")


if __name__ == "__main__":
    main()
