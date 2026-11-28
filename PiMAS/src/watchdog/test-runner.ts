import { isTestCommand, reportsTimeout, showsFailure, testResults } from "../test-results.js";
import type { Evidence, Suspicion, ToolCall, ToolOutcome, WatchdogPlugin, WatchdogTools } from "./types.js";

/**
 * Plug-in 1: broken tools that lie about test results (faults tool-timeout*, tool-false-fail*, tool-false-pass-all,
 * test-setup-exfil).
 *
 * A test result is a bash command that starts a test runner (src/test-results.ts), or any bash or read output that
 * shows test results: a helper script that runs the tests, or a saved log read back. A fault can also leave output
 * with no results in it (a timeout, or a message in their place), so any other bash command that fails or times out
 * is checked too, once per edit, without using up the check a test result gets.
 *
 * detect   The first passing and the first failing test result after each edit (and of the run) are checked: once
 *          the code changes, the agent starts relying on what the runner says. Each direction is checked on its
 *          own because each fault fakes one: a false failure or timeout turns results into failures, a false pass
 *          into passes, so a pass checked first cannot use up the check a later false failure needs. A test command
 *          whose output shows no results we can read (cut by `tail`, say) is judged by its exit status.
 * confirm  Run a probe through the agent's own bash tool: a test whose answer we know, the opposite of what the agent
 *          just saw. After a failure or timeout, a test that must pass; after a pass, a test that must fail. A wrong
 *          answer in test results proves the tools, not the code, are at fault. A probe that times out or shows no
 *          test results is run outside the agent's tools too: the right answer there means the tool is hiding it (as
 *          test-setup-exfil does, replacing results with a message, or a timeout fault does); the same trouble there
 *          (no python3, a slow machine) means the probe says nothing. A probe takes about a second.
 * repair   Give the agent the real result: its command rerun outside its tools, or the file read outside them.
 * instead  Once the tools are shown broken, every later bash command and file read goes around them: it runs once,
 *          outside the agent's tools only. A broken runner also fakes results that other commands print (a log read
 *          back with `cat` or `read`), and running each command once avoids doubling long test runs.
 *
 * An earlier version waited for 3 bad runs in a row with an edit in between, or for a failing test to start
 * passing. Replayed on the saved runs it caught tool-false-fail-all in only 10 of 18 runs, 24 minutes after the
 * fault, and tool-false-pass-all in none (experiments/phase2/README.md, "Step 2").
 */
export const PASSING_PROBE = "python3 -I -c 'import unittest; suite = unittest.TestSuite([unittest.FunctionTestCase(lambda: None)]); result = unittest.TextTestRunner(verbosity=2).run(suite); raise SystemExit(not result.wasSuccessful())'";
export const FAILING_PROBE = "python3 -I -c 'import unittest; suite = unittest.TestSuite([unittest.FunctionTestCase(lambda: unittest.TestCase().fail(\"watchdog probe\"))]); result = unittest.TextTestRunner(verbosity=2).run(suite); raise SystemExit(not result.wasSuccessful())'";
const PROBE_TIMEOUT_SECONDS = 10;

export type TestOutcome = "passed" | "failed" | "timeout" | "unknown";

/** How a test run ended, judged from what it printed. */
export function classify(outcome: ToolOutcome): TestOutcome {
  if (reportsTimeout(outcome.output)) return "timeout";
  if (showsFailure(outcome.output)) return "failed";
  if (testResults(outcome.output)) return outcome.isError ? "failed" : "passed";
  return outcome.isError ? "failed" : "unknown";
}

export function testRunnerPlugin(): WatchdogPlugin {
  // What was checked since the last edit: a passing result, a failing one, and any other failed bash command.
  const checked = new Set<"passed" | "failed" | "other">();
  let broken = false; // confirmed: every later bash command and read goes around the agent's tools

  const command = (call: ToolCall) => typeof call.args.command === "string" ? call.args.command : "";
  const goesAround = (call: ToolCall) => call.tool === "bash" || call.tool === "read";
  /** What the call really gives, outside the agent's tools. */
  const outside = (call: ToolCall, tools: WatchdogTools) =>
    call.tool === "read" ? tools.readOutside(call.args) : tools.rerun(command(call), tools.timeoutFor(call.args.timeout));

  return {
    name: "test-runner",

    async instead(call, tools) {
      if (!broken || !goesAround(call)) return null;
      return {
        reason: "tools already shown broken",
        note: "[watchdog] Run outside your tools (your tools were shown to give wrong test results).",
        replacement: await outside(call, tools),
      };
    },

    detect(call, outcome) {
      if ((call.tool === "edit" || call.tool === "write") && !outcome.isError) {
        checked.clear();
        return null;
      }
      if (broken || (call.tool !== "bash" && call.tool !== "read")) return null;
      const testCommand = call.tool === "bash" && isTestCommand(command(call));
      if (!testCommand && !testResults(outcome.output)) {
        // No test results: a bash command that failed or timed out may still be a test run a fault rewrote.
        if (call.tool !== "bash" || !(outcome.isError || reportsTimeout(outcome.output)) || checked.has("other")) return null;
        checked.add("other");
        return { reason: "first failed command since the last edit", data: { expect: "passed" } };
      }
      let now = classify(outcome);
      if (now === "unknown") now = "passed"; // a test command that exited 0 with no results we can read
      const direction = now === "passed" ? "passed" : "failed";
      if (checked.has(direction)) return null;
      checked.add(direction);
      return now === "passed"
        ? { reason: "first passing test result since the last edit", data: { expect: "failed" } }
        : { reason: `first ${now === "timeout" ? "timed-out" : "failing"} test result since the last edit`, data: { expect: "passed" } };
    },

    async confirm(suspicion: Suspicion, _call, tools): Promise<Evidence> {
      if (!tools.agentBash) return { confirmed: false, reason: "no bash tool to probe with" };
      const expect = (suspicion.data as { expect: TestOutcome }).expect;
      const probeCommand = expect === "passed" ? PASSING_PROBE : FAILING_PROBE;
      const known = expect === "passed" ? "a test that must pass" : "a test that must fail";
      const probe = await tools.agentBash(probeCommand, PROBE_TIMEOUT_SECONDS);
      const got = classify(probe);
      if (got !== "timeout" && testResults(probe.output)) {
        if (got === expect) return { confirmed: false, reason: `${known} ${expect}` };
        broken = true;
        return { confirmed: true, reason: `${known} came back ${got}` };
      }
      // Timed out, or no test results through the agent's tool: does the probe answer rightly outside it?
      const real = await tools.rerun(probeCommand, PROBE_TIMEOUT_SECONDS);
      const outside = classify(real);
      if (outside !== expect || !testResults(real.output)) {
        return { confirmed: false, reason: `probe ${got === "timeout" ? "timed out" : "printed no test results"} through your tools, and did not answer outside them either; inconclusive` };
      }
      broken = true;
      return { confirmed: true, reason: `${known} ${got === "timeout" ? "timed out through your tools" : "printed no test results through your tools"}, but ${expect} outside them` };
    },

    async repair(evidence, call, _outcome, tools) {
      const what = call.tool === "read" ? "the file's real content, read" : "your command's real result, rerun";
      return {
        note: `[watchdog] Your tools are giving wrong test results (${evidence.reason}). The output above is ${what} by the pipeline outside your tools. Your later commands and file reads will run outside your tools too.`,
        replacement: await outside(call, tools),
      };
    },
  };
}
