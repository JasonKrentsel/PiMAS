import { DEFAULT_MAX_BYTES, formatSize, truncateTail, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CommandLimits } from "../execution-tools.js";
import { createWorkspaceTools, shellQuote, type ExecResult, type Workspace } from "../workspace.js";
import type { ToolOutcome } from "./types.js";

/**
 * Where the watchdog reruns a command once the agent's tools are shown to be broken. A rerun returns what the
 * agent's bash tool would have shown: the same output format, truncation, timeout message and exit status.
 */
export type Rerun = (command: string, timeoutSeconds: number, signal?: AbortSignal) => Promise<ToolOutcome>;

/**
 * The default: a fresh bash tool of the pipeline's own on the same workspace, built exactly like the agent's but
 * with nothing wrapped around it. It runs the command the way the agent's tool does (in the workspace's directory,
 * stderr merged into stdout, the same exit status, timeout and output cap), so a rerun differs from the agent's only
 * where a fault was.
 *
 * That escapes any fault in the tool layer, which is where every fault in this project lives. It does not escape a
 * broken environment (a stuck database, a full disk): for that, pass a `rerun` that starts a fresh container from
 * the task image with the agent's diff applied (Sean's Harbor verifier on the fault_recovery branch is a start).
 */
export function outsideAgentTools(workspace: Workspace, limits?: CommandLimits): Rerun {
  const [bash] = createWorkspaceTools(workspace, ["bash"], limits);
  return (command, timeoutSeconds, signal) => runTool(bash!, { command, timeout: timeoutSeconds }, signal);
}

/** Read a file through a fresh read tool on the workspace, with the agent's arguments, around any fault. */
export function readOutsideAgentTools(workspace: Workspace) {
  const [read] = createWorkspaceTools(workspace, ["read"]);
  return (args: Record<string, unknown>, signal?: AbortSignal) => runTool(read!, args, signal);
}

/**
 * Runs the command in a throwaway copy of the workspace instead. It escapes stuck state in the directory, but
 * breaks projects installed in editable mode from the workspace path: in the SWE-bench astropy image, pytest in
 * the copy fails with ImportMismatchError because it finds /testbed/conftest.py and the copy's. Use it only for
 * workspaces that do not import themselves from their own path.
 */
export function freshCopy(workspace: Workspace): Rerun {
  return async (command, timeoutSeconds, signal) => {
    const cwd = workspace.cwd.replace(/\/+$/, "");
    const inCopy = command.split(cwd).join('"$PIMAS_FRESH"');
    const script = [
      `PIMAS_FRESH=$(mktemp -d) || exit 125`,
      `cp -a ${shellQuote(cwd)}/. "$PIMAS_FRESH"/ || exit 125`,
      `cd "$PIMAS_FRESH" && ( ${inCopy}\n ) 2>&1; status=$?`,
      `cd / && rm -rf "$PIMAS_FRESH"`,
      `exit $status`,
    ].join("\n");
    const result = await workspace.exec(script, { timeoutSeconds, ...(signal ? { signal } : {}) });
    return { output: asToolOutput(result, timeoutSeconds), isError: result.exitCode !== 0 };
  };
}

/**
 * A command's raw result in the shape Pi's bash tool gives the agent, cut to its last 2000 lines or 50KB as that
 * tool cuts it, so a long test run cannot flood the agent's context. For reruns that do not go through a bash tool.
 */
export function asToolOutput(result: ExecResult, timeoutSeconds?: number): string {
  const full = [result.stdout, result.stderr].filter((part) => part.trim()).join("\n").trimEnd();
  const cut = truncateTail(full);
  let output = cut.content || "(no output)";
  if (cut.truncated) {
    const first = cut.totalLines - cut.outputLines + 1;
    const limit = cut.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
    output += `\n\n[Showing lines ${first}-${cut.totalLines} of ${cut.totalLines}${limit}. Send the output to a file to see all of it.]`;
  }
  if (result.exitCode === 124) return `${output}\n\nCommand timed out${timeoutSeconds === undefined ? "" : ` after ${timeoutSeconds} seconds`}`;
  return result.exitCode === 0 ? output : `${output}\n\nCommand exited with code ${result.exitCode}`;
}

/** Run a tool and give its text and error status. Pi's bash tool throws on a nonzero exit; the message holds the output. */
export async function runTool(tool: ToolDefinition, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
  try {
    const result = await tool.execute("watchdog-outside", args as never, signal, undefined, undefined as never);
    const content = (result as { content?: { type?: string }[] }).content ?? [];
    return {
      output: textOf(result),
      isError: (result as { isError?: boolean }).isError === true,
      ...(content.some((part) => part.type !== "text") ? { content } : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { output: error instanceof Error ? error.message : String(error), isError: true };
  }
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : "")).join("");
}
