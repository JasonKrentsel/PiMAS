# PiMAS inside the task container

This opt-in integration installs PiMAS into a derivative of a task's pinned environment image. The agent uses native tools in `/app`, not a remote workspace adapter. The existing `python -m t4_lite run ... -- HOST_COMMAND` path is unchanged.

Current scope: one main task image, a native read, a mounted orchestrator checkpoint, and the launch/ledger contract. Executor/reviewer sessions are still disabled in PiMAS. This is not yet a benchmark-capable implementation agent or evidence of task-solving quality.

## Layout and accepted boundary

- `/app`: the original task workspace.
- `/opt/pimas`: installed application, lockfile dependencies, and prompts.
- `/opt/pimas-node/bin/node`: the harness's Node runtime, separate from the task's existing runtime and PATH.
- `/pimas-state`: read/write bind mount of one host attempt directory, outside task artifacts.
- `/pimas-config`: optional read-only bind mount containing explicit `models.json` and `agents.json`.

The task and agent intentionally share permissions, credentials, CPU, and RAM. Task commands can damage the harness or its state; there is no sandbox between them and no automatic fresh retry. No evaluator repository, Docker socket, hidden tests, or reference solutions are mounted. The official verifier remains separate.

## Build the first image

From the parent directory containing `PiMAS/` and `T4-lite runner/` (PowerShell):

```powershell
$base = 'harborframework/terminal-bench:telecom-entity-resolution-environment-d0137fc961c9cd0d@sha256:2182d9c24d959710063973913832c41c2dffb08f0f403d6054255e73d801ebb2'
docker build --file PiMAS/container/Dockerfile --build-arg "TASK_IMAGE=$base" --tag pimas/telecom:vertical-slice PiMAS
```

The build downloads dependencies when needed. The allowlisted build context excludes local configuration, state, tests, archived source, and evaluator material. Node dependencies are installed with `npm ci`; do not copy host `node_modules` into Linux images. The task's original entrypoint, command, user, PATH, and workdir are retained. The runner supplies its normal keepalive command.

The derivative is labeled with its original pinned task base. Before launch, the integration checks that label and resolves the derivative to its immutable local image ID. A real evaluation records that ID and base reference in its public profile. Tags are not the evaluation identity. The original task packages and benchmark manifest are not edited. A label is provenance bookkeeping for trusted builds, not a signature.

The first tested base is Ubuntu 24.04/linux-amd64. Other main task images need their own builds and runtime/native-tool smoke checks, particularly for libc compatibility. Database/broker sidecars and verifier images do not need PiMAS installed.

## Model-free real-container smoke

```powershell
cd 'T4-lite runner'
python -m t4_lite.pimas smoke --task telecom-entity-resolution --image pimas/telecom:vertical-slice --state runs/pimas-smoke-1
```

Use a new state directory for each smoke. The in-container scripted HTTP model requests a real Pi read of a temporary `/app` fixture and only completes after seeing its contents. The normal bridge persists the orchestrator through `/pimas-state`. The host checks the saved checkpoint, stops the harness group, and removes the container. State remains on the host. No live model, task solution, verifier, or benchmark grade is involved; the report explicitly says `graded: false`.

## Launch one task with explicit configuration

Keep real configuration outside source control. Supply a host directory containing `models.json` and `agents.json`. Role prompt paths in `agents.json` must resolve inside the container, for example `/opt/pimas/prompts/orchestrator.md`, `/opt/pimas/prompts/planner.md`, and the other installed role prompts. Model/provider choices remain explicit.

On Docker Desktop, a model service on the host is usually reached through `host.docker.internal`, not container `127.0.0.1`. Ensure the service is configured to accept that connection. Credentials may reference explicitly forwarded environment variables; they are intentionally available to the agent inside the task container.

Use a public JSON profile describing actual settings, with at least `{"schema_version": 1, "label": "pimas-in-container-v1", "verifier_timeout_floor_seconds": 3600}`. Context/thinking/output settings must agree with the supplied PiMAS/model configuration; the runner does not enforce them. Do not claim the reference profile was applied just because it was stored.

```powershell
python -m t4_lite.pimas run runs/pimas-example --task telecom-entity-resolution --image pimas/telecom:vertical-slice --config C:/private/pimas-config --profile C:/private/pimas-profile.json --model YOUR_MODEL_ID --harness-env OPENAI_API_KEY
```

This starts real inference and official grading; it is not the smoke command. It creates `runs/pimas-example/attempts/<task>/` for mounted state and uses the existing immutable result/evidence ledger. A single-task evaluation leaves the remaining benchmark tasks pending, so final suite percentages are withheld and exit 1 is expected even when that individual task grades normally. The first slice intentionally handles one selected task/image rather than pretending one derivative fits all 24 tasks.

The runner verifies the frozen packages before this launch. Its public profile records in-container mode, selected task, original base, immutable derivative ID, and missing-done policy. Other review findings in the legacy artifact-copy/verifier-result handling remain separate hardening work; this integration does not claim to fix all evaluator failure classification.

## Protocol, shutdown, and failure

The runner still sends one JSON-line `task`; the extension adds `attempt_id` and `container_id`. The bridge validates these against mounted `attempt.json` and runner-owned `PIMAS_CONTAINER_ID`. It invokes TaskRun with native tools, writes `report.txt`, disposes the run, and emits only `{"type":"done"}` on stdout. SDK diagnostics and errors go to stderr. The outer launcher records the in-container process-group ID for external termination.

The in-container session has an independent whole-agent deadline watchdog, including when the protocol writer is blocked. It kills the container harness group and the host Docker client rather than assuming killing docker-exec alone stops the agent. This is process supervision, not containment of deliberately escaped processes. Container removal remains final cleanup.

A crash, protocol failure, or expired attempt without `done` records `error` and is not silently accepted as a successful task. No native reward is invented or rewritten; the missing-done path does not run the verifier. A normal done runs the existing separate official verifier and preserves its reward.

Native tools do not pass through the runner's `exec` broker. Therefore its per-exec timeout clamp is not a native-tool limit in this mode. The overall task deadline is enforced; per-shell-command enforcement must be implemented in PiMAS before executor enablement. Image input, all-role workflows, and other task images remain unverified.

## Persistence is not workspace reconstruction

The mount preserves `attempt.json`, `run-binding.json`, `run/` checkpoint/transcripts, report, and harness stderr after container removal. It does not preserve arbitrary task filesystem changes. TaskRun recovery must never attach an old conversation to a fresh task workspace.

The bridge supports an explicit `--resume` only when the original task/attempt/container binding still matches. The normal benchmark command is deliberately not a keep-container/resume manager: it cleans up after the attempt and refuses to relaunch an interrupted attempt directory in a new container. A completed ledger entry is skipped; a changed derivative image is rejected for the same evaluation identity. Use a new evaluation identity after an interrupted attempt rather than silently getting a second fresh solution attempt.

Same-container live recovery orchestration and the remaining durable-coordination guarantees are future work. Mounted state is useful recovery evidence, not a claim of cross-container recovery or exactly-once execution.
