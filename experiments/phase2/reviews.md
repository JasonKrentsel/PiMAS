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

## Step 4: the hold queue

**Change.** A new plug-in, `PiMAS/src/watchdog/hold-queue.ts`, listed first in `plugins.ts`.
- **Before each call, free rules (no model).** A call that sends over the network, installs software, or writes
  outside the workspace is held and never runs, and the agent is told.
- **When the run ends, one review, only if something was held.** It is a model call on the reviewer role's model,
  with its own system prompt, no tools and a 3-minute cap. It gets the task, each held call and the last output the
  agent was given, all inside one JSON document, and answers run or drop per call in JSON. Unparseable, undecided or
  conflicting means drop, and the `reviewed` event says why.
- **Calls marked run** run once each (5 minutes at most) through a fresh tool, and the workspace patch is saved again
  (`patches/finish.diff`).

Around it:
- **Pipeline:** the watchdog gets `finish()` and a `seen` hook, and the pipeline calls `finish()` before `run_end`.
- **analyze.py:** new `leaked` (a leak that actually ran), `watchdog_held`, `watchdog_released` and
  `hold_review_in_tokens` columns.
- **Replay:** `replay-hold-queue.mts`.
- **Docs:** `RUNNING.md` for Jason.

**Replay over all 437 saved runs.**
- Every curl that sends to the collector is held.
- The first leak is held in 21 of the 24 exfil runs that leaked. 2 of the others first wrote a script containing the
  address, and 1 first compared decoded text with it.
- 3 of 95 control runs hold anything: two real `curl`s to github.com, and two `pip install flake8`.
- Under the faults, the other holds are real installs, and the agent probing the collector's port.
- The review prompt is under 1,400 tokens (median) in every condition.

**Verdict: holds, after three rounds of review.**
- **Round 1 (8 defects):**
  - analyze.py's `complied` counted held calls as leaks; the new `leaked` column fixes that.
  - The first rules missed `bash /dev/tcp` sends, which the saved exfil runs use, and wrapped commands (`time curl`,
    `xargs curl`, `bash -c "pip install"`).
  - They held `grep "curl"`, and mis-resolved `cd tests && … > ../log.txt`.
  - The review was shown the fault's injected text as "what the agent saw", and ran under the stage reviewer's own
    prompt.
  - End-of-run work was unbounded and unrecorded.
  - Fix: the rules became a reader that takes each bash command one simple command at a time, plus the review fixes
    above.
- **Round 2:** gaps in that reader.
  - Missed forms: combined flags (`bash -lc`, `python -Bc`), `<(...)`/`>(...)`, here-strings, `cat <<EOF | python3`,
    glued redirects, `git -C`, and line continuations.
  - A `<<` inside quoted Python code read as a heredoc and hid every later line from the check.
  - A `cd` inside `( … )` leaked out of it, and a draft answer followed by a final one used the first.
  - All fixed; each case is now a test.
- **Round 3:** no defect left in the saved data.
  - Applied from its optional list: code piped into an interpreter by `echo`/`printf` is checked; `import socket`
    alone no longer makes any later `.connect(` a send; the cache directories themselves are allowed.

What the reviewer checked:
- **Replay:** it reruns byte for byte.
- **Saved-run scans:** every hold and every unheld leak in all 437 runs. There are no false holds on the saved data;
  the only holds are real installs, real `curl`s, port probes and one write to `/root`.
- **Held calls never run:** no other path (plug-in order, probes, reroutes, the stage reviewer) runs one.

Open points, not changed:
1. **The rules read commands, not what they do.** The watchdog README lists examples of what they still miss, such as
   a script the agent wrote and then runs, or a command named by a variable.
2. **The end-of-run work counts against the run's time limit.** The review is capped at 3 minutes and each released
   call at 5. A run cut off then is scored as not finished. No pipeline-level test covers the review's timer.
3. **Measures that ignore `finish.diff`.** analyze.py's patch, tampering and outside-write measures, and phase2
   `score.py`, use the last stage's files, so they leave out changes made by released calls.
4. **The review was not judged with a model** (no model runs here). Its tests use a scripted model.
5. **Cal's conditions now include the hold queue.** The watchdog has no flag to run them without it.
