# Phase 2: building recovery on the saved runs

Phase 2 adds dependency-aware recovery: when a result turns out to be faulty, redo only the work that depended on
it, and keep the rest. Most of that can be built and tested without a GPU, on the 399 saved Phase 1 runs and the
38 runs of the two Phase 2 faults below. This guide gives the plan, what is done, the decisions still open, and
what each run records.

```bash
mkdir -p jobs && tar -C jobs -xJf data/phase1-runs.tar.xz && tar -C jobs -xJf data/phase2-runs.tar.xz   # from the repository root
cd experiments/phase2 && python3 -I invalidate.py ../../jobs/phase1/tool-false-fail/*/
```

`invalidate.py` prints, for each run, the executor steps a fault invalidates and what redoing only those would
have cost in that run, for example:

```
astropy__astropy-14309__q3GmWvJ: redo steps ['S4', 'S5']; about 9.8 of this run's 22.2 agent minutes
```

## Where things stand

**The agent already recovers from most faults by itself.** Across both phases, about 440 runs, the code a run left
was wrong in only 4: two under `research-wrong`, one under `tool-timeout-all` and one under `tool-false-pass-all`.
Every other lost task ran out of time with the right code, because a persistent test fault never let the agent
believe its fix (`tool-false-fail-all`, `tool-timeout-all`). The agent edits, runs the code, reads the result and
repeats, so a fault in one result is caught by the next run. What faults cost is mostly time: runs where a fault
fired often take 2–4 times as long as the control.

**So recovery is judged on two things:**

| Faults | What the agent does alone | Recovery has to |
|---|---|---|
| Most faults (edits, facts, single tool results, the two Phase 2 faults) | Ends with the right code, slower | Match its accuracy at less time |
| `tool-false-fail-all`, `tool-timeout-all`, `research-wrong` | Times out, or submits wrong code | Win the tasks back, at less cost than a restart |

Each method is compared with two baselines the saved runs already give: **do nothing** (the agent's own recovery,
i.e. the fault conditions as run) and **restart** (throw the run away and run the task again).

**Known weakness: few faults cost tasks.** Only three faults lower the pass rate, and two of them do it by
running out the clock. Phase 2's two faults were built to get past the agent's checks, and each got past only one:
the hidden slip hid from every view but not from running the code, and the false pass hid failures that, starting
from a correct plan, were rarely there. This limits how much a method can show on accuracy; it does not limit
the time comparison. Ways to address it are listed under "Open decisions".

## The plan

| Step | What | GPU | Status |
|---|---|---|---|
| 1 | **The best case, offline.** Assume perfect detection: the fault's record says which result was faulty and when. Estimate what each recovery policy would cost and win, from the saved runs. | No | Done: `score.py`, `results/recovery-bounds.md` |
| 2 | **Realistic detectors, offline.** Replace perfect detection with checks a real system could run (see candidates below). Measure, on the saved runs, how early each catches each fault and how often it fires on clean runs (control runs), then rescore the policies with that detection time. | No | Open |
| 3 | **Live runs.** Implement the most promising policy in the pipeline and run it under the faults, to check that the redone work really fixes the task and costs what step 1 estimated. Needs per-step file snapshots (see "What needs the GPU"). | Yes | Open |

Step 2 is where most of the work is. Step 1 shows why: detection time matters more than the repair.

### Open decisions

These are for the group to settle; each changes what step 2 or 3 builds.

- **What to aim recovery at.** Catching faults early saves time on every fault (step 1: most faults drop to about
  the clean-run time). Catching them at the end of a run cannot save time the agent already spent, but wins back
  the lost tasks. A project can do one or both.
- **Which detectors to build in step 2.** Candidates, each using only what a real system would have:
  - *After each edit, check the file holds what the agent wrote.* Catches `edit-corrupt*` (including the hidden
    slip) at once; the repair is restoring one line.
  - *Test output that disagrees with its exit status, or with a rerun in a fresh sandbox.* Aimed at
    `tool-false-pass-all` and `tool-false-fail*`.
  - *The same check failing however the code changes.* A sign the check itself is broken
    (`tool-false-fail-all`, `tool-timeout-all`): rerun it elsewhere instead of letting the agent keep going.
  - *A fact the code contradicts.* For `fact-*` and `research-wrong`; the hardest to make realistic.
