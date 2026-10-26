"""Command-line interface for the benchmark definition and result ledger."""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

from .contracts import Harness
from .core import (ROOT, Invalid, load_benchmark, load_run, read_json, read_results, summarize,
                   validate_result, verify_evidence, verify_packages)
from .runner import run_benchmark


def pilot_summary(benchmark):
    data = read_json(benchmark.root / "pilot/results.json")
    if data["benchmark_sha256"] != benchmark.digest:
        raise Invalid("Pilot belongs to another benchmark revision")
    meta = {"run_id": "historical-pilot", "benchmark_sha256": benchmark.digest,
            "profile_sha256": "historical-mixed-settings"}
    results = {}
    for item in data["tasks"]:
        task = benchmark.task(item["task_id"])
        result = {"schema_version": 1, **meta, "task_id": item["task_id"], "source_ref": task["source"]["ref"],
                  "status": item["status"], "reward": item["reward"], "checks": item["checks"],
                  "health": item["health"], "evidence": [dict(e, kind="native_result" if e["path"].endswith("native-result.json") else "verifier") for e in item["evidence"]]}
        validate_result(benchmark, meta, result)
        verify_evidence(benchmark.root / "pilot", result)
        if item["task_id"] in results:
            raise Invalid("Duplicate pilot task")
        results[item["task_id"]] = result
    report = summarize(benchmark, results)
    report.update(kind="historical_pilot", caveat=data["caveat"], parent_run_id=data["parent_run_id"])
    return report


def print_report(report, as_json=False):
    if as_json:
        print(json.dumps(report, indent=2))
        return
    print(report["benchmark"])
    if report.get("caveat"):
        print(report["caveat"])
    print(f"Coverage: {report['coverage']['valid_tasks']}/{report['coverage']['total_tasks']} valid tasks; "
          f"{report['coverage']['recorded_tasks']} recorded")
    print("Outcomes: " + ", ".join(f"{key}={value}" for key, value in report["counts"].items() if value))
    if report["valid"]:
        print(f"Task pass rate: {report['task_pass_percent']:.2f}%")
        print(f"Verification checks passed: {report['verification_pass_percent']:.2f}% "
              f"({report['checks']['passed_recorded']}/{report['checks']['total']})")
    else:
        print("Final scores withheld: every fixed task needs a valid Pass/Fail result and its complete check catalog.")


def main(argv=None):
    parser = argparse.ArgumentParser(description="T4-lite: frozen 24-task benchmark and evidence-backed scorer")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "verify", "pilot"):
        cmd = commands.add_parser(name)
        cmd.add_argument("--json", action="store_true")
    for name in ("report", "export"):
        cmd = commands.add_parser(name)
        cmd.add_argument("folder", type=Path)
        cmd.add_argument("--json", action="store_true")
    execute = commands.add_parser("run", help="Run pending tasks with an external harness",
                                  usage="%(prog)s FOLDER [options] -- HARNESS_COMMAND [ARG ...]")
    execute.add_argument("folder", type=Path)
    execute.add_argument("--model", default="")
    execute.add_argument("--agent", default="")
    execute.add_argument("--profile", type=Path, default=ROOT / "benchmark/reference-profile.json")
    execute.add_argument("--harness-env", action="append", default=[], metavar="NAME",
                         help="Copy this variable from the current environment into the harness only")
    execute.add_argument("--task", default="", help="Run one task id instead of every pending task")
    # Everything after `--` is the harness argv, so arguments like `python -u` are never parsed as options.
    argv = sys.argv[1:] if argv is None else list(argv)
    harness_command = argv[argv.index("--") + 1:] if "--" in argv else []
    argv = argv[:argv.index("--")] if "--" in argv else argv
    args = parser.parse_args(argv)
    if (args.command == "run") != bool(harness_command):
        parser.error("run needs a harness command after --" if args.command == "run"
                     else "-- HARNESS_COMMAND only applies to run")
    try:
        benchmark = load_benchmark()
        if args.command == "list":
            if args.json:
                print(json.dumps([{"id": t["id"], "category": t["category"], "checks": len(t["checks"]),
                                   "source": t["source"]} for t in benchmark.tasks], indent=2))
            else:
                for task in benchmark.tasks:
                    print(f"{task['category']:12} {len(task['checks']):3} checks  {task['id']}")
                print(f"Total: {len(benchmark.tasks)} tasks, {benchmark.manifest['check_count']} solution checks")
        elif args.command == "verify":
            print(json.dumps(verify_packages(benchmark), indent=2))
        elif args.command == "run":
            env = []
            for name in args.harness_env:
                if name not in os.environ:
                    raise Invalid(f"Harness environment {name} is not set")
                env.append((name, os.environ[name]))
            harness = Harness(command=tuple(harness_command), env=tuple(env))
            folder = args.folder
            if (folder / "run.json").exists():
                report = run_benchmark(benchmark, folder, harness, only=args.task or None)
            else:
                if not args.model or not args.agent:
                    raise Invalid("A new run needs --model and --agent")
                report = run_benchmark(benchmark, folder, harness, model=args.model, agent=args.agent,
                                       profile=read_json(args.profile), only=args.task or None)
            print_report(report)
            return 0 if report["valid"] else 1
        elif args.command == "pilot":
            print_report(pilot_summary(benchmark), args.json)
        else:
            load_run(benchmark, args.folder)
            results = read_results(benchmark, args.folder)
            report = summarize(benchmark, results)
            if args.command == "export":
                fields = ["task_id", "category", "status", "checks_passed", "checks_total", "notes"]
                writer = csv.DictWriter(sys.stdout, fieldnames=fields, lineterminator="\n")
                writer.writeheader()
                writer.writerows(report["tasks"])
            else:
                print_report(report, args.json)
                return 0 if report["valid"] else 1
        return 0
    except (Invalid, ValueError, OSError, KeyError, TypeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
