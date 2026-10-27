import { Type, type Usage } from "@earendil-works/pi-ai";
import {
  defineTool,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import type { AgentConfig, AgentRole } from "./agent-config.js";
import { createRoleSession } from "./agent.js";
import { getFinalAnswer } from "./answer.js";
import { openSavedSession } from "./recovery.js";
import { RunStore, type AgentStatus } from "./run-store.js";
import { assertWorkerAllowed, beginWorker } from "./workflow.js";
import { createSubmitReviewTool, createWorkflowTools } from "./workflow-tools.js";

/** How long a worker waits for an answer before it is reported as paused. */
export const ANSWER_WAIT_MS = 2 * 60 * 1000;

export type AgentEvent =
  | {
      type: "settled";
      agentId: string;
      role: AgentRole;
      report: string;
      sessionFile: string | undefined;
      usage: Usage;
    }
  | {
      type: "failed";
      agentId: string;
      role: AgentRole;
      error: string;
      sessionFile: string | undefined;
      usage: Usage;
    }
  | { type: "question"; agentId: string; role: AgentRole; question: string }
  | { type: "paused"; agentId: string; role: AgentRole; question: string };

interface AgentRecord {
  id: string;
  role: AgentRole;
  status: AgentStatus;
  session: AgentSession;
}

interface Waiter {
  agentId: string | undefined;
  deliver: (event: AgentEvent | undefined) => void;
}

interface PendingQuestion {
  question: string;
  resolve: (answer: string) => void;
}

export interface AgentRuntimeOptions {
  cwd: string;
  modelsFile: string;
  roles: AgentConfig["roles"];
  runStore: RunStore;
  answerWaitMs?: number;
}

export interface ResumeOptions {
  cwd: string;
  modelsFile: string;
  roles: AgentConfig["roles"];
  runDirectory: string;
  answerWaitMs?: number;
}

/**
 * Owns spawned agents and their lifecycle. Pi owns each conversation; this
 * registry owns ids, events, checkpoints, and abort/dispose across agents.
 */
export class AgentRuntime {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly events: AgentEvent[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly answerWaitMs: number;
  private notifier: ((text: string) => void) | undefined;
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.answerWaitMs = options.answerWaitMs ?? ANSWER_WAIT_MS;
  }

  /** The run directory holding run.json and the Pi session files. */
  get runDirectory(): string {
    return this.options.runStore.directory;
  }

  workflowTools(): ToolDefinition[] {
    return createWorkflowTools(this.options.runStore);
  }

  /**
   * Reopen a saved run: live agents become interrupted, interrupted
   * conversations are reopened, and the caller gets a recovery summary.
   */
  static async resume(options: ResumeOptions): Promise<{ runtime: AgentRuntime; summary: string; runStore: RunStore }> {
    const runStore = await RunStore.open(options.runDirectory);
    runStore.assertIdentity(options.cwd, options.modelsFile);
    const runtime = new AgentRuntime({
      cwd: options.cwd,
      modelsFile: options.modelsFile,
      roles: options.roles,
      runStore,
      ...(options.answerWaitMs === undefined ? {} : { answerWaitMs: options.answerWaitMs }),
    });
    try {
      await runtime.restoreInterrupted();
      return { runtime, summary: runtime.summary(), runStore };
    } catch (error) {
      await runtime.dispose().catch(() => {});
      throw error;
    }
  }

  /** Downgrade live agents first, then reopen only interrupted conversations. */
  private async restoreInterrupted(): Promise<void> {
    const entries = this.options.runStore.agents();
    for (const entry of entries) {
      if (entry.status === "running" || entry.status === "waiting") entry.status = "interrupted";
    }
    await this.options.runStore.save();
    for (const entry of entries) {
      const number = Number(entry.id.slice("agent-".length));
      if (Number.isInteger(number) && number >= this.nextId) this.nextId = number + 1;
      if (entry.status !== "interrupted" || !entry.sessionFile) continue;
      const session = await createRoleSession({
        cwd: this.options.cwd,
        modelsFile: this.options.modelsFile,
        role: entry.role,
        roles: this.options.roles,
        sessionManager: await openSavedSession(entry.sessionFile, this.options.cwd),
        customTools: createWorkerTools(this, this.options.runStore, entry.id, entry.role),
      });
      this.agents.set(entry.id, { id: entry.id, role: entry.role, status: "interrupted", session });
    }
  }

  /** A readable recovery summary for the orchestrator. */
  summary(): string {
    const agents = this.options.runStore.agents();
    const lines = [`Run ${this.options.runStore.runId} resumed from ${this.runDirectory}.`];
    if (agents.length === 0) lines.push("No agents were recorded.");
    for (const agent of agents) {
      lines.push(`- ${agent.id} (${agent.role}) ${agent.status}: ${agent.assignment}`);
      if (agent.question) lines.push(`  question: ${agent.question}`);
      if (agent.answer) lines.push(`  answer: ${agent.answer}`);
      if (agent.report) lines.push(`  report: ${agent.report}`);
      if (agent.error) lines.push(`  error: ${agent.error}`);
    }
    lines.push("Completed work remains completed. Use resume_agent to continue an interrupted agent, or spawn_agent for replacement work.");
    return lines.join("\n");
  }

  /** Deliver events that no wait tool is collecting into the orchestrator session. */
  setNotifier(notifier: ((text: string) => void) | undefined): void {
    this.notifier = notifier;
  }

  /** Create a session, record it, and start the assignment without waiting for the model. */
  async spawn(role: AgentRole, assignment: string): Promise<string> {
    if (this.closed) throw new Error("Agent runtime is disposed");
    assertWorkerAllowed(this.options.runStore, role);
    const text = assignment.trim();
    if (!text) throw new Error("The assignment must not be empty");
    const id = `agent-${this.nextId++}`;
    const manager = SessionManager.create(this.options.cwd, path.join(this.runDirectory, "sessions"));
    // A committed launch must reference an existing transcript, even before inference.
    manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    const session = await createRoleSession({
      cwd: this.options.cwd,
      modelsFile: this.options.modelsFile,
      role,
      roles: this.options.roles,
      sessionManager: manager,
      customTools: createWorkerTools(this, this.options.runStore, id, role),
    });
    try {
      if (this.closed) throw new Error("Agent runtime is disposed");
      const revision = beginWorker(this.options.runStore, role);
      this.agents.set(id, { id, role, status: "running", session });
      this.options.runStore.addAgent({ id, role, assignment: text, status: "running", sessionFile: session.sessionFile,
        ...(revision === undefined ? {} : { revision }) });
      // Record the launch before any work starts, so a restart sees it.
      await this.options.runStore.save();
      if (this.closed) throw new Error("Agent runtime is disposed");
      void this.run(id, "Carry out your recorded assignment, then report evidence, checks, and limitations.");
      return id;
    } catch (error) {
      session.dispose();
      this.agents.delete(id);
      const entry = this.options.runStore.agent(id);
      if (entry) entry.status = "interrupted";
      throw error;
    }
  }

  private async run(id: string, assignment: string): Promise<void> {
    const record = this.agents.get(id);
    if (!record) return;
    const entry = this.options.runStore.agent(id);
    try {
      await record.session.prompt(assignment);
      const report = getFinalAnswer(record.session);
      if (record.role === "reviewer" && !entry?.review) {
        throw new Error("Reviewer must call submit_review with an explicit verdict before finishing");
      }
      if (this.closed) return;
      if (entry) {
        entry.status = "settled";
        entry.report = report;
        entry.sessionFile = record.session.sessionFile;
      }
      await this.options.runStore.save();
      this.publish({
        type: "settled",
        agentId: id,
        role: record.role,
        report,
        sessionFile: record.session.sessionFile,
        usage: collectUsage(record.session),
      });
      // Stay active until the event exists, so a concurrent wait cannot miss it.
      record.status = "settled";
    } catch (error) {
      // Disposal already recorded this agent as interrupted.
      if (record.status === "interrupted") return;
      const message = error instanceof Error ? error.message : String(error);
      if (entry) {
        entry.status = "failed";
        entry.error = message;
        entry.sessionFile = record.session.sessionFile;
      }
      await this.options.runStore.save();
      this.publish({
        type: "failed",
        agentId: id,
        role: record.role,
        error: message,
        sessionFile: record.session.sessionFile,
        usage: collectUsage(record.session),
      });
      record.status = "failed";
    }
  }

  /**
   * Worker side: publish a question, then wait for the answer. A waiting tool
   * call collects it; otherwise the notifier pushes it to the orchestrator.
   * After the wait window the worker is reported as paused and stays blocked
   * until an answer arrives.
   */
  async ask(agentId: string, question: string, signal: AbortSignal | undefined): Promise<string> {
    const text = question.trim();
    if (!text) throw new Error("The question must not be empty");
    const record = this.agents.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} is not running`);
    if (this.pending.has(agentId)) throw new Error(`Agent ${agentId} already has a pending question`);

    const pending: PendingQuestion = { question: text, resolve: () => {} };
    const answer = new Promise<string>((resolve) => {
      pending.resolve = resolve;
    });
    this.pending.set(agentId, pending);
    record.status = "waiting";
    const entry = this.options.runStore.agent(agentId);
    if (entry) {
      entry.status = "waiting";
      entry.question = text;
    }
    await this.options.runStore.save();

    const timer = setTimeout(() => {
      if (this.pending.get(agentId) === pending) {
        this.publish({ type: "paused", agentId, role: record.role, question: text });
      }
    }, this.answerWaitMs);
    this.publish({ type: "question", agentId, role: record.role, question: text });
    try {
      return await abortable(answer, signal);
    } finally {
      clearTimeout(timer);
      if (this.pending.get(agentId) === pending) this.pending.delete(agentId);
    }
  }

  /** Orchestrator side: record the answer, then release the waiting agent. */
  async answer(agentId: string, text: string): Promise<void> {
    const pending = this.pending.get(agentId);
    if (!pending) throw new Error(`Agent ${agentId} has no pending question`);
    const answer = text.trim();
    if (!answer) throw new Error("The answer must not be empty");
    const record = this.agents.get(agentId);
    if (record) record.status = "running";
    const entry = this.options.runStore.agent(agentId);
    if (entry) {
      entry.status = "running";
      entry.answer = answer;
    }
    await this.options.runStore.save();
    this.pending.delete(agentId);
    pending.resolve(answer);
  }

  /** Continue an interrupted agent's saved conversation in place. */
  async resumeAgent(agentId: string, instruction?: string): Promise<void> {
    if (this.closed) throw new Error("Agent runtime is disposed");
    const record = this.agents.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} is not available to resume`);
    if (record.status !== "interrupted") throw new Error(`Agent ${agentId} is ${record.status}, not interrupted`);
    const entry = this.options.runStore.agent(agentId);
    if (entry?.resolution) throw new Error(`Agent ${agentId} was retired and cannot resume`);
    const revision = beginWorker(this.options.runStore, record.role);
    if (entry) {
      if (revision !== undefined) entry.revision = revision;
      entry.review = undefined;
    }
    record.status = "running";
    if (entry) {
      entry.status = "running";
      entry.error = undefined;
    }
    await this.options.runStore.save();
    const text = instruction?.trim() || "Continue your assignment from where it stopped, then report what you found.";
    void this.run(agentId, text);
  }

  private publish(event: AgentEvent): void {
    const index = this.waiters.findIndex((waiter) => waiter.agentId === undefined || waiter.agentId === event.agentId);
    if (index !== -1) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter?.deliver(event);
      return;
    }
    // Questions and pauses must reach an orchestrator that is not waiting.
    if ((event.type === "question" || event.type === "paused") && this.notifier) {
      this.notifier(describe(event));
      return;
    }
    this.events.push(event);
  }

  /** Next settlement, failure, question, or pause, optionally for one agent. */
  async next(agentId?: string, signal?: AbortSignal): Promise<AgentEvent | undefined> {
    if (signal?.aborted) throw new Error("Wait aborted");
    const index = this.events.findIndex((event) => agentId === undefined || event.agentId === agentId);
    if (index !== -1) return this.events.splice(index, 1)[0];
    if (!this.isActive(agentId)) return undefined;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("Wait aborted"));
      };
      const waiter: Waiter = {
        agentId,
        deliver: (event) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(event);
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private isActive(agentId?: string): boolean {
    for (const record of this.agents.values()) {
      if ((record.status === "running" || record.status === "waiting") && (agentId === undefined || record.id === agentId)) {
        return true;
      }
    }
    return false;
  }

  /** Record live agents as interrupted, then abort and dispose every session. */
  async dispose(): Promise<void> {
    this.closed = true;
    for (const record of this.agents.values()) {
      if (record.status !== "running" && record.status !== "waiting") continue;
      record.status = "interrupted";
      const entry = this.options.runStore.agent(record.id);
      if (entry) {
        entry.status = "interrupted";
        entry.sessionFile = record.session.sessionFile;
      }
    }
    try {
      await this.options.runStore.save();
    } finally {
      const sessions = [...this.agents.values()].map((record) => record.session);
      this.agents.clear();
      this.pending.clear();
      for (const waiter of this.waiters.splice(0)) waiter.deliver(undefined);
      await Promise.all(sessions.map(async (session) => {
        try {
          await session.abort();
        } finally {
          session.dispose();
        }
      }));
    }
  }
}

