# Phase 1 baseline: PiMAS pipeline on Terminal-Bench 4.0

This folder connects the fixed-stage PiMAS pipeline (`PiMAS/src/pipeline.ts`) to [Harbor](https://www.tbench.ai/docs), the official Terminal-Bench runner.

- **The agent runs on the host.** Each tool call (read, edit, write, bash, grep, find, ls) becomes a `docker exec` into the task container through Harbor's environment.
- **Agent state stays outside the container.** Conversations, provenance and the summary live in Harbor's trial `agent/` folder.
- **Nothing is installed into task images.**

```
vLLM (Qwen3.8-27B) ◄── HTTP ── PiMAS pipeline-bridge (Node, host)
                                    ▲ JSON lines: exec / exec_result / cancel / done
Harbor ── pimas_harbor.agent:PimasAgent (Python, host) ── environment.exec ──► task container
   └── official verifier → reward.txt, ctrf.json
```

## Pipeline

| Stage | Role | Tools | Submits | Inputs (provenance parents) |
| --- | --- | --- | --- | --- |
| research | researcher | read, grep, find, ls, bash (inspection only, by prompt) | `submit_findings`: facts F1..Fn with evidence | task |
| plan | planner | none | `submit_plan`: steps S1..Sn, each listing the facts it `uses` | task, research |
| execute | executor | read, grep, find, ls, edit, write, bash | `submit_report`: per-step status and evidence | task, research, plan |
| review (optional) | reviewer | as research | `submit_review`: approve/reject with problems | task, research, plan, execute |
| correct-N (on rejection) | executor | as execute | `submit_report` | review, previous execute, plan, research |

**Single mode** (`PIMAS_MODE=single`) runs one executor on the raw task. Use it as the single-agent comparison.

**Provenance.** Every stage writes to `agent/pimas/provenance.jsonl` as it runs, so a run killed at the 8-hour agent timeout still leaves a partial trace. Each stage records:
- its exact prompt and a SHA-256 of it
- its structured submission and a SHA-256 of it
- its parents
- its conversation file
- token usage
- every tool call, tagged with the plan step the executor declared through `begin_step` (a `begin_step` call carries the step it opens)
- every file it created, modified or deleted anywhere in the container
- for executor stages, the same file changes split at each `begin_step` (`stepFileChanges`, also streamed as `step_files` events), so a step's effects, including those of shell commands, can be found and undone on their own
- for stages with workspace tools, when the working directory is a git work tree: the cumulative `git diff HEAD` of that directory at stage end, saved as `patches/<stage>.diff`, plus the untracked files it does not cover

File contents are not stored apart from these patches. Per-step token use is derived from the session files: each assistant message lists its tool-call IDs, and `tool-calls.jsonl` maps those to steps.

**Budgets.**
- Shell commands default to 600 s and are capped at 3600 s (`PIPELINE_COMMAND_LIMITS`).
- Each stage has a tool-call budget (`DEFAULT_BUDGETS` in `pipeline.ts`). Past it, the stage is stopped and told to submit.
- The overall limit is the task's own agent timeout, enforced by Harbor.

## What each trial stores

Everything for one trial is in `jobs/<condition>/<replicate>/<trial>/`. Nothing is derived on the fly, so later analysis (propagation, replay, unauthorized actions) works from these files alone.

| File | Contents |
| --- | --- |
| `result.json` | Harbor's trial result: reward, exception, timings for setup, agent and verifier |
| `config.json`, `lock.json` | Harbor's trial configuration, including `--ae` settings and the pinned task |
| `verifier/reward.txt`, `verifier/ctrf.json` | Official grade and per-test results (`trace_results.json` for the warranty task) |
| `agent/pimas/run-info.json` | Git commit, branch and uncommitted files; Pi and Harbor versions; host; settings; config and prompt hashes; container working directory; bridge exit; whole-run file-change counts and scan times. Written before the run starts and updated at the end |
| `agent/pimas/instruction.md` | The task instruction as given to the agent |
| `agent/pimas/config/` | Copies of `models.json` (credentials redacted), `agents.json`, and each role's prompt as used |
| `agent/pimas/provenance.jsonl` | Run settings (budgets, limits, role profiles), then per stage: start with prompt, session file, compact tool calls, per-step file changes, end with the full artifact |
| `agent/pimas/patches/<stage>.diff` | Working-directory `git diff HEAD` at the end of each stage with workspace tools (git work trees only; stops at 1 MiB) |
| `agent/pimas/tool-calls.jsonl` | Every tool call with complete arguments and complete output text, step tag, error flag and timing |
| `agent/pimas/sessions/*.jsonl` | Pi's complete conversation per stage: every message, tool call, tool result and token count |
| `agent/pimas/summary.json` | All stage artifacts and totals; missing if the run was killed |
| `agent/pimas/filesystem/before.tsv.gz`, `after.tsv.gz` | Manifest of every file in the container before and after the agent ran: path, mtime, size, mode |
| `agent/pimas/filesystem/changes.tsv.gz` | `C`/`M`/`D` lines: files created, modified, deleted during the run, anywhere in the container |
| `agent/pimas/bridge-stderr.txt` | Pipeline diagnostics and errors |

Manifests skip `/proc`, `/sys`, `/dev`, `/run`, Harbor's `/logs` mount, and the tracker's own `/tmp/.pimas`. Scanning time is recorded as tracking overhead: each stage's `fileChanges.overheadMs` covers all of its scans, per-step diffs and patch. It counts against the task's agent timeout.

## Server setup (once)

Requirements:
- Linux x86_64 with Docker
- Node.js 22.19+
- Python 3.12+
- NVIDIA GPUs for vLLM

```bash
cd PiMAS && npm ci && cd ..
uv tool install harbor
cp -r config.example config
```

Start the model. One copy runs per GPU. Check the Qwen3.8 model card for the right `TOOL_PARSER` and `REASONING_PARSER` before the first real run.

```bash
config/pipeline/serve_vllm.sh
```

`config/pipeline/models.json` points at `http://127.0.0.1:8000/v1`. It turns on Qwen thinking through `chat_template_kwargs` (`thinkingFormat: qwen-chat-template`) and requests usage in streaming responses, which the token counts depend on. All roles use the same model at thinking level `medium`. Change that in `config/pipeline/agents.json`, and record it if you do.

## Runs

Run from the repository root, on a commit, with no uncommitted changes. `run-info.json` records the commit and flags uncommitted files.

Use one folder per condition and one Harbor job per replicate (`-o jobs/<condition> --job-name r1`), not `-k 3`. Each replicate is then complete on its own, you can stop after any replicate, and a broken run can stay as it is while a new job takes its place. Never rerun into an existing job folder.

Leave out the three GPU tasks with `-x <task-name>` (repeatable). They are the tasks whose `task.toml` asks for `gpus` > 0.

```bash
export PYTHONPATH=$PWD
DATASET=terminal-bench/terminal-bench@4.0.0
AGENT="--agent pimas_harbor.agent:PimasAgent -m Qwen/Qwen3.8-27B"
```

1. **Infrastructure check.** The reference solutions should pass, and an agent that does nothing sets the check-rate floor.

```bash
harbor run -d $DATASET -a oracle -n 8 -o jobs/infra --job-name oracle
```

```bash
harbor run -d $DATASET -a nop -n 8 -o jobs/infra --job-name nop
```

2. **Smoke test.** Run one short task end to end with the pipeline.

```bash
harbor run -d $DATASET -i mvcc-lsm-compaction $AGENT -n 1 -o jobs/smoke --job-name s1
```

Check that `jobs/smoke/s1/*/` has every file in the table above. In particular:
- `summary.json` shows the stages as `submitted`
- `run-info.json` has a `filesystem` block with counts
- `tool-calls.jsonl` has full outputs

Then read `bridge-stderr.txt`.

3. **Full sweep, one replicate.** Use it to measure time per task and per tool call before deciding what to prune.

```bash
harbor run -d $DATASET $AGENT -n 10 -o jobs/clean-pipeline --job-name r1
```

If pruning only drops tasks, `r1` still counts as a replicate. If it changes limits or budgets, treat `r1` as a pilot and move it to `jobs/pilot/`.

4. **Remaining replicates and conditions,** with settings frozen.

```bash
harbor run -d $DATASET $AGENT -n 10 -o jobs/clean-pipeline --job-name r2
```

```bash
harbor run -d $DATASET $AGENT -n 10 --ae PIMAS_REVIEW=1 -o jobs/clean-pipeline-review --job-name r1
```

```bash
harbor run -d $DATASET $AGENT -n 10 --ae PIMAS_MODE=single -o jobs/clean-single --job-name r1
```

`-n` is the number of task containers running at once. Size it to host RAM, since tasks reserve 4–16 GB each. Do not use Harbor's `--max-retries`: one attempt per trial, with failures kept, is the methodology.

## Results

```bash
mkdir -p results
```

```bash
python3 -m pimas_harbor.collect jobs --rows results/trials.csv --summary results/summary.csv --tool-calls results/tool_calls.csv
```

The CSVs are always rebuilt from `jobs/`, so back up `jobs/` and nothing else.

`trials.csv` has one row per trial:
- official reward
- unit-test checks passed and total, from `ctrf.json` (or `trace_results.json`), with the known verifier self-tests excluded
- Harbor exception, if any
- agent and verifier time
- pipeline status
- tokens (input including cached, cached, output)
- provenance size
- per-stage status, time, tokens and tool calls
- condition and replicate, git commit and whether there were uncommitted changes, mode and review setting
- whole-container files created, modified and deleted, and how many changes fall outside the task directory (the clean-run baseline for unauthorized actions)
- tracking overhead: run-level scan seconds and per-stage tracking seconds

`tool_calls.csv` has one row per tool call: task, stage, plan step, tool, seconds, error flag, start time, bash command (first 300 characters), and argument and output sizes. Use it to find the tasks and tool calls that dominate run time.

`summary.csv` has one row per condition, pooling its replicates:
- pass rate and per-task check fraction, each with a 95% bootstrap CI over tasks (replicates are averaged within a task first)
- tasks always and sometimes passed
- errored trials
- mean tokens and agent time

Report check fractions against the `nop` job's floor. Errored trials (agent timeout, infrastructure failure) are listed separately and are never counted as fails.

## Configuration reference

Agent environment variables, set with `--ae KEY=VALUE` or in the shell:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIMAS_MODE` | `pipeline` | `pipeline` or `single` |
| `PIMAS_REVIEW` | `0` | `1` adds the reviewer and corrections |
| `PIMAS_MAX_CORRECTIONS` | `1` | executor corrections after a rejection |
| `PIMAS_MODELS` | `config/pipeline/models.json` | Pi provider file |
| `PIMAS_AGENTS` | `config/pipeline/agents.json` | role profiles and prompts |
| `PIMAS_ROOT` | `PiMAS/` | PiMAS checkout |
| `PIMAS_NODE` | `node` | Node executable |
| `PIMAS_SNAPSHOT_ROOT` | `/` | Directory tracked for per-stage file changes; `none` turns it off |
| `PIMAS_RUN_SNAPSHOT` | `1` | `0` skips the whole-container manifests before and after the run |

## Tests

```bash
cd PiMAS && npm run check && node --import tsx --test tests/pipeline.test.ts
```

```bash
python -m unittest discover -s pimas_harbor/tests -t .
```

The TypeScript tests use the real Pi SDK against a scripted local model. They cover:
- the workspace tools
- stage order, parents and step tags
- changed files
- review and correction
- missing submissions and tool budgets
- the bridge protocol

The agent test needs Harbor installed and drives the relay with a fake bridge and a local-bash stand-in for the environment. The collector test needs only the standard library. None of these contact a real model, Docker, or Terminal-Bench. The first live run is the smoke test above.

## Known limits

- **Inspection-only is a prompt rule, not enforced.** The researcher and reviewer have bash, so nothing technically stops them changing files. Any files they change appear in their stage's `changedFiles`.
- **Change detection compares path, modification time, size and mode.** A rewrite that keeps all four the same is missed, as are changes inside pruned directories. `changedFiles` is the task-directory subset of created and modified files; `fileChanges` has everything, deletions included.
- **Scans count against the agent timeout.** On images with very many files, check `stage_tracking_seconds` and `run_snapshot_seconds` in the smoke run. If they are large, narrow per-stage tracking with `PIMAS_SNAPSHOT_ROOT` and keep the run-level manifests.
- **Command timeouts leave survivors in rare cases.** Each command is wrapped in coreutils `timeout` inside the container when it is available, but a process that escapes its process group can outlive the timeout.
- **Planner fact IDs are checked; executor behavior is not.** The planner must cite fact IDs that exist. Whether the executor actually relied on them shows up only in the tool-call tags and the outcome.
