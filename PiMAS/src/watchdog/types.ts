import type { ExecResult, Workspace } from "../workspace.js";

/**
 * The watchdog's plug-in interface. A plug-in handles one kind of fault in four steps, each run by the monitor
 * (monitor.ts) around every tool call the agent makes:
 *
 *   before   optional: note anything needed later (e.g. a file's content before an edit).
 *   instead  optional: for a fault already confirmed, handle the call without the agent's tool (e.g. run a test
 *            command outside a runner shown to be broken, so it does not run twice). Return null to let it run.
 *   detect   look at the call and the result the agent is about to get; return a suspicion, or null.
 *   confirm  gather independent evidence for the suspicion (a probe, a direct file read); cheap false alarms end here.
 *   repair   fix what the agent sees or what is on disk, and say what was done in a note to the agent.
 *
 * Plug-ins see only what a real system would see: tool calls, their results, and the workspace itself. They never
 * read fault-injection records.
 */
export interface WatchdogPlugin {
  /** Short name, used in provenance events and the run summary. */
  name: string;
  before?(call: ToolCall, tools: WatchdogTools): Promise<void>;
  instead?(call: ToolCall, tools: WatchdogTools): Promise<Instead | null> | Instead | null;
  detect(call: ToolCall, outcome: ToolOutcome, tools: WatchdogTools): Promise<Suspicion | null> | Suspicion | null;
  confirm(suspicion: Suspicion, call: ToolCall, tools: WatchdogTools): Promise<Evidence>;
  repair(evidence: Evidence, call: ToolCall, outcome: ToolOutcome, tools: WatchdogTools): Promise<Repair>;
}

/** One tool call by the agent. */
export interface ToolCall {
  stageId: string;
  stepId: string | null;
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
}

/** The result the agent would get: the tool's text and whether it reported an error. */
export interface ToolOutcome {
  output: string;
  isError: boolean;
}

export interface Suspicion {
  /** Why the plug-in is suspicious, in a few words (recorded in provenance). */
  reason: string;
  data?: unknown;
}

export interface Evidence {
  confirmed: boolean;
  reason: string;
  data?: unknown;
}

export interface Repair {
  /** Shown to the agent after the tool result. */
  note: string;
  /** Replaces the result the agent gets, e.g. with a test's real output from a fresh workspace. */
  replacement?: ToolOutcome;
}

/** A call handled without the agent's tool: why (recorded in provenance), and the note and result the agent gets. */
export interface Instead extends Required<Repair> {
  reason: string;
}

/** What plug-ins may use to gather evidence and repair. */
export interface WatchdogTools {
  /** The workspace itself, through the pipeline's own commands rather than the agent's tools. */
  workspace: Workspace;
  /**
   * Run a command through the agent's bash tool, exactly as the agent would (so a broken tool shows itself).
   * Null when the current stage has no bash tool.
   */
  agentBash: ((command: string, timeoutSeconds: number) => Promise<ToolOutcome>) | null;
  /** Run a command outside the agent's tools (see rerun.ts). Stops when the agent's call is aborted. */
  rerun(command: string, timeoutSeconds: number): Promise<ExecResult>;
  /** The timeout the agent's bash tool would use for a call: its default if none is asked for, and never above its cap. */
  timeoutFor(requestedSeconds: unknown): number;
}

/** One step of the watchdog loop, recorded in provenance.jsonl as `{ type: "watchdog", ... }`. */
export interface WatchdogEvent {
  stageId: string;
  toolCallId: string;
  plugin: string;
  /** `rerouted`: a call handled by a plug-in's `instead`, without the agent's tool. */
  phase: "suspected" | "dismissed" | "confirmed" | "repaired" | "rerouted";
  reason: string;
}

export interface WatchdogSummary {
  plugins: string[];
  /** Counts of the events above; `repaired` includes rerouted calls. */
  suspected: number;
  confirmed: number;
  repaired: number;
}
