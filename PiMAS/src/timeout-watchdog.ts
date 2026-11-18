import type { CommandLimits } from "./execution-tools.js";
import { testResults } from "./test-results.js";
import type { WatchdogDetector, WatchdogEvent } from "./watchdog-types.js";

/** A timing mismatch is a suspicion, not proof that the timeout is false. */
export interface EarlyTimeoutAlert {
  stageId: string;
  stepId: string | null;
  toolCallId: string;
  elapsedMs: number;
  timeoutSeconds: number;
  thresholdRatio: number;
}

/** A truncated test log may be incomplete for ordinary reasons, including an ongoing test. */
export interface IncompleteTestLogAlert {
  stageId: string;
  stepId: string | null;
  toolCallId: string;
  path: string;
  reason: "test_started_without_results" | "empty_log_after_timeout";
}

/** Adjust this threshold here; the watchdog's on/off switch enables all detectors. */
export const DEFAULT_EARLY_TIMEOUT_RATIO = 0.5; //if time out result came back x of actual timeout time

export function reportsBashTimeout(tool: string, isError: boolean, output: string): boolean {
  return tool === "bash" && isError && /(?:^|\n)Command timed out after \d+(?:\.\d+)? seconds\b/.test(output);
}

/** Read calls have no test deadline: flag missing evidence, not a fast timeout. */
export function incompleteTestLogAlert(input: {
  stageId: string; stepId: string | null; toolCallId: string; tool: string;
  args: unknown; isError: boolean; output: string; sawTimeout: boolean;
}): IncompleteTestLogAlert | null {
  if (input.tool !== "read" || input.isError || !input.args || typeof input.args !== "object") return null;
  const args = input.args as { path?: unknown; offset?: unknown; limit?: unknown };
  if (typeof args.path !== "string" || args.offset !== undefined || args.limit !== undefined) return null;
  const output = input.output.replace(/\x1b\[[0-9;]*m/g, "");
  let reason: IncompleteTestLogAlert["reason"] | null = null;
  if (!output.trim() && input.sawTimeout && /\.(?:log|txt|out)$/i.test(args.path)) {
    reason = "empty_log_after_timeout";
  } else if (/(?:test session starts|\bfound \d+ tests?\b|\bfound \d+ test\(s\)|\brunning tests?\b|\bcreating test database\b|\btesting against django\b)/i.test(output) && !testResults(output)) {
    reason = "test_started_without_results";
  }
  return reason ? { stageId: input.stageId, stepId: input.stepId, toolCallId: input.toolCallId, path: args.path, reason } : null;
}

export function validateEarlyTimeoutRatio(ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new Error("Watchdog timeout ratio must be greater than 0 and at most 1");
  }
}

/** Uses the tool's policy, not the (possibly faulty) timeout printed in its output. */
export function earlyTimeoutAlert(input: {
  stageId: string;
  stepId: string | null;
  toolCallId: string;
  tool: string;
  args: unknown;
  isError: boolean;
  output: string;
  elapsedMs: number;
  limits: CommandLimits;
  thresholdRatio: number;
}): EarlyTimeoutAlert | null {
  if (!reportsBashTimeout(input.tool, input.isError, input.output)) return null;
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) return null;
  const args = input.args && typeof input.args === "object" ? input.args as { timeout?: unknown } : {};
  const requested = args.timeout === undefined ? input.limits.defaultSeconds : args.timeout;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return null;
  const timeoutSeconds = Math.min(requested, input.limits.maxSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || input.elapsedMs >= timeoutSeconds * 1000 * input.thresholdRatio) return null;
  return {
    stageId: input.stageId, stepId: input.stepId, toolCallId: input.toolCallId,
    elapsedMs: input.elapsedMs, timeoutSeconds, thresholdRatio: input.thresholdRatio,
  };
}

export interface TimeoutDetectorResult {
  earlyTimeoutRatio: number;
  alerts: EarlyTimeoutAlert[];
  logAlerts: IncompleteTestLogAlert[];
}

/** Keep timeout-specific state and alerts together, with a fresh instance for each run. */
export function createTimeoutDetector(options: { earlyTimeoutRatio?: number } = {}): WatchdogDetector & { result: TimeoutDetectorResult } {
  const result: TimeoutDetectorResult = {
    earlyTimeoutRatio: options.earlyTimeoutRatio ?? DEFAULT_EARLY_TIMEOUT_RATIO,
    alerts: [],
    logAlerts: [],
  };
  validateEarlyTimeoutRatio(result.earlyTimeoutRatio);
  let sawTimeout = false;
  return {
    result,
    observe(input) {
      if (reportsBashTimeout(input.tool, input.isError, input.output)) sawTimeout = true;
      const events: WatchdogEvent[] = [];
      const alert = earlyTimeoutAlert({ ...input, thresholdRatio: result.earlyTimeoutRatio });
      if (alert) {
        result.alerts.push(alert);
        events.push({ type: "watchdog_early_timeout", alert });
      }
      const logAlert = incompleteTestLogAlert({ ...input, sawTimeout });
      if (logAlert) {
        result.logAlerts.push(logAlert);
        events.push({ type: "watchdog_incomplete_test_log", alert: logAlert });
      }
      return events;
    },
  };
}
