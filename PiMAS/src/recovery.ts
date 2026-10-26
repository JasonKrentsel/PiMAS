import { readFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Open required history, repairing unfinished calls without executing them. */
export async function openSavedSession(file: string, cwd: string): Promise<SessionManager> {
  // Pi tolerates missing files and malformed lines; workflow recovery must not.
  const content = await readFile(file, "utf8");
  let rows: Record<string, unknown>[];
  try {
    rows = content.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    const header = rows[0];
    if (!header || header.type !== "session" || typeof header.id !== "string" ||
        typeof header.cwd !== "string" || path.resolve(header.cwd) !== path.resolve(cwd)) {
      throw new Error("Invalid session header or workspace");
    }
    const ids = new Set<string>();
    for (const entry of rows.slice(1)) {
      if (!entry || typeof entry.type !== "string" || typeof entry.id !== "string" ||
          ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId as string))) {
        throw new Error("Invalid session entry tree");
      }
      ids.add(entry.id);
    }
  } catch {
    throw new Error(`Invalid saved session: ${file}`);
  }
  const manager = SessionManager.open(file);
  const pending = new Map<string, string>();
  for (const message of manager.buildSessionContext().messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") pending.set(block.id, block.name);
      }
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }
  for (const [toolCallId, toolName] of pending) {
    manager.appendMessage({
      role: "toolResult", toolCallId, toolName, isError: true, timestamp: Date.now(),
      content: [{ type: "text", text: "Run interrupted before this tool result was recorded. The action may already have taken effect. It was not replayed. Inspect the recovery summary and saved state before deciding what to do next." }],
    });
  }
  return manager;
}
