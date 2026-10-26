"""Runner, harness protocol, and verifier mapping. No agent is implemented here."""
import ctypes
import dataclasses
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

from t4_lite.contracts import Harness
from t4_lite.core import ROOT, Invalid, create_run, load_benchmark, read_json, read_results
from t4_lite.docker import (CLEANUP_TIMEOUT_SEC, DockerSession, _docker, _pipe_docker, artifact_origin, compose_override,
                            prepare_docker, stream_copy_commands, task_command)
from t4_lite.grade import map_grade, parse_reward
from t4_lite.runner import drive_harness, images_for_tasks, layout_for, run_benchmark, run_task


class ProtocolTests(unittest.TestCase):
    def test_harness_requires_a_command_and_is_not_an_agent(self):
        with self.assertRaises(ValueError):
            Harness(command=())
        harness = Harness(command=("node", "dist/harness.js"), env=(("OPENAI_API_KEY", "secret"),))
        self.assertEqual(harness.command, ("node", "dist/harness.js"))
        self.assertEqual(harness.env, (("OPENAI_API_KEY", "secret"),))

    def test_exec_request_runs_in_the_task_and_result_returns(self):
        sent = []
        seen = []

        def read_line():
            if not seen:
                seen.append("exec")
                return '{"type":"exec","command":"ls /app","timeout":9}\n'
            return '{"type":"done"}\n'

        def execute(command, timeout, background):
            seen.append((command, timeout, background))
            return 0, "listed\n", ""

        outcome = drive_harness(read_line, sent.append, execute, {"type": "task", "task_id": "telecom-entity-resolution",
                                                                  "cwd": "/app", "prompt": "do the task"})
        self.assertEqual(outcome, "done")
        self.assertEqual(sent[0]["type"], "task")
        self.assertNotIn("task_host", sent[0])
        self.assertEqual(seen[1], ("ls /app", 9, False))
        self.assertEqual(sent[1], {"type": "exec_result", "exit_code": 0, "stdout": "listed\n", "stderr": ""})

    def test_closed_stdin_stops_the_exchange(self):
        self.assertEqual(drive_harness(lambda: None, lambda message: None, lambda *args: (0, "", ""),
                                       {"type": "task"}), "closed")

    def test_exec_timeout_above_profile_limit_is_clamped(self):
        seen = []

        def read_line():
            if not seen:
                return '{"type":"exec","command":"ls","timeout":1800}\n'
            return '{"type":"done"}\n'

        def execute(command, timeout, background):
            seen.append(timeout)
            return 0, "", ""

        outcome = drive_harness(read_line, lambda message: None, execute, {"type": "task"}, tool_limit=900)
        self.assertEqual(outcome, "done")
        self.assertEqual(seen, [900])

    def test_exec_timeout_is_capped_by_remaining_agent_time(self):
        seen = []

        def read_line():
            if not seen:
                return '{"type":"exec","command":"ls","timeout":100}\n'
            return '{"type":"done"}\n'

        def execute(command, timeout, background):
            seen.append(timeout)
            return 0, "", ""

        drive_harness(read_line, lambda message: None, execute, {"type": "task"}, tool_limit=900,
                      deadline=time.monotonic() + 30)
        self.assertEqual(len(seen), 1)
        self.assertLessEqual(seen[0], 30)
        self.assertLess(seen[0], 100)

    def test_exited_harness_skips_exec_result(self):
        sent = []
        state = {"read": False, "alive": True}

        def read_line():
            if not state["read"]:
                state["read"] = True
                return '{"type":"exec","command":"ls /app"}\n'
            return '{"type":"done"}\n'

        def execute(command, timeout, background):
            state["alive"] = False
            return 0, "ok\n", ""

        outcome = drive_harness(read_line, sent.append, execute, {"type": "task"}, alive=lambda: state["alive"])
        self.assertEqual(outcome, "closed")
        self.assertEqual([message["type"] for message in sent], ["task"])

    def test_write_failure_after_the_harness_exits_closes_the_exchange(self):
        for error in (BrokenPipeError(32, "Broken pipe"), OSError(22, "Invalid argument"), ValueError("closed file")):
            def write(message, error=error):
                if message["type"] == "exec_result":
                    raise error

            outcome = drive_harness(lambda: '{"type":"exec","command":"ls"}\n', write, lambda *args: (0, "", ""),
                                    {"type": "task"}, alive=lambda: True)
            self.assertEqual(outcome, "closed")


class GradeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.benchmark = load_benchmark()

    def test_ctrf_maps_onto_the_pilot_catalog(self):
        task = self.benchmark.task("telecom-entity-resolution")
        ctrf = json.loads((ROOT / "pilot/evidence/telecom-entity-resolution/ctrf.json").read_text(encoding="utf-8"))
        grade = map_grade(task, reward=0, ctrf=ctrf, trace=None)
        pilot = next(item for item in read_json(ROOT / "pilot/results.json")["tasks"]
                     if item["task_id"] == task["id"])
        self.assertEqual(grade.status, "fail")
        self.assertEqual(grade.reward, 0)
        self.assertEqual(grade.checks, pilot["checks"])

    def test_repeated_names_follow_occurrence(self):
        task = self.benchmark.task("live-database-cutover")
        repeated = [check for check in task["checks"] if check["name"].endswith("test_stage_b_seed_user_spot_check")]
        ctrf = {"results": {"tests": [
            {"name": repeated[0]["name"], "status": "passed"},
            {"name": repeated[0]["name"], "status": "failed"},
            {"name": repeated[0]["name"], "status": "skipped"},
            {"name": repeated[0]["name"], "status": "pending"},
        ]}}
        # Fill the other catalog names so mapping can complete.
        others = []
        seen = set()
        for check in task["checks"]:
            if check["name"] == repeated[0]["name"] or check["name"] in seen:
                continue
            seen.add(check["name"])
            others.append({"name": check["name"], "status": "passed"})
        ctrf["results"]["tests"] = others + ctrf["results"]["tests"]
        grade = map_grade(task, reward=0, ctrf=ctrf, trace=None)
        by_occ = {check["occurrence"]: check["id"] for check in repeated}
        self.assertEqual(grade.checks[by_occ[1]], "pass")
        self.assertEqual(grade.checks[by_occ[2]], "fail")
        self.assertEqual(grade.checks[by_occ[3]], "skipped")
        self.assertEqual(grade.checks[by_occ[4]], "not_run")

    def test_failed_health_check_is_an_error(self):
        task = self.benchmark.task("ontology-kg-querying")
        tests = []
        for check in [*task["checks"], *task["health_checks"]]:
            status = "failed" if check in task["health_checks"][:1] else "passed"
            tests.append({"name": check["name"], "status": status})
        grade = map_grade(task, reward=1, ctrf={"results": {"tests": tests}}, trace=None)
        self.assertEqual(grade.status, "error")
        self.assertIsNone(grade.reward)
        self.assertIn("health", grade.notes)

    def test_reward_is_not_inferred_from_checks(self):
        task = self.benchmark.task("telecom-entity-resolution")
        ctrf = {"results": {"tests": [{"name": check["name"], "status": "passed"} for check in task["checks"]]}}
        grade = map_grade(task, reward=0, ctrf=ctrf, trace=None)
        self.assertEqual(grade.status, "fail")
        self.assertTrue(all(value == "pass" for value in grade.checks.values()))

    def test_react_uses_the_reward_file_for_its_one_check(self):
        task = self.benchmark.task("react-lead-form")
        grade = map_grade(task, reward=1, ctrf=None, trace=None)
        self.assertEqual(grade.status, "pass")
        self.assertEqual(grade.checks, {"check-001": "pass"})

    def test_warranty_claims_map_from_trace(self):
        task = self.benchmark.task("heat-pump-warranty")
        trace = json.loads((ROOT / "pilot/evidence/heat-pump-warranty/trace_results.json").read_text(encoding="utf-8"))
        grade = map_grade(task, reward=0, ctrf=None, trace=trace)
        pilot = next(item for item in read_json(ROOT / "pilot/results.json")["tasks"]
                     if item["task_id"] == task["id"])
        self.assertEqual(grade.checks, pilot["checks"])

    def test_reward_file_accepts_only_a_binary_value(self):
        self.assertEqual(parse_reward("1\n"), 1)
        self.assertEqual(parse_reward("0"), 0)
        # heat-pump-warranty writes the reward with one decimal place.
        self.assertEqual(parse_reward("0.0\n"), 0)
        self.assertEqual(parse_reward("1.0\n"), 1)
        for text in ("", "true\n", "0.5\n", "nan\n", "inf\n", "2\n"):
            self.assertIsNone(parse_reward(text), text)

    def test_missing_check_identity_is_an_error(self):
        task = self.benchmark.task("telecom-entity-resolution")
        grade = map_grade(task, reward=0, ctrf={"results": {"tests": []}}, trace=None)
        self.assertEqual(grade.status, "error")
        self.assertIsNone(grade.reward)
        self.assertTrue(grade.notes)

    def test_tests_outside_the_catalog_are_an_error(self):
        task = self.benchmark.task("telecom-entity-resolution")
        tests = [{"name": check["name"], "status": "passed"} for check in task["checks"]]
        for extra in ({"name": "test_new_upstream_case", "status": "passed"}, dict(tests[0])):
            grade = map_grade(task, reward=1, ctrf={"results": {"tests": [*tests, extra]}}, trace=None)
            self.assertEqual(grade.status, "error")
            self.assertIsNone(grade.reward)
            self.assertIn(extra["name"], grade.notes)

    def test_a_stray_report_does_not_affect_tasks_without_ctrf_checks(self):
        task = self.benchmark.task("react-lead-form")
        stray = {"results": {"tests": [{"name": "vitest case", "status": "passed"}]}}
        self.assertEqual(map_grade(task, reward=1, ctrf=stray, trace=None).status, "pass")

    def test_every_pilot_report_matches_the_catalog_exactly(self):
        pilot = {item["task_id"]: item for item in read_json(ROOT / "pilot/results.json")["tasks"]}
        for task in self.benchmark.tasks:
            folder = ROOT / "pilot/evidence" / task["id"]
            ctrf = folder / "ctrf.json"
            trace = folder / "trace_results.json"
            grade = map_grade(task, reward=pilot[task["id"]]["reward"],
                              ctrf=json.loads(ctrf.read_text(encoding="utf-8")) if ctrf.exists() else None,
                              trace=json.loads(trace.read_text(encoding="utf-8")) if trace.exists() else None)
            self.assertEqual(grade.status, pilot[task["id"]]["status"], task["id"])
            self.assertEqual(grade.checks, pilot[task["id"]]["checks"], task["id"])


class LayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.benchmark = load_benchmark()

    def test_single_container_task_uses_the_pinned_images(self):
        layout = layout_for(self.benchmark, self.benchmark.task("telecom-entity-resolution"))
        self.assertIn("telecom-entity-resolution-environment", layout.image)
        self.assertIn("telecom-entity-resolution-verifier", layout.verifier_image)
        self.assertIsNone(layout.compose)
        self.assertEqual(layout.cpus, 2)
        self.assertEqual(layout.memory_mb, 8192)
        self.assertIn("Four CSV", layout.prompt)
        self.assertEqual(layout.artifacts, ("/app/output/customer_clusters.json",))

    def test_compose_task_keeps_its_file_and_collect_commands(self):
        task = self.benchmark.task("payments-pipeline-fix")
        layout = layout_for(self.benchmark, task)
        self.assertTrue(str(layout.compose).endswith("docker-compose.yaml"))
        self.assertGreaterEqual(len(layout.collect), 1)
        self.assertEqual(layout.collect[0]["service"], "kafka")
        package = tomllib.loads((self.benchmark.root / task["package"] / "task.toml").read_text(encoding="utf-8"))
        self.assertEqual((package["environment"]["cpus"], package["environment"]["memory_mb"]), (4, 8192))
        self.assertEqual((layout.cpus, layout.memory_mb), (task["resources"]["cpus"], task["resources"]["memory_mb"]))
        self.assertEqual((layout.cpus, layout.memory_mb), (6, 12288))
        self.assertEqual(artifact_origin(layout.artifacts[1]), ("kafka", "/tmp/kafka-snapshot.tgz"))

    def test_verifier_timeout_floor_uses_the_reference_profile(self):
        profile = read_json(ROOT / "benchmark/reference-profile.json")
        floor = profile["verifier_timeout_floor_seconds"]
        self.assertEqual(floor, 3600)
        self.assertEqual(profile["single_tool_elapsed_limit_seconds"], 900)
        self.assertEqual(profile["task_concurrency"], 2)
        expected = {
            "foodstuff-beta-activity": 120.0,
            "protein-autointerp-disulfide": 180.0,
            "layout-config-recreation": 180.0,
        }
        for task_id, task_timeout in expected.items():
            task = self.benchmark.task(task_id)
            self.assertEqual(task["verifier"]["timeout_sec"], task_timeout)
            self.assertEqual(layout_for(self.benchmark, task).verifier_timeout, task_timeout)
            self.assertEqual(layout_for(self.benchmark, task, profile).verifier_timeout, max(task_timeout, floor))

    def test_images_follow_the_selected_tasks_once(self):
        telecom = self.benchmark.task("telecom-entity-resolution")
        payments = self.benchmark.task("payments-pipeline-fix")
        one = images_for_tasks(self.benchmark, [telecom], None)
        layout = layout_for(self.benchmark, telecom)
        self.assertEqual(one, [layout.image, layout.verifier_image])
        pay = images_for_tasks(self.benchmark, [payments], None)
        self.assertEqual(len(pay), len(set(pay)))
        self.assertIn(layout_for(self.benchmark, payments).image, pay)
        self.assertIn(layout_for(self.benchmark, payments).verifier_image, pay)
        self.assertIn("apache/kafka-native:4.3.1", pay)
        self.assertEqual(images_for_tasks(self.benchmark, [telecom, telecom], None), one)


