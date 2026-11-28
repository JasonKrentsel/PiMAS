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
fault-injection records. To check the truth they go around the agent's tools: they read files directly from the
workspace, and rerun commands and reads through fresh bash and read tools of the pipeline's own, built on the same
workspace exactly like the agent's but with nothing wrapped around them (`rerun.ts`).

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
| `test-runner` | `test-runner.ts` | `tool-timeout*`, `tool-false-fail*`, `tool-false-pass-all`, `test-setup-exfil` | After each edit (and at the start), the first passing and the first failing test result. A test result is a test command by name, or any bash or read output that shows test results (a helper script, a saved log). Also the first bash command that fails or times out | A probe through the agent's own bash tool: a test that must pass (after a failure or timeout) or must fail (after a pass). A wrong answer proves the tools are broken. A probe that times out or shows no results is run outside the agent's tools too: the right answer there also proves it | Give the agent its command's real result (rerun outside its tools) or the file's real content. From then on, every bash command and file read runs outside the agent's tools only (`instead`), so each runs once and no faked log reaches the agent |
| `edit-check` | `edit-check.ts` | `edit-corrupt`, `edit-corrupt-all`, `edit-corrupt-hidden` | After an edit or write, read the file directly; suspicious if it holds anything but the intended content: for an edit, Pi's own edit tool applied in memory to the old file (so line endings, byte-order marks and fuzzy matching are the agent's tool's) | The direct read, and the first line that differs | Write the intended content, and tell the agent which line was wrong |

Not covered yet: wrong knowledge (`fact-*`, `research-*`), the optional third plug-in. See
`experiments/phase2/README.md` for which faults are worth targeting and why.

## Files

| File | What it is |
|---|---|
| `types.ts` | The plug-in interface (`WatchdogPlugin`) and the types passed around. Start here. |
| `monitor.ts` | The loop: wraps tools, runs each plug-in's detect, confirm and repair, appends notes, records events. |
| `plugins.ts` | The list of plug-ins a run uses. Register a new plug-in here. |
| `test-runner.ts`, `edit-check.ts` | The two plug-ins. |
| `rerun.ts` | Going around the agent's tools: `outsideAgentTools` (the default rerun: a fresh bash tool on the workspace), `readOutsideAgentTools`, and `freshCopy` (a throwaway copy of the workspace). |
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

## Results

- **Live** (`experiments/phase2/README.md`, "Step 3"): under `tool-timeout-all`, `tool-false-fail-all`,
  `tool-false-pass-all`, `edit-corrupt-hidden` and a control, 19 SWE-bench tasks each, every fault run passed except
  one, and the control had no false alarms. These runs used an earlier version (commit 7638ad1); the fixes listed
  under "Changes since the live runs" are checked offline only.
- **Replayed on the saved runs** (`experiments/phase2/results/watchdog-replay.md`, current code): `tool-timeout-all`,
  `tool-false-fail-all`, `tool-false-pass-all` and `test-setup-exfil` are each caught in every run, at or before
  the first faulty result. No control run (0 of 57) is flagged, at about 4 probes per run. Among the other faults the
  only catches are real ones: the single-shot `tool-false-fail` (11 of 19) and `tool-timeout` (8 of 18), whose one
  faulty result the probe met.

## Changes since the live runs

Found after the live runs, in a review by a teammate, our own review and an independent one; each is covered by a
test in `tests/watchdog.test.ts` or `tests/pipeline.test.ts`.

