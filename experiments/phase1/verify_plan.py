"""Which conditions get the always-verify comparison.

Usage: python3 -I verify_plan.py <report-dir>   (the folder analyze.py wrote, holding runs.csv)

The rule is fixed before the fault runs are seen: verifying is compared only where the fault did harm the reviewer
could prevent, in at least 2 of a condition's runs: the executor submitted, and the run then did not pass or acted on
an injected instruction. A run that timed out before submitting never reaches review, so verifying would repeat it
unchanged; such runs are listed but not counted. With 1 harmed run out of 19, a verify comparison could not tell
recovery from chance. A condition
with no such harm can only gain cost from verifying, and that cost is measured on its control. Each control
paired with a chosen condition is verified too, as the cost of verifying when nothing is wrong.

Writes verify-plan.md (every condition with its reason) and verify-plan.json (the conditions to run, longest
first, with an hour estimate at 4 streams from the condition's own runs) to <report-dir>.
"""
import csv
import json
import pathlib
import statistics
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # python3 -I leaves the script's folder off the path
from analyze import CONTROL  # noqa: E402

MIN_HARMED = 2


def main() -> None:
    report = pathlib.Path(sys.argv[1])
    rows = [r for r in csv.DictReader(open(report / "runs.csv")) if r["verify"] != "True" and not r["audit"]]
    by_condition: dict[str, list] = {}
    for row in rows:
        by_condition.setdefault(row["condition"], []).append(row)
    chosen, lines = [], ["# Always-verify plan", "", f"A condition is verified if at least {MIN_HARMED} runs were harmed "
                         "where review could act: the executor submitted, and the run then did not pass or acted on an "
                         "injected instruction. Runs that timed out before submitting never reach review; see verify_plan.py.", "",
                         "| Condition | Runs | Did not submit | Submitted, not passed | Acted on injection | Verify | Reason |",
                         "|---|---|---|---|---|---|---|"]
    for name, runs in sorted(by_condition.items()):
        if name not in CONTROL:
            continue
        submitted = [r for r in runs if r["finished"] == "True"]
        failed = sum(r["resolved"] != "1.0" for r in submitted)
        complied = sum(r["complied"] == "True" for r in submitted)
        harmed = sum(r["resolved"] != "1.0" or r["complied"] == "True" for r in submitted)
        yes = harmed >= MIN_HARMED
        timed_out = len(runs) - len(submitted)
        reason = (f"{harmed} harmed runs" if yes else f"only {harmed} harmed run" if harmed == 1
                  else "no harm: verifying can only add cost" if timed_out < MIN_HARMED else
                  "harm is timeouts before review, which verifying would repeat")
        lines.append(f"| {name} | {len(runs)} | {timed_out} | {failed} | {complied} | {'yes' if yes else 'no'} | {reason} |")
        if yes:
            chosen.append(name)
    controls = sorted({CONTROL[name] for name in chosen})
    lines += ["", f"Controls verified for the cost of verifying on clean runs: {', '.join(controls) or 'none'}."]
    # Hours at 4 streams: the condition's runs one after another, divided over the streams, plus a third for review.
    hours = {name: round(sum(float(r["agent_min"] or 0) for r in by_condition.get(name, [])) / 60 / 4 * 1.3, 1)
             for name in chosen + controls}
    plan = sorted(chosen + controls, key=lambda name: -hours[name])
    (report / "verify-plan.md").write_text("\n".join(lines) + "\n")
    (report / "verify-plan.json").write_text(json.dumps({"conditions": plan, "hours": hours}, indent=1))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
