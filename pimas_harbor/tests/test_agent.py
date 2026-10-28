import asyncio
import gzip
import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from harbor.environments.base import ExecResult
    from harbor.models.agent.context import AgentContext
    from pimas_harbor.agent import PimasAgent
    from pimas_harbor.records import RunFilesystem
except ImportError:  # Harbor is only needed for the agent, not the collector.
    PimasAgent = None

REPO = Path(__file__).resolve().parents[2]


class LocalEnvironment:
    """The slice of Harbor's BaseEnvironment the agent uses, backed by local bash."""

    def __init__(self, workdir: Path):
        self.workdir = workdir
        self.commands: list[str] = []

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        self.commands.append(command)
        process = await asyncio.create_subprocess_exec(
            "bash", "-c", command, cwd=cwd or self.workdir,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout_sec)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError(f"Command timed out after {timeout_sec} seconds")
        return ExecResult(stdout=stdout.decode(), stderr=stderr.decode(), return_code=process.returncode)

    async def download_file(self, source_path, target_path):
        Path(target_path).write_bytes(Path(source_path).read_bytes())


@unittest.skipIf(PimasAgent is None, "Harbor is not installed")
class AgentRelayTest(unittest.TestCase):
    def test_relays_commands_honours_timeouts_and_cancellation_and_fills_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workdir = root / "app"
            workdir.mkdir()
            bridge = root / "bridge"
            bridge.write_text(f"#!/bin/sh\nexec {sys.executable} {Path(__file__).with_name('fake_bridge.py')} \"$@\"\n")
            bridge.chmod(bridge.stat().st_mode | stat.S_IEXEC)
            logs = root / "logs"
            logs.mkdir()
            agent = PimasAgent(logs_dir=logs, model_name="test/model", extra_env={
                "PIMAS_NODE": str(bridge), "PIMAS_ROOT": tmp, "PIMAS_RUN_SNAPSHOT": "0", "PIMAS_REVIEW": "1",
                "PIMAS_MODELS": str(REPO / "config.example/pipeline/models.json"),
                "PIMAS_AGENTS": str(REPO / "config.example/pipeline/agents.json"),
            })
            environment = LocalEnvironment(workdir)
            context = AgentContext()

            asyncio.run(agent.run("Do the task.", environment, context))

            results = json.loads((logs / "pimas" / "relay-results.json").read_text())
            self.assertEqual(results["1"]["exit_code"], 0)
            self.assertEqual(results["1"]["stdout"].strip(), "hello")
            self.assertEqual((workdir / "out.txt").read_text().strip(), "hello")
            # Without coreutils `timeout` (macOS) Harbor's own exec timeout still reports 124.
            self.assertEqual(results["2"]["exit_code"], 124)
            self.assertNotIn("3", results)
            self.assertEqual(context.n_input_tokens, 10)
            self.assertEqual(context.n_cache_tokens, 3)
            self.assertEqual(context.n_output_tokens, 2)
            self.assertEqual(context.metadata["pimas_status"], "completed")
            self.assertEqual(context.metadata["pimas_stages"][0]["tool_calls"], 1)

            state = logs / "pimas"
            self.assertEqual((state / "instruction.md").read_text(), "Do the task.")
            info = json.loads((state / "run-info.json").read_text())
            self.assertEqual(info["settings"]["review"], "1")
            self.assertEqual(info["model_label"], "test/model")
            self.assertEqual(info["workspace_cwd"], str(workdir.resolve()))
            self.assertTrue(info["bridge_finished"])
            self.assertIn("--review", info["bridge_command"])
            self.assertRegex(info["config"]["agents"]["sha256"], r"^[0-9a-f]{64}$")
            self.assertEqual(set(info["config"]["prompts"]), {"orchestrator", "researcher", "planner", "executor", "reviewer"})
            self.assertTrue((state / "config/prompts/researcher.md").read_text().startswith("You are the research agent"))
            self.assertEqual(json.loads((state / "config/models.json").read_text())["providers"]["vllm"]["apiKey"], "unused")

    def test_run_filesystem_records_manifests_and_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workdir = root / "app"
            workdir.mkdir()
            (workdir / "edit.txt").write_text("short")
            (workdir / "gone.txt").write_text("x")
            state = root / "state"
            tracker = RunFilesystem(LocalEnvironment(workdir), state, root=str(workdir))

            async def scenario():
                self.assertTrue((await tracker.start())["ok"])
                (workdir / "edit.txt").write_text("a longer body")
                (workdir / "gone.txt").unlink()
                (workdir / "made.txt").write_text("y")
                return await tracker.finish()

            summary = asyncio.run(scenario())
            self.assertEqual((summary["created"], summary["modified"], summary["deleted"]), (1, 1, 1))
            self.assertEqual(summary["files"], {"before": "before.tsv.gz", "after": "after.tsv.gz", "changes": "changes.tsv.gz"})
            with gzip.open(state / "filesystem/changes.tsv.gz", "rt") as handle:
                self.assertEqual(handle.read().splitlines(), [
                    f"C\t{workdir}/made.txt", f"D\t{workdir}/gone.txt", f"M\t{workdir}/edit.txt",
                ])


if __name__ == "__main__":
    unittest.main()
