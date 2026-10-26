"""In-container PiMAS launch contract; never contacts Docker or a model."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from t4_lite.contracts import Harness
from t4_lite.core import Invalid, create_run, load_benchmark, load_run, read_results
from t4_lite.docker import DockerSession, compose_override, task_command
from t4_lite.pimas import SMOKE, ContainerSession, resolve_image, run_one, smoke


class ContainerTests(unittest.TestCase):
    def test_mounts_are_explicit_and_config_is_read_only(self):
        mounts = [("C:/attempt state", "/pimas-state", False), ("C:/config", "/pimas-config", True)]
        args = task_command(name="task", image="derived", cpus=2, memory_mb=8192, mounts=mounts)
        self.assertIn("type=bind,source=C:/attempt state,target=/pimas-state", args)
        self.assertIn("type=bind,source=C:/config,target=/pimas-config,readonly", args)
        self.assertNotIn("docker.sock", str(args))
        override = compose_override("derived", 2, 8192, mounts)
        self.assertIn('source: "C:/attempt state"', override)
        self.assertIn('target: "/pimas-config"\n        read_only: true', override)

    def test_image_must_match_task_base_and_is_resolved_to_an_id(self):
        info = [{"Id": "sha256:derived", "Config": {"Labels": {"org.pimas.task-base": "base@sha256:pinned"}}}]
        with patch("t4_lite.pimas._docker", return_value=subprocess.CompletedProcess([], 0, json.dumps(info).encode(), b"")):
            self.assertEqual(resolve_image("moving-tag", "base@sha256:pinned"), "sha256:derived")
            with self.assertRaises(Invalid):
                resolve_image("moving-tag", "another-base")

    def test_existing_attempt_state_is_never_reused_in_a_fresh_container(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "attempt"
            ContainerSession(image="derived", task_id="task", state=state)
            with self.assertRaises(FileExistsError):
                ContainerSession(image="derived", task_id="task", state=state)

    def test_launcher_runs_inside_container_and_does_not_put_secrets_in_argv(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = ContainerSession(image="derived", task_id="task", state=Path(tmp) / "state")
            session.container_id = "container-id"
            with patch.object(DockerSession, "spawn_harness") as spawn:
                session.spawn_harness(Harness(command=("/opt/pimas/src/container-bridge.ts",), env=(("MODEL_KEY", "secret-value"),)))
            harness = spawn.call_args.args[0]
            self.assertEqual(harness.command[:3], ("docker", "exec", "-i"))
            self.assertIn("PIMAS_CONTAINER_ID=container-id", harness.command)
            self.assertIn("MODEL_KEY", harness.command)
            self.assertNotIn("secret-value", " ".join(harness.command))
            self.assertEqual(harness.env, (("MODEL_KEY", "secret-value"),))

    def test_task_messages_carry_attempt_and_container_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = ContainerSession(image="derived", task_id="task", state=Path(tmp) / "state")
            session.project, session.container_id = "attempt-id", "container-id"
            with patch.object(DockerSession, "write") as write:
                session.write({"type": "task", "task_id": "task"})
            self.assertEqual(write.call_args.args[0]["attempt_id"], "attempt-id")
            self.assertEqual(write.call_args.args[0]["container_id"], "container-id")

    def test_missing_done_fails_before_accepting_a_grade(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = ContainerSession(image="derived", task_id="task", state=Path(tmp) / "state")
            with patch.object(session, "stop_harness"), patch.object(DockerSession, "grade") as grade:
                with self.assertRaises(Invalid):
                    session.grade()
                grade.assert_not_called()
                session.done = True
                session.grade()
                grade.assert_called_once()

    def test_native_launch_records_the_image_profile_and_official_reward(self):
        benchmark = load_benchmark()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / "config"
            config.mkdir()
            for name in ("models.json", "agents.json"):
                (config / name).write_text("{}", encoding="utf-8")
            session = Mock()
            session.stderr, session.copy_failures = "", []
            session.read_line.return_value = '{"type":"done"}\n'
            session.grade.return_value = (b"0\n", None, None, b"official verifier output")
            options = dict(task_id="react-lead-form", image="derived", config=config,
                           model="scripted", agent="pimas", profile={"schema_version": 1})
            folder = root / "run"
            with patch("t4_lite.pimas.resolve_image", return_value="sha256:derived"), \
                 patch("t4_lite.pimas.verify_packages"), \
                 patch("t4_lite.runner.prepare_docker"), \
                 patch("t4_lite.pimas.ContainerSession", return_value=session) as factory:
                run_one(benchmark, folder, **options)
                self.assertEqual(read_results(benchmark, folder)["react-lead-form"]["status"], "fail")
                profile = load_run(benchmark, folder)["profile"]
                self.assertEqual(profile["pimas_container"]["image_id"], "sha256:derived")
                self.assertEqual(factory.call_args.kwargs["state"], folder / "attempts/react-lead-form")
                factory.reset_mock()
                run_one(benchmark, folder, **options)
                factory.assert_not_called()
                with patch("t4_lite.pimas.resolve_image", return_value="sha256:changed"):
                    with self.assertRaises(Invalid):
                        run_one(benchmark, folder, **options)

    def test_pending_attempt_cannot_be_restarted_in_a_new_workspace(self):
        benchmark = load_benchmark()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / "config"
            config.mkdir()
            for name in ("models.json", "agents.json"):
                (config / name).write_text("{}", encoding="utf-8")
            task = benchmark.task("react-lead-form")
            from t4_lite.runner import layout_for
            integration = {"mode": "in-task-container", "task_id": task["id"], "image_id": "sha256:derived",
                           "base_image": layout_for(benchmark, task).image, "agent_failure": "missing-done-is-error"}
            folder = root / "run"
            create_run(benchmark, folder, model="scripted", agent="pimas",
                       profile={"schema_version": 1, "pimas_container": integration})
            (folder / "attempts" / task["id"]).mkdir(parents=True)
            with patch("t4_lite.pimas.resolve_image", return_value="sha256:derived"), \
                 patch("t4_lite.pimas.verify_packages"), \
                 patch("t4_lite.pimas.ContainerSession") as factory:
                with self.assertRaisesRegex(Invalid, "interrupted attempt"):
                    run_one(benchmark, folder, task_id=task["id"], image="derived", config=config,
                            model="scripted", agent="pimas", profile={"schema_version": 1})
                factory.assert_not_called()

    def test_implementation_smoke_requires_current_saved_approval_without_grading(self):
        benchmark = load_benchmark()
        for verdict in ("approved", "missing", "stale"):
            with self.subTest(verdict=verdict), tempfile.TemporaryDirectory() as tmp:
                session = Mock()
                session.state = Path(tmp)
                checkpoint = {"runId": "smoke-run", "orchestrator": {"status": "settled"},
                              "workflow": {"revision": 1, "plan": {"text": "smoke plan"}},
                              "agents": [{"role": "planner", "status": "settled"},
                                         {"role": "executor", "status": "settled"},
                                         {"role": "reviewer", "status": "settled"}]}
                if verdict != "missing":
                    checkpoint["agents"][2]["review"] = {"approved": True, "revision": 1 if verdict == "approved" else 0}
                with patch("t4_lite.pimas.resolve_image", return_value="sha256:derived"), \
                     patch("t4_lite.pimas.verify_packages"), \
                     patch("t4_lite.pimas.ContainerSession", return_value=session), \
                     patch("t4_lite.pimas.drive_harness", return_value="done"), \
                     patch("t4_lite.pimas.read_json", return_value=checkpoint):
                    if verdict == "approved":
                        report = smoke(benchmark, task_id="telecom-entity-resolution", image="derived", state=Path(tmp), implementation=True)
                        self.assertFalse(report["graded"])
                        self.assertEqual(report["workflow"], "implementation")
                    else:
                        with self.assertRaisesRegex(Invalid, "current independent approval"):
                            smoke(benchmark, task_id="telecom-entity-resolution", image="derived", state=Path(tmp), implementation=True)
                self.assertEqual(session.spawn_harness.call_args.args[0].command, (SMOKE, "--implementation"))
                session.grade.assert_not_called()
                session.close.assert_called_once()

    def test_stop_targets_the_container_group_even_after_host_client_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = ContainerSession(image="derived", task_id="task", state=Path(tmp) / "state")
            session.container_id = "container-id"
            with patch("t4_lite.pimas._docker") as docker:
                session.stop_harness()
            self.assertEqual(docker.call_args.args[0][:3], ["docker", "exec", "container-id"])
            self.assertIn("process.kill(-Number(s)", docker.call_args.args[0][-1])
            self.assertTrue((session.state / "harness-stderr.txt").is_file())


if __name__ == "__main__":
    unittest.main()
