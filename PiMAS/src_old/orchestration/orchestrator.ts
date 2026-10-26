import { Mailbox } from "./mailbox.js";
import { scopesOverlap, validatePlan } from "./plan.js";
import type {
  AgentDriver,
  AgentTask,
  AgentUpdate,
  OrchestratorStatus,
  Phase,
  Review,
} from "./types.js";

const MAX_PLAN_ATTEMPTS = 5;

interface OrchestratorOptions {
  maxParallel?: number;
  maxTasks?: number;
  onUpdate?: (update: AgentUpdate) => void;
}

/** Owns one user request: its plan, task lifecycle, and worker communication. */
export class Orchestrator {
  private readonly tasks = new Map<string, AgentTask>();
  private readonly runningJobs = new Set<Promise<void>>();
  private readonly cancellation = new AbortController();
  private readonly mailbox: Mailbox;
  private readonly maxTasks: number;

  readonly maxParallel: number;
  private currentTaskIds: string[] = [];
  private phaseTitles: string[] = [];
  private plansUsed = 0;
  private stopReason?: string;

  constructor(
    readonly prompt: string,
    private readonly driver: AgentDriver,
    options: OrchestratorOptions = {},
  ) {
    this.maxParallel = options.maxParallel ?? 4;
    this.maxTasks = options.maxTasks ?? 40;
    this.mailbox = new Mailbox(options.onUpdate ?? (() => {}));

    if (!Number.isInteger(this.maxParallel) || this.maxParallel < 1 || this.maxParallel > 32) {
      throw new Error("maxParallel must be an integer between 1 and 32");
    }

    const planner = createInitialPlanner();
    this.tasks.set(planner.id, planner);
  }

