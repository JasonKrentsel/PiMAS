# Reviews of Edward's recovery work (for Edward)

Each step on `edward-recovery` was reviewed by a separate agent with fresh context, asked to argue why it does not
work. Its verdict, what it ran, and what changed in response are below. Tests ran on Linux (WSL, Node 22): the
Windows host has no `python3` and the watchdog uses POSIX paths. `fresh-app.test.ts` "aborting the orchestrator stops
its wait" fails before and after every step; nothing here touches it.

## Rebuilt on Cal's fixes

Steps 1 and 2 were first written on `ef44be1a` and reviewed there. Then Cal's `f47918fd` fixed the same bugs another
way:
- It catches test-setup-exfil by running the probe again outside the agent's tools, where mine reran the agent's own
  test command.
- After a catch, every bash command and read goes around the agent's tools, where mine remade only test commands and
  text views.

His version passed every outcome test written for mine. In the replay it also catches more runs:
- tool-false-fail-all: 18/18, where mine caught 16/18;
- the one-shot faults: 11/19 and 8/18, where mine caught 1/19 and 0/18;
- controls: 0/57 for both.

So `edward-recovery` was rebuilt on his commit. The earlier work is on the local branch `edward-recovery-old-base`, and
is not pushed. From it, only these were carried over:
- the shared test harness;
- the tests his suite lacked;
- the tokens-after-catch column.

Findings from the old-base reviews that still apply to Cal's design are listed at the end.

## Commit 1: shared harness and saved-log tests

**Change.** The scripted-model harness moves from `pipeline.test.ts` to `tests/harness.ts`, unchanged; it is checked
line by line against the version reviewed on the old base. New end-to-end tests in `watchdog.test.ts`:
- a false failure first seen in a log read back is caught, and repaired on that read;
- without a fault, both a read and a `cat` of a saved log are checked, and the agent sees the log as it is;
- after a catch, a 200,000-line log is cut as the agent's own view would be.

**Verdict: feedback, fixed.**
- **Big-log test:** a Python syntax error meant `big.log` was never big, so the test checked nothing. It now writes the
  log with `seq` and asserts that the output was cut.
- **Saved-log test:** it did not pin where the catch happened; a mutation that moved the catch to an earlier call still
  passed. It now asserts that the repair note is on the read itself, and the same mutation fails it.
- **No-fault test:** a tail of calls was never inspected, and "changes nothing" was only checked by the absence of a
  note. The tail was dropped, and the test now compares what the agent saw with the file itself.

## Step 3: tokens after the catch in the replay

**Change.** `replay-watchdog.mts` gains output and input tokens after the catch. They are summed from the run's
`sessions/*.jsonl` (assistant messages and compaction), each the median of its own column, with "–" for a run that
has no sessions. The task's expectation holds: test-setup-exfil 18/18, controls 0/57. Every other column is identical
to Cal's published table and CSV.

**Verdict: holds on the numbers.**
- **Token numbers:** the reviewer recomputed every caught run independently in Python, and all 92 rows and every
  median match.
- **Fixes carried over:** what the old-base reviewer asked for is in: compaction usage counted, "–" for a run with no
  sessions, and the medians labelled as independent. Cal's replay already fixed that reviewer's other points: the
  fault is armed only after a successful edit, and every results fault is answered.
- **Nits applied:** the README called medians "the most that could be saved", and missing values were blank in the
  CSV. Both are fixed.

## Still open from the old-base reviews

These apply to Cal's design as well; none was changed here.
1. In the saved runs the probe is never inconclusive without a fault, so the no-fault path for a probe that prints no
   results rests on unit tests.
2. On a live run, the one-shot faults (`tool-false-fail`, `tool-timeout`) are used up by the probe or by the agent's
   own call, so the agent never meets them. The replay's 11/19 and 8/18 count catches of a fault the agent would
   never have seen.
3. A log still being written in the background can differ between the agent's read and the watchdog's.
