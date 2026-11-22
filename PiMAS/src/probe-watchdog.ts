import { randomUUID } from "node:crypto";
import { incompleteTestLogAlert, reportsBashTimeout } from "./timeout-watchdog.js";
import type { WatchdogObservation } from "./watchdog-types.js";

// Both probes run the same known-passing test; the read probe saves the output before reading it.
export const WATCHDOG_PROBE_COMMAND = "python3 -I -c 'import unittest; suite = unittest.TestSuite([unittest.FunctionTestCase(lambda: None)]); result = unittest.TextTestRunner(verbosity=2).run(suite); raise SystemExit(not result.wasSuccessful())'";
export const WATCHDOG_PROBE_TIMEOUT = 10;
export const readProbeCommand = (path: string) => `${WATCHDOG_PROBE_COMMAND} > ${path} 2>&1`;

export function probePrompt(request: ProbeRequest): string {
  if (request.tool === "bash") return `Watchdog: Three tool failures or timeouts have occurred. Test the bash result path by running this known-passing test using bash with timeout ${WATCHDOG_PROBE_TIMEOUT} seconds. Copy the command exactly:\n${WATCHDOG_PROBE_COMMAND}`;
  return `Watchdog: Independently test the read result path. First run this known-passing test using bash with timeout ${WATCHDOG_PROBE_TIMEOUT} seconds, copying the command exactly:\n${request.prepareCommand}\nThen use the read tool on ${request.path} without an offset or limit. Do not substitute bash for read.`;
}

export function probeOutcomeMessage(outcome: ProbeOutcome): string {
  const label = outcome.request.tool;
  if (outcome.outcome === "failed") {
    const observation = outcome.reason === "timeout" ? "timed out" : outcome.reason === "incomplete_read" ? "returned incomplete or unexpected output" : "reported a failure";
    return `Watchdog: The known-passing test ${observation} through ${label}. Flag the ${label} test-result path as suspect; do not claim the task tests verified the solution on this evidence. An independent verifier is needed to distinguish tool faults from task-code problems.`;
  }
  if (outcome.outcome === "passed") return `Watchdog: The ${label} probe found no evidence of a test-result fault; this does not rule out selective faults.`;
  return `Watchdog: The ${label} diagnostic test was inconclusive. Do not infer that this path is healthy or faulty from this probe.`;
}

export interface ProbeRequest {
  stageId: string;
  stepId: string | null;
  triggerToolCallId: string;
  failures: number;
  tool: "bash" | "read";
  path?: string;
  prepareCommand?: string;
}

export interface ProbeOutcome {
  request: ProbeRequest;
  toolCallId: string | null;
  outcome: "passed" | "failed" | "inconclusive";
  reason: "passed" | "test_failed" | "timeout" | "unrecognized_result" | "not_run" | "prepare_failed" | "partial_read" | "incomplete_read";
}

