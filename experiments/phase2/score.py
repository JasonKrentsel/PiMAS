"""Step 1 of Phase 2: what recovery could achieve with perfect detection, estimated from the saved runs.

Usage: python3 -I score.py <out-dir> <job-dir>...   (see README: "Step 1: the best case, offline")

Every injected run of a fault is scored under five policies. Detection is perfect: the fault's own record says
which result was faulty and when. Nothing is rerun; each policy's cost and outcome is estimated from the paired
control's runs of the same task (the same replayed input, no fault):

  Do nothing                 the run as it went: the agent's own recovery.
  Caught at once, fix        the faulty result is repaired the moment it is delivered, so the run goes on as a
                             clean run: the control's time, plus rerunning research when the whole report was bad.
  Caught at once, restart    the run is thrown away when the fault fires and started again from its entry point.
  Caught at end, restart     the finished run is thrown away and started again.
  Caught at end, redo        the finished run keeps its work and redoes only the steps invalidate.py marks;
                             each step is priced at what the same step took in the control.

Writes recovery-bounds.md (the tables) and recovery-runs.csv (one row per run and policy) to <out-dir>.
"""
import csv
import pathlib
import re
import statistics
import sys
from collections import defaultdict

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "phase1"))
sys.path.insert(0, str(HERE))
import analyze  # noqa: E402  run_row: outcome, minutes, injection time
import invalidate  # noqa: E402  which steps a fault invalidates

POLICIES = ["Do nothing", "Caught at once, fix", "Caught at once, restart", "Caught at end, restart", "Caught at end, redo"]


def mean(values, default=None):
    values = [v for v in values if v is not None]
    return statistics.mean(values) if values else default


def segment_minutes(execute: dict) -> dict:
    return invalidate.step_minutes(execute)


def patch_files(trial: pathlib.Path) -> set:
    """Source files (not tests) the run's final patch changes, as workspace paths."""
    state = trial / "agent/pimas"
    events = analyze.read_jsonl(state / "provenance.jsonl")
    artifacts = [e["artifact"] for e in events if e["type"] == "stage_end"]
    files = set()
    for line in analyze.last_patch(state, artifacts).splitlines():
        if line.startswith("diff --git "):
            path = line.split(" b/", 1)[-1]
            if path.endswith(".py") and not analyze.TEST_FILE.search(path):
                files.add(invalidate.WORKSPACE + path)
    return files


def control_prices(rows: list, trials: dict) -> dict:
    """Per control and task: mean minutes and pass rate, mean stage minutes, and mean minutes of each plan step
    (step ids match across runs only where the plan is replayed, i.e. control-rp)."""
    prices = defaultdict(lambda: {"min": [], "pass": [], "execute": [], "plan": [], "research": [],
                                  "steps": defaultdict(list)})
    for r in rows:
        if not r["condition"].startswith("control") or r["verify"] or r["audit"]:
            continue
        p = prices[(r["condition"], r["task"])]
        p["min"].append(r["agent_min"])
        p["pass"].append(r["resolved"])
        for stage in ("execute", "plan", "research"):
            p[stage].append(r[f"{stage}_min"])
        execute = invalidate.load(trials[r["trial"]])["artifacts"].get("execute", {})
        for step, minutes in segment_minutes(execute).items():
            p["steps"][step].append(minutes)
    return prices


