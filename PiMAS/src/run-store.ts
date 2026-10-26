import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_ROLES, type AgentRole } from "./agent-config.js";

export type AgentStatus = "running" | "waiting" | "settled" | "failed" | "interrupted";

export interface WorkflowState {
  revision: number;
  plan?: { text: string; plannerIds: string[] };
}

export interface CheckpointAgent {
  id: string;
  role: AgentRole;
  assignment: string;
  status: AgentStatus;
  sessionFile?: string;
  report?: string;
  error?: string;
  question?: string;
  answer?: string;
  revision?: number;
  review?: { approved: boolean; reason: string; revision: number };
  resolution?: string;
}

export interface CheckpointOrchestrator {
  sessionFile: string;
  status: "ready" | "running" | "settled" | "failed" | "interrupted";
  report?: string;
  error?: string;
}

export interface RunCheckpoint {
  version: 2;
  workflow: WorkflowState;
  runId: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  modelsFile: string;
  agents: CheckpointAgent[];
  request?: string;
  orchestrator?: CheckpointOrchestrator;
}

/**
 * The workflow checkpoint for one run. Writes are serialized and atomic
 * (temporary file, then rename), and callers await save() before
 * acknowledging a state change.
 */
export class RunStore {
  readonly directory: string;
  readonly file: string;
  private readonly state: RunCheckpoint;
  private writes: Promise<void> = Promise.resolve();

  private constructor(directory: string, state: RunCheckpoint) {
    this.directory = directory;
    this.file = path.join(directory, "run.json");
    this.state = state;
  }

  static async create(options: { directory: string; cwd: string; modelsFile: string }): Promise<RunStore> {
    await mkdir(options.directory, { recursive: true });
    const now = new Date().toISOString();
    const store = new RunStore(options.directory, {
      version: 2,
      workflow: { revision: 0 },
      runId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      cwd: options.cwd,
      modelsFile: options.modelsFile,
      agents: [],
    });
    // Reserve the checkpoint exclusively: create must never overwrite a run.
    await writeFile(store.file, JSON.stringify(store.state, null, 2), { flag: "wx" });
    return store;
  }

