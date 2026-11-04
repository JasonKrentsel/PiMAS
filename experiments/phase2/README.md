# Phase 2: building recovery on the saved runs

Phase 2 adds dependency-aware recovery: when a result turns out to be faulty, redo only the work that depended on
it, and keep the rest. Most of that can be built and tested without a GPU, on the 399 saved Phase 1 runs. This
guide shows what each run records and how to use it.

```bash
mkdir -p jobs && tar -C jobs -xJf data/phase1-runs.tar.xz        # from the repository root
cd experiments/phase2 && python3 -I invalidate.py ../../jobs/phase1/tool-false-fail/*/
```

`invalidate.py` is a working starting point. For each run it prints the executor steps a fault invalidates and
what redoing only those would have cost, for example:

```
astropy__astropy-14309__q3GmWvJ: redo steps ['S4', 'S5', 'S6']; about 12.0 of this run's 22.2 agent minutes
```

## What a run records

Each run is a folder `jobs/phase1/<condition>/<task>__<id>/`. Recovery uses `agent/pimas/`:

| File | What is in it | What recovery uses it for |
|---|---|---|
| `summary.json` → `fault` | `spec.target`: what the fault hits (a fact, a stage, a plan step or a tool). `injection`: the stage, step and tool call it was delivered in, with the original and delivered content | **Which result was faulty**, the starting point (Phase 2 tells the method this) |
| `summary.json` → `artifacts` | One entry per stage: its output, `parents` (the stages it read), status, token `usage`, start and end times | The stage graph and each stage's cost |
| research artifact → `content.facts` | Facts F1…Fn, each with its evidence | Where a wrong fact starts |
| plan artifact → `content.steps` | Steps S1…Sn, each with `uses`: the facts it cites | **Fact → step links** |
| execute artifact → `stepFileChanges` | For each step: when it started and ended, and the files it created, modified or deleted | **Step → file links**, and each step's time |
| `tool-calls.jsonl` | Every tool call: stage, `stepId`, arguments, full output, error flag, duration | Step → action links, and the faulty call itself |
| `provenance.jsonl` | Everything in order, including one `fault` event per injection | Every injection of a persistent fault (`summary.json` keeps only the first) |
| `patches/<stage>.diff` | Each stage's change to the code | What restoring a whole stage would undo |
| `sessions/*.jsonl` | Every model message, with its token usage | Tokens per step, when per-stage numbers are not fine enough |
| `../../result.json`, `../../verifier/report.json` | The grade and every hidden test result | Whether the run really ended up wrong |

## The dependency graph

```
faulty fact ──(plan steps' "uses")──► steps ──(stepId on tool calls)──► their actions
                                        └──(stepFileChanges)──────────► files they changed
                                                                            │
                                 later steps that changed the same files ◄──┘
```

Start from the faulty result, mark it invalid, and follow the links forward:

| Fault hits | Invalid work |
|---|---|
| A fact | The steps that cite it, then later steps that changed the same files |
| A tool result | The step it was delivered in, then later steps that changed the same files |
| A plan step | That step, then later steps that changed the same files |
| A whole stage (wrong or lost research) | That stage and everything after it. This is close to a restart, which is the right answer here. |

Everything not marked is kept. Redone work is costed from what it took in the run: stage minutes and tokens from
`artifacts[].latencyMs` and `usage`, step minutes from `stepFileChanges`. A replayed stage shows zero time, so cost
a rerun of it from `control-full` on the same task.

## Judging a method offline

Compare each method with the baselines in `../phase1/results/summary.md`. A restart from scratch costs about 30
minutes, 40K output and 1M input tokens per failed run. Then score the invalidation itself:

- **Missed work:** did it include the steps that changed the files where hidden tests failed
  (`../phase1/results/failing-tests.md`, or the run's `verifier/report.json`)?
- **Wasted work:** how much clean work did it throw away?

## What needs the GPU

- **Rerunning the invalid steps.** Offline gives the decisions and the cost estimates; a live run checks that the
  rerun actually fixes the task.
- **Restoring files to a given step.** Runs record which files each step changed, but save the code only per
  stage (`patches/`). Undoing one step needs per-step snapshots, which the Phase 2 pipeline has to add.

## Limits of the records

- **Citations are what the planner declared.** A step can be swayed by a fact it does not cite, so a fact cited by
  no step invalidates nothing here.
- **Steps record no step-to-step dependencies.** Shared files stand in for them; to be safe, treat every later
  step as affected.
- **A tool fault's step is where the lie was seen,** not every step that acted on it.

## Things that trip people up

- `sessionFile` paths point at the original machine (`/mnt/bravo/...`). Use the file name inside `sessions/`.
- `fileChanges` include `__pycache__/*.pyc` files from running Python. Filter them out (`invalidate.py` does), or
  every step looks like it touched the same files.
- Replayed stages have status `replayed`, no tool calls and zero time. They are saved inputs, not work.
- Tool calls with `stepId: null` happened before the executor's first `begin_step`.
- A run whose fault never fired has no `fault` events in `provenance.jsonl`.
