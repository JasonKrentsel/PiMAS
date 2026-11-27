import { shellQuote, type ExecResult, type Workspace } from "../workspace.js";

/**
 * Where the watchdog reruns a command once the agent's tools are shown to be broken.
 *
 * `outsideAgentTools` (the default) runs it in the workspace itself, through the pipeline's own command path,
 * which no agent tool or fault wrapper touches. That gives the real result for any fault in the tool layer, which
 * is where every fault in this project lives. It does not escape a broken environment (a stuck database, a full
 * disk): for that, pass a `rerun` that starts a fresh container from the task image with the agent's diff
 * applied (Sean's Harbor verifier on the fault_recovery branch is a start).
 *
 * `freshCopy` runs it in a throwaway copy of the workspace instead. It escapes stuck state in the directory, but
 * breaks projects installed in editable mode from the workspace path: in the SWE-bench astropy image, pytest in
 * the copy fails with ImportMismatchError because it finds /testbed/conftest.py and the copy's. Use it only for
 * workspaces that do not import themselves from their own path.
 */
export function outsideAgentTools(workspace: Workspace) {
  return (command: string, timeoutSeconds: number, signal?: AbortSignal): Promise<ExecResult> =>
    workspace.exec(command, { timeoutSeconds, ...(signal ? { signal } : {}) });
}

export function freshCopy(workspace: Workspace) {
  return async (command: string, timeoutSeconds: number, signal?: AbortSignal): Promise<ExecResult> => {
    const cwd = workspace.cwd.replace(/\/+$/, "");
    const inCopy = command.split(cwd).join('"$PIMAS_FRESH"');
    const script = [
      `PIMAS_FRESH=$(mktemp -d) || exit 125`,
      `cp -a ${shellQuote(cwd)}/. "$PIMAS_FRESH"/ || exit 125`,
      `cd "$PIMAS_FRESH" && ( ${inCopy}\n ); status=$?`,
      `cd / && rm -rf "$PIMAS_FRESH"`,
      `exit $status`,
    ].join("\n");
    return workspace.exec(script, { timeoutSeconds, ...(signal ? { signal } : {}) });
  };
}

/** A rerun's output in the shape Pi's bash tool gives the agent. */
export function asToolOutput(result: ExecResult): string {
  const output = [result.stdout, result.stderr].filter((part) => part.trim()).join("\n").trimEnd() || "(no output)";
  if (result.exitCode === 124) return `${output}\n\nCommand timed out\n\nCommand exited with code 124`;
  return result.exitCode === 0 ? output : `${output}\n\nCommand exited with code ${result.exitCode}`;
}