class DockerPlanTests(unittest.TestCase):
    def test_task_container_keeps_the_image_workspace(self):
        args = task_command(name="t4-task", image="env@sha256:abc", cpus=2, memory_mb=8192)
        text = " ".join(args)
        self.assertIn("env@sha256:abc", args)
        self.assertIn("8192m", args)
        self.assertNotIn("--network", args)
        self.assertNotIn("--mount", args)
        self.assertNotIn("docker.sock", text)
        self.assertNotIn("secret", text)

    def test_declared_artifact_copy_streams(self):
        file_src, file_dst = stream_copy_commands("task", "verifier", "/app/output/customer_clusters.json")
        self.assertEqual(file_src, ["docker", "cp", "task:/app/output/customer_clusters.json", "-"])
        self.assertEqual(file_dst, ["docker", "cp", "-", "verifier:/app/output"])
        outside_src, outside_dst = stream_copy_commands("task", "verifier", "/results/TB3_Conf_Answers.csv")
        self.assertEqual(outside_src, ["docker", "cp", "task:/results/TB3_Conf_Answers.csv", "-"])
        self.assertEqual(outside_dst, ["docker", "cp", "-", "verifier:/results"])
        root_src, root_dst = stream_copy_commands("task", "verifier", "/app")
        self.assertEqual(root_src, ["docker", "cp", "task:/app/.", "-"])
        self.assertEqual(root_dst, ["docker", "cp", "-", "verifier:/app"])
        self.assertNotIn("app/app", "".join(root_src + root_dst))
        directory_src, directory_dst = stream_copy_commands("task", "verifier", "/app/src/")
        self.assertEqual(directory_src, ["docker", "cp", "task:/app/src", "-"])
        self.assertEqual(directory_dst, ["docker", "cp", "-", "verifier:/app"])
        for command in (file_src, file_dst, outside_src, outside_dst, root_src, root_dst):
            self.assertNotIn("--mount", command)
            self.assertNotIn("-v", command)

    def test_compose_exec_uses_app_and_manifest_limits(self):
        benchmark = load_benchmark()
        layout = layout_for(benchmark, benchmark.task("payments-pipeline-fix"))
        text = compose_override(layout.image, layout.cpus, layout.memory_mb)
        self.assertIn('cpus: 6\n', text)
        self.assertIn("mem_limit: 12288m\n", text)
        self.assertIn('command: ["sleep", "infinity"]\n', text)
        session = DockerSession()
        session.layout = layout
        session._compose = ["docker", "compose", "-p", "p", "-f", "base.yml", "-f", "override.yml"]
        args = session.exec_args("ls /app", 10, False)
        self.assertEqual(args[args.index("-w") + 1], "/app")
        self.assertLess(args.index("-T"), args.index("main"))
        self.assertLess(args.index("-w"), args.index("main"))
        self.assertIn("timeout -k 10 10 sh -c", args[-1])
        self.assertNotIn("timeout", session.exec_args("sleep 1", 10, True)[-1])

    def test_docker_timeout_is_invalid_before_returncode(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            subprocess.run([sys.executable, "-c", "import time; time.sleep(5)"],
                           capture_output=True, timeout=0.2, check=False)
        with self.assertRaises(Invalid) as caught:
            _docker([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.2)
        self.assertIn("timed out", str(caught.exception))

    def test_prepare_docker_requires_the_daemon(self):
        def run(args, timeout=None, check=True):
            raise Invalid("Docker is not on PATH")

        with self.assertRaises(Invalid) as caught:
            prepare_docker(["env:latest"], run=run)
        self.assertIn("Docker", str(caught.exception))

    def test_prepare_docker_pulls_each_missing_image_once(self):
        calls = []

        class Completed:
            def __init__(self, code):
                self.returncode = code

        def run(args, timeout=None, check=True):
            calls.append(list(args))
            if args[:2] == ["docker", "version"]:
                return Completed(0)
            if args[:3] == ["docker", "image", "inspect"]:
                return Completed(0 if args[3] == "present:tag" else 1)
            if args[:2] == ["docker", "pull"]:
                if args[2] == "broken:tag":
                    raise Invalid("pull failed")
                return Completed(0)
            raise AssertionError(args)

        prepare_docker(["present:tag", "missing:tag", "present:tag"], run=run)
        self.assertEqual(calls, [
            ["docker", "version"],
            ["docker", "image", "inspect", "present:tag"],
            ["docker", "image", "inspect", "missing:tag"],
            ["docker", "pull", "missing:tag"],
        ])
        with self.assertRaises(Invalid) as caught:
            prepare_docker(["broken:tag"], run=run)
        self.assertIn("pull failed", str(caught.exception))
        self.assertEqual(calls[-1], ["docker", "pull", "broken:tag"])

    def test_artifact_pipe_timeout_does_not_hang(self):
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            _pipe_docker(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                [sys.executable, "-c", "import sys, time; sys.stdin.read(); time.sleep(30)"],
                timeout=0.3,
            )
        self.assertLess(time.monotonic() - started, 15)

    def test_read_line_stops_at_the_deadline(self):
        session = DockerSession()
        try:
            session.spawn_harness(Harness(command=(sys.executable, "-c", "import time; time.sleep(30)")))
            session.arm_deadline(time.monotonic() + 0.3)
            started = time.monotonic()
            self.assertIsNone(session.read_line())
            self.assertLess(time.monotonic() - started, 5)
        finally:
            session.stop_harness()

    def test_stop_harness_kills_descendant_processes(self):
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = Path(tmp) / "child.pid"
            code = (
                "import os,subprocess,sys,time,pathlib;"
                "p=pathlib.Path(os.environ['PIDFILE']);"
                "c=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)']);"
                "p.write_text(str(c.pid));"
                "time.sleep(120)"
            )
            session = DockerSession()
            try:
                session.spawn_harness(Harness(
                    command=(sys.executable, "-c", code), env=(("PIDFILE", str(pidfile)),)))
                deadline = time.monotonic() + 5
                while not pidfile.is_file() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(pidfile.is_file(), "descendant did not start")
                pid = int(pidfile.read_text())
                session.stop_harness()
                self.assertIsNotNone(session.proc.poll())
                alive = True
                for _ in range(30):
                    alive = _process_alive(pid)
                    if not alive:
                        break
                    time.sleep(0.1)
                self.assertFalse(alive)
            finally:
                session.stop_harness()

    def _close_session(self, stop, fake_docker):
        """Run close() on a session with two cleanup commands; returns (error, calls, timeouts, work, session)."""
        session = DockerSession()
        session._cleanup = [
            ["docker", "rm", "-f", "t4-task"],
            ["docker", "compose", "-p", "p", "down", "--volumes"],
        ]
        session.stop_harness = stop
        calls, timeouts = [], []

        def recording_docker(args, timeout=None, check=True):
            calls.append(list(args))
            timeouts.append(timeout)
            return fake_docker(args)

        with tempfile.TemporaryDirectory() as tmp:
            session.work = work = Path(tmp) / "work"
            work.mkdir()
            error = None
            with patch("t4_lite.docker._docker", recording_docker):
                try:
                    session.close()
                except Invalid as caught:
                    error = caught
            return error, calls, timeouts, work.exists(), session

    def test_close_removes_containers_when_stop_harness_raises(self):
        def stop():
            raise Invalid("Harness did not exit after the agent timeout")

        error, calls, _, work_exists, session = self._close_session(
            stop, lambda args: subprocess.CompletedProcess(args, 0, b"", b""))
        self.assertEqual(str(error), "Harness did not exit after the agent timeout")
        self.assertEqual(calls, [
            ["docker", "compose", "-p", "p", "down", "--volumes"],
            ["docker", "rm", "-f", "t4-task"],
        ])
        self.assertFalse(work_exists)
        self.assertIsNone(session.work)
        self.assertEqual(session._cleanup, [])

    def test_close_attempts_every_cleanup_command_and_names_failures(self):
        def fake_docker(args):
            if args[:2] == ["docker", "compose"]:
                raise Invalid("compose down failed")
            return subprocess.CompletedProcess(args, 0, b"", b"")

        error, calls, _, work_exists, _ = self._close_session(lambda: None, fake_docker)
        self.assertIn("compose down failed", str(error))
        self.assertEqual(len(calls), 2)
        self.assertFalse(work_exists)

    def test_close_passes_a_cleanup_timeout(self):
        _, _, timeouts, _, _ = self._close_session(
            lambda: None, lambda args: subprocess.CompletedProcess(args, 0, b"", b""))
        self.assertEqual(timeouts, [CLEANUP_TIMEOUT_SEC, CLEANUP_TIMEOUT_SEC])


class ScriptedSession:
    """A fake session. reward, ctrf, and trace are the raw bytes grade() returns, None when absent."""

    def __init__(self, lines, reward, ctrf=None, trace=None):
        self.lines = list(lines)
        self.reward_raw = reward
        self.ctrf_raw = ctrf
        self.trace_raw = trace
        self.execs = []
        self.spawned = None
        self.closed = False
        self.sent = []
        self.stderr = ""
        self.copy_failures = []
        self.deadline = None
        self.stopped = False

    def open(self, layout):
        self.layout = layout

    def spawn_harness(self, harness):
        self.spawned = harness

    def arm_deadline(self, deadline):
        self.deadline = deadline

    def stop_harness(self):
        self.stopped = True

    def harness_running(self):
        return True

    def read_line(self):
        return self.lines.pop(0) if self.lines else None

    def write(self, message):
        self.sent.append(message)

    def execute(self, command, timeout, background):
        self.execs.append((command, timeout, background))
        return 0, "", ""

    def grade(self):
        return self.reward_raw, self.ctrf_raw, self.trace_raw, b"verifier log"

    def close(self):
        self.closed = True


class RunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.benchmark = load_benchmark()

    def setUp(self):
        (ROOT / "tests/.tmp").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / "tests/.tmp")
        self.run = Path(self.temp.name) / "run"
        self.meta = create_run(self.benchmark, self.run, model="test-model", agent="pi-custom",
                               profile={"schema_version": 1, "label": "test"})

    def tearDown(self):
        self.temp.cleanup()

    def test_one_task_drives_the_harness_then_records_the_grade(self):
        task = self.benchmark.task("telecom-entity-resolution")
        ctrf = (ROOT / "pilot/evidence/telecom-entity-resolution/ctrf.json").read_bytes()
        session = ScriptedSession(
            ['{"type":"exec","command":"ls /app","background":true}\n', '{"type":"done"}\n'],
            b"0\n", ctrf)
        harness = Harness(command=("node", "dist/harness.js"), env=(("OPENAI_API_KEY", "secret"),))
        status = run_task(self.benchmark, self.run, task, harness, session)
        self.assertEqual(status, "recorded")
        self.assertEqual(session.spawned.command, ("node", "dist/harness.js"))
        self.assertEqual(session.execs, [("ls /app", 900, True)])
        self.assertEqual(session.sent[0]["cwd"], "/app")
        self.assertNotIn("task_host", session.sent[0])
        self.assertEqual(session.sent[0]["prompt"][:4], "<!--")
        self.assertTrue(session.closed)
        stored = read_results(self.benchmark, self.run)[task["id"]]
        self.assertEqual(stored["status"], "fail")
        self.assertEqual(stored["reward"], 0)
        self.assertEqual(stored["run_id"], self.meta["run_id"])
        self.assertNotIn("secret", json.dumps(read_json(self.run / "run.json")))

    def test_ontology_bootstrap_failure_commits_a_fail_with_every_check_not_run(self):
        # The exact report ontology's verifier wrote on real Docker when pipeline.py was missing.
        task = self.benchmark.task("ontology-kg-querying")
        ctrf = json.dumps({"results": {"tests": [{"name": "verifier_bootstrap", "status": "failed",
                                                  "message": "Missing required file: pipeline.py"}]}}).encode()
        run_task(self.benchmark, self.run, task, Harness(command=("node", "harness.js")),
                 ScriptedSession(['{"type":"done"}\n'], b"0\n", ctrf))
        stored = read_results(self.benchmark, self.run)[task["id"]]
        self.assertEqual((stored["status"], stored["reward"]), ("fail", 0))
        self.assertEqual(set(stored["checks"].values()), {"not_run"})
        self.assertEqual(len(stored["checks"]), len(task["checks"]))
        self.assertEqual(set(stored["health"].values()), {"not_run"})
        self.assertIn("pipeline.py", stored["notes"])

    def test_bootstrap_exception_is_narrow(self):
        ontology = self.benchmark.task("ontology-kg-querying")
        bootstrap = {"name": "verifier_bootstrap", "status": "failed"}
        cases = [
            (ontology, 1, [bootstrap]),                                         # a pass cannot be a bootstrap failure
            (ontology, 0, [bootstrap, {"name": "other", "status": "failed"}]),  # anything else in the report
            (ontology, 0, [dict(bootstrap, status="passed")]),
            (self.benchmark.task("telecom-entity-resolution"), 0, [bootstrap]),  # only ontology's verifier
        ]
        for task, reward, tests in cases:
            grade = map_grade(task, reward=reward, ctrf={"results": {"tests": tests}}, trace=None)
            self.assertEqual(grade.status, "error", (task["id"], reward, tests))

    def test_missing_reward_is_an_error_without_reward_evidence(self):
        task = self.benchmark.task("react-lead-form")
        session = ScriptedSession(['{"type":"done"}\n'], None)
        run_task(self.benchmark, self.run, task, Harness(command=("node", "harness.js")), session)
        stored = read_results(self.benchmark, self.run)[task["id"]]
        folder = self.run / "results" / task["id"]
        self.assertEqual(stored["status"], "error")
        self.assertIsNone(stored["reward"])
        self.assertIn("reward.txt", stored["notes"])
        self.assertFalse((folder / "reward.txt").exists())
        self.assertFalse((folder / "ctrf.json").exists())
        self.assertEqual([item["kind"] for item in stored["evidence"]], ["verifier"])

    def test_empty_reward_is_stored_and_is_an_error(self):
        task = self.benchmark.task("react-lead-form")
        session = ScriptedSession(['{"type":"done"}\n'], b"")
        run_task(self.benchmark, self.run, task, Harness(command=("node", "harness.js")), session)
        stored = read_results(self.benchmark, self.run)[task["id"]]
        self.assertEqual(stored["status"], "error")
        self.assertIsNone(stored["reward"])
        self.assertNotIn("not written", stored["notes"])
        self.assertEqual((self.run / "results" / task["id"] / "reward.txt").read_bytes(), b"")
        hashed = next(item for item in stored["evidence"] if item["path"] == "reward.txt")
        self.assertEqual(hashed["kind"], "native_result")
        self.assertEqual(hashed["sha256"], hashlib.sha256(b"").hexdigest())

    def test_stored_profile_raises_the_verifier_floor(self):
        profile = read_json(ROOT / "benchmark/reference-profile.json")
        folder = Path(self.temp.name) / "profiled"
        create_run(self.benchmark, folder, model="test-model", agent="pi-custom", profile=profile)
        task = self.benchmark.task("foodstuff-beta-activity")
        session = ScriptedSession(['{"type":"done"}\n'], b"")
        run_task(self.benchmark, folder, task, Harness(command=("node", "harness.js")), session)
        floor = profile["verifier_timeout_floor_seconds"]
        self.assertEqual(session.layout.verifier_timeout, max(task["verifier"]["timeout_sec"], floor))

    def test_exec_timeout_above_profile_limit_is_graded(self):
        folder = Path(self.temp.name) / "limited"
        create_run(self.benchmark, folder, model="test-model", agent="pi-custom",
                   profile={"schema_version": 1, "label": "limited", "single_tool_elapsed_limit_seconds": 30})
        task = self.benchmark.task("react-lead-form")
        session = ScriptedSession(
            ['{"type":"exec","command":"sleep 99999","timeout":100}\n', '{"type":"done"}\n'], b"1\n")
        run_task(self.benchmark, folder, task, Harness(command=("node", "harness.js")), session)
        stored = read_results(self.benchmark, folder)[task["id"]]
        self.assertEqual(session.execs, [("sleep 99999", 30, False)])
        self.assertEqual(stored["status"], "pass")
        self.assertEqual(stored["reward"], 1)
        self.assertEqual(stored["checks"], {"check-001": "pass"})
        self.assertNotIn("single-tool", stored["notes"])

    def test_agent_deadline_grades_without_writing_exec_result(self):
        # The clock is explicit. execute moves it onto the deadline, so the outcome does not depend on a sleep.
        task = self.benchmark.task("react-lead-form")
        clock = {"now": 1000.0}
        session = _DeadlineSession(clock, b"1\n", move_on="execute")

        def short_layout(benchmark, task, profile=None):
            return dataclasses.replace(layout_for(benchmark, task, profile), agent_timeout=5.0)

        with patch("t4_lite.runner.time.monotonic", lambda: clock["now"]), patch("t4_lite.runner.layout_for", short_layout):
            status = run_task(self.benchmark, self.run, task, Harness(command=("node", "harness.js")), session)
        stored = read_results(self.benchmark, self.run)[task["id"]]
        self.assertEqual(status, "recorded")
        self.assertEqual(stored["status"], "pass")
        self.assertEqual(stored["reward"], 1)
        self.assertEqual(stored["checks"], {"check-001": "pass"})
        self.assertIn("agent timeout", stored["notes"])
        self.assertEqual(session.execs, [("ls /app", 5.0, False)])
        self.assertNotIn("exec_result", [message.get("type") for message in session.sent])
        self.assertFalse(session.stopped)
        self.assertTrue(session.closed)

    def test_harness_exit_during_exec_is_graded(self):
        task = self.benchmark.task("react-lead-form")
        session = _ExitsDuringExec(b"1\n")
        status = run_task(self.benchmark, self.run, task, Harness(command=("node", "harness.js")), session)
        stored = read_results(self.benchmark, self.run)[task["id"]]
        self.assertEqual(status, "recorded")
        self.assertEqual(stored["status"], "pass")
        self.assertEqual(stored["reward"], 1)
        self.assertEqual(stored["checks"], {"check-001": "pass"})
        self.assertNotIn("exec_result", [message.get("type") for message in session.sent])
        self.assertNotIn("OSError", stored["notes"])
        self.assertTrue(session.closed)

    def test_oserror_on_exec_result_is_graded(self):
        task = self.benchmark.task("react-lead-form")
        session = ScriptedSession(['{"type":"exec","command":"ls /app"}\n'], b"1\n")

        def write(message):
            session.sent.append(message)
            if message.get("type") == "exec_result":
                raise OSError(22, "Invalid argument")

        session.write = write
        run_task(self.benchmark, self.run, task, Harness(command=("node", "harness.js")), session)
        stored = read_results(self.benchmark, self.run)[task["id"]]
        self.assertEqual(stored["status"], "pass")
        self.assertNotIn("OSError", stored["notes"])

    def test_raw_verifier_bytes_are_evidence(self):
        task = self.benchmark.task("telecom-entity-resolution")
        reward = b"0\n"
        ctrf_bytes = (ROOT / "pilot/evidence/telecom-entity-resolution/ctrf.json").read_bytes()
        trace_bytes = b'{"cases":{"claim":{"passed":false}}}\n'
        session = ScriptedSession(['{"type":"done"}\n'], reward, ctrf_bytes, trace_bytes)
        run_task(self.benchmark, self.run, task, Harness(command=("node", "harness.js")), session)
        folder = self.run / "results" / task["id"]
        stored = read_results(self.benchmark, self.run)[task["id"]]
        self.assertEqual(stored["status"], "fail")
        self.assertEqual(stored["reward"], 0)
        self.assertFalse((folder / "native-result.json").exists())
        self.assertEqual((folder / "reward.txt").read_bytes(), reward)
        self.assertEqual((folder / "ctrf.json").read_bytes(), ctrf_bytes)
        self.assertEqual((folder / "trace_results.json").read_bytes(), trace_bytes)
        by_path = {item["path"]: item["sha256"] for item in stored["evidence"]}
        self.assertEqual(by_path["reward.txt"], hashlib.sha256(reward).hexdigest())
        self.assertEqual(by_path["ctrf.json"], hashlib.sha256(ctrf_bytes).hexdigest())
        self.assertEqual(by_path["trace_results.json"], hashlib.sha256(trace_bytes).hexdigest())
        kinds = {item["path"]: item["kind"] for item in stored["evidence"]}
        self.assertEqual(kinds, {"reward.txt": "native_result", "verifier-output.json": "verifier",
                                 "ctrf.json": "verifier", "trace_results.json": "verifier"})
        self.assertEqual(read_json(folder / "verifier-output.json"), {"log": "verifier log"})

    def test_error_results_validate_without_native_result(self):
        task = self.benchmark.task("wdm-design")
        run_task(self.benchmark, self.run, task, Harness(command=("node", "harness.js")), _StopFails())
        stored = read_results(self.benchmark, self.run)[task["id"]]
        self.assertEqual(stored["status"], "error")
        self.assertNotIn("native_result", [item["kind"] for item in stored["evidence"]])

    def test_failed_artifact_copies_are_noted(self):
        task = self.benchmark.task("react-lead-form")
        session = ScriptedSession(['{"type":"done"}\n'], b"1\n")
        session.copy_failures = ["/app/missing.json", "/tmp/other"]
        run_task(self.benchmark, self.run, task, Harness(command=("node", "harness.js")), session)
        stored = read_results(self.benchmark, self.run)[task["id"]]
        self.assertEqual(stored["status"], "pass")
        self.assertEqual(stored["notes"], "Failed to copy: /app/missing.json, /tmp/other")

    def test_error_path_saves_harness_stderr(self):
        task = self.benchmark.task("telecom-entity-resolution")
        session = _StderrSession()
        run_task(self.benchmark, self.run, task, Harness(command=("node", "harness.js")), session)
        stored = read_results(self.benchmark, self.run)[task["id"]]
        self.assertEqual(stored["status"], "error")
        self.assertTrue(session.stopped)
        text = (self.run / "results" / task["id"] / "harness-stderr.txt").read_text(encoding="utf-8")
        self.assertEqual(text, "harness exploded\n")
        self.assertTrue(any(item["path"] == "harness-stderr.txt" for item in stored["evidence"]))

    def test_stop_harness_failure_keeps_the_original_error(self):
        task = self.benchmark.task("wdm-design")
        session = _StopFails()
        run_task(self.benchmark, self.run, task, Harness(command=("node", "harness.js")), session)
        stored = read_results(self.benchmark, self.run)[task["id"]]
        self.assertEqual(stored["status"], "error")
        self.assertIn("Harness sent invalid JSON", stored["notes"])
        self.assertNotIn("stop failed", stored["notes"])

    def test_task_errors_are_committed_and_the_run_continues(self):
        ids = [task["id"] for task in self.benchmark.tasks]
        made = []
        order = []

        def ensure(images):
            order.append("ensure")
            self.assertEqual(read_results(self.benchmark, self.run), {})
            self.assertEqual(len(images), len(set(images)))
            self.assertGreaterEqual(len(images), 2)

        def factory():
            order.append("session")
            kind = ("exec", "json", "grade")[len(made)] if len(made) < 3 else "ok"
            session = BoomSession(kind) if kind != "ok" else ScriptedSession(['{"type":"done"}\n'], b"")
            made.append(session)
            return session

        report = run_benchmark(self.benchmark, self.run, Harness(command=("node", "harness.js")),
                               session_factory=factory, ensure_docker=ensure)
        stored = read_results(self.benchmark, self.run)
        self.assertEqual(len(made), len(ids))
        self.assertEqual(set(stored), set(ids))
        self.assertEqual(stored[ids[0]]["status"], "error")
        self.assertIsNone(stored[ids[0]]["reward"])
        self.assertEqual(stored[ids[0]]["checks"], {})
        self.assertIn("TimeoutExpired", stored[ids[0]]["notes"])
        self.assertIn("Harness sent invalid JSON", stored[ids[1]]["notes"])
        self.assertIsNone(stored[ids[1]]["reward"])
        self.assertIn("verifier container failed", stored[ids[2]]["notes"])
        self.assertIn(ids[3], stored)
        self.assertFalse(report["valid"])
        self.assertEqual(0 if report["valid"] else 1, 1)
        self.assertTrue(all(getattr(session, "closed", False) for session in made))
        self.assertEqual(order[0], "ensure")
        self.assertEqual(order.count("ensure"), 1)
        self.assertEqual(order.count("session"), len(ids))

    def test_docker_preflight_failure_commits_nothing(self):
        seen = []

        def ensure(images):
            seen.append(list(images))
            self.assertEqual(read_results(self.benchmark, self.run), {})
            raise Invalid("Docker is not on PATH")

        with self.assertRaises(Invalid) as caught:
            run_benchmark(self.benchmark, self.run, Harness(command=("node", "harness.js")),
                          only="telecom-entity-resolution", ensure_docker=ensure,
                          session_factory=lambda: self.fail("task started"))
        layout = layout_for(self.benchmark, self.benchmark.task("telecom-entity-resolution"))
        self.assertEqual(seen, [[layout.image, layout.verifier_image]])
        self.assertIn("Docker", str(caught.exception))
        self.assertEqual(read_results(self.benchmark, self.run), {})

    def test_docker_preflight_failure_does_not_create_a_run(self):
        folder = Path(self.temp.name) / "fresh"

        def ensure(images):
            raise Invalid("docker down")

        with self.assertRaises(Invalid):
            run_benchmark(self.benchmark, folder, Harness(command=("node", "harness.js")),
                          model="test-model", agent="pi-custom",
                          profile={"schema_version": 1, "label": "test"},
                          only="react-lead-form", ensure_docker=ensure,
                          session_factory=lambda: self.fail("task started"))
        self.assertFalse((folder / "run.json").exists())

    def test_unknown_task_does_not_create_a_run(self):
        import contextlib
        import io

        from t4_lite.__main__ import main

        folder = Path(self.temp.name) / "typo"
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = main(["run", str(folder), "--model", "test-model", "--agent", "pi-custom",
                         "--task", "not-a-real-task", "--", "node", "harness.js"])
        self.assertEqual(code, 2)
        self.assertIn("outside this benchmark", err.getvalue())
        self.assertIn("not-a-real-task", err.getvalue())
        self.assertFalse(folder.exists())

    def test_harness_command_after_double_dash_keeps_its_own_options(self):
        import contextlib
        import io

        from t4_lite.__main__ import main

        seen = {}

        def fake_run(benchmark, folder, harness, **kwargs):
            seen["command"] = harness.command
            return {"valid": False, "benchmark": "t", "coverage": {"valid_tasks": 0, "total_tasks": 24,
                    "recorded_tasks": 0}, "counts": {}}

        with patch("t4_lite.__main__.run_benchmark", fake_run), contextlib.redirect_stdout(io.StringIO()):
            main(["run", str(self.run), "--", "python", "-u", "harness.py", "--model", "x"])
        self.assertEqual(seen["command"], ("python", "-u", "harness.py", "--model", "x"))

        for argv in (["run", str(self.run)], ["report", str(self.run), "--", "node"]):
            with self.assertRaises(SystemExit) as caught, contextlib.redirect_stderr(io.StringIO()):
                main(argv)
            self.assertEqual(caught.exception.code, 2)


class _DeadlineSession(ScriptedSession):
    """One exec, then the deadline. Time moves only when this session says so."""

    def __init__(self, clock, reward, move_on, error=None):
        super().__init__([], reward)
        self.clock = clock
        self.move_on = move_on
        self.error = error
        self._asked = False

    def read_line(self):
        if not self._asked:
            self._asked = True
            if self.clock["now"] >= self.deadline:
                raise AssertionError("exec was issued after the deadline")
            return '{"type":"exec","command":"ls /app","timeout":30}\n'
        if self.clock["now"] < self.deadline:
            raise AssertionError("read_line resumed before the deadline")
        return None

    def execute(self, command, timeout, background):
        self.execs.append((command, timeout, background))
        if self.move_on == "execute":
            self.clock["now"] = self.deadline
        return 0, "ok\n", ""

    def write(self, message):
        self.sent.append(message)
        if message.get("type") != "exec_result":
            return
        if self.move_on == "write":
            self.clock["now"] = self.deadline
        if self.clock["now"] >= self.deadline:
            raise self.error or ValueError("I/O operation on closed file")


class _ExitsDuringExec(ScriptedSession):
    def __init__(self, reward):
        super().__init__([], reward)
        self._asked = False
        self._alive = True

    def read_line(self):
        if not self._asked:
            self._asked = True
            return '{"type":"exec","command":"ls /app","timeout":5}\n'
        return None

    def execute(self, command, timeout, background):
        self.execs.append((command, timeout, background))
        self._alive = False
        return 0, "ok\n", ""

    def harness_running(self):
        return self._alive


class _StderrSession(ScriptedSession):
    def __init__(self):
        super().__init__([], b"")

    def read_line(self):
        return "not json\n"

    def stop_harness(self):
        self.stopped = True
        self.stderr = "harness exploded\n"


class _StopFails(ScriptedSession):
    def __init__(self):
        super().__init__([], b"")

    def read_line(self):
        raise Invalid("Harness sent invalid JSON")

    def stop_harness(self):
        raise RuntimeError("stop failed")


class BoomSession(ScriptedSession):
    def __init__(self, kind):
        super().__init__(['{"type":"done"}\n'], b"")
        self.kind = kind
        self._asked = False

    def read_line(self):
        if self.kind == "exec":
            if not self._asked:
                self._asked = True
                return '{"type":"exec","command":"ls /app","timeout":1}\n'
            return None
        if self.kind == "json":
            return "not json\n"
        return super().read_line()

    def execute(self, command, timeout, background):
        if self.kind == "exec":
            raise subprocess.TimeoutExpired(["docker", "exec"], 1)
        return super().execute(command, timeout, background)

    def grade(self):
        if self.kind == "grade":
            raise Invalid("verifier container failed")
        return super().grade()


def _process_alive(pid: int) -> bool:
    if sys.platform == "win32":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel.GetExitCodeProcess.restype = ctypes.c_int
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        code = ctypes.c_uint32()
        ok = kernel.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel.CloseHandle(handle)
        return bool(ok) and code.value == 259
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


if __name__ == "__main__":
    unittest.main()
