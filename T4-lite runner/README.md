# T4-lite

T4-lite is a small, frozen benchmark of **24 CPU task environments** selected from Terminal-Bench 4.0.0. It measures two things:

1. **Task pass rate:** the percentage of the 24 tasks whose official verifier awards a binary pass.
2. **Verification-check pass rate:** the percentage of the benchmark's 333 predefined solution checks that pass, pooled across those same 24 tasks.

This project contains the complete pinned task packages, an explicit check catalog, a result contract, an evidence-backed scorer, and durable result storage. It uses Python 3.11+ and the standard library; there are no runtime dependencies to install. The folder is the distribution: run the commands below from this directory.

The harness is yours. `t4_lite/contracts.py` defines `Harness`: a host command and environment variables that stay out of the task container. The runner starts the task container, speaks with that process, runs the official verifier, and commits the score. It does not contain an agent. The wire protocol is in [docs/INTEGRATION.md](docs/INTEGRATION.md).

## PiMAS in-container integration

An opt-in [PiMAS integration](docs/PIMAS.md) installs the agent into a derived task image and mounts attempt state outside `/app`. It includes a model-free real-container smoke command and a single-task evaluation entry point. The original host-harness protocol below is unchanged. The first slice is planner-only and is not yet a benchmark-capable solver.

## Quick start

```powershell
cd "C:\Users\Jason\Desktop\T4-lite runner"
python -m t4_lite verify
python -m t4_lite list
python -m t4_lite pilot
python -m unittest discover -s tests -v
```

`verify` hashes every bundled task file and checks the frozen manifest. `pilot` verifies and scores the included historical evidence. It does not run the benchmark again.

`run` executes the benchmark. It creates the run folder (model, agent label, and public profile), starts each pending task, speaks the harness protocol, grades the official verifier, and commits the result. A full pass is the benchmark itself (the historical pilot took about 28 task-hours; that is planning context, not a promised ETA):

```powershell
python -m t4_lite run runs/example --model YOUR_MODEL_ID --agent pi-custom --harness-env OPENAI_API_KEY -- node dist/harness.js
```

Add `--task TASK_ID` to run a single task first. The default public execution profile is `benchmark/reference-profile.json`; `--profile OTHER.json` records a different one. If `runs/example` already contains a run, omit `--model` and `--agent`; `run` continues with the tasks that have no committed result. One task failure is committed as `error` and the remaining pending tasks still run. `run` exits 0 when the report is a complete valid evaluation and 1 when scores are withheld, including when a committed task is `error` or the run is incomplete. Invalid arguments and ledger corruption exit 2.

Before `run` commits any task, it checks that the Docker daemon answers (`docker version`) and that every image needed by the tasks about to run is present (`docker image inspect`, then `docker pull` when the image is missing). Each distinct image is checked once, and `--task` limits the check to that task. If Docker is unavailable or a pull fails, the command fails and no task result is committed.

Inspect a run at any point:

```powershell
python -m t4_lite report runs/example
python -m t4_lite report runs/example --json
python -m t4_lite export runs/example
```

`export` writes a 24-row CSV to stdout. `report` uses the same 0/1 exit rule as `run`. Other successful commands exit 0.

## How the 24 were selected

The source was the completed exploratory run `run-20261021T230611Z-279c`:

- 63 CPU-eligible tasks: 10 Pass, 34 Fail, 13 Blocked, 6 Error.
- Begin with its 44 Pass/Fail outcomes.
- Withhold three quarantined tasks: `html-js-filter`, `cumulative-layout-shift`, and `glycan-ms2-elucidation`.
- Withhold two CAD tasks, `freecad-impeller` and `freecad-spring-clip`, because their available discrete counts omit separately scored geometry.
- Draw 24 from the remaining 39 using the category quotas below.

Within each category, sort by the ascending hexadecimal SHA256 of UTF-8 `terminal-bench-4.0-lite-v1` + one newline + the task name. Take the first quota entries. Observed pass/fail, check percentage, and runtime do not influence ranking within the eligible pool. `benchmark/selection.json` preserves the 44 candidates, exclusion flags, ranks, seed, quotas, source-state hash, and selected names. A test reproduces the draw.

