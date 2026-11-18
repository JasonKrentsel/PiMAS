import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class Phase1LaunchTest(unittest.TestCase):
    def test_watchdog_argument_is_forwarded_and_validated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            phase1 = root / "experiments/phase1"
            (phase1 / "conditions/control-rp").mkdir(parents=True)
            shutil.copy(Path(__file__).resolve().parents[2] / "experiments/phase1/run.sh", phase1 / "run.sh")
            launcher = root / "experiments/swe-bench-baseline/scripts/launch.sh"
            launcher.parent.mkdir(parents=True)
            launcher.write_text('#!/bin/bash\nprintf "%s\\n" "$@"\n')
            launcher.chmod(0o755)
            env = os.environ.copy()
            env.pop("PIMAS_WATCHDOG", None)

            def run(*args):
                return subprocess.run(["bash", str(phase1 / "run.sh"), "control-rp", *args],
                                      env=env, text=True, capture_output=True)

            self.assertIn("PIMAS_WATCHDOG=false", run().stdout.splitlines())
            enabled = run("verify", "--watchdog", "true")
            self.assertEqual(enabled.returncode, 0, enabled.stderr)
            self.assertIn("PIMAS_WATCHDOG=true", enabled.stdout.splitlines())
            self.assertIn("PIMAS_REVIEW=1", enabled.stdout.splitlines())
            invalid = run("--watchdog", "yes")
            self.assertEqual(invalid.returncode, 2)
            self.assertIn("must be true or false", invalid.stderr)


if __name__ == "__main__":
    unittest.main()
