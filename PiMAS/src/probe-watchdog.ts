import type { WatchdogObservation } from "./watchdog-types.js";
import { incompleteTestLogAlert, reportsBashTimeout } from "./timeout-watchdog.js";

// A real, self-contained test: its output has the same unittest format as task tests.
export const WATCHDOG_PROBE_COMMAND = "python3 -I -c 'import unittest; suite = unittest.TestSuite([unittest.FunctionTestCase(lambda: None)]); result = unittest.TextTestRunner(verbosity=2).run(suite); raise SystemExit(not result.wasSuccessful())'";
export const WATCHDOG_PROBE_TIMEOUT = 10;
export const WATCHDOG_PROBE_PROMPT = `Watchdog: Three tool failures or timeouts have occurred. Before continuing, run this known-passing, quick test using the bash tool with timeout ${WATCHDOG_PROBE_TIMEOUT} seconds. Copy the command exactly so the watchdog can identify its result:\n${WATCHDOG_PROBE_COMMAND}`;

export function probeOutcomeMessage(outcome: ProbeOutcome): string {
  if (outcome.outcome === "failed") return "Watchdog: The known-passing test failed or timed out. Flag the test-result path as suspect; do not claim the task tests verified the solution on this evidence. An independent verifier is needed to distinguish tool faults from task-code problems.";
  if (outcome.outcome === "passed") return "Watchdog: The known-passing test passed. The probe found no evidence of a test-result fault; investigate the task code and its tests. This does not rule out every possible fault.";
  return "Watchdog: The diagnostic test was inconclusive. Do not infer that the tool is healthy or faulty from this probe.";
}

export interface ProbeRequest {
  stageId: string;
  stepId: string | null;
  triggerToolCallId: string;
  failures: number;
}

export interface ProbeOutcome {
  request: ProbeRequest;
  toolCallId: string | null;
  outcome: "passed" | "failed" | "inconclusive";
  reason: "passed" | "test_failed" | "timeout" | "unrecognized_result" | "not_run";
}

const nativeTools = new Set(["read", "grep", "find", "ls", "edit", "write", "bash"]);
// A read of a failing test log normally succeeds as a read, even though the test failed.
const failedTest = /(?:^|\n)(?:FAILED \((?:failures|errors)=|\S+::\S+ (?:FAILED|ERROR)\b|(?:FAILED|ERROR) \S+::\S+|.* \.\.\. (?:FAIL|ERROR)\b|.*\b\d+ (?:failed|errors?)\b.* in [\d.]+ ?s\b|.*tests finished:.*\b\d+ (?:failed|exceptions?)\b)/m;

export function createProbeDetector() {
  const result: { flagged: boolean; requests: ProbeRequest[]; outcomes: ProbeOutcome[] } = { flagged: false, requests: [], outcomes: [] };
  let failures = 0;
  let sawTimeout = false;
  let pending: ProbeRequest | undefined;
  const finish = (outcome: ProbeOutcome) => {
    result.outcomes.push(outcome);
    if (outcome.outcome === "failed") result.flagged = true;
    pending = undefined;
    failures = 0;
    return { type: "watchdog_probe_result" as const, outcome };
  };
  return {
    result,
    observe(input: WatchdogObservation) {
      if (reportsBashTimeout(input.tool, input.isError, input.output)) sawTimeout = true;
      const args = input.args && typeof input.args === "object" ? input.args as { command?: unknown; timeout?: unknown } : {};
      if (pending && input.stageId === pending.stageId && input.tool === "bash" && args.command === WATCHDOG_PROBE_COMMAND) {
        const plain = input.output.replace(/\x1b\[[0-9;]*m/g, "");
        const requestedTimeout = args.timeout === undefined ? input.limits.defaultSeconds : args.timeout;
        const enoughTime = typeof requestedTimeout === "number" && Number.isFinite(requestedTimeout) && Math.min(requestedTimeout, input.limits.maxSeconds) >= WATCHDOG_PROBE_TIMEOUT;
        const timeout = enoughTime && reportsBashTimeout(input.tool, input.isError, plain);
        const fail = failedTest.test(plain);
        const passed = !input.isError && /(?:^|\n)Ran 1 test in [\d.]+s\s*\n\s*OK\s*(?:\n|$)/m.test(plain);
        const reason = timeout ? "timeout" : fail ? "test_failed" : passed ? "passed" : "unrecognized_result";
        return [finish({ request: pending, toolCallId: input.toolCallId, outcome: timeout || fail ? "failed" : passed ? "passed" : "inconclusive", reason })];
      }
      if (pending || result.flagged || !nativeTools.has(input.tool)) return [];
      const incompleteLog = incompleteTestLogAlert({ ...input, sawTimeout }) !== null;
      const isFailure = input.isError || incompleteLog || ((input.tool === "read" || input.tool === "bash") && failedTest.test(input.output.replace(/\x1b\[[0-9;]*m/g, "")));
      if (!isFailure || ++failures < 3) return [];
      pending = { stageId: input.stageId, stepId: input.stepId, triggerToolCallId: input.toolCallId, failures };
      result.requests.push(pending);
      return [{ type: "watchdog_probe_requested" as const, request: pending }];
    },
    endStage(stageId: string) {
      if (!pending || pending.stageId !== stageId) return [];
      return [finish({ request: pending, toolCallId: null, outcome: "inconclusive", reason: "not_run" })];
    },
  };
}