| Category | Eligible pool | Selected |
| --- | ---: | ---: |
| Software | 15 | 9 |
| Science | 11 | 7 |
| Operations | 5 | 3 |
| ML | 4 | 2 |
| Media | 3 | 2 |
| Security | 1 | 1 |
| Total | 39 | 24 |

This is a community/local CPU subset, not an official Terminal-Bench release or an unbiased estimate of all Terminal-Bench tasks. Completion-based filtering favors tasks this particular pilot could execute successfully. The result has not been validated as preserving rankings across model families. Hardware/CAD is outside v1 coverage. CPU-only refers to task environments; the model server may use GPUs. Some tasks require image handling, substantial RAM, or nested virtualization support. None of the 24 tasks provide an MCP server to the agent.

The exact task list and check counts are in [docs/TASKS.md](docs/TASKS.md).

## Scoring

For a complete valid run:

```text
Task pass rate (%) = 100 * official task passes / 24
Verification-check pass rate (%) = 100 * passed solution checks / 333
```

The two numbers measure different things. A task can pass most checks and still fail its official acceptance criteria. The native binary reward is authoritative for task success; this scorer never derives it from the check fraction. Check counts have different granularity across tasks, and tasks with more checks have more weight in the pooled secondary score. This score is not an average of task percentages or an official Terminal-Bench partial-credit score.

The catalog in `benchmark/manifest.json` fixes every included check ID before evaluation:

- Pytest/CTRF tasks contribute their candidate-facing test cases, including parameterized cases. The report sometimes omits parameter labels; the native test name plus its one-based occurrence in fixed collection order disambiguates cases. The runner keeps that mapping and does not drop repeated names.
- Warranty contributes its 20 named claim cases.
- React contributes **one composite acceptance test**: the complete `/tests/test_outputs.mjs` workflow. Its preliminary Vitest runs are nested prerequisites and are not counted separately. The runner keeps the Node verifier output with the task evidence. This is explicitly a coarser unit than an individual assertion.
- Six verifier/reference/fixture self-checks are separately cataloged as health checks. They must succeed for a valid task result and never earn solution credit. The candidate's MVCC regression test against the original bug remains a solution check because it evaluates the submitted regression test.
- `skipped` and confirmed candidate-caused `not_run` checks contribute zero passes while remaining in the denominator. Missing evidence, unknown check identity, or a verifier/infrastructure crash cannot be relabeled `not_run`; these require an invalid task result.

A valid Pass/Fail result must enumerate every solution and health check. Missing, extra, and unknown check IDs are rejected. Changing check units, adding/removing cases, changing task resources, or changing task contents requires a new benchmark version and new manifest digest.

### Incomplete runs and errors

Both headline percentages are **null/withheld** unless all 24 tasks have valid Pass/Fail outcomes. The report always shows coverage and the outcome counts. Error, Blocked, Quarantined, Cancelled, and pending tasks do not disappear from the task list or denominator. A future model performing badly does not get a smaller benchmark.

There is one fresh solution attempt per task. Infrastructure faults require an explicit documented disposition; they never trigger retry-until-pass or selection of the best outcome. This minimal ledger deliberately does not implement result supersession. Preserve an invalid run and use a new run identity for a clean evaluation. Replicates are separate complete runs and should be reported individually or with a declared averaging rule.

## Historical pilot

The included `pilot/` directory retains native verifier/result evidence for the selected latest source attempts. Its normalized result summary is reproducible with `python -m t4_lite pilot`:

| Metric | Result |
| --- | ---: |
| Task passes | 7/24 = 29.17% |
| Task failures | 17/24 = 70.83% |
| Solution checks passed | 254/333 = 76.28% |

This differs from the earlier provisional 270/349 calculation: the audited definition removes six passing verifier/fixture self-checks and replaces React's 11 nested unit tests with one complete workflow acceptance test. Neither the official task grades nor the task selection changed.

The pilot used mixed settings and some fresh retries from the exploratory parent run. It is a retrospective baseline, not a fresh standardized T4-lite evaluation and not evidence that the reference profile has been executed. It consumed no new inference during creation of this project. Historical native files are copied byte-for-byte and checked against SHA256 digests.

