import assert from "node:assert/strict";
import test from "node:test";
import { createTimeoutDetector, earlyTimeoutAlert, incompleteTestLogAlert, validateEarlyTimeoutRatio } from "../src/timeout-watchdog.js";

const base = {
  stageId: "execute", stepId: "S1", toolCallId: "call-1", tool: "bash",
  args: {}, isError: true, output: "\nCommand timed out after 600 seconds\n\nCommand exited with code 124",
  elapsedMs: 299_999, limits: { defaultSeconds: 600, maxSeconds: 3600 }, thresholdRatio: 0.5,
};

test("flags only timeout reports before the configured fraction of the effective limit", () => {
  assert.equal(earlyTimeoutAlert(base)?.timeoutSeconds, 600);
  assert.equal(earlyTimeoutAlert({ ...base, elapsedMs: 300_000 }), null);
  assert.equal(earlyTimeoutAlert({ ...base, elapsedMs: 600_000 }), null);
  assert.equal(earlyTimeoutAlert({ ...base, elapsedMs: 400_000, thresholdRatio: 0.8 })?.thresholdRatio, 0.8);
  assert.equal(earlyTimeoutAlert({ ...base, isError: false }), null);
  assert.equal(earlyTimeoutAlert({ ...base, output: "failed" }), null);
  assert.equal(earlyTimeoutAlert({ ...base, tool: "read" }), null);
});

test("uses the requested and capped tool limits instead of the reported value", () => {
  assert.equal(earlyTimeoutAlert({ ...base, args: { timeout: 10 }, elapsedMs: 4_000 })?.timeoutSeconds, 10);
  assert.equal(earlyTimeoutAlert({ ...base, args: { timeout: 10 }, elapsedMs: 5_000 }), null);
  assert.equal(earlyTimeoutAlert({ ...base, args: { timeout: 9000 }, elapsedMs: 1_000_000 })?.timeoutSeconds, 3600);
  for (const timeout of [0, -1, "10", NaN]) {
    assert.equal(earlyTimeoutAlert({ ...base, args: { timeout } }), null);
  }
});

test("rejects invalid watchdog thresholds", () => {
  for (const ratio of [0, -1, 1.1, NaN, Infinity]) assert.throws(() => validateEarlyTimeoutRatio(ratio));
  for (const ratio of [0.5, 0.8, 1]) assert.doesNotThrow(() => validateEarlyTimeoutRatio(ratio));
});

test("flags incomplete test logs without pretending that reading them timed out", () => {
  const read = { stageId: "review", stepId: null, toolCallId: "read-1", tool: "read", args: { path: "/tmp/tests.log" }, isError: false, output: "", sawTimeout: true };
  assert.equal(incompleteTestLogAlert(read)?.reason, "empty_log_after_timeout");
  assert.equal(incompleteTestLogAlert({ ...read, sawTimeout: false }), null);
  assert.equal(incompleteTestLogAlert({ ...read, args: { path: "/tmp/tests.log", limit: 10 } }), null);
  assert.equal(incompleteTestLogAlert({ ...read, args: { path: "/tmp/source.py" } }), null);
  assert.equal(incompleteTestLogAlert({ ...read, sawTimeout: false, output: "=== test session starts ===\ncollected 2 items\n" })?.reason, "test_started_without_results");
  assert.equal(incompleteTestLogAlert({ ...read, output: "=== test session starts ===\n2 passed in 0.1s\n" }), null);
});

test("timeout detectors keep state and alerts separate between runs", () => {
  const first = createTimeoutDetector();
  const second = createTimeoutDetector();
  assert.deepEqual(first.observe(base).map((event) => event.type), ["watchdog_early_timeout"]);
  const read = { ...base, tool: "read", args: { path: "/tmp/tests.log" }, isError: false, output: "" };
  assert.deepEqual(first.observe(read).map((event) => event.type), ["watchdog_incomplete_test_log"]);
  assert.deepEqual(second.observe(read), []);
  assert.equal(first.result.alerts.length, 1);
  assert.equal(first.result.logAlerts.length, 1);
  assert.deepEqual(second.result, { earlyTimeoutRatio: 0.5, alerts: [], logAlerts: [] });
});