  start(): void {
    this.startReadyTasks();
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.runningJobs]);
  }

  setPlan(phases: Phase[]): void {
    this.assertPlanCanChange();
    validatePlan(phases, this.tasks, this.maxTasks);
    this.cancelSupersededTasks();

    this.plansUsed++;
    this.phaseTitles = phases.map((phase) => phase.title);
    this.currentTaskIds = [];

    for (const [phaseIndex, phase] of phases.entries()) {
      for (const specification of phase.tasks) {
        const task: AgentTask = {
          ...structuredClone(specification),
          phase: phaseIndex,
          status: "queued",
        };
        this.tasks.set(task.id, task);
        this.currentTaskIds.push(task.id);
      }
    }

    this.startReadyTasks();
  }

  snapshot(): OrchestratorStatus {
    return structuredClone({
      phases: this.phaseTitles,
      tasks: [...this.tasks.values()],
      pendingQuestions: this.mailbox.pendingQuestions(),
      complete: this.isComplete(),
      stopped: this.stopReason,
      plansUsed: this.plansUsed,
    });
  }

  isComplete(): boolean {
    return this.currentTaskIds.length > 0 && this.currentTasks().every(taskIsApproved);
  }

  finalBlocker(): string | undefined {
    if (this.stopReason || this.isComplete()) {
      return undefined;
    }

    return "Work is unfinished. Use task_status and wait_for_updates, answer questions, " +
      "and finish execution plus an approved review. If tasks fail or review rejects " +
      "the work, replace the plan with fresh task IDs for fixes and review. If you " +
      "cannot proceed, call stop_work and explain the blocker honestly.";
  }

  waitForUpdates(signal?: AbortSignal, timeoutMs = 15_000): Promise<AgentUpdate[]> {
    return this.mailbox.takeUpdates(signal, timeoutMs);
  }

  async messageOrchestrator(
    taskId: string,
    text: string,
    waitForReply: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    const task = this.requireActiveTask(taskId);
    signal?.throwIfAborted();

    if (!waitForReply) {
      this.mailbox.post({ type: "message", taskId, text });
      return "Delivered to the orchestrator.";
    }

    const alreadyWaiting = this.mailbox.pendingQuestions().some(
      (question) => question.taskId === taskId,
    );
    if (alreadyWaiting) {
      throw new Error("This agent already has a pending question");
    }

    task.status = "waiting";
    try {
      return await this.mailbox.ask(taskId, text, signal);
    } finally {
      if (task.status === "waiting") {
        task.status = "running";
      }
    }
  }

  reply(questionId: string, text: string): void {
    this.mailbox.reply(questionId, text);
  }

  async send(taskId: string, text: string): Promise<void> {
    this.requireActiveTask(taskId);
    await this.driver.send(taskId, `Message from the orchestrator:\n${text}`);
  }

  review(taskId: string, verdict: Review): void {
    const task = this.requireActiveTask(taskId);
    if (task.role !== "reviewer") {
      throw new Error("Only reviewers can submit a review");
    }
    task.review = { ...verdict };
  }

  stop(reason: string): void {
    this.stopReason = reason;

    for (const task of this.tasks.values()) {
      if (task.status === "queued" || taskIsActive(task)) {
        task.status = "cancelled";
      }
    }

    this.mailbox.close(reason);
    this.cancellation.abort(new Error(reason));
  }

  private assertPlanCanChange(): void {
    if (this.stopReason) {
      throw new Error("Work has been stopped");
    }
    if (this.tasks.get("planner")?.status !== "completed") {
      throw new Error("Wait for the planner before setting the plan");
    }
    if (this.activeTasks().length > 0) {
      throw new Error("Wait for active agents before replacing the plan");
    }
    if (this.plansUsed >= MAX_PLAN_ATTEMPTS) {
      throw new Error("Five plans have been attempted. Stop and report the remaining blockers.");
    }
  }

  private cancelSupersededTasks(): void {
    for (const task of this.currentTasks()) {
      if (task.status === "queued") {
        task.status = "cancelled";
      }
    }
  }

  private requireActiveTask(taskId: string): AgentTask {
    const task = this.tasks.get(taskId);
    if (!task || !taskIsActive(task)) {
      throw new Error(`Agent ${taskId} is not active`);
    }
    return task;
  }

  private currentTasks(): AgentTask[] {
    return this.currentTaskIds.map((id) => this.tasks.get(id)!);
  }

  private activeTasks(): AgentTask[] {
    return [...this.tasks.values()].filter(taskIsActive);
  }

  private startReadyTasks(): void {
    if (this.stopReason) {
      return;
    }

    for (const task of this.tasks.values()) {
      if (this.activeTasks().length >= this.maxParallel) {
        break;
      }
      if (this.canStart(task)) {
        this.launchTask(task);
      }
    }
  }

  private canStart(task: AgentTask): boolean {
    if (task.status !== "queued") {
      return false;
    }

    const dependenciesDone = task.dependsOn.every(
      (id) => this.tasks.get(id)?.status === "completed",
    );
    const earlierPhasesDone = this.currentTasks().every(
      (other) => other.phase >= task.phase || taskIsApproved(other),
    );
    const fileConflict = task.role === "executor" && this.activeTasks().some(
      (other) => other.role === "executor" && scopesOverlap(task.files, other.files),
    );

    return dependenciesDone && earlierPhasesDone && !fileConflict;
  }

  private launchTask(task: AgentTask): void {
    task.status = "running";
    this.mailbox.post({
      type: "started",
      taskId: task.id,
      text: `${task.role}: ${task.title}`,
    });

    // The runtime owns this promise, so a short-lived tool call can launch workers
    // and return while those workers keep running.
    const job = this.executeTask(task).finally(() => {
      this.runningJobs.delete(job);
      this.startReadyTasks();
    });
    this.runningJobs.add(job);
  }

  private async executeTask(task: AgentTask): Promise<void> {
    try {
      const result = await this.driver.run(
        structuredClone(task),
        this.buildWorkerContext(),
        this.cancellation.signal,
      );

      if (this.stopReason) {
        return;
      }
      if (task.role === "reviewer" && !task.review) {
        throw new Error("Reviewer did not call submit_review");
      }

      task.status = "completed";
      task.result = result;
      this.mailbox.post({ type: "completed", taskId: task.id, text: result });
    } catch (error) {
      if (this.stopReason) {
        return;
      }

      task.status = "failed";
      task.result = error instanceof Error ? error.message : String(error);
      this.mailbox.post({ type: "failed", taskId: task.id, text: task.result });
    }
  }

  private buildWorkerContext(): string {
    const summaries = [...this.tasks.values()].map((task) => ({
      id: task.id,
      title: task.title,
      role: task.role,
      phase: task.phase,
      status: task.status,
      result: task.result,
      review: task.review,
    }));

    return JSON.stringify({
      request: this.prompt,
      phases: this.phaseTitles,
      tasks: summaries,
    });
  }
}

function taskIsActive(task: AgentTask): boolean {
  return task.status === "running" || task.status === "waiting";
}

function taskIsApproved(task: AgentTask): boolean {
  const reviewApproved = task.role !== "reviewer" || task.review?.approved === true;
  return task.status === "completed" && reviewApproved;
}

function createInitialPlanner(): AgentTask {
  return {
    id: "planner",
    title: "Break the request into phases and independent subtasks",
    role: "planner",
    instructions: "Inspect the project and propose a minimal plan. Identify parallel " +
      "executor tasks, file ownership, dependencies, shared interfaces, acceptance " +
      "criteria, and a final review phase. Return the proposed plan to the " +
      "orchestrator. Do not implement anything.",
    dependsOn: [],
    files: [],
    phase: -1,
    status: "queued",
  };
}
