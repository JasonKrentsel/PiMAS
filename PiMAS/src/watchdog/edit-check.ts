import path from "node:path";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { readWorkspaceFile, writeWorkspaceFile, type Workspace } from "../workspace.js";
import type { Evidence, ToolCall, WatchdogPlugin } from "./types.js";

/**
 * Plug-in 2: a corrupted edit (faults edit-corrupt, edit-corrupt-all, edit-corrupt-hidden).
 *
 * before   Read the file as it is on disk, through the workspace rather than the agent's tools (which a fault can
 *          make lie, as edit-corrupt-hidden does).
 * detect   After a successful edit or write, read the file again the same way, and work out what it should hold:
 *          for a write, the content written; for an edit, the old file with the agent's edits applied by Pi's own
 *          edit tool, run on a copy in memory (so its line endings, byte-order mark and fuzzy matching are exactly
 *          the agent's tool's). Suspicious if the file holds anything else.
 * confirm  The direct read is the evidence; the difference is named by its first line.
 * repair   Write the intended content, and tell the agent which line was wrong. If the intended content cannot be
 *          worked out (no old copy, or the edit does not apply to it), only tell the agent if the file does not hold
 *          the text it wrote.
 */

/** What the file should hold after the agent's edit: Pi's edit tool applied to the old content in memory. */
export async function intendedEdit(old: string, args: Record<string, unknown>, cwd: string): Promise<string | null> {
  let written: string | null = null;
  const tool = createEditToolDefinition(cwd, { operations: {
    readFile: async () => Buffer.from(old, "utf8"),
    writeFile: async (_file, content) => { written = content; },
    access: async () => {},
  } });
  try {
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    await tool.execute("watchdog-intended", prepared as never, undefined, undefined, undefined as never);
  } catch {
    return null;
  }
  return written;
}

/** The agent's new texts, in every form Pi's edit tool accepts (a list, a JSON string of one, or one edit). */
export function newTextsOf(args: Record<string, unknown>): string[] {
  let edits: unknown = args.edits;
  if (typeof edits === "string") { try { edits = JSON.parse(edits); } catch { edits = []; } }
  const list = Array.isArray(edits) ? edits : edits && typeof edits === "object" ? [edits] : [];
  return [...list, args].map((edit) => (edit as { newText?: unknown })?.newText).filter((text): text is string => typeof text === "string");
}

/** The first line where two versions of a file differ, as `line N reads "shown" instead of "wanted"`. */
export function firstDifference(actual: string, intended: string): string {
  const a = actual.split(/\r?\n/);
  const b = intended.split(/\r?\n/);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1} reads ${JSON.stringify(a[i] ?? "")} instead of ${JSON.stringify(b[i] ?? "")}`;
  }
  return "the files differ in their line endings";
}

const lf = (text: string) => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

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
      const old = before.get(call.toolCallId) ?? null;
      before.delete(call.toolCallId);
      if (!changesFiles(call) || !file || outcome.isError) return null;
      const now = await readOrNull(tools.workspace, file);
      if (now === null) return null; // nothing to check against (the file is gone, or unreadable)
      const intended = call.tool === "write"
        ? String(call.args.content ?? "")
        : old === null ? null : await intendedEdit(old, call.args, tools.workspace.cwd);
      const matches = intended !== null
        ? now === intended
        : newTextsOf(call.args).every((text) => lf(now).includes(lf(text)));
      if (matches) return null;
      return { reason: `${call.args.path} does not hold what the agent wrote`, data: { file, now, intended } };
    },

    async confirm(suspicion): Promise<Evidence> {
      const { file, now, intended } = suspicion.data as { file: string; now: string; intended: string | null };
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
