import assert from "node:assert/strict";
import test from "node:test";
import { createProbeDetector, WATCHDOG_PROBE_COMMAND } from "../src/probe-watchdog.js";

const base = { stageId: "execute", stepId: "S1", toolCallId: "1", tool: "bash", args: {}, isError: true,
  output: "Command exited with code 1", elapsedMs: 1, limits: { defaultSeconds: 600, maxSeconds: 600 } };
const pass = "test (unittest.case.FunctionTestCase) ... ok\n\nRan 1 test in 0.001s\n\nOK\n";
const fail = "test (unittest.case.FunctionTestCase) ... FAIL\n\nRan 1 test in 0.001s\n\nFAILED (failures=1)\n";
const bashProbe = { ...base, toolCallId: "bash-probe", args: { command: WATCHDOG_PROBE_COMMAND, timeout: 10 } };

function requested() {
  const detector = createProbeDetector();
  detector.observe(base); detector.observe(base);
  const events = detector.observe(base);
  assert.deepEqual(events.map((event) => event.type), ["watchdog_probe_requested", "watchdog_probe_requested"]);
  return detector;
}
function prepare(detector: ReturnType<typeof createProbeDetector>) {
  const request = detector.result.requests.find((item) => item.tool === "read")!;
  detector.observe({ ...base, toolCallId: "prepare", args: { command: request.prepareCommand, timeout: 10 }, isError: false, output: "" });
  return request;
}

test("bash and read probes have independent outcomes", () => {
  for (const badTool of ["bash", "read", null] as const) {
    const detector = requested();
    const read = prepare(detector);
    detector.observe({ ...bashProbe, isError: badTool === "bash", output: badTool === "bash" ? fail : pass });
    detector.observe({ ...base, tool: "read", toolCallId: "read-probe", args: { path: read.path }, isError: false, output: badTool === "read" ? fail : pass });
    assert.deepEqual(detector.result.outcomes.map((item) => [item.request.tool, item.outcome]), [
      ["bash", badTool === "bash" ? "failed" : "passed"], ["read", badTool === "read" ? "failed" : "passed"],
    ]);
    assert.equal(detector.result.flagged, badTool !== null);
    detector.observe(base); detector.observe(base); detector.observe(base);
    assert.equal(detector.result.requests.length, badTool === null ? 4 : 2);
    if (badTool === null) {
      const second = detector.result.requests.filter((item) => item.tool === "read").at(-1)!;
      assert.notEqual(second.path, read.path);
      assert.equal(detector.observe({ ...base, args: { command: second.prepareCommand, timeout: 10 }, isError: false, output: "" })[0]?.type, "watchdog_probe_prepared");
      detector.observe({ ...base, tool: "read", args: { path: second.path }, isError: false, output: pass });
      assert.equal(detector.result.outcomes.at(-1)?.outcome, "passed");
    }
  }
});

test("read probe requires successful preparation and a full read", () => {
  const noPrep = requested();
  const request = noPrep.result.requests.find((item) => item.tool === "read")!;
  assert.deepEqual(noPrep.observe({ ...base, tool: "read", args: { path: request.path }, output: pass, isError: false }), []);
  noPrep.observe({ ...base, args: { command: request.prepareCommand, timeout: 10 }, output: "python3: command not found" });
  assert.equal(noPrep.result.outcomes[0]?.reason, "prepare_failed");
  assert.equal(noPrep.result.flagged, false);
  const partial = requested();
  const read = prepare(partial);
  partial.observe({ ...base, tool: "read", args: { path: read.path, limit: 2 }, isError: false, output: fail });
  assert.equal(partial.result.outcomes[0]?.reason, "partial_read");
  assert.equal(partial.result.flagged, false);
});

test("too-short timeouts and unrun probes remain inconclusive", () => {
  const detector = requested();
  detector.observe({ ...bashProbe, args: { ...bashProbe.args, timeout: 1 }, output: "Command timed out after 1 seconds" });
  assert.equal(detector.result.outcomes[0]?.outcome, "inconclusive");
  assert.deepEqual(detector.endStage("review"), []);
  assert.equal(detector.endStage("execute")[0]?.outcome.reason, "not_run");
  assert.equal(detector.result.flagged, false);
});

test("a complete read missing the prepared test result flags the read path", () => {
  const detector = requested();
  const read = prepare(detector);
  detector.observe({ ...base, tool: "read", args: { path: read.path }, isError: false, output: "" });
  assert.equal(detector.result.outcomes[0]?.reason, "incomplete_read");
  assert.equal(detector.result.outcomes[0]?.outcome, "failed");
  assert.equal(detector.result.flagged, true);
});

test("failed tests and incomplete logs in bash and read results count", () => {
  const detector = createProbeDetector();
  detector.observe({ ...base, isError: false, output: "test_example (suite.Case) ... FAIL\n" });
  detector.observe({ ...base, tool: "read", args: { path: "test.log" }, isError: false, output: "=== test session starts ===\n" });
  const events = detector.observe({ ...base, tool: "read", isError: false, output: "1 failed, 3 passed in 0.2s\n" });
  assert.equal(events.length, 2);
});