/** The orchestrator's delegation tools; no other role receives them. */
export function createOrchestratorTools(runtime: AgentRuntime): ToolDefinition[] {
  const spawnAgent = defineTool({
    name: "spawn_agent",
    label: "Spawn agent",
    description: "Start a new agent on one self-contained assignment and return its id immediately. The agent cannot see your conversation, so include the context it needs. Use wait_for_agents to collect its report.",
    parameters: Type.Object({
      role: Type.Union([Type.Literal("planner"), Type.Literal("executor"), Type.Literal("reviewer")], {
        description: "Planners inspect; executors edit and run bounded commands after plan acceptance; reviewers inspect settled execution and submit a verdict. Workers cannot delegate.",
      }),
      assignment: Type.String({ minLength: 1, description: "The assignment, including any context the agent needs." }),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const agentId = await runtime.spawn(params.role, params.assignment);
      return {
        content: [{ type: "text", text: `Spawned ${params.role} ${agentId}. Use wait_for_agents to collect its report.` }],
        details: { agentId, role: params.role },
      };
    },
  });

  const waitForAgents = defineTool({
    name: "wait_for_agents",
    label: "Wait for agents",
    description: "Wait for the next agent report, failure, question, or pause notice and return it. Omit agentId to accept any agent. Returns at once if an event is already pending, and reports when no agents are running.",
    parameters: Type.Object({
      agentId: Type.Optional(Type.String({ description: "Only wait for this agent id." })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const event = await runtime.next(params.agentId, signal);
      if (!event) {
        const text = params.agentId ? `Agent ${params.agentId} is not running.` : "No agents are running.";
        return { content: [{ type: "text", text }], details: {} };
      }
      return {
        content: [{ type: "text", text: describe(event) }],
        details: {
          type: event.type,
          agentId: event.agentId,
          role: event.role,
          sessionFile: "sessionFile" in event ? event.sessionFile : undefined,
          usage: "usage" in event ? event.usage : undefined,
          ...("report" in event ? { report: event.report } : {}),
          ...("error" in event ? { error: event.error } : {}),
          ...("question" in event ? { question: event.question } : {}),
        },
        usage: "usage" in event ? event.usage : undefined,
        isError: event.type === "failed",
      };
    },
  });

  const answerWorker = defineTool({
    name: "answer_worker",
    label: "Answer worker",
    description: "Answer a pending question from a spawned agent so it can continue. Use the agent id from the question or pause notice.",
    parameters: Type.Object({
      agentId: Type.String({ description: "Agent id that asked the question." }),
      answer: Type.String({ minLength: 1, description: "The answer to send back to the agent." }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      await runtime.answer(params.agentId, params.answer);
      return {
        content: [{ type: "text", text: `Answered ${params.agentId}.` }],
        details: { agentId: params.agentId },
      };
    },
  });

  const resumeAgentTool = defineTool({
    name: "resume_agent",
    label: "Resume agent",
    description: "Continue an interrupted agent's saved conversation with an optional instruction. The agent keeps its earlier history and reports again when done.",
    parameters: Type.Object({
      agentId: Type.String({ description: "Interrupted agent id." }),
      instruction: Type.Optional(Type.String({ description: "What the agent should do next; omit to continue the original assignment." })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      await runtime.resumeAgent(params.agentId, params.instruction);
      return {
        content: [{ type: "text", text: `Resumed ${params.agentId}. Use wait_for_agents to collect its report.` }],
        details: { agentId: params.agentId },
      };
    },
  });

  return [spawnAgent, waitForAgents, answerWorker, resumeAgentTool, ...runtime.workflowTools()];
}

function createWorkerTools(runtime: AgentRuntime, store: RunStore, agentId: string, role: AgentRole): ToolDefinition[] {
  return [createAskTool(runtime, agentId, role), ...(role === "reviewer" ? [createSubmitReviewTool(store, agentId)] : [])];
}

/** Worker side: ask the orchestrator and wait for its answer. */
function createAskTool(runtime: AgentRuntime, agentId: string, role: AgentRole): ToolDefinition {
  return defineTool({
    name: "ask_orchestrator",
    label: "Ask the orchestrator",
    description: "Ask the orchestrator a question and wait for its answer. Use this when a decision or missing detail blocks the assignment. If no answer arrives within two minutes you remain paused until the orchestrator replies.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, description: "The question, including the context needed to answer it." }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const answer = await runtime.ask(agentId, params.question, signal);
      return {
        content: [{ type: "text", text: answer }],
        details: { agentId, role },
      };
    },
  });
}

function describe(event: AgentEvent): string {
  const label = `${event.agentId} (${event.role})`;
  switch (event.type) {
    case "settled":
      return `${label} settled:\n${event.report}`;
    case "failed":
      return `${label} failed: ${event.error}`;
    case "question":
      return `${label} asks: ${event.question}`;
    case "paused":
      return `${label} is paused: its question is still unanswered.`;
  }
}

/** Stop waiting when the calling tool call is aborted. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Wait aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Wait aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Include compacted turns and summarization usage, not just the current context. */
export function collectUsage(session: AgentSession): Usage {
  const total: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const entry of session.sessionManager.getEntries()) {
    const usage = entry.type === "message"
      ? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
      : ("usage" in entry ? entry.usage : undefined);
    if (!usage) continue;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      total[key] += usage[key];
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      total.cost[key] += usage.cost[key];
    }
    if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
    if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }
  return total;
}
