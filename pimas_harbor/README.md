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
- its structured submission and a SHA-256 of it
- its parents
- token usage
- every tool call, tagged with the plan step the executor declared through `begin_step`
- the workspace files it created or modified

**Budgets.**
- Shell commands default to 600 s and are capped at 3600 s (`PIPELINE_COMMAND_LIMITS`).
- Each stage has a tool-call budget (`DEFAULT_BUDGETS` in `pipeline.ts`). Past it, the stage is stopped and told to submit.
- The overall limit is the task's own agent timeout, enforced by Harbor.

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

Run from the repository root. `-k 3` gives three independent attempts per task inside one job, and each job is one condition. Leave out the three GPU tasks with `-x <task-name>` (repeatable). They are the tasks whose `task.toml` asks for `gpus` > 0.

```bash
export PYTHONPATH=$PWD
DATASET=terminal-bench/terminal-bench@4.0.0
```

1. **Infrastructure check.** The reference solutions should pass, and an agent that does nothing sets the check-rate floor.

```bash
harbor run -d $DATASET -a oracle -n 8 --job-name oracle -o jobs
```

```bash
harbor run -d $DATASET -a nop -n 8 --job-name nop -o jobs
```

2. **Smoke test.** Run one short task end to end with the pipeline.

```bash
harbor run -d $DATASET -i mvcc-lsm-compaction --agent pimas_harbor.agent:PimasAgent -m Qwen/Qwen3.8-27B -n 1 --job-name smoke -o jobs
```

Check the following, then look at `jobs/smoke/*/agent/pimas/provenance.jsonl` and `bridge-stderr.txt`:
- `jobs/smoke/*/verifier/reward.txt` exists
- `ctrf.json` exists
- `agent/pimas/summary.json` shows the stages as `submitted`

3. **Pilot for the model decision.** Run 10 tasks once each.

```bash
harbor run -d $DATASET --agent pimas_harbor.agent:PimasAgent -m Qwen/Qwen3.8-27B -l 10 -n 8 --job-name pilot -o jobs
```

4. **Baseline.** Run each condition with 3 attempts per task.

```bash
harbor run -d $DATASET --agent pimas_harbor.agent:PimasAgent -m Qwen/Qwen3.8-27B -k 3 -n 10 --job-name pipeline -o jobs
```

```bash
harbor run -d $DATASET --agent pimas_harbor.agent:PimasAgent -m Qwen/Qwen3.8-27B -k 3 -n 10 --ae PIMAS_REVIEW=1 --job-name pipeline-review -o jobs
```

```bash
harbor run -d $DATASET --agent pimas_harbor.agent:PimasAgent -m Qwen/Qwen3.8-27B -k 3 -n 10 --ae PIMAS_MODE=single --job-name single -o jobs
```

`-n` is the number of task containers running at once. Size it to host RAM, since tasks reserve 4–16 GB each. Do not use Harbor's `--max-retries`: one attempt per trial, with failures kept, is the methodology.

## Results

```bash
mkdir -p results
```

```bash
python3 -m pimas_harbor.collect jobs --rows results/trials.csv --summary results/summary.csv
```

`trials.csv` has one row per trial:
- official reward
- unit-test checks passed and total, from `ctrf.json` (or `trace_results.json`), with the known verifier self-tests excluded
- Harbor exception, if any
- agent and verifier time
- pipeline status
- tokens (input including cached, cached, output)
- provenance size
- per-stage status, time, tokens and tool calls

`summary.csv` has one row per job (condition):
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
- **`changedFiles` misses some changes.** It only covers files under the task working directory whose modification time moved during the stage. Deleted files and changes outside that directory are not listed.
- **Command timeouts leave survivors in rare cases.** Each command is wrapped in coreutils `timeout` inside the container when it is available, but a process that escapes its process group can outlive the timeout.
- **Planner fact IDs are checked; executor behavior is not.** The planner must cite fact IDs that exist. Whether the executor actually relied on them shows up only in the tool-call tags and the outcome.
