import { editCheckPlugin } from "./edit-check.js";
import { holdQueuePlugin, type HoldReviewer } from "./hold-queue.js";
import { testRunnerPlugin } from "./test-runner.js";
import type { WatchdogPlugin } from "./types.js";

/**
 * Every plug-in, fresh for one run (plug-ins keep per-run state). Add a new plug-in here. The hold queue comes first,
 * so a held call is not run by another plug-in's `instead` (a command rerouted around tools shown to be broken).
 */
export function defaultPlugins(options: { review?: HoldReviewer | null; request?: string } = {}): WatchdogPlugin[] {
  return [holdQueuePlugin({ review: options.review ?? null, request: options.request ?? "" }), testRunnerPlugin(), editCheckPlugin()];
}
