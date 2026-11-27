# The watchdog: detecting and repairing faults while the agent works

The watchdog is Phase 2's recovery layer. It wraps every tool the agent uses and, after each call, lets a set of
plug-ins check for a fault, confirm it with independent evidence, and repair it. It is off by default.

```
agent ──call──► watchdog ──► fault wrapper (experiments only) ──► real tool
        ◄─result + note──┘
                 │ before each call, for each plug-in:
                 │   instead → a fault already confirmed? handle the call without the tool (optional)
                 │ after each call, for each plug-in:
                 │   detect  → suspicious?            (cheap, from the call and its result)
                 │   confirm → independent evidence   (a probe, a direct file read)
                 │   repair  → fix the result or the file, and tell the agent in a note
```

The watchdog sits outside the fault wrapper, so it sees exactly what the agent sees. Plug-ins never read
fault-injection records. To check the truth they use the workspace directly, through `workspace.exec`, the
pipeline's own command path, which no agent tool or fault wraps.

## Turning it on

| Where | How |
|---|---|
| `runPipeline` | `watchdog: true`, or `{ plugins, rerun }` to choose plug-ins or where commands are rerun |
| Pipeline bridge | `--watchdog` |
| Harbor | `--ae PIMAS_WATCHDOG=1` |
| Phase 1 runs | `K=1 ./run.sh tool-timeout-all watchdog` (writes `jobs/phase1/tool-timeout-all+watchdog`) |

Each step is recorded in `provenance.jsonl` as `{"type": "watchdog", "plugin", "phase", "reason", ...}`, with
`phase` one of `suspected`, `dismissed`, `confirmed`, `repaired` or `rerouted` (a call handled without the agent's
tool). The run summary gets `watchdog: { plugins, suspected, confirmed, repaired }`, where `repaired` includes
rerouted calls.

## The plug-ins

| Plug-in | File | Faults | Detect | Confirm | Repair |
|---|---|---|---|---|---|
| `test-runner` | `test-runner.ts` | `tool-timeout*`, `tool-false-fail*`, `tool-false-pass-all` | The first test result after each edit, and the first of the run | A probe through the agent's own bash tool: a test that must pass (after a failure or timeout) or must fail (after a pass) | Rerun the agent's command outside its tools and give it the real result. From then on, run every test command outside its tools only (`instead`), so it runs once |
| `edit-check` | `edit-check.ts` | `edit-corrupt`, `edit-corrupt-all`, `edit-corrupt-hidden` | After an edit or write, read the file directly; suspicious if it does not hold the text the agent wrote | The direct read; the intended content is the old file with the agent's edits applied exactly | Write the intended content, and tell the agent which line was wrong |

Not covered yet: wrong knowledge (`fact-*`, `research-*`), the optional third plug-in. See
`experiments/phase2/README.md` for which faults are worth targeting and why.

## Files

| File | What it is |
|---|---|
| `types.ts` | The plug-in interface (`WatchdogPlugin`) and the types passed around. Start here. |
| `monitor.ts` | The loop: wraps tools, runs each plug-in's detect, confirm and repair, appends notes, records events. |
| `plugins.ts` | The list of plug-ins a run uses. Register a new plug-in here. |
| `test-runner.ts`, `edit-check.ts` | The two plug-ins. |
| `rerun.ts` | Where commands are rerun: `outsideAgentTools` (the default) or `freshCopy` (a throwaway copy of the workspace). |
| `../test-results.ts` | Recognizing test commands and their results; shared with the fault injector. |

## Adding a plug-in

1. Write `src/watchdog/<name>.ts` exporting a function that returns a `WatchdogPlugin` (see `types.ts`). Keep its
   state inside that function, so each run gets a fresh copy. `before` and `instead` are optional; use `instead`
   only for a fault already confirmed, since the agent's tool does not run.
2. Add it to `defaultPlugins()` in `plugins.ts`.
3. Add unit tests in `tests/watchdog.test.ts` (no model needed), and an end-to-end test in
   `tests/pipeline.test.ts` under the fault it targets (see the tests named "the watchdog ...", which load the
   faults exactly as the experiments ran them).
4. Check its false alarms on the saved runs: extend `experiments/phase2/replay-watchdog.mts`, or write a replay
   for your detector the same way.

## Live results

Run under the faults and on a control, 19 SWE-bench tasks each: every fault run passed except one
`tool-false-fail-all` run, which ran a long test command twice (see Limits; since fixed, and that task passed 3 of 3
reruns), and no false alarms on the control. Full
numbers: `experiments/phase2/README.md`, "Step 3".

## Tests

```bash
cd PiMAS
node --import tsx --test tests/watchdog.test.ts                               # plug-ins and loop, no model
node --import tsx --test --test-name-pattern=watchdog tests/pipeline.test.ts  # full pipeline under real faults
```

The end-to-end tests run the real pipeline with a scripted model, under `tool-false-fail-all`,
`tool-timeout-all`, `tool-false-pass-all`, `edit-corrupt-hidden` and no fault. They check that the agent gets
real results or a restored file, and that without a fault the agent sees exactly what it would without the
watchdog.

## Limits

- **Reruns escape the agent's tools, not its environment.** By default a command is rerun in the same workspace,
  through the pipeline's own command path. That gives the real result for a fault in the tool layer, where all
  of this project's faults live, but not for a broken environment (a stuck database, a full disk). For that, pass
  a `rerun` that starts a fresh container from the task image with the agent's diff applied; Sean's Harbor verifier
  on the `fault_recovery` branch (`pimas_harbor/verification/manager.py`) does this but has not been run against
  Docker yet. `freshCopy` (a throwaway copy of the workspace) is not a substitute in SWE-bench images: projects
  installed in editable mode from `/testbed` break in the copy (astropy's pytest fails with
  `ImportMismatchError`).
- **Only bash test runs are checked.** A test run whose output goes to a log that the agent then reads is not
  recognized, so it is not checked. Test commands are recognized by name (`src/test-results.ts`).
- **The test command that reveals the fault runs twice:** through the agent's tool, then again outside it. Later
  test commands run once. (Before `instead`, every rerouted command ran twice; in one live run a Django suite with
  a one-hour timeout ran for 87 minutes and the run hit the time limit.)
- **Reruns get the agent's timeout,** capped as the bash tool caps it, and stop when the agent's call is aborted.
- **Probes go through the fault wrapper,** so each probe that hits a fault is recorded as an injection. A
  single-shot fault (`tool-false-fail`, `tool-timeout`) can be used up by a probe instead of by the agent's test.
- **Edit check reads each edited file twice** (before and after), by direct workspace commands.