| Problem | Effect in the live runs | Fix |
|---|---|---|
| Rerouted test commands ran twice (through the agent's tool, then outside it) | One lost run: a Django suite with a one-hour timeout ran for 87 minutes | Rerouted calls run once, outside the agent's tools (`instead`). Live check: that task passed 3 of 3 reruns |
| pytest before 5.0 ends its summary "in 0.04 seconds", which was not read as a failure | In pytest-5262 a faked failure was read as a pass; under `tool-false-fail-all`, 12 faulty results reached the agent before the catch. No task lost | `SHOWS_FAILURE` in `src/test-results.ts` accepts "seconds" |
| A probe whose results the fault replaced with a message (`test-setup-exfil`) was taken as inconclusive | Never caught (0 of 18 in replay; not run live) | An inconclusive probe is also run outside the agent's tools |
| Only test commands were checked or rerouted; a helper script's test results, and logs read back after a catch, were not | 3 faulty log reads reached the agent after a catch, in 57 fault runs. No task lost | Any bash or read output that shows test results is a test result; after a catch every bash command and read goes around the agent's tools |
| One check per edit: a pass checked first (or a test command with unreadable output) used up the check a later false failure needed | Not seen | The first pass and the first failure after each edit are checked separately |
| Reruns ran the command bare, not as the agent's bash tool does (different working directory, separate stderr, no output cap) | Not seen (largest rerun output 46KB, under the tool's 50KB cap) | Reruns use a fresh bash tool built like the agent's |
| Edit check compared raw text, so a correct multi-line edit to a CRLF file looked corrupted, and the "repair" wrote LF lines into it; edits sent as a JSON string were not checked | Not seen (no false alarm on the control) | The intended file is computed with Pi's own edit tool, in memory |
| The replay answered probes truly under faults that replace results, and armed the fault on failed edits too | `test-setup-exfil`'s 0/18 was right for the wrong reason | The replay fakes probes for every results fault, answers them truly outside the tools, and arms as the fault does |
| A fault can leave output with no test results in it (a timeout, a message), so a helper script or log under `tool-timeout-all` or `test-setup-exfil` was never checked | Not seen | Any bash command that fails or times out is checked once per edit, apart from test results |
| A probe that only timed out counted as proof, so a slow machine could raise a false alarm | Not seen | A probe that times out or shows no results is proof only if it answers rightly outside the agent's tools |
| Edit check: two edits to the same file in one turn (Pi runs them in parallel) made the second look corrupt, and its "repair" undid the first | Not possible in the live runs (the earlier check compared the new text only) | Calls that change the same file run one at a time |
| A rerouted read of an image dropped the image | Not seen | Rerouted results keep every part the tool returned |

## Tests

```bash
cd PiMAS
node --import tsx --test tests/watchdog.test.ts                               # plug-ins and loop, no model
node --import tsx --test --test-name-pattern=watchdog tests/pipeline.test.ts  # full pipeline under real faults
```

The end-to-end tests run the real pipeline with a scripted model, under `tool-false-fail-all`,
`tool-timeout-all`, `tool-false-pass-all`, `test-setup-exfil`, `edit-corrupt-hidden` and no fault. They check that
the agent gets real results (including from a helper script and from logs read back after a catch, under
`tool-false-fail-all`, `tool-timeout-all` and `test-setup-exfil`) or a restored file, and that without a fault the
agent sees exactly what it would without the watchdog.

## Limits

- **Reruns escape the agent's tools, not its environment.** By default a command is rerun in the same workspace,
  through the pipeline's own command path. That gives the real result for a fault in the tool layer, where all
  of this project's faults live, but not for a broken environment (a stuck database, a full disk). For that, pass
  a `rerun` that starts a fresh container from the task image with the agent's diff applied; Sean's Harbor verifier
  on the `fault_recovery` branch (`pimas_harbor/verification/manager.py`) does this but has not been run against
  Docker yet. `freshCopy` (a throwaway copy of the workspace) is not a substitute in SWE-bench images: projects
  installed in editable mode from `/testbed` break in the copy (astropy's pytest fails with
  `ImportMismatchError`).
- **Before the catch, the watchdog checks once per edit each:** a passing and a failing test result (a test
  command by name, `src/test-results.ts`, or bash or read output in a test format we know), and any other bash
  command that fails or times out. A faked result that is none of these reaches the agent until one of them is
  checked: a log read back with `read` that a timeout fault emptied, or a `grep FAILED log` that a false pass turned
  into nothing. After the catch, every bash command and read goes around the agent's tools, so nothing faked through
  them reaches it; other tools (`grep`, `find`, `ls`) are left alone.
- **The call that reveals the fault runs twice:** through the agent's tool, then again outside it (any bash
  command, since a failed one can reveal it). Later calls run once.
- **Reruns get the agent's timeout,** capped as the bash tool caps it, and stop when the agent's call is aborted.
- **A real hang costs its full timeout before the watchdog acts,** for the agent's test run and again for the probe
  (10 seconds). The simulated `tool-timeout*` faults return at once, so the live runs do not show this cost.
- **Probes go through the fault wrapper,** so each probe that hits a fault is recorded as an injection. A
  single-shot fault (`tool-false-fail`, `tool-timeout`) can be used up by a probe instead of by the agent's test.
- **Edit check reads each edited file twice** (before and after), by direct workspace commands.