The selected pilot attempts consumed approximately 28.3 task-hours in total. That is useful for planning, not a promised run ETA; hardware, inference speed, resource reservations, and model behavior change runtime.

## Reproducibility and durable storage

Task packages under `tasks/` are unmodified copies of the pinned upstream packages, including instructions, environments, verifiers, and reference solutions. Every file has a SHA256 in the manifest; the original registry ref is also retained. No dependency on the earlier TerminalBench folder is required to inspect or score this bundle.

**Treat the bundle as evaluator-only.** The harness runs on the host. The runner sends the instruction on stdin and runs the harness's shell commands inside the task container. That container does not receive the harness code, API keys, this repository, or the Docker socket. The repository contains hidden tests, solutions, and the check catalog.

A run snapshots its model/agent labels and public execution profile. The metadata and profile have checksums. Each accepted result binds the run ID, manifest digest, task registry ref, and profile digest; results from another run or configuration are rejected.

Each task result is checked against the full result contract and its evidence hashes, staged and flushed, then committed as a whole directory with an atomic rename. A committed result cannot be overwritten. Incomplete `.pending-*` directories are ignored. Every report rechecks committed result and evidence hashes. Filesystem crash guarantees still depend on the underlying filesystem and storage; keep the run directory on reliable local storage and back it up.

Checksums detect changed files and configuration. They are not signatures and do not establish that an agent was isolated. The runner stores the verifier evidence it collected; that record is what a later audit can recheck. This project does not implement an adversarial grading sandbox.

The reference profile requests 256 Ki tokens of context, 64 Ki tokens of output, Pi default thinking, two task slots, two model-request slots, a 1,800-second request idle timeout, a 3,600-second verifier timeout floor, and a 900-second single-tool elapsed limit. This runner enforces the verifier timeout floor, the per-command cap, and each task's agent timeout. It executes one task at a time, so the profile's two task slots are not applied. Context, output, thinking, model concurrency, and the request idle timeout stay in the stored profile for the harness. CPU and memory come from the frozen manifest. A harness request longer than the single-tool limit is clamped to that limit and the command is killed then; it is not a breach and does not commit `error`. Public profiles contain no API keys; credentials belong in the harness environment.

`payments-pipeline-fix` is a known resource deviation. `task.toml` declares 4 CPU and 8192 MB. The frozen manifest declares 6 CPU and 12288 MB. The runner applies the manifest (6 CPU / 12288 MB) and does not silently correct it. Changing the manifest would be a new benchmark version.

## Project layout

```text
benchmark/manifest.json          Frozen tasks, file hashes, resources, check catalog
benchmark/manifest.sha256        Manifest checksum
benchmark/selection.json         Reproducible selection provenance
benchmark/reference-profile.json Public reference execution settings
tasks/<task>/                   Complete pinned upstream task package
t4_lite/core.py                  Manifest validation, immutable ledger, scoring
t4_lite/__main__.py              Small CLI
t4_lite/contracts.py             Harness command and environment; wire protocol in docs/INTEGRATION.md
t4_lite/runner.py                Task container, harness session, verifier, commit
t4_lite/docker.py                Docker command lines and container session
t4_lite/grade.py                 reward.txt and verifier output mapped onto the catalog
docs/INTEGRATION.md              Harness protocol, stored result, and check mapping
pilot/                          Historical results and native verifier evidence
tests/                          Scoring, durability, provenance and CLI tests
runs/<name>/run.json             Frozen evaluation identity and public settings
runs/<name>/results/<task>/      Committed result and copied evidence
```

The runner uses the local Docker engine to start the pinned task and verifier images. It has no service, database, UI, or model gateway. The harness brings its own model client.

## Attribution

Upstream: [Terminal-Bench 4.0](https://www.tbench.ai/news/terminal-bench-4-0), dataset `terminal-bench/terminal-bench@4.0.0`, and [Harbor](https://github.com/harbor-framework/harbor). Upstream task contents, ownership notices, and benchmark canaries are retained. T4-lite does not relicense upstream task material. Benchmark tasks, reference solutions, hidden checks, and pilot evidence must not be used as model training data.