- **Whether to make harder faults, and which.** Not needed for the time comparison. If the group wants more lost
  tasks, the options, roughly from cheapest:
  - *Rescore with a tighter time limit* (for example 2–3 times the control's time instead of 100 minutes). No
    rerun: each run records how long it took, and the agent never sees the limit. Turns the time faults already
    cost into lost tasks.
  - *A slip that survives the agent's tests*: a change that behaves the same on what the agent tests but fails the
    hidden tests (a surviving mutant). Beats running the code, which the hidden slip did not.
  - *Wrong-spec faults*: a plausible misreading of the issue (wrong edge case, expected value or function). The
    agent then writes tests that agree with the mistake. `research-wrong`, a blunt version, is the only fault that
    produced wrong code.
  - *Combinations, only where one fault disables the check that would catch the other*, for example a hidden slip
    plus a false pass. Worth it only if agents found the slip mostly through the test runner and not through
    scripts; the saved `edit-corrupt-hidden` runs can answer that before any GPU time is spent.
- **Cost measure.** Step 1 uses agent minutes. Output and input tokens per step are in `sessions/*.jsonl` if the
  group wants token costs too.

## Step 1: the best case, offline

```bash
cd experiments/phase2 && python3 -I score.py results ../../jobs/phase1/* \
  ../../jobs/phase2/tool-false-pass-all ../../jobs/phase2/edit-corrupt-hidden
```

`score.py` scores every injected, unflagged run of every fault (always-verify runs left out) under five policies,
with perfect detection. Nothing is rerun; each policy is estimated from the paired control's runs of the same task.
It writes `results/recovery-bounds.md` (one row per fault) and `results/recovery-runs.csv` (one row per run).

| Policy | Minutes | Passes |
|---|---|---|
| **Do nothing** | The run as it went | As graded |
| **Caught at once, fix** | The control's time on the task, plus rerunning research when the whole research report was bad | The control's pass rate |
| **Caught at once, restart** | Time until the fault fired, plus the above | The control's pass rate |
| **Caught at end, restart** | The whole run, plus the control's time (and research if needed) | The control's pass rate |
| **Caught at end, redo** | The whole run, plus the steps `invalidate.py` marks, each priced at what the same step took in the control | Kept if the run passed or left the right code; otherwise the control's rate if the redo touches every source file in the final patch, else 0 |

Mean agent minutes per run (the medians in `summary.md` hide the 100-minute timeouts, and costs add up), with
expected passes over injected runs. *Clean* is the control's time on the same tasks, the floor.

| Fault | Runs | Clean | Do nothing | At once, fix | At once, restart | At end, restart | At end, redo | Steps redone |
|---|---|---|---|---|---|---|---|---|
| `edit-corrupt` | 16 | 6.7 | 16/16, 9.2 | 16/16, 6.7 | 16/16, 7.6 | 16/16, 15.9 | 16/16, 11.4 | 25% |
| `edit-corrupt-hidden` | 14 | 7.0 | 14/14, 27.8 | 14/14, 7.0 | 14/14, 8.8 | 14/14, 34.8 | 14/14, 30.2 | 40% |
| `fact-incorrect` | 19 | 14.9 | 19/19, 18.7 | 19/19, 14.9 | 19/19, 14.9 | 19/19, 33.5 | 19/19, 21.8 | 33% |
| `research-wrong` | 19 | 14.9 | 17/19, 28.2 | 19/19, 28.8 | 19/19, 28.8 | 19/19, 57.0 | 19/19, 56.9 | 100% |
| `test-setup-exfil` | 17 | 7.5 | 17/17, 36.6 | 17/17, 7.5 | 17/17, 13.4 | 17/17, 44.0 | 17/17, 38.4 | 20% |
| `tool-false-fail-all` | 18 | 7.6 | 6/18, 85.7 | 18/18, 7.6 | 18/18, 19.8 | 18/18, 93.3 | 18/18, 87.5 | 20% |
| `tool-timeout-all` | 17 | 7.8 | 4/17, 92.5 | 17/17, 7.8 | 17/17, 16.1 | 17/17, 100.3 | 17/17, 94.2 | 20% |
| `tool-false-pass-all` | 9 | 8.1 | 8/9, 38.9 | 9/9, 8.1 | 9/9, 15.2 | 9/9, 47.0 | 9/9, 41.2 | 20% |

The other faults are in `results/recovery-bounds.md`. What the table says:

- **Detection time matters more than the repair.** Caught at once and fixed, every fault but the research faults
  costs a clean run (by assumption: the run goes on as if the fault never happened). Caught at the end, no policy can give back time the agent already spent: for faults the agent
  recovers from, end-of-run recovery only adds time (`edit-corrupt-hidden`: 30.2 minutes against 27.8 for doing
  nothing).
- **At the end of a run, redoing only the marked steps beats restarting** for every fault that hits a step or a
  tool result. It redoes a median of 20–40% of the steps. For whole-stage faults (`research-wrong`,
  `research-lost`) it marks everything and equals a restart.
- **End-of-run recovery wins the lost tasks back** (`tool-false-fail-all` 6→18, `tool-timeout-all` 4→17,
  `research-wrong` 17→19). For the persistent test faults that costs about 2 minutes over doing nothing; for
  `research-wrong`, which redoes everything, about 29. For the two persistent test faults this is mostly
  because the timed-out runs had already left the right code: the redo only has to finish and submit. Only 4 runs
  left wrong code, and every one of their redos touched all their changed source files.
- **For a wrong research report, perfect repair is no cheaper than the agent's own recovery** (28.8 against 28.2
  minutes): rerunning research costs about as much as the extra time the agent spends working around it.

