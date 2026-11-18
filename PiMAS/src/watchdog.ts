import { createTimeoutDetector, type TimeoutDetectorResult } from "./timeout-watchdog.js";
import type { WatchdogDetector, WatchdogObservation } from "./watchdog-types.js";
import { createProbeDetector } from "./probe-watchdog.js";

// Preserve the existing summary fields while detectors own their results.
export type WatchdogResult = TimeoutDetectorResult & { probe: ReturnType<typeof createProbeDetector>["result"] };

/** Dispatch observed tool results to the registered detectors. */
export function createWatchdog(options: { earlyTimeoutRatio?: number } = {}) {
  const timeout = createTimeoutDetector(options);
  const probe = createProbeDetector();
  const detectors: WatchdogDetector[] = [timeout, probe];
  return {
    result: { ...timeout.result, probe: probe.result },
    observe(input: WatchdogObservation) {
      return detectors.flatMap((detector) => detector.observe(input));
    },
    endStage(stageId: string) { return probe.endStage(stageId); },
  };
}
