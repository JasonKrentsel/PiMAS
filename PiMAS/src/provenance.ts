import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentRole } from "./agent-config.js";

export type StageName = "research" | "plan" | "execute" | "review" | "correct" | "solve";

export interface ToolCallRecord {
  toolCallId: string;
  tool: string;
  /** Plan step the executor declared with begin_step; null outside a step. */
  stepId: string | null;
  args: string;
  isError: boolean;
  durationMs: number | null;
  startedAt: string;
}

/** One stage output and everything it was built from. */
export interface StageArtifact {
  id: string;
  stage: StageName;
  role: AgentRole;
  /** Artifact IDs this stage received as input. */
  parents: string[];
  status: "submitted" | "missing" | "failed";
  content: unknown;
  sha256: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  usage: Usage;
  toolCalls: ToolCallRecord[];
  /** Workspace files created or modified while the stage ran; null when the probe failed. */
  changedFiles: string[] | null;
  sessionFile: string | null;
}

export type ProvenanceEvent =
  | { type: "run_start"; mode: string; review: boolean; request: string }
  | { type: "stage_start"; id: string; stage: StageName; role: AgentRole; parents: string[] }
  | { type: "tool_call"; stageId: string; call: ToolCallRecord }
  | { type: "stage_end"; artifact: StageArtifact }
  | { type: "run_end"; status: string; durationMs: number };

/**
 * Append-only JSONL. Each event is written as it happens so a run killed at the agent
 * deadline still leaves the stages and tool calls that completed.
 */
export class ProvenanceLog {
  readonly file: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.file = path.join(directory, "provenance.jsonl");
  }

  record(event: ProvenanceEvent): Promise<void> {
    const line = JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n";
    this.pending = this.pending.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await appendFile(this.file, line);
    });
    return this.pending;
  }

  flush(): Promise<void> {
    return this.pending;
  }
}

/** SHA-256 of canonical JSON, so equal content always hashes the same regardless of key order. */
export function contentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
