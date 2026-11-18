import assert from "node:assert/strict";
import test from "node:test";
import { createProbeDetector, WATCHDOG_PROBE_COMMAND } from "../src/probe-watchdog.js";

const base = { stageId: "execute", stepId: "S1", toolCallId: "1", tool: "bash", args: {}, isError: true,
  output: "Command exited with code 1", elapsedMs: 1, limits: { defaultSeconds: 600, maxSeconds: 600 } };
const probe = { ...base, toolCallId: "probe", args: { command: WATCHDOG_PROBE_COMMAND, timeout: 10 } };

test("the third mixed failure requests one probe, with no flag before the result", () => {
  const detector = createProbeDetector();
  assert.deepEqual(detector.observe(base), []);
  assert.deepEqual(detector.observe({ ...base, tool: "read", isError: false, output: "Ran 1 test in 0.01s\n\nFAILED (failures=1)" }), []);
  assert.deepEqual(detector.observe({ ...base, isError: false, output: "ordinary success" }), []);
  assert.equal(detector.observe({ ...base, toolCallId: "3" })[0]?.type, "watchdog_probe_requested");
  assert.equal(detector.result.flagged, false);
  assert.deepEqual(detector.observe({ ...base, toolCallId: "4" }), []);
  assert.equal(detector.observe({ ...probe, isError: false, output: "Ran 1 test in 0.001s\n\nOK\n" })[0]?.type, "watchdog_probe_result");
  assert.equal(detector.result.outcomes[0]?.outcome, "passed");
  assert.equal(detector.result.flagged, false);
});

test("an incomplete test log counts, but a missing runtime or too-short deadline is inconclusive", () => {
  for (const output of ["python3: command not found", "\nCommand timed out after 1 seconds\n"]) {
    const detector = createProbeDetector();
    const log = { ...base, tool: "read", args: { path: "test.log" }, isError: false, output: "=== test session starts ===\n" };
    detector.observe(log); detector.observe(log); detector.observe(log);
    detector.observe({ ...probe, args: { ...probe.args, timeout: 1 }, output });
    assert.equal(detector.result.outcomes[0]?.outcome, "inconclusive");
    assert.equal(detector.result.flagged, false);
  }
});

test("failed tests in successful bash and read results still count", () => {
  const detector = createProbeDetector();
  detector.observe({ ...base, isError: false, output: "test_example (suite.Case) ... FAIL\n" });
  detector.observe({ ...base, tool: "read", isError: false, output: "tests finished: 1 passed, 1 failed\n" });
  const events = detector.observe({ ...base, tool: "read", isError: false, output: "1 failed, 3 passed in 0.2s\n" });
  assert.equal(events[0]?.type, "watchdog_probe_requested");
});

test("a failed probe flags once, and an unrun probe remains inconclusive", () => {
  const detector = createProbeDetector();
  detector.observe(base); detector.observe(base); detector.observe(base);
  detector.observe({ ...probe, output: "Ran 1 test in 0.001s\n\nFAILED (failures=1)\n" });
  assert.equal(detector.result.flagged, true);
  detector.observe(base); detector.observe(base); detector.observe(base);
  assert.equal(detector.result.requests.length, 1);

  const unrun = createProbeDetector();
  unrun.observe(base); unrun.observe(base); unrun.observe(base);
  assert.deepEqual(unrun.endStage("review"), []);
  assert.equal(unrun.endStage("execute")[0]?.outcome.reason, "not_run");
  assert.equal(unrun.result.flagged, false);
});