def score_run(r: dict, trial: pathlib.Path, prices: dict) -> dict | None:
    control = analyze.CONTROL.get(r["condition"])
    clean = prices.get((control, r["task"]))
    if not clean or not clean["min"]:
        return None
    run = invalidate.load(trial)
    target = run["summary"]["fault"]["spec"]["target"]
    clean_min, clean_pass = mean(clean["min"]), mean(clean["pass"])
    # Repairing the faulty input itself. A wrong or lost research report means running research again, unless the
    # control (control-full) already includes research. A wrong fact is dropped, a tool result fetched again and a
    # slipped edit restored, all assumed to cost nothing.
    research = mean(prices.get(("control-full", r["task"]), {}).get("research", []), 0)
    rerun_input = research if target["kind"] == "stage" and control != "control-full" else 0.0
    fault_at = max(0.0, (r["agent_min"] or 0) - (r["min_after_fault"] or 0))
    graded_right = r["reward"] == 1  # the code it left is right, even if it ran out of time

    # Which steps to redo, and what they cost in the control. Where the plan is replayed the step ids are the
    # control's; otherwise a step is priced as an equal share of the control's executor time.
    bad, stages = invalidate.invalidate(run)
    steps = run["artifacts"]["plan"]["content"]["steps"] if "plan" in run["artifacts"] else []
    redo = 0.0
    for sid in bad:
        same_step = clean["steps"].get(sid)
        redo += mean(same_step) if same_step and control == "control-rp" else (
            mean(clean["execute"], 0) / max(len(steps), 1))
    for stage in stages:
        redo += research if stage == "research" else mean(prices.get(("control-r", r["task"]), {}).get("plan", []), 0)
    # Missed work: a run left wrong code, and the redo leaves some changed source file untouched.
    files = invalidate.step_files(run["artifacts"].get("execute", {}))
    redone_files = set().union(*(files.get(s, set()) for s in bad)) if bad else set()
    patched = patch_files(trial)
    missed = sorted(f.removeprefix(invalidate.WORKSPACE) for f in patched - redone_files)
    covered = not missed or set(bad) == {s["id"] for s in steps}
    redo_pass = 1.0 if r["resolved"] == 1 or graded_right else (clean_pass if covered else 0.0)

    out = {"condition": r["condition"], "task": r["task"], "trial": r["trial"], "fault_at_min": round(fault_at, 1),
           "clean_min": round(clean_min, 1), "steps_redone": f"{len(bad)}/{len(steps)}",
           "wrong_code": not graded_right, "missed_files": ";".join(missed) if not graded_right else ""}
    for policy, (passes, minutes) in {
        "Do nothing": (r["resolved"] or 0.0, r["agent_min"]),
        "Caught at once, fix": (clean_pass, clean_min + rerun_input),
        "Caught at once, restart": (clean_pass, fault_at + rerun_input + clean_min),
        "Caught at end, restart": (clean_pass, r["agent_min"] + rerun_input + clean_min),
        "Caught at end, redo": (redo_pass, r["agent_min"] + redo),
    }.items():
        out[f"{policy}: pass"] = round(passes, 2)
        out[f"{policy}: min"] = round(minutes, 1)
    return out


def table(scored: list) -> str:
    by = defaultdict(list)
    for s in scored:
        by[s["condition"]].append(s)
    cell = lambda runs, p: (f'{sum(s[p + ": pass"] for s in runs):.1f}/{len(runs)}, '
                            f'{mean([s[p + ": min"] for s in runs]):.1f}')
    lines = ["| Fault | Injected runs | Clean run min | " + " | ".join(POLICIES) + " | Steps redone (median share) | Wrong-code runs | Redo misses a changed file |",
             "|" + "---|" * (len(POLICIES) + 6)]
    for name, runs in sorted(by.items()):
        wrong = [s for s in runs if s["wrong_code"]]
        shares = [int(s["steps_redone"].split("/")[0]) / max(int(s["steps_redone"].split("/")[1]), 1) for s in runs]
        lines.append(f'| {name} | {len(runs)} | {mean([s["clean_min"] for s in runs]):.1f} | '
                     + " | ".join(cell(runs, p) for p in POLICIES)
                     + f' | {statistics.median(shares):.0%} | {len(wrong)} | {sum(bool(s["missed_files"]) for s in wrong)} |')
    return "\n".join(lines)


def main() -> None:
    out, jobs = pathlib.Path(sys.argv[1]), [pathlib.Path(j) for j in sys.argv[2:]]
    rows, trials = [], {}
    for job in jobs:
        if not job.is_dir() or job.name.endswith("+verify"):
            continue  # always-verify runs add review stages this first pass does not model
        for trial in sorted(p for p in job.iterdir() if p.is_dir() and "__" in p.name and (p / "agent/pimas").exists()):
            rows.append(analyze.run_row(trial, job.name))
            trials[trial.name] = trial
    prices = control_prices(rows, trials)
    scored = [s for r in rows if r["fault"] and r["injected"] and not r["audit"]
              if (s := score_run(r, trials[r["trial"]], prices))]

    out.mkdir(parents=True, exist_ok=True)
    with (out / "recovery-runs.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, list(scored[0]))
        writer.writeheader()
        writer.writerows(scored)
    text = "\n".join([
        "# Recovery with perfect detection (Phase 2, step 1)", "",
        "Estimated from the saved runs; nothing here was rerun. Each cell is expected passes / injected runs, then mean "
        "agent minutes per run (means, not the medians of summary.md, because recovery costs add up). *Clean run* is the "
        "paired control's mean on the same tasks: the floor no recovery can beat. How each policy is estimated, and what "
        "it assumes, is in README.md (\"Step 1: the best case, offline\").", "",
        table(scored), "",
        "*Wrong-code runs* left code the grader rejects (timed-out runs whose code is right are not among them); *Redo "
        "misses a changed file* counts those whose redo leaves a changed source file untouched, so the redo keeps "
        "possibly wrong code. Per-run numbers: recovery-runs.csv.",
        "",
    ])
    (out / "recovery-bounds.md").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