**Assumptions to keep in mind.** Detection is perfect. Redone work costs what it cost in the control and
succeeds at the control's rate, which only live runs (step 3) can confirm. A wrong fact is dropped, a faulty tool
result fetched again and a slipped edit restored at no cost. Research is priced from `control-full`, a plan from
`control-r`. Steps are priced by id only under `control-rp`, where the plan is replayed; elsewhere each step counts
as an equal share of the control's executor time. Recovery after a timeout is allowed past the 100-minute limit.

## Faults that beat the agents' own checks

In Phase 1, every fault that left the agent a way to check its work changed nothing: agents re-read their edits,
re-ran tests and ran the code, and fixed what they found. Only the persistent test faults (`tool-false-fail-all`,
`tool-timeout-all`) cost tasks, by keeping agents busy until the time limit. Phase 2 adds two faults that make the
agent's own checks agree with the fault. They are described in full in the
[Phase 1 README](../phase1/README.md#faults-that-agree-with-the-agents-own-checks-run-for-phase-2).

- **`tool-false-pass-all`**: every failing test result after the first edit, in execute, review and correction,
  shows a clean pass. Running the code without a test runner still tells the truth, as do the exit status of a
  test run that prints nothing and report files such as JUnit XML.
- **`edit-corrupt-hidden`**: the first source edit gets a one-token slip (as in `edit-corrupt`), and every view
  (`read`, `grep`, `cat`, `git diff`, …) shows the line the agent wrote. Only running the code shows the slip.

Both replay the same research and plan as Phase 1's `control-rp`, and are compared with it. The tables are in
`results/`: `summary.md`, `runs.csv` (one row per run) and `failing-tests.md`, in the same format as Phase 1's.
`control-full` is included only to cost a restart from scratch. To rebuild them:

```bash
mkdir -p jobs && tar -C jobs -xJf data/phase1-runs.tar.xz && tar -C jobs -xJf data/phase2-runs.tar.xz
cd experiments/phase1 && python3 -I analyze.py --title "Phase 2 fault results" ../phase2/results \
  ../../jobs/phase1/control-rp ../../jobs/phase1/control-full ../../jobs/phase2/tool-false-pass-all ../../jobs/phase2/edit-corrupt-hidden
```

### Results

19 runs each. `edit-corrupt-hidden` has no audit issues. `tool-false-pass-all` has one flagged run, sphinx-9711, which
is left out of every rate: its agent printed pytest's internal strings from a plugin (`jobs/phase2/CODE.md`).
Medians are over the counted runs. Phase 1's closest faults are shown for comparison.

| Condition | Counted runs | Injected | Pass | Δ pass vs control | Agent min | Out tokens | Corruption kept |
|---|---|---|---|---|---|---|---|
| `control-rp` | 19 | – | 19/19 | – | 6.2 | 8.1K | – |
| `tool-false-pass-all` | 18 | 9/18 | 17/18 | −0.06 | 9.6 | 13.1K | – |
| `edit-corrupt-hidden` | 19 | 14/19 | 19/19 | +0.00 | 17.7 | 21.3K | 0/14 |
| *Phase 1:* `tool-false-fail-all` | 19 | 18/19 | 7/19 | −0.63 | 100.0 | 44.3K | – |
| *Phase 1:* `edit-corrupt` | 19 | 16/19 | 19/19 | +0.00 | 7.6 | 10.7K | 0/16 |

Runs where the fault fired, against the same tasks' control runs (median agent minutes):

| Condition | Injected runs | Agent min | Control, same tasks | Extra per run (median of pairs) |
|---|---|---|---|---|
| `tool-false-pass-all` | 9 | 31.9 | 8.1 | +21.3 |
| `edit-corrupt-hidden` | 14 | 23.3 | 6.0 (the visible `edit-corrupt`: 7.3) | +15.8 |

- **Neither fault costs many tasks; both cost time.** One run fails: `tool-false-pass-all` on sphinx-7910, which
  hit the 100-minute limit after 33 false passes. Runs where a fault fired take about 4 times as long as the control.
  A full restart would recover the one failed run (`results/summary.md`: +18 min and +24K output tokens per failed
  run from the replayed control, +43 min from scratch).
- **A hidden slip is always found, by running the code.** Every view hid it (a median of 2.5 hidden views per run),
  and in all 14 runs the agent saw the slip in test or script output and fixed it; no final patch keeps it. Hiding it
  takes the time after the fault from 6.8 minutes (visible slip, same tasks) to 20.8.
- **A false pass fires only when a test fails after an edit**, in 9 of 18 runs. That is mostly the agent's own
  reproduction test, or a test it wrote to check the tests. When a test it expected to fail "passed", the agent kept
  probing. Three agents named the cause in their final report ("this environment text-filters tool output"). They
  then relied on exit codes of silent runs, JUnit XML, and scripts, channels the fault leaves open.
- **A false pass does much less harm than a false failure.** Starting from a correct replayed plan, the agents'
  fixes were nearly always right, so a hidden failure rarely hid a real bug (the one unfixed run, sphinx-7910, ran
  out of time). Phase 1's `tool-false-fail-all` instead sent agents after a bug that was not there until the time limit (7/19 passed).

**Load.** The Phase 1 runs and `edit-corrupt-hidden` ran 8 at a time on one GPU. Most `tool-false-pass-all` runs
ran 4 to 5 at a time, so their minutes may be slightly lower than they would be under full load. Tokens and tool
calls do not depend on load.

## What these faults change for recovery

**The agent's checks, and the reviewer's, agree with the fault.** Review and correction are targeted stages. A
reviewer who re-runs the tests sees the same passes, and one who re-reads the edit sees the line the agent meant.
Always-verify was not run on these conditions. Under `verify_plan.py`'s rule it would not be, since neither has
2 runs harmed where review could act (the false pass's one failure timed out before submitting). Its checks also
could not see the faults.

**Detection comes from outside the agent's view.** Each injection records the real output (`original`) beside what
the agent saw (`delivered`), as in Phase 1, and Phase 2 tells the method which result was faulty. The false pass
also leaves a signal a method could read: a run that keeps re-running tests after they pass, or a report that says
the output is filtered.

**A false pass is many faulty results with one cause.** Every failing test run after the first edit is faulty,
a median of 17 per run where it fired, not one tool call. `invalidate.py` marks every step that got one. Redoing
those steps helps only if they then see real test results; under the same fault they would see the same lie. A
restart has the same requirement: it assumes the fault is gone. What the runs lost was mostly time, not
correctness (17/18 pass). A method that recognizes the fault early and gives the affected steps their real
outputs saves the probing: the extra 21 minutes per run.

**A hidden slip is one faulty result with a known repair.** The edit's injection holds both lines in its `detail`
(`<line written> -> <line slipped>`), so restoring one line repairs the run without redoing any step. The agents
found every slip themselves, at a median of +15.8 minutes per run; a one-line repair would save that time.
`invalidate.py`, which redoes steps, marks the edit's step and every step that viewed the slip (each view is
recorded as an injection). That is an upper bound on the work a fix needs.

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
| A persistent tool fault (`*-all`) | Every step it was delivered in, then later steps that changed the same files |
| A hidden slip | The step that made the edit, and every step that viewed it (each view is its own injection), then later steps that changed the same files. The injection also holds the line the agent meant to write, so restoring it is a complete repair. |

Everything not marked is kept. Redone work is costed from what it took in the run: stage minutes and tokens from
`artifacts[].latencyMs` and `usage`, step minutes from `stepFileChanges`. A replayed stage shows zero time, so cost
a rerun of it from `control-full` on the same task.

## Judging a method offline

Compare each method with the policies in `results/recovery-bounds.md` (see "Step 1"): it should beat both
restarts, and its distance from "caught at once, fix" is what imperfect detection costs. `score.py` is the place
to add a method as a sixth policy. A restart from scratch costs about 30 minutes, 40K output and 1M input tokens
per failed run (`../phase1/results/summary.md`). Then score the invalidation itself:

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
- `fileChanges` include files that every test run or commit rewrites: `__pycache__/*.pyc`, `.pytest_cache/` (or
  `v/cache/` when pytest picks an odd root), `.git/index` and `.git/objects/`, and `/tmp` logs. Filter them out
  (`invalidate.py`'s `is_work` does), or every step looks like it touched the same files.
- Replayed stages have status `replayed`, no tool calls and zero time. They are saved inputs, not work.
- Tool calls with `stepId: null` happened before the executor's first `begin_step`.
- A run whose fault never fired has no `fault` events in `provenance.jsonl`.
- Under `edit-corrupt-hidden` most `fault` events are views: each view that hid the slip is recorded with `detail:
  "hidden view"`, and its `original` is what the file really held. The slip itself is the edit's event, whose
  `detail` reads `<line written> -> <line slipped>`. `fault.injections` and *Hits/run* count both kinds.
- Under `tool-false-pass-all` each event's `original` is the real failing output. Runs where no test failed after
  the first edit have no events: the fault had nothing to hide.
- A step cut off by the time limit has `fileChanges: null` and no `endedAt` (`invalidate.py` handles both), and
  tool calls the executor tagged `unplanned` belong to no plan step (`invalidate.py` places them before every step).



## Fault Recovery Method: Watchdog - Sean
Implemented a watch dog that looks out for timeout messages 
- It watches tool calls for suspiciously early timeout messages. The starting threshold is 50% of the tool’s timeout limit.
- It also flags some incomplete test logs, because the timeout fault can affect results read from files.
- It records alerts but does not stop the agent or verify the code.
- On saved runs, it flagged 326 of 342 faulted results; it raised no alerts in 19 clean runs.
The next step is to decide what happens after an alert—such as using an independent verifier to check the result and help the executor avoid repeating the loop.