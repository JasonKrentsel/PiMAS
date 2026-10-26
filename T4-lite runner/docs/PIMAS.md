# PiMAS inside the task container

This opt-in integration installs PiMAS into a derivative of a task's pinned environment image. The agent uses native tools in `/app`, not a remote workspace adapter. The existing `python -m t4_lite run ... -- HOST_COMMAND` path is unchanged.

Current scope: one main task image with autonomous planning, native implementation/checks, read-only independent review, mounted conversations/workflow checkpoints, and the launch/ledger contract. The full loop and native shell timeout have passed a scripted real-container smoke. A separate small live-model task also passed in an empty mounted workspace: implementation and 11 passing Node tests, current explicit reviewer approval, an additional host-selected contract check, and verified cleanup. It used no benchmark task inputs or official verifier. This is limited integration evidence, not a benchmark result or broad task-solving-quality claim.

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
docker build --file PiMAS/container/Dockerfile --build-arg "TASK_IMAGE=$base" --tag pimas/telecom:execution-v1 PiMAS
```

The build downloads dependencies when needed. The allowlisted build context excludes local configuration, state, tests, archived source, and evaluator material. Node dependencies are installed with `npm ci`; do not copy host `node_modules` into Linux images. The task's original entrypoint, command, user, PATH, and workdir are retained. The runner supplies its normal keepalive command.

The derivative is labeled with its original pinned task base. Before launch, the integration checks that label and resolves the derivative to its immutable local image ID. A real evaluation records that ID and base reference in its public profile. Tags are not the evaluation identity. The original task packages and benchmark manifest are not edited. A label is provenance bookkeeping for trusted builds, not a signature.

The first tested base is Ubuntu 24.04/linux-amd64. The implementation smoke passed for image `sha256:cc4350ef6c04e24ec46242d6808544150715b3bbe8827627bfc80da0713826a2` (local tag `pimas/telecom:execution-v1`). The older `vertical-slice` image contains the earlier read-only code. Rebuild after source changes; a stored image does not update itself. Other main task images need their own builds and runtime/native-tool smoke checks, particularly for libc compatibility. Database/broker sidecars and verifier images do not need PiMAS installed.

## Model-free real-container smoke

```powershell
cd 'T4-lite runner'
# Read-only integration smoke:
python -m t4_lite.pimas smoke --task telecom-entity-resolution --image pimas/telecom:execution-v1 --state runs/pimas-smoke-read-1
# Full planner -> executor -> reviewer smoke:
python -m t4_lite.pimas smoke --task telecom-entity-resolution --image pimas/telecom:execution-v1 --state runs/pimas-smoke-implementation-1 --implementation
```

Use a new state directory for each smoke. Both use a scripted HTTP model inside the container, not an external provider. The default requests a real Pi read. `--implementation` additionally creates a planner-backed accepted plan, performs native write/edit and an exact-content shell check, verifies that a deliberate long-running command times out, and obtains a separate read-only review with explicit saved approval. The host validates current review evidence as well as the settled orchestrator.

The normal bridge persists conversations and workflow through `/pimas-state`. The runner stops the harness group and removes the container; state remains on the host and temporary workspace fixtures are removed. No live model, task solution, verifier, or benchmark grade is involved; the report explicitly says `graded: false` and identifies `workflow` as `inspection` or `implementation`.

## Launch one task with explicit configuration

Keep real configuration outside source control. The outer repository root provides tracked [`config.example/`](../../config.example/README.md) templates and ignores the real `config/` directory. Supply that directory explicitly as `--config ../config` when launching here, or use another explicitly chosen private directory containing `models.json` and `agents.json`. Role prompt paths must resolve inside the container, for example `/opt/pimas/prompts/orchestrator.md`, `/opt/pimas/prompts/planner.md`, and the other installed role prompts. Model/provider choices remain explicit; nothing is auto-discovered.

On Docker Desktop, a model service on the host is usually reached through `host.docker.internal`, not container `127.0.0.1`; a separate LAN server uses its explicit LAN address. Ensure the service accepts that connection. For a no-key server, use a non-secret placeholder such as `unused` and omit `--harness-env`. Authenticated providers can reference explicitly forwarded environment variables; those credentials are intentionally available to the agent inside the task container.

Use a public JSON profile describing actual settings, with at least `{"schema_version": 1, "label": "pimas-in-container-v1", "verifier_timeout_floor_seconds": 3600}`. Context/thinking/output settings must agree with the supplied PiMAS/model configuration; the runner does not enforce them. Do not claim the reference profile was applied just because it was stored.

```powershell
python -m t4_lite.pimas run runs/pimas-example --task telecom-entity-resolution --image pimas/telecom:execution-v1 --config C:/private/pimas-config --profile C:/private/pimas-profile.json --model YOUR_MODEL_ID --harness-env OPENAI_API_KEY
```

This starts real inference and official grading; it is not the smoke command. It creates `runs/pimas-example/attempts/<task>/` for mounted state and uses the existing immutable result/evidence ledger. A single-task evaluation leaves the remaining benchmark tasks pending, so final suite percentages are withheld and exit 1 is expected even when that individual task grades normally. The first slice intentionally handles one selected task/image rather than pretending one derivative fits all 24 tasks.

The runner verifies the frozen packages before this launch. Its public profile records in-container mode, selected task, original base, immutable derivative ID, and missing-done policy. Other review findings in the legacy artifact-copy/verifier-result handling remain separate hardening work; this integration does not claim to fix all evaluator failure classification.

## Protocol, shutdown, and failure

The runner still sends one JSON-line `task`; the extension adds `attempt_id` and `container_id`. The bridge validates these against mounted `attempt.json` and runner-owned `PIMAS_CONTAINER_ID`. It invokes TaskRun with native tools, writes `report.txt`, disposes the run, and emits only `{"type":"done"}` on stdout. SDK diagnostics and errors go to stderr. The outer launcher records the in-container process-group ID for external termination.

The in-container session has an independent whole-agent deadline watchdog, including when the protocol writer is blocked. It kills the container harness group and the host Docker client rather than assuming killing docker-exec alone stops the agent. This is process supervision, not containment of deliberately escaped processes. Container removal remains final cleanup.

A crash, protocol failure, or expired attempt without `done` records `error` and is not silently accepted as a successful task. No native reward is invented or rewritten; the missing-done path does not run the verifier. A normal done runs the existing separate official verifier and preserves its reward.

Native tools do not pass through the runner's `exec` broker, so its per-exec timeout clamp does not apply in this mode. PiMAS enforces its own native bash policy: **120-second default, 300-second maximum**, with shorter positive requests preserved. Pi handles timeout/cancellation and local process-tree termination; effects already performed are not undone. The independent whole-attempt watchdog remains active, and container removal is final cleanup. Record these actual settings in the public profile rather than claiming the legacy broker's single-tool policy was applied.

Only executors can edit/write or run bash; orchestrator, planners, and reviewers are read-only. Implementation requires accepted settled-planner evidence and current explicit independent approval; new/resumed execution invalidates old review. A premature final answer fails the task. These are tool/workflow rules, not protection against agents modifying their shared harness or saved state. Image input, broad live-model task quality, and other task images remain unverified.

## Persistence is not workspace reconstruction

The mount preserves `attempt.json`, `run-binding.json`, `run/` checkpoint/transcripts, report, and harness stderr after container removal. It does not preserve arbitrary task filesystem changes. TaskRun recovery must never attach an old conversation to a fresh task workspace.

The bridge supports an explicit `--resume` only when the original task/attempt/container binding still matches. The normal benchmark command is deliberately not a keep-container/resume manager: it cleans up after the attempt and refuses to relaunch an interrupted attempt directory in a new container. A completed ledger entry is skipped; a changed derivative image is rejected for the same evaluation identity. Use a new evaluation identity after an interrupted attempt rather than silently getting a second fresh solution attempt.

Same-container live recovery orchestration and the remaining durable-coordination guarantees are future work. Mounted state is useful recovery evidence, not a claim of cross-container recovery or exactly-once execution.
