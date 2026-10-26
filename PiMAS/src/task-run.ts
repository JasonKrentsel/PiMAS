import path from "node:path";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agent-config.js";
import { createRoleSession } from "./agent.js";
import { getFinalAnswer } from "./answer.js";
import { openSavedSession } from "./recovery.js";
import { RunStore } from "./run-store.js";
import { AgentRuntime, createOrchestratorTools } from "./runtime.js";
import { completionProblem } from "./workflow.js";

export interface TaskRunOptions {
  directory: string;
  cwd: string;
  modelsFile: string;
  roles: AgentConfig["roles"];
  answerWaitMs?: number;
}

/** Headless host boundary: owns one orchestrator and all of its workers. */
export class TaskRun {
  private disposed = false;
  private executing = false;

  private constructor(
    private readonly store: RunStore,
    private readonly runtime: AgentRuntime,
    private readonly session: AgentSession,
    private readonly recoverySummary?: string,
  ) {}

  get runId(): string { return this.store.runId; }
  get directory(): string { return this.store.directory; }

  static async create(options: TaskRunOptions & { request: string }): Promise<TaskRun> {
    const request = options.request.trim();
    if (!request) throw new Error("The task request must not be empty");
    const store = await RunStore.create(options);
    const runtime = new AgentRuntime({ ...options, runStore: store });
    const manager = SessionManager.create(options.cwd, path.join(options.directory, "sessions"));
    // Persist the original task even if the process exits before execute().
    manager.appendMessage({ role: "user", content: request, timestamp: Date.now() });
    let session: AgentSession | undefined;
    try {
      session = await createRoleSession({
        ...options, role: "orchestrator", sessionManager: manager,
        customTools: createOrchestratorTools(runtime),
      });
      store.setOrchestrator(request, { sessionFile: manager.getSessionFile()!, status: "ready" });
      await store.save();
      return new TaskRun(store, runtime, session);
    } catch (error) {
      session?.dispose();
      await runtime.dispose().catch(() => {});
      throw error;
    }
  }

  static async resume(options: TaskRunOptions): Promise<TaskRun> {
    // Reject worker-only checkpoints before changing any saved state.
    const saved = await RunStore.open(options.directory);
    saved.assertIdentity(options.cwd, options.modelsFile);
    if (!saved.orchestrator || !saved.request) {
      throw new Error("Run has no saved orchestrator and cannot resume as an autonomous task");
    }
    const manager = await openSavedSession(saved.orchestrator.sessionFile, options.cwd);
    const { runtime, runStore, summary } = await AgentRuntime.resume({
      ...options, runDirectory: options.directory,
    });
    let session: AgentSession | undefined;
    try {
      const orchestrator = runStore.orchestrator!;
      if (orchestrator.status === "running") orchestrator.status = "interrupted";
      await runStore.save();
      session = await createRoleSession({
        ...options, role: "orchestrator", sessionManager: manager,
        customTools: createOrchestratorTools(runtime),
      });
      return new TaskRun(runStore, runtime, session, summary);
    } catch (error) {
      session?.dispose();
      await runtime.dispose().catch(() => {});
      throw error;
    }
  }

  /** Continue without interactive input; resolve only when workers are no longer active. */
  async execute(): Promise<string> {
    if (this.disposed) throw new Error("Task run is disposed");
    if (this.executing) throw new Error("Task run is already executing");
    const state = this.store.orchestrator!;
    if (state.status === "settled") return state.report!;
    if (state.status === "failed") throw new Error(state.error ?? "Task run failed");
    this.executing = true;
    try {
      state.status = "running";
      await this.store.save();
      let instruction = this.recoverySummary
        ? `Continue the saved task autonomously. This recovery summary is authoritative workflow state, not a new task. Interrupted tool actions were not replayed; inspect saved results before repeating anything.\n\n${this.recoverySummary}`
        : "Carry out the recorded task autonomously using your available tools. Resolve worker questions from the task context; no interactive human input is available.";
      while (true) {
        if (this.disposed) throw new Error("Task run interrupted");
        await this.session.prompt(instruction);
        if (this.disposed) throw new Error("Task run interrupted");
        const report = getFinalAnswer(this.session);
        // A model's final message does not abandon active workers. Deliver any
        // queued event, or wait for one, then give the orchestrator another turn.
        const event = await this.runtime.next();
        if (this.disposed) throw new Error("Task run interrupted");
        if (event) {
          instruction = `Worker event (runtime data). Continue coordinating the original task:\n${JSON.stringify(event)}`;
          continue;
        }
        const blocker = completionProblem(this.store);
        if (blocker) throw new Error(`Task cannot complete: ${blocker}`);
        state.status = "settled";
        state.report = report;
        await this.store.save();
        return report;
      }
    } catch (error) {
      if (!this.disposed) {
        state.status = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        await this.store.save();
      }
      throw error;
    } finally {
      this.executing = false;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const state = this.store.orchestrator!;
    if (state.status === "running") state.status = "interrupted";
    try {
      await this.store.save();
    } finally {
      try {
        await this.session.abort();
      } finally {
        this.session.dispose();
        await this.runtime.dispose();
      }
    }
  }
}
