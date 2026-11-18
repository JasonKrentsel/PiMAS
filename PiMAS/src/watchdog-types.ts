import type { CommandLimits } from "./execution-tools.js";
import type { EarlyTimeoutAlert, IncompleteTestLogAlert } from "./timeout-watchdog.js";
import type { ProbeOutcome, ProbeRequest } from "./probe-watchdog.js";

/** The tool result visible to the agent and the timing measured by the pipeline. */
export interface WatchdogObservation {
  stageId: string;
  stepId: string | null;
  toolCallId: string;
  tool: string;
  args: unknown;
  isError: boolean;
  output: string;
  elapsedMs: number;
  limits: CommandLimits;
}

/** Add a detector's event type here so the pipeline and provenance can record it. */
export type WatchdogEvent =
  | { type: "watchdog_early_timeout"; alert: EarlyTimeoutAlert }
  | { type: "watchdog_incomplete_test_log"; alert: IncompleteTestLogAlert }
  | { type: "watchdog_probe_requested"; request: ProbeRequest }
  | { type: "watchdog_probe_result"; outcome: ProbeOutcome };

/** Detectors own their state and inspect observations independently. */
export interface WatchdogDetector {
  observe(input: WatchdogObservation): WatchdogEvent[];
}