const nativeTools = new Set(["read", "grep", "find", "ls", "edit", "write", "bash"]);
const failedTest = /(?:^|\n)(?:FAILED \((?:failures|errors)=|\S+::\S+ (?:FAILED|ERROR)\b|(?:FAILED|ERROR) \S+::\S+|.* \.\.\. (?:FAIL|ERROR)\b|.*\b\d+ (?:failed|errors?)\b.* in [\d.]+ ?s\b|.*tests finished:.*\b\d+ (?:failed|exceptions?)\b)/m;

export function createProbeDetector() {
  const result: { flagged: boolean; requests: ProbeRequest[]; outcomes: ProbeOutcome[] } = { flagged: false, requests: [], outcomes: [] };
  let failures = 0;
  let sawTimeout = false;
  let requested = false;
  const pending = new Map<"bash" | "read", ProbeRequest>();
  let readPrepared = false;
  const finish = (outcome: ProbeOutcome) => {
    result.outcomes.push(outcome);
    if (outcome.outcome === "failed") result.flagged = true;
    pending.delete(outcome.request.tool);
    if (!pending.size) { requested = false; failures = 0; }
    return { type: "watchdog_probe_result" as const, outcome };
  };
  return {
    result,
    observe(input: WatchdogObservation) {
      if (reportsBashTimeout(input.tool, input.isError, input.output)) sawTimeout = true;
      const args = input.args && typeof input.args === "object" ? input.args as { command?: unknown; timeout?: unknown; path?: unknown; offset?: unknown; limit?: unknown } : {};
      const bash = pending.get("bash");
      const read = pending.get("read");
      const enoughTime = () => {
        const timeout = args.timeout === undefined ? input.limits.defaultSeconds : args.timeout;
        return typeof timeout === "number" && Number.isFinite(timeout) && Math.min(timeout, input.limits.maxSeconds) >= WATCHDOG_PROBE_TIMEOUT;
      };
      if (read && input.stageId === read.stageId && input.tool === "bash" && args.command === read.prepareCommand && !readPrepared) {
        if (input.isError || !enoughTime()) return [finish({ request: read, toolCallId: input.toolCallId, outcome: "inconclusive", reason: "prepare_failed" })];
        readPrepared = true;
        return [{ type: "watchdog_probe_prepared" as const, request: read, toolCallId: input.toolCallId }];
      }
      const bashCall = bash && input.stageId === bash.stageId && input.tool === "bash" && args.command === WATCHDOG_PROBE_COMMAND;
      const readCall = read && readPrepared && input.stageId === read.stageId && input.tool === "read" && args.path === read.path;
      if (bashCall || readCall) {
        const request = (bashCall ? bash : read)!;
        const plain = input.output.replace(/\x1b\[[0-9;]*m/g, "");
        const timeout = !!bashCall && enoughTime() && reportsBashTimeout(input.tool, input.isError, plain);
        const partial = !!readCall && (args.offset !== undefined || args.limit !== undefined);
        const valid = !partial && (!bashCall || enoughTime()) && (!readCall || !input.isError);
        const fail = valid && failedTest.test(plain);
        const passed = valid && !input.isError && /(?:^|\n)Ran 1 test in [\d.]+s\s*\n\s*OK\s*(?:\n|$)/m.test(plain);
        // Preparation succeeded, so a complete read must contain this known test's result.
        // A missing result is suspicious but does not establish that a timeout caused it.
        const incomplete = !!readCall && valid && !fail && !passed;
        const reason = partial ? "partial_read" : timeout ? "timeout" : fail ? "test_failed" : passed ? "passed" : incomplete ? "incomplete_read" : "unrecognized_result";
        return [finish({ request, toolCallId: input.toolCallId, outcome: timeout || fail || incomplete ? "failed" : passed ? "passed" : "inconclusive", reason })];
      }
      if (requested || result.flagged || !nativeTools.has(input.tool)) return [];
      const incompleteLog = incompleteTestLogAlert({ ...input, sawTimeout }) !== null;
      const isFailure = input.isError || incompleteLog || ((input.tool === "read" || input.tool === "bash") && failedTest.test(input.output.replace(/\x1b\[[0-9;]*m/g, "")));
      if (!isFailure || ++failures < 3) return [];
      requested = true;
      readPrepared = false;
      const common = { stageId: input.stageId, stepId: input.stepId, triggerToolCallId: input.toolCallId, failures };
      const path = `/tmp/pimas-watchdog-read-${randomUUID()}.log`;
      const requests: ProbeRequest[] = [{ ...common, tool: "bash" }, { ...common, tool: "read", path, prepareCommand: readProbeCommand(path) }];
      for (const request of requests) { pending.set(request.tool, request); result.requests.push(request); }
      return requests.map((request) => ({ type: "watchdog_probe_requested" as const, request }));
    },
    endStage(stageId: string) {
      return [...pending.values()].filter((request) => request.stageId === stageId)
        .map((request) => finish({ request, toolCallId: null, outcome: "inconclusive", reason: "not_run" }));
    },
  };
}
