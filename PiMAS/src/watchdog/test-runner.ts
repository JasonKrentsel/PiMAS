import { isTestCommand, reportsTimeout, showsFailure, testResults } from "../test-results.js";
import { asToolOutput } from "./rerun.js";
import type { Evidence, Suspicion, ToolCall, ToolOutcome, WatchdogPlugin } from "./types.js";

/**
 * Plug-in 1: a broken test runner (faults tool-timeout*, tool-false-fail*, tool-false-pass-all).
 *
 * detect   The first test result after each edit (and the first of the run) is checked: once the code changes,
 *          the agent starts relying on what the runner says. Later results before the next edit are not checked.
 * confirm  Run a probe through the agent's own bash tool: a test whose answer we know, the opposite of what the agent
 *          just saw. After a failure or timeout, a test that must pass; after a pass, a test that must fail. A wrong
 *          answer proves the runner, not the code, is at fault. A probe takes about a second.
 * repair   Rerun the agent's command outside its tools (rerun.ts) and give the agent that real result.
 * instead  Once the runner is shown broken, run every later test command outside the agent's tools only, so it
 *          does not run twice (a broken runner stays broken; long test suites would double the agent's wait).
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
  let checked = false; // the runner was checked since the last edit
  let broken = false; // confirmed: reroute every later test command

  const command = (call: ToolCall) => typeof call.args.command === "string" ? call.args.command : "";
  const isTestRun = (call: ToolCall) => call.tool === "bash" && isTestCommand(command(call));

  return {
    name: "test-runner",

    async instead(call, tools) {
      if (!broken || !isTestRun(call)) return null;
      const real = await tools.rerun(command(call), tools.timeoutFor(call.args.timeout));
      return {
        reason: "runner already shown broken",
        note: "[watchdog] Run outside your tools (your bash tool was shown to give wrong test results).",
        replacement: { output: asToolOutput(real), isError: real.exitCode !== 0 },
      };
    },

    detect(call, outcome) {
      if ((call.tool === "edit" || call.tool === "write") && !outcome.isError) {
        checked = false;
        return null;
      }
      if (!isTestRun(call) || broken) return null;
      const now = classify(outcome);
      if (now === "unknown" || checked) return null;
      checked = true;
      return now === "passed"
        ? { reason: "first passing test run since the last edit", data: { expect: "failed" } }
        : { reason: `first test run since the last edit, ${now}`, data: { expect: "passed" } };
    },

    async confirm(suspicion: Suspicion, _call, tools): Promise<Evidence> {
      if (!tools.agentBash) return { confirmed: false, reason: "no bash tool to probe with" };
      const expect = (suspicion.data as { expect: TestOutcome }).expect;
      const probe = await tools.agentBash(expect === "passed" ? PASSING_PROBE : FAILING_PROBE, PROBE_TIMEOUT_SECONDS);
      const got = classify(probe);
      // A probe that printed no test results (no python3, say) says nothing about the runner.
      if (got !== "timeout" && !testResults(probe.output)) return { confirmed: false, reason: "probe printed no test results; inconclusive" };
      const known = expect === "passed" ? "a test that must pass" : "a test that must fail";
      if (got === expect) return { confirmed: false, reason: `${known} ${expect}` };
      broken = true;
      return { confirmed: true, reason: `${known} came back ${got}` };
    },

    async repair(evidence, call, _outcome, tools) {
      const real = await tools.rerun(command(call), tools.timeoutFor(call.args.timeout));
      return {
        note: `[watchdog] Your bash tool is giving wrong test results (${evidence.reason}). The output above is your command's real result, rerun by the pipeline outside your tools. Your later test commands will run outside your tools too.`,
        replacement: { output: asToolOutput(real), isError: real.exitCode !== 0 },
      };
    },
  };
}
