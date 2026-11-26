import path from "node:path";
import { readWorkspaceFile, writeWorkspaceFile, type Workspace } from "../workspace.js";
import type { Evidence, ToolCall, WatchdogPlugin } from "./types.js";

/**
 * Plug-in 2: a corrupted edit (faults edit-corrupt, edit-corrupt-all, edit-corrupt-hidden).
 *
 * before   Read the file as it is on disk, through the workspace rather than the agent's tools (which a fault can
 *          make lie, as edit-corrupt-hidden does).
 * detect   After a successful edit or write, read the file again the same way. Suspicious if it does not hold
 *          the text the agent wrote.
 * confirm  The direct read is the evidence. Work out what the file should hold: the old content with the agent's
 *          edits applied exactly.
 * repair   Write that content, and tell the agent which line was wrong. If the intended content cannot be worked
 *          out, only tell the agent what the file really holds.
 */
interface Edit { oldText: string; newText: string }

/** The agent's edits, in either form Pi's edit tool accepts. */
export function editsOf(args: Record<string, unknown>): Edit[] {
  const list = Array.isArray(args.edits) ? args.edits as Edit[] : [];
  const single = typeof args.oldText === "string" && typeof args.newText === "string" ? [{ oldText: args.oldText, newText: args.newText }] : [];
  return [...list, ...single].filter((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string");
}

/** The old content with each edit applied, as Pi's edit tool does; null if an old text is not found exactly once. */
export function applyEdits(content: string, edits: Edit[]): string | null {
  let result = content;
  for (const edit of edits) {
    const at = result.indexOf(edit.oldText);
    if (at < 0 || result.indexOf(edit.oldText, at + 1) >= 0) return null;
    result = result.slice(0, at) + edit.newText + result.slice(at + edit.oldText.length);
  }
  return result;
}

/** The first line where two versions of a file differ, as "line N: 'shown' instead of 'wanted'". */
export function firstDifference(actual: string, intended: string): string {
  const a = actual.split("\n");
  const b = intended.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1} reads ${JSON.stringify(a[i] ?? "")} instead of ${JSON.stringify(b[i] ?? "")}`;
  }
  return "the files differ";
}

async function readOrNull(workspace: Workspace, file: string): Promise<string | null> {
  try { return (await readWorkspaceFile(workspace, file)).toString("utf8"); } catch { return null; }
}

export function editCheckPlugin(): WatchdogPlugin {
  const before = new Map<string, string | null>(); // file content before each edit or write, by tool call
  const fileOf = (call: ToolCall, cwd: string) =>
    typeof call.args.path === "string" ? path.posix.resolve(cwd, call.args.path.replace(/^@/, "")) : null;
  const changesFiles = (call: ToolCall) => call.tool === "edit" || call.tool === "write";

  return {
    name: "edit-check",

    async before(call, tools) {
      const file = fileOf(call, tools.workspace.cwd);
      if (changesFiles(call) && file) before.set(call.toolCallId, await readOrNull(tools.workspace, file));
    },

    async detect(call, outcome, tools) {
      const file = fileOf(call, tools.workspace.cwd);
      if (!changesFiles(call) || !file || outcome.isError) return null;
      const now = await readOrNull(tools.workspace, file);
      const wrote = call.tool === "write" ? [String(call.args.content ?? "")] : editsOf(call.args).map((edit) => edit.newText);
      const missing = call.tool === "write" ? now !== wrote[0] : wrote.some((text) => !(now ?? "").includes(text));
      if (!missing) {
        before.delete(call.toolCallId);
        return null;
      }
      return { reason: `${call.args.path} does not hold the text the agent wrote`, data: { file, now: now ?? "" } };
    },

    async confirm(suspicion, call): Promise<Evidence> {
      const { file, now } = suspicion.data as { file: string; now: string };
      const old = before.get(call.toolCallId) ?? null;
      before.delete(call.toolCallId);
      const intended = call.tool === "write" ? String(call.args.content ?? "") : old === null ? null : applyEdits(old, editsOf(call.args));
      const reason = intended === null ? "file read directly; intended content unknown" : firstDifference(now, intended);
      return { confirmed: true, reason, data: { file, intended } };
    },

    async repair(evidence, call, _outcome, tools) {
      const { file, intended } = evidence.data as { file: string; intended: string | null };
      if (intended === null) {
        return { note: `[watchdog] After this change, ${call.args.path} on disk does not hold the text you wrote. Check the file with python or a test, not only by viewing it.` };
      }
      await writeWorkspaceFile(tools.workspace, file, intended);
      return { note: `[watchdog] After this change, ${call.args.path} on disk did not match what you wrote (${evidence.reason}). It has been restored to the content you intended.` };
    },
  };
}
