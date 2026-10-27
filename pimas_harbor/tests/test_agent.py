import asyncio
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from harbor.environments.base import ExecResult
    from harbor.models.agent.context import AgentContext
    from pimas_harbor.agent import PimasAgent
except ImportError:  # Harbor is only needed for the agent, not the collector.
    PimasAgent = None


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
            agent = PimasAgent(logs_dir=logs, model_name="test/model", extra_env={"PIMAS_NODE": str(bridge), "PIMAS_ROOT": tmp})
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


if __name__ == "__main__":
    unittest.main()
