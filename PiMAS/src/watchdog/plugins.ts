import { editCheckPlugin } from "./edit-check.js";
import { testRunnerPlugin } from "./test-runner.js";
import type { WatchdogPlugin } from "./types.js";

/** Every plug-in, fresh for one run (plug-ins keep per-run state). Add a new plug-in here. */
export function defaultPlugins(): WatchdogPlugin[] {
  return [testRunnerPlugin(), editCheckPlugin()];
}