  /**
   * Open and validate a saved run. Nothing is trusted until the file parses
   * and every recorded agent has a known role and status.
   */
  static async open(directory: string): Promise<RunStore> {
    const file = path.join(directory, "run.json");
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      throw new Error(`No run.json found in ${directory}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`run.json is not valid JSON: ${file}`);
    }
    if (typeof parsed !== "object" || parsed === null) throw new Error(`Invalid run.json: ${file}`);
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version === 1) {
      // Legacy history stays evidence; never fabricate prior plan/review decisions.
      candidate.version = 2;
      candidate.workflow = { revision: 0 };
    } else if (candidate.version !== 2) {
      throw new Error(`Unsupported run.json version: ${String(candidate.version)}`);
    }
    if (
      typeof candidate.runId !== "string" ||
      typeof candidate.cwd !== "string" ||
      typeof candidate.modelsFile !== "string" ||
      !Array.isArray(candidate.agents)
    ) {
      throw new Error(`Invalid run.json: ${file}`);
    }
    const ids = new Set<string>();
    for (const agent of candidate.agents) {
      validateAgent(agent, file);
      if (ids.has(agent.id)) throw new Error(`Duplicate agent id in run.json: ${agent.id}`);
      ids.add(agent.id);
    }
    validateWorkflow(candidate.workflow, candidate.agents as CheckpointAgent[], file);
    if (candidate.orchestrator !== undefined || candidate.request !== undefined) {
      const orchestrator = candidate.orchestrator as Record<string, unknown> | null;
      if (typeof candidate.request !== "string" || !candidate.request.trim() ||
          !orchestrator || typeof orchestrator !== "object" || typeof orchestrator.sessionFile !== "string" ||
          !["ready", "running", "settled", "failed", "interrupted"].includes(orchestrator.status as string) ||
          (orchestrator.report !== undefined && typeof orchestrator.report !== "string") ||
          (orchestrator.error !== undefined && typeof orchestrator.error !== "string") ||
          (orchestrator.status === "settled" && typeof orchestrator.report !== "string")) {
        throw new Error(`Invalid orchestrator checkpoint: ${file}`);
      }
    }
    return new RunStore(directory, candidate as unknown as RunCheckpoint);
  }

  agent(id: string): CheckpointAgent | undefined {
    return this.state.agents.find((agent) => agent.id === id);
  }

  addAgent(agent: CheckpointAgent): void {
    this.state.agents.push(agent);
  }

  agents(): readonly CheckpointAgent[] {
    return this.state.agents;
  }

  get workflow(): WorkflowState {
    return this.state.workflow;
  }

  get runId(): string {
    return this.state.runId;
  }

  get request(): string | undefined {
    return this.state.request;
  }

  get orchestrator(): CheckpointOrchestrator | undefined {
    return this.state.orchestrator;
  }

  setOrchestrator(request: string, orchestrator: CheckpointOrchestrator): void {
    this.state.request = request;
    this.state.orchestrator = orchestrator;
  }

  assertIdentity(cwd: string, modelsFile: string): void {
    if (path.resolve(cwd) !== path.resolve(this.state.cwd) ||
        path.resolve(modelsFile) !== path.resolve(this.state.modelsFile)) {
      throw new Error("Run workspace or models file does not match its checkpoint");
    }
  }

  /** Persist the current state; resolves once the rename has completed. */
  async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const content = JSON.stringify(this.state, null, 2);
    const temporary = `${this.file}.tmp`;
    // A failed write must not poison later saves, but its caller still sees it.
    const next = this.writes.catch(() => {}).then(async () => {
      await writeFile(temporary, content);
      await rename(temporary, this.file);
    });
    this.writes = next;
    await next;
  }
}

const AGENT_STATUSES = ["running", "waiting", "settled", "failed", "interrupted"] as const;

function validateAgent(value: unknown, file: string): void {
  const invalid = (): never => {
    throw new Error(`Invalid run.json: ${file}`);
  };
  if (typeof value !== "object" || value === null) invalid();
  const agent = value as Record<string, unknown>;
  if (typeof agent.id !== "string" || typeof agent.assignment !== "string") invalid();
  if (!(AGENT_ROLES as readonly string[]).includes(agent.role as string)) invalid();
  if (!(AGENT_STATUSES as readonly string[]).includes(agent.status as string)) invalid();
  for (const key of ["sessionFile", "report", "error", "question", "answer", "resolution"]) {
    if (agent[key] !== undefined && typeof agent[key] !== "string") invalid();
  }
  if (agent.revision !== undefined && (!Number.isSafeInteger(agent.revision) || Number(agent.revision) < 1)) invalid();
  if (agent.review !== undefined) {
    const review = agent.review as Record<string, unknown> | null;
    if (agent.role !== "reviewer" || !review || typeof review !== "object" ||
        typeof review.approved !== "boolean" || typeof review.reason !== "string" || !review.reason.trim() ||
        review.revision !== agent.revision || !Number.isSafeInteger(review.revision) || Number(review.revision) < 1) invalid();
  }
}

function validateWorkflow(value: unknown, agents: CheckpointAgent[], file: string): void {
  const invalid = (): never => { throw new Error(`Invalid workflow checkpoint: ${file}`); };
  if (!value || typeof value !== "object") invalid();
  const workflow = value as Record<string, unknown>;
  if (!Number.isSafeInteger(workflow.revision) || Number(workflow.revision) < 0) invalid();
  for (const agent of agents) {
    if (agent.revision !== undefined && agent.revision > Number(workflow.revision)) invalid();
  }
  if (workflow.plan !== undefined) {
    const plan = workflow.plan as Record<string, unknown> | null;
    if (!plan || typeof plan !== "object") return invalid();
    if (typeof plan.text !== "string" || !plan.text.trim() ||
        !Array.isArray(plan.plannerIds) || !plan.plannerIds.length || new Set(plan.plannerIds).size !== plan.plannerIds.length) invalid();
    for (const id of plan.plannerIds as unknown[]) {
      const planner = agents.find((agent) => agent.id === id);
      if (typeof id !== "string" || !planner || planner.role !== "planner" || planner.status !== "settled" || !planner.report) invalid();
    }
  }
}
