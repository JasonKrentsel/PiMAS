# Harness integration

## Boundary

A harness is a program you supply. Construct `Harness` from `t4_lite.contracts` or pass the same facts on the command line. This repository does not implement an agent.

```powershell
python -m t4_lite run runs/example --model YOUR_MODEL_ID --agent pi-custom --harness-env OPENAI_API_KEY -- node dist/harness.js
```

Everything after `--` is the harness command, a program on the host. Its own arguments, such as `python -u harness.py`, pass through unparsed. `--harness-env` copies a named variable from the current process into that program only. The task container does not receive the harness code, those variables, this repository, or the Docker socket.

## Wire protocol

There is one parser: `drive_harness` in `t4_lite/runner.py`. The harness must read runner messages from stdin and write its own messages to stdout. Stderr is not parsed. The runner stores it as `harness-stderr.txt` when it is non-empty.

Every message is one JSON object followed by a newline. Extra fields are ignored. A line that is not a JSON object, or a `type` other than the ones below, commits the task as `error`. The note contains the failure. That result stays committed.

| Direction | `type` | Required fields | Optional fields |
| --- | --- | --- | --- |
| Runner to harness stdin | `task` | `task_id`, `cwd`, `prompt` | none |
| Harness stdout to runner | `exec` | `command`, a non-empty string | `timeout` (positive seconds; omitted means the profile's `single_tool_elapsed_limit_seconds`, 900 in the reference profile). The command is killed at the minimum of that request, the profile limit, and the agent time remaining: TERM, then KILL 10 seconds later if it ignores TERM. A request above the profile limit is clamped; it does not commit `error`. `background` defaults to false. |
| Runner to harness stdin | `exec_result` | `exit_code`, `stdout`, `stderr` | none |
| Harness stdout to runner | `done` | none | none |

The first line the harness reads is always `task`. `cwd` is `"/app"` inside the task container. `prompt` is the full `instruction.md`.

```json
{"type":"task","task_id":"telecom-entity-resolution","cwd":"/app","prompt":"..."}
```

The harness asks for a shell command. The runner runs it in the task container and writes `exec_result` back to the harness stdin. `stdout` and `stderr` in that reply belong to the shell command. Reading and writing files is a shell command. HTTP services that belong to a task are reached by commands run inside that container.

```json
{"type":"exec","command":"ls /app","timeout":30,"background":false}
{"type":"exec_result","exit_code":0,"stdout":"","stderr":""}
```

`background: true` leaves the command running. That is how a dev server stays up. `{"type":"done"}`, closing stdout, or the harness process exiting ends the attempt, including when the process exits during an `exec`. The runner then copies the declared artifacts into the verifier and grades the task. The harness does not write `result.json`.

The harness process never joins the task network and never receives a mount of `/app`. A shell command inside the task container cannot read the harness code or its environment.

One fresh task environment per task. One attempt. An error result stays committed; start a new run folder for a clean evaluation.

## What the runner owns

1. Start the pinned environment image with the manifest's CPU and RAM. Three tasks use their `environment/docker-compose.yaml`. The runner execs into the `main` service with working directory `/app` and sets those CPU and memory limits on `main`.
2. Leave the task container in place for the attempt. After the harness exits, copy only the artifacts declared in `task.toml` into the verifier, each at the same path. Paths under `/app` come from the main container. An artifact that names another service is copied from that service. The declared artifact `/app` copies the contents of `/app` into the verifier's `/app`. A missing artifact does not stop the copy. Paths that could not be copied are listed on one result-notes line. The verifier image's other files stay as they were built.
3. Enforce the task's agent timeout. When it expires, stop exchanging commands and grade the workspace. Grading stops the harness process tree before collecting artifacts. If that grade is pass or fail, the notes say the harness exceeded the agent timeout.
4. Run verifier collect commands after the harness is gone. The verifier timeout is the task's verifier timeout, raised to the run profile's `verifier_timeout_floor_seconds` when the profile sets one (3600 in the reference profile). `reward.txt` is the task grade. A missing or non-binary reward is an error, not a fail. The raw `reward.txt` bytes are stored as `native_result` evidence when the file exists, including an empty file; a missing file is not stored, so its absence from the evidence list shows it was never written. `ctrf.json` and `trace_results.json` are stored raw as `verifier` evidence when they exist, next to `verifier-output.json` (the verifier log).
5. Cap each harness `exec` at the profile's `single_tool_elapsed_limit_seconds` (900 in the reference profile) and at the agent time remaining. A requested timeout above the profile limit is clamped to that limit. The command still runs. It is sent TERM when the limit is reached, then KILL 10 seconds later if it ignores TERM, so the harness receives `exec_result`. Omitting `timeout` uses the profile limit.
6. Map CTRF tests, warranty claims, and the React workflow onto the manifest. A failed health check, a report that does not identify every cataloged check, or a CTRF report with tests beyond the catalog (including a name repeated more often than cataloged) becomes `error`. The check fraction never becomes the reward.
7. Run one task at a time. The profile's `task_concurrency` is stored with the run and is not applied. A failure in one task commits `error` and the run continues. There is no infrastructure retry.

## Stored result

`run` writes one `result.json` per task under `runs/<name>/results/<task>/`, next to the evidence files it lists. A graded result looks like:

```json
{
  "schema_version": 1,
  "run_id": "from run.json",
  "benchmark_sha256": "manifest digest",
  "profile_sha256": "profile digest",
  "task_id": "telecom-entity-resolution",
  "source_ref": "pinned task registry ref",
  "status": "pass or fail",
  "reward": 0,
  "checks": {"check-001": "pass"},
  "health": {},
  "evidence": [
    {"kind": "native_result", "path": "reward.txt", "sha256": "64 lowercase hex characters"},
    {"kind": "verifier", "path": "verifier-output.json", "sha256": "64 lowercase hex characters"},
    {"kind": "verifier", "path": "ctrf.json", "sha256": "64 lowercase hex characters"}
  ],
  "notes": ""
}
```

The example shows one check for brevity. A pass/fail result enumerates every check and health-check ID in the task's catalog, and `reward` is the native 0 or 1 from `reward.txt`. A legitimate failure can have a high check fraction; the reward is never derived from the checks.

Check values are `pass`, `fail`, `skipped`, and `not_run`. The last two stay in the fixed denominator with zero credit.

`error` results have a null reward, a nonempty `notes` reason, and any check outcomes that were known. They invalidate the final suite scores while keeping the task in the coverage count. A pass/fail result must carry `native_result` (the verifier's `reward.txt`) and `verifier` evidence; an `error` result needs only nonempty evidence. Harness stderr is stored as `harness_stderr` when the harness wrote any. Before committing, the ledger rejects unknown fields, unknown check IDs, incomplete catalogs, boolean or fractional rewards, and evidence whose hash does not match.

## Check mapping

CTRF tasks map each native test name and occurrence to the catalog. Parameterized reports may repeat a displayed name; occurrences are distinct cases in the pinned verifier's collection order and are never deduplicated. A cataloged check missing from the report, a report test outside the catalog, or a name repeated more often than cataloged makes the attempt `error` rather than shrinking or reshaping the denominator.

One verifier is an explicit exception. When `ontology-kg-querying` rejects a submission before grading (for example, `pipeline.py` is missing), it writes reward 0 and a single failed `verifier_bootstrap` entry. That is a candidate failure, so it is scored `fail` with all 11 checks and both health checks `not_run`. The exception is listed in `BOOTSTRAP_FAILURES` in `t4_lite/grade.py` and applies only to that exact report; any other incomplete report is still `error`.

By decision, that includes `live-database-cutover` and `payments-pipeline-fix`. Their verifiers write reward 0 and stop before running checks when they judge an early agent failure (for live-database-cutover: the patch does not apply, `requirements.txt` is broken, or the app does not start without MySQL). Those attempts are recorded as `error`, so a model that fails either task that early withholds the run's final scores. The verifier log in `verifier-output.json` shows the reason.

`heat-pump-warranty` maps the exact 20 claim IDs in `trace_results.json` `cases` and their boolean `passed` values.

`react-lead-form` has one check: the complete `/tests/test_outputs.mjs` acceptance program, scored from its reward. Its preliminary `npm test`/Vitest runs are prerequisites inside that workflow, not separate checks.

The six health checks listed in the manifest are verifier or fixture self-tests. They must pass for a graded result and never earn solution credit. The MVCC test that runs the submitted regression against the original bug stays in solution credit, because it tests the candidate's regression suite.

## Persistence and retries

Each task result is committed once with an atomic rename; a later attempt to commit a different result for that task is rejected. The benchmark does not overwrite native grades or implement supersession. A harness protocol error or a Docker failure is committed as `error` and is not left pending. A harness that exits without a `done` message, including during `exec`, is graded the same way as closing stdout. A malformed JSON line or an unknown message type is `error`. After the deadline, the workspace is graded instead. Interrupted work that never reached a commit (for example, Ctrl+C) stays pending, and the next `run` on that folder picks it up. Committed results survive restarts.

Infrastructure faults need a documented disposition outside the runner. Preserve invalid runs; use a new run identity for a clean evaluation. Do not drop a problematic task, change settings halfway through a run, or choose the best of multiple solution attempts. Explicit repeated measurements should be separate complete run identities.
