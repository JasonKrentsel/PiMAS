import csv
import json
import tempfile
import unittest
from pathlib import Path

from pimas_harbor import collect


def trial(job: Path, name: str, task: str, reward, tests: list[tuple[str, str]] | None, status: str = "completed"):
    directory = job / name
    (directory / "verifier").mkdir(parents=True)
    (directory / "agent" / "pimas" / "sessions").mkdir(parents=True)
    (directory / "result.json").write_text(json.dumps({
        "task_name": f"terminal-bench/{task}", "trial_name": name, "agent_info": {"name": "pimas"},
        "verifier_result": None if reward is None else {"rewards": {"reward": reward}},
        "exception_info": None if reward is not None else {"exception_type": "AgentTimeoutError"},
        "agent_execution": {"started_at": "2026-10-27T10:00:00+00:00", "finished_at": "2026-10-27T10:01:30+00:00"},
    }))
    if tests is not None:
        (directory / "verifier" / "ctrf.json").write_text(json.dumps({"results": {"tests": [
            {"name": test_name, "status": test_status} for test_name, test_status in tests
        ]}}))
    events = [
        {"type": "stage_start", "id": "research", "stage": "research"},
        {"type": "tool_call", "stageId": "research", "call": {}},
        {"type": "stage_end", "artifact": {"id": "research", "status": "submitted", "latencyMs": 2000, "changedFiles": [],
                                           "usage": {"input": 100, "cacheRead": 50, "output": 10}}},
        {"type": "stage_start", "id": "execute", "stage": "execute"},
        {"type": "run_end", "status": status},
    ]
    (directory / "agent" / "pimas" / "provenance.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events) + '{"truncated')
    (directory / "agent" / "pimas" / "sessions" / "a.jsonl").write_text(
        json.dumps({"type": "message", "message": {"role": "assistant", "usage": {"input": 100, "cacheRead": 50, "output": 10}}}) + "\n"
        + json.dumps({"type": "compaction", "usage": {"input": 5, "output": 1}}) + "\n"
    )


class CollectTest(unittest.TestCase):
    def test_rows_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            jobs = Path(tmp)
            job = jobs / "pipeline-r1"
            job.mkdir()
            (job / "result.json").write_text("{}")  # job-level result, not a trial
            trial(job, "mvcc__a", "mvcc-lsm-compaction", 1, [
                ("test_visibility.py::test_reference_model_is_checked_by_independent_timeline_oracle", "passed"),
                ("test_a", "passed"), ("test_b", "passed"),
            ])
            trial(job, "wdm__a", "wdm-design", 0, [("t1", "passed"), ("t2", "failed"), ("t3", "skipped"), ("t4", "failed")])
            trial(job, "wdm__b", "wdm-design", None, None, status="interrupted")

            rows_file, summary_file = jobs / "rows.csv", jobs / "summary.csv"
            self.assertEqual(collect.main([str(jobs), "--rows", str(rows_file), "--summary", str(summary_file)]), 0)
            with rows_file.open() as handle:
                rows = {row["trial"]: row for row in csv.DictReader(handle)}
            self.assertEqual(set(rows), {"mvcc__a", "wdm__a", "wdm__b"})
            # The verifier self-test is excluded from the check fraction.
            self.assertEqual((rows["mvcc__a"]["checks_passed"], rows["mvcc__a"]["checks_total"]), ("2", "2"))
            self.assertEqual(rows["wdm__a"]["check_fraction"], "0.25")
            self.assertEqual(rows["wdm__b"]["exception"], "AgentTimeoutError")
            self.assertEqual(rows["wdm__b"]["pimas_status"], "interrupted")
            self.assertEqual(rows["mvcc__a"]["input_tokens"], "155")
            self.assertEqual(rows["mvcc__a"]["agent_seconds"], "90.0")
            self.assertEqual(rows["mvcc__a"]["research_seconds"], "2.0")
            self.assertEqual(rows["mvcc__a"]["execute_status"], "unfinished")

            with summary_file.open() as handle:
                summary = list(csv.DictReader(handle))
            self.assertEqual(len(summary), 1)
            self.assertEqual(summary[0]["condition"], "pipeline-r1")
            self.assertEqual(summary[0]["graded_trials"], "2")
            self.assertEqual(summary[0]["errored_trials"], "1")
            self.assertEqual(float(summary[0]["pass_rate"]), 0.5)
            self.assertEqual(float(summary[0]["check_fraction"]), 0.625)


if __name__ == "__main__":
    unittest.main()
