# PiMAS: failure propagation and recovery in a multi-agent coding system

CSE 291A project (Option 5). A fixed pipeline of LLM agents (research → plan → execute, with optional review →
correct) fixes real bugs from SWE-bench Verified. We inject one controlled fault per run and measure how far it
spreads, what it costs, and how well full restart and always-verify recover. Phase 1 (the baselines, 399 runs on
19 tasks) is done; Phase 2 will add dependency-aware recovery and compare it with them.

The agents are built on Pi Agent (TypeScript), runs go through [Harbor](https://www.tbench.ai/docs), and the model
is Qwen3.8-27B served by vLLM.

## Layout

| Path | Contents |
|---|---|
| `PiMAS/src/pipeline.ts` | The pipeline: stage order, handoffs, replaying saved stages, review and correction. |
| `PiMAS/src/faults.ts` | The faults and where they are injected. |
| `PiMAS/src/provenance.ts` | Records each stage's inputs, outputs, tool calls and file changes. |
| `PiMAS/prompts/pipeline/` | One prompt per role. |
| `pimas_harbor/` | The Harbor agent that runs the pipeline and relays its tool calls into the task container. |
| `experiments/swe-bench-baseline/` | The clean baseline: task selection, results CSVs, and the scripts every run uses. |
| `experiments/phase1/` | The fault experiment: condition files, run scripts and `analyze.py`. Its README has the full method. |
| `experiments/phase2/` | A guide to building recovery on the saved runs, with a starter script (`invalidate.py`). No GPU needed. |
| `T4-lite runner/` | Our first attempt, on Terminal-Bench. Kept as a record; its results are not used. |

The rest of `PiMAS/src` is an earlier orchestrator prototype that the pipeline replaced.

## Results

The result tables are in git, so they can be checked without rerunning anything:

| File | Contents |
|---|---|
| `experiments/phase1/results/summary.md` | Every Phase 1 condition: pass, hidden tests, time, tokens, unauthorized actions, restart and verify. |
| `experiments/phase1/results/runs.csv` | One row per run, all 399, with every measure `analyze.py` computes. |
| `experiments/phase1/results/verify-plan.md` | Which conditions got always-verify, and why. |
| `experiments/phase1/results/failing-tests.md` | Each hidden test a fault broke or left unfixed. |
| `experiments/phase1/results/memorization-probe.json` | The check that the model cannot write the fixes from memory. |
| `experiments/swe-bench-baseline/results/` | The clean baseline and pilot, one row per run. |

**The saved runs** are in `data/`: `phase1-runs.tar.xz` (all 399 Phase 1 runs) and `swe-baseline-runs.tar.xz` (the
60 clean baseline runs). Each run has its grade, every conversation, tool call and stage diff, and the provenance
graph. Only the whole-filesystem manifests are left out, to keep them small. No GPU is needed to use them:

```bash
mkdir -p jobs && tar -C jobs -xJf data/phase1-runs.tar.xz && tar -C jobs -xJf data/swe-baseline-runs.tar.xz
cd experiments/phase1 && python3 -I analyze.py /tmp/check ../../jobs/phase1/*   # rebuilds results/ exactly
```

Each run is a folder `jobs/phase1/<condition>/<task>__<id>/`; `agent/pimas/` holds `summary.json`,
`provenance.jsonl`, `tool-calls.jsonl`, `sessions/` and `patches/`. `pimas_harbor/README.md` describes each file.

## Reproducing

You need Linux with Docker, `python3`, `uv`, Node 22.19+, and a GPU with about 96 GB.
`experiments/swe-bench-baseline/scripts/env.sh` sets every path; tools, caches and logs go in the gitignored
`.local/`. Two defaults point at our machine, so override them:

- `VLLM_ROOT`: a folder with `.venv-vllm/` (vLLM 0.31.0) and `hf_cache/` (the Qwen3.8-27B weights). Set `WEIGHTS`
  if the weights are elsewhere.
- `DOCKER_MOUNT`: the disk Docker stores images on. Runs stop if it falls below 40 GB free, and the task images
  need about 75 GB.

**The API key** is any string you choose. It stops other users on a shared machine from using your model server.
Put it in a file and set `VLLM_API_KEY_FILE` to that file. The server and the agents both read it from there.

```bash
# Once: tools and config
mkdir -p .local/tools .local/logs/vllm   # then unpack Node 22 and link it as .local/tools/node-v22
source experiments/swe-bench-baseline/scripts/env.sh
uv tool install harbor==0.25.0 && (cd PiMAS && npm ci)
mkdir -p config/pipeline && cp experiments/swe-bench-baseline/config/*.json config/pipeline/

# Check the install (no GPU needed)
(cd PiMAS && npm run check && node --import tsx --test tests/pipeline.test.ts)

# Start the model server
GPU=0 nohup experiments/swe-bench-baseline/scripts/serve-vllm.sh > "$VLLM_LOG" 2>&1 &

# Run a condition (19 runs; this blocks until done, so use nohup for long ones), then build the tables
cd experiments/phase1
K=1 ./run.sh control-rp
K=1 ./run.sh research-wrong verify        # with always-verify
python3 -I analyze.py results ../../jobs/phase1/* && python3 -I verify_plan.py results
```

The conditions are the folders in `experiments/phase1/conditions/`. All 399 runs took about a day on one GPU.
`experiments/phase1/README.md` lists the conditions, how to run them in parallel, and how each metric is computed.
