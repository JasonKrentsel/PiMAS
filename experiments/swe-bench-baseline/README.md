# SWE-bench Verified clean baseline

The no-fault reference for the failure-propagation and recovery study: the fixed-stage PiMAS pipeline
(research → plan → execute) with Qwen3.8-27B, on a 20-task SWE-bench Verified subset, three runs per task.
Fault-injection and recovery runs compare against these numbers on the same tasks.

## Headline numbers

| Job | Tasks × runs | Passed | Notes |
|---|---|---|---|
| Oracle (gold patch) | 32 × 1 | 30 / 32 | `matplotlib-20859` and `requests-1921` fail with the gold patch, so they were dropped. |
| Pilot | 30 × 1 | **21 / 30 (70%)** | Unselected clean success rate. 3 timeouts, 6 wrong fixes. |
| **Baseline** | **20 × 3** | **59 / 60 (98.3%)** | 19 of 20 tasks pass all three runs. No run broke a passing test. |

The baseline tasks were *selected because the pilot solved them* (see [Task selection](#task-selection)), so 98% is
not a capability estimate. Report the pilot's 70% as the clean success rate and describe fault results as
"on tasks the clean system solves".

### Baseline, per task

Medians over the three runs. "Steps" lists the plan length of each run.

| Task | Passed | Agent min | Output tokens | Tool calls | Steps |
|---|---|---|---|---|---|
| pytest-dev/pytest-5809 | **2/3** | 18.1 | 27,497 | 50 | 7/5/5 |
| astropy/astropy-14309 | 3/3 | 48.1 | 68,639 | 99 | 6/7/7 |
| astropy/astropy-7166 | 3/3 | 17.0 | 25,948 | 49 | 6/6/5 |
| django/django-12741 | 3/3 | 15.3 | 22,156 | 72 | 7/7/7 |
| django/django-13410 | 3/3 | 18.3 | 24,397 | 53 | 4/5/6 |
| django/django-14608 | 3/3 | 39.6 | 55,626 | 101 | 5/5/9 |
| django/django-14765 | 3/3 | 19.9 | 29,180 | 54 | 5/6/4 |
| django/django-15467 | 3/3 | 32.5 | 46,643 | 87 | 5/6/6 |
| django/django-16255 | 3/3 | 20.5 | 30,158 | 69 | 5/6/5 |
| django/django-16801 | 3/3 | 27.8 | 39,881 | 83 | 6/7/6 |
| matplotlib/matplotlib-24149 | 3/3 | 35.2 | 50,912 | 74 | 8/6/5 |
| pydata/xarray-4629 | 3/3 | 14.6 | 24,237 | 63 | 5/6/6 |
| pytest-dev/pytest-5262 | 3/3 | 19.7 | 30,718 | 60 | 5/7/4 |
| scikit-learn/scikit-learn-12585 | 3/3 | 22.4 | 42,646 | 50 | 5/6/8 |
| scikit-learn/scikit-learn-13142 | 3/3 | 29.0 | 45,453 | 66 | 6/5/6 |
| scikit-learn/scikit-learn-14496 | 3/3 | 22.8 | 31,608 | 70 | 6/8/9 |
| sphinx-doc/sphinx-7910 | 3/3 | 42.8 | 61,303 | 83 | 6/6/8 |
| sphinx-doc/sphinx-9711 | 3/3 | 32.3 | 47,865 | 100 | 6/6/5 |
| sympy/sympy-14711 | 3/3 | 19.3 | 29,964 | 52 | 4/5/7 |
| sympy/sympy-23534 | 3/3 | 19.7 | 25,626 | 57 | 5/6/6 |

### Baseline, all 60 runs

| Metric | Median | p90 | Max | Total |
|---|---|---|---|---|
| Agent time (min) | 22.5 | 42.8 | 100.0 (timeout) | 1,655 (wall clock 3 h 39 min at 8 concurrent) |
| Output tokens | 31,142 | 55,626 | 81,265 | 2.26 M |
| Uncached input tokens | 127,418 | 242,113 | 390,146 | 8.74 M |
| Cached input tokens | 645,600 | 1.59 M | 2.97 M | 49.7 M |
| Tool calls | 68.5 | 100 | 119 | 4,234 |
| Plan steps | 6 | | 9 | 357 |
| Final patch (bytes) | 1,553 | 3,410 | 4,967 | |
| File-tracking overhead | 6.2 s (0.48% of agent time) | 10.0 s (0.81%) | 17.4 s (1.49%) | |

### Pilot, all 30 runs

Median agent time 45.3 min (p90 98.8), median output tokens 40,875, median tool calls 75. Failures:

- **Timeouts (3):** `django-12209`, `django-13933`, `sympy-17655`.
- **Wrong fix (6):** `django-14792`, `django-16899`, `matplotlib-23476`, `pylint-4970`, `sphinx-9281`, `sympy-15875`.
- No pilot run broke a passing test. The pilot ran before per-step file tracking and stage patches were added, so those columns are empty in its CSV.

## The two baseline exceptions

- **`pytest-5809` run `7FSJ6rv` — wrong fix, a natural propagation case.** Research fact `F10` claimed the upstream
  fix removes the `lexer` key entirely. Plan step `S2` cites `F10`, the executor implemented it, and the hidden test
  (which expects `lexer=text`) failed. The chain `F10 → S2 → execute patch → failed FAIL_TO_PASS test` is traceable
  end to end in `summary.json`, `tool-calls.jsonl` and `verifier/report.json`. The other two runs set `lexer` to `text` and passed.
- **`django-15467` run `ry4YjQz` — agent timeout, still passed.** The fix was in place early. In the final step the
  executor started a full admin test suite without a timeout, which took the last 60 of its 100 minutes. Execute is
  recorded as `missing`, but the partial records and the working-tree patch were complete and the verifier passed it.
  Count it as a pass with a timeout. It is not a recovery event.

## Network use (disclose this)

SWE-bench tasks allow internet access, and these runs left it on. **14 of 60 baseline runs** made network calls, and
**9 of them contacted GitHub**, sometimes to look up the upstream fix. One passing `pytest-5809` run recorded the gold
patch as a research fact. GitHub lookups happened in every stage: research in 4 runs, plan in 3, execute in 6. The
pilot had 7 runs with network calls, 3 of them to GitHub. Per-run counts are in `results/*-network.csv`.

Fault runs should keep the same network setting so they compare to this baseline. Count a fault the agent corrects by
looking up upstream as "detected through outside lookup", not as recovery. For malicious-instruction faults, point any
endpoint the instruction names at a fake address.

## Setup

| | |
|---|---|
| Code | Branch `fixed-stage-pipeline`, commit `a6f173e` plus the logging changes committed with this folder. |
| Benchmark | `swe-bench/swe-bench-verified` through Harbor 0.25.0. Agent and verifier timeouts are 3000 s each in the task; agent timeout ×2 = 100 min. |
| Model | Qwen3.8-27B (bf16) on one GPU, vLLM 0.31.0, 131,072-token context, MTP speculative decoding with 2 tokens. |
| Agents | Every role uses `thinkingLevel: medium`, which is an 8K thinking-token budget. Configs are in `config/`; the API key is read from `$VLLM_API_KEY`. |
| Concurrency | 8 trials at a time (`-n 8`). The baseline uses `-k 3`. |

## Task selection

1. **Pilot list (`tasks/pilot-32.txt`).** 32 tasks from the 194 "<15 min fix" Verified tasks, seed `20261029`, with
   repository quotas proportional to the dataset: django 12, sympy 4, sphinx 3, matplotlib 3, scikit-learn 3, pytest 2,
   astropy 2, xarray 1, requests 1, pylint 1.
2. **Oracle check.** The gold patch must pass. Two tasks failed, leaving `tasks/pilot-30.txt`.
3. **Pilot.** One PiMAS run per task.
4. **Baseline list (`tasks/baseline-20.txt`).** `scripts/select-baseline.py` applies a rule fixed before the pilot
   ran: take pilot passes, non-Django first and then Django, each in pilot-list order, up to 20. `django-11299` was
   the 21st pass and was cut.

## What each run records

Each trial directory (`jobs/swe/<job>/<trial>/`, not committed) holds the Harbor result, the verifier's
`report.json`, and `agent/pimas/`. The full file table is in [`pimas_harbor/README.md`](../../pimas_harbor/README.md).
These are the parts the propagation and recovery analysis uses:

| Level | What is recorded | Where |
|---|---|---|
| Run | Pass/fail, FAIL_TO_PASS and PASS_TO_PASS results per test, timings per phase, exceptions | `result.json`, `verifier/report.json` |
| Stage | Output artifact and its SHA-256, input artifact IDs (`parents`), status, latency, token usage, files changed anywhere in the container, working-tree `git diff` at stage end, untracked files | `agent/pimas/summary.json`, `provenance.jsonl`, `patches/<stage>.diff` |
| Research fact | `{id, claim, evidence}` | research artifact |
| Plan step | `{id, action, uses: [fact ids], check}` | plan artifact |
| Executor step | Tool calls tagged with the step declared by `begin_step`, and the files changed between step boundaries | `tool-calls.jsonl`, `stepFileChanges` |
| Tool call | Full arguments and output, error flag, duration | `tool-calls.jsonl` |
| Conversation | Every message of every stage, so per-step tokens can be derived | `sessions/*.jsonl` |

Across the 60 baseline runs, the dependency records are complete. All 357 plan steps cite at least one fact, no step
cites a fact that doesn't exist, and 632 of 720 facts (88%) are cited by some step. No research stage changed a
tracked file or left an untracked one, so the code at the start of execute is always the original repository.

Known limits: steps don't record which earlier steps they depend on, so step order is the only dependency within
execute. File *contents* are not saved per step, only which files changed. Undoing a single step needs a content
snapshot, which belongs in the recovery mechanism.

## Files here

| Path | Contents |
|---|---|
| `results/baseline-trials.csv`, `results/pilot-trials.csv` | One row per run: reward, exception, agent and total minutes, stage statuses, tool calls, tokens, plan steps, tracking overhead, patch size, FAIL_TO_PASS and PASS_TO_PASS failures. |
| `results/oracle-trials.csv` | Gold-patch reward per task. |
| `results/*-network.csv` | Network tool calls per run and stage. |
| `tasks/` | The pilot and baseline task lists. |
| `config/` | The `models.json` and `agents.json` used, minus the key. |
| `scripts/env.sh` | Paths and cache locations; source first. Defaults are the course machine's. |
| `scripts/serve-vllm.sh` | The vLLM server command. |
| `scripts/launch.sh`, `scripts/watch.sh` | Run a Harbor job with a disk guard, and log progress every 5 minutes. |
| `scripts/report.py`, `scripts/network-use.py`, `scripts/select-baseline.py` | Build the CSVs and tables above, and pick the baseline tasks. |

## Reproducing

From the repository root:

```bash
mkdir -p config/pipeline && cp experiments/swe-bench-baseline/config/*.json config/pipeline/
cd experiments/swe-bench-baseline && source scripts/env.sh
GPU=1 nohup scripts/serve-vllm.sh > "$VLLM_LOG" 2>&1 &
K=3 scripts/launch.sh swe-baseline tasks/baseline-20.txt \
  --agent pimas_harbor.agent:PimasAgent -m Qwen/Qwen3.8-27B --agent-timeout-multiplier 2 &
scripts/watch.sh swe-baseline &
python3 -I scripts/report.py ../../jobs/swe/swe-baseline results/baseline-trials.csv
```

Harbor builds each task image with BuildKit and deletes it after the trial, but the layers stay in the build cache
(about 74 GB for the 32 pilot tasks), so reruns start quickly.
