import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_ROLES, type AgentRole } from "./agent-config.js";

export type AgentStatus = "running" | "waiting" | "settled" | "failed" | "interrupted";

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
}

export interface RunCheckpoint {
  version: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  modelsFile: string;
  agents: CheckpointAgent[];
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
      version: 1,
      runId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      cwd: options.cwd,
      modelsFile: options.modelsFile,
      agents: [],
    });
    await store.save();
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
    if (candidate.version !== 1) {
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
    for (const agent of candidate.agents) validateAgent(agent, file);
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

  get runId(): string {
    return this.state.runId;
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
  for (const key of ["sessionFile", "report", "error", "question", "answer"]) {
    if (agent[key] !== undefined && typeof agent[key] !== "string") invalid();
  }
}
