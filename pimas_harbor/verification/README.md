# On-demand test verification

When `PIMAS_WATCHDOG=true`, a failed watchdog probe can trigger an independent test in a separate Harbor Docker environment. The agent waits while the check runs and receives its result. The ordinary Harbor final grader is unchanged.

## Flow

1. The watchdog sees tool failures and asks the agent to run its known-passing bash and read probes. A **failed** probe signals a suspect result path; a pass or inconclusive probe does not start verification. As before, the watchdog does not use fault-injection records.
2. PiMAS collects all distinct recognizable failed test commands observed so far across the run. Repeated instances of the same command are rerun once, using the longest requested timeout. A failed read result is associated with the most recent test command in its stage containing that log path. The watchdog's probe is never selected. If no command can be identified, the result is inconclusive and the agent can use `verify_test` to provide one or more commands. This tool also accepts up to eight additional absolute paths for missing files and retries all recorded failures together with any newly supplied commands. There are at most two automatic and two manual verifier requests per stage.
3. The host relay builds a compressed snapshot from the actual task container, bypassing the agent's potentially faulty tool wrappers. It includes the entire working directory, including untracked and ignored files, plus configured or requested paths. The snapshot is **not** a full container or live filesystem snapshot. The agent's tool calls are serialized while it is taken, but independently running background processes are not frozen. Avoid writing to snapshot paths in the background.
4. Harbor creates a fresh Docker environment from the task environment definition, with a unique Compose project and without automatic host log mounts or PiMAS's fault wrappers. It checks that the main image matches the source container's image, then runs each failed command in turn. Before each command it clears the working directory and requested paths, restores the same snapshot and configured database exports, and checks for Python and `timeout`. Each command's stdout, stderr, exit code, snapshot identity, and timing return to the agent, including completed results if another command is inconclusive. A real nonzero test exit is reported as such; the agent must distinguish test failures from missing packages or setup errors. Exit codes 124–127 and 137, startup failures and unavailable files are inconclusive, not passes. A 15-minute batch limit bounds repeated tests; any commands not run before the limit are explicitly reported as inconclusive.
5. All verifier services are stopped after the result. At the next request, the previous Compose project and its volumes are removed before another environment starts. The final stopped project remains for inspection and uses disk but not running-container memory. Harbor's normal trial cleanup does not own this separate project; remove it manually when no longer needed, using the project name recorded in Docker. Failed cleanup prevents starting another verifier.

The automatic command selection recognizes common test runners and outputs, not every possible script or shell pipeline. Commands are rerun as written, including setup commands or redirections. A redirected test may need `verify_test` with a command that displays its results. The workspace and configured exports are restored between commands, but other state and background processes in the same verifier are not automatically reset. A snapshot is only trustworthy for the captured state; this does not detect a fault that affects both environments, guarantee test completeness, or establish that a solution is correct.

## Configuration

Enable the watchdog through `--ae PIMAS_WATCHDOG=true`. For additional paths or state hooks, set `--ae PIMAS_VERIFICATION_CONFIG=/absolute/path/to/config.json` to a host-side JSON file. Example:

```json
{
  "paths": ["/opt/project-fixtures", "/opt/venv"],
  "exclude": ["*/__pycache__/*", "*/.pytest_cache/*"],
  "max_bytes": 268435456,
  "exports": [
    {
      "service": "db",
      "export": "pg_dump -U postgres -Fc example > /tmp/pimas-example.dump",
      "path": "/tmp/pimas-example.dump",
      "target_service": "db",
      "import": "pg_restore -U postgres -d example --clean --if-exists /tmp/pimas-example.dump"
    }
  ]
}
```

`paths` copies extra files from the main container at the same absolute paths; use it for task-specific fixtures or installed package directories when needed. This does not automatically discover or reinstall packages. `exclude` contains tar patterns; defaults are empty so necessary files are not silently omitted. When extra paths are configured or requested, exclusions are disabled to ensure those paths are included, which can make the snapshot larger. The compressed workspace archive plus exports is limited to 256 MiB by default and cannot be configured above that limit. A missing path or an oversized snapshot is inconclusive.

`exports` are explicit, task-specific commands. The export must create a consistent file at `path` in the source service; it is copied to the target verifier service and the import command restores it. Omit a service name for the main container. Operators must choose appropriate database credentials, consistency guarantees, and an isolated target; no automatic database discovery, quiescing, or dump format is assumed. Export and import commands are trusted configuration, not model-supplied commands. The hashes of exports are included in the snapshot identity. Temporary host copies are removed after use.

Compose definitions using host bind mounts, published ports, external or explicitly named volumes/networks, shared namespaces, privileged containers, or Compose overlays are rejected rather than risk sharing resources with the original. Ordinary project-scoped services and named volumes can start independently. External service addresses in application configuration are not automatically rewritten. `PIMAS_OFFLINE` disconnects the verifier main container from all networks, which also disconnects it from Compose databases; database-backed verification in that mode may be inconclusive.

This implementation supports Harbor Docker only and relies on Harbor 0.25's Compose command interface for stopping and later removing the verifier. If the task needs other runtime state, a different provider, or files beyond the size limit, verification is inconclusive. The verifier's image and dependencies are only as healthy as its task definition.

## Evidence and measurements

Each request writes `agent/pimas/verification/<id>/result.json` with its request, status, individual test results, snapshot paths and hashes, archive size, export size, startup/snapshot/test/total time and, when Docker sampling succeeds, sampled peak main-container memory. This is sampled working-set memory, not a kernel high-water mark and not the sum of sidecar memory. Captured test output is capped at 100,000 characters per stream; messages to the agent contain at most the last 4,000 characters per stream. The pipeline records the verification result in `provenance.jsonl`; existing stage usage and duration records provide agent tokens and time. To measure savings, compare otherwise matched watchdog-enabled runs and controls, including total runtime and verifier resource use. Snapshot archives and database exports are deleted from host storage after each request.

## Tests

```bash
# From the repository root, with Harbor 0.25 installed:
python -m unittest pimas_harbor.tests.test_verification pimas_harbor.tests.test_agent.VerificationRelayTest
cd PiMAS && npm run check && npm test

# With a running Docker daemon and access to python:3.12-slim:
cd ..
PIMAS_DOCKER_SMOKE=1 python -m unittest pimas_harbor.tests.test_verification.DockerSmokeTest -v
```

The fake-environment tests exercise snapshot contents, multiple test commands, requested paths, cleanup on the next request, failure handling, size limits and the relay protocol. The scripted-model pipeline test injects a false failure and checks that the agent waits for and receives independent verification. The opt-in Docker smoke test checks a passing and a failing command in a real Harbor environment with a simulated false failure and prints snapshot and resource measurements; it does not run a live model or inject a PiMAS wrapper fault. At implementation time the Docker daemon was unavailable, so this smoke test and real-container measurements remain to be run.
