import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type, type Usage } from "@earendil-works/pi-ai";
import { defineTool, SessionManager, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRoleSession, type Toolset } from "./agent.js";
import type { AgentConfig, AgentRole } from "./agent-config.js";
import type { CommandLimits } from "./execution-tools.js";
import { FileTracker } from "./filesystem.js";
import {
  contentDigest,
  ProvenanceLog,
  type StageArtifact,
  type StageName,
  type ToolCallRecord,
} from "./provenance.js";
import { collectUsage } from "./runtime.js";
import type { Workspace } from "./workspace.js";

/**
 * Fixed-topology alternative to TaskRun: host code, not an orchestrator model, decides
 * which stage runs next and what each stage receives. That keeps "stage k" and its
 * inputs identical across runs, which fault injection and selective recovery rely on.
 */
export interface PipelineOptions {
  /** Host directory for Pi sessions, provenance.jsonl, and summary output. */
  directory: string;
  workspace: Workspace;
  modelsFile: string;
  roles: AgentConfig["roles"];
  request: string;
  /** `single` runs one executor on the raw task, as a single-agent comparison. */
  mode?: "pipeline" | "single";
  /** Add an independent reviewer and up to `maxCorrections` executor corrections. */
  review?: boolean;
  maxCorrections?: number;
  commandLimits?: CommandLimits;
  /** Non-submit tool calls allowed per stage before it is told to submit. */
  toolCallBudgets?: Partial<Record<StageName, number>>;
  /** Directory whose files are tracked per stage (default "/"); null turns tracking off. */
  snapshotRoot?: string | null;
  signal?: AbortSignal;
}

export interface Fact { id: string; claim: string; evidence: string }
export interface Findings { summary: string; facts: Fact[] }
export interface PlanStep { id: string; action: string; uses: string[]; check: string }
export interface Plan { summary: string; steps: PlanStep[] }
export interface StepOutcome { stepId: string; status: "done" | "skipped" | "failed"; evidence: string }
export interface ExecutionReport { summary: string; steps: StepOutcome[] }
export interface Review { approved: boolean; reason: string; problems: string[] }

export interface PipelineResult {
  status: "completed" | "incomplete" | "interrupted";
  approved: boolean | null;
  artifacts: StageArtifact[];
  usage: Usage;
  durationMs: number;
  provenanceFile: string;
}

export const PIPELINE_COMMAND_LIMITS: CommandLimits = { defaultSeconds: 600, maxSeconds: 3600 };

const DEFAULT_BUDGETS: Record<StageName, number> = {
  research: 80, plan: 10, execute: 400, review: 80, correct: 200, solve: 500,
};

const UNPLANNED_STEP = "unplanned";
/** Tool calls a stage may make beyond its budget, so it can still submit or resubmit. */
const SUBMIT_ALLOWANCE = 10;

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const mode = options.mode ?? "pipeline";
  const review = options.review ?? false;
  if (mode === "pipeline" && !options.roles.researcher) {
    throw new Error("The pipeline needs a researcher profile in the agents configuration");
  }
  const log = new ProvenanceLog(options.directory);
  const started = Date.now();
  const artifacts: StageArtifact[] = [];
  const snapshotRoot = options.snapshotRoot === undefined ? "/" : options.snapshotRoot;
  const tracker = snapshotRoot === null
    ? null
    : new FileTracker(options.workspace, snapshotRoot, `run-${randomUUID().slice(0, 8)}`);
  const context: StageContext = { options, log, artifacts, tracker };
  // Everything that shapes agent behavior, so a later reader can tell runs apart.
  const settings = {
    workspaceCwd: options.workspace.cwd,
    maxCorrections: options.maxCorrections ?? 1,
    commandLimits: options.commandLimits ?? PIPELINE_COMMAND_LIMITS,
    toolCallBudgets: { ...DEFAULT_BUDGETS, ...options.toolCallBudgets },
    submitAllowance: SUBMIT_ALLOWANCE,
    snapshotRoot,
    roles: options.roles,
  };
  await log.record({ type: "run_start", mode, review, request: options.request, settings });

  let approved: boolean | null = null;
  try {
    if (options.signal?.aborted) throw new PipelineInterrupted();
    if (mode === "single") {
      await runStage<ExecutionReport>(context, {
        id: "solve", stage: "solve", role: "executor", toolset: "execute", parents: [],
        prompt: soloPrompt(options.request),
        submitTool: reportTool([]),
      });
    } else {
      const research = await runStage<Findings>(context, {
        id: "research", stage: "research", role: "researcher", toolset: "inspect", parents: [],
        prompt: researchPrompt(options.request),
        submitTool: findingsTool(),
      });
      const findings = research.submission ?? { summary: "The researcher submitted no findings.", facts: [] };

      const planning = await runStage<Plan>(context, {
        id: "plan", stage: "plan", role: "planner", toolset: "none", parents: ["research"],
        prompt: planPrompt(options.request, findings),
        submitTool: planTool(findings),
      });
      const plan = planning.submission ?? { summary: "The planner submitted no plan.", steps: [] };

      let execution = await runStage<ExecutionReport>(context, {
        id: "execute", stage: "execute", role: "executor", toolset: "execute", parents: ["plan", "research"],
        prompt: executePrompt(options.request, findings, plan),
        submitTool: reportTool(plan.steps),
        stepTracking: plan.steps,
      });

      if (review) {
        const maxCorrections = options.maxCorrections ?? 1;
        for (let round = 0; ; round++) {
          const reviewId = round === 0 ? "review" : `review-${round + 1}`;
          const verdict = await runStage<Review>(context, {
            id: reviewId, stage: "review", role: "reviewer", toolset: "inspect",
            parents: [execution.artifact.id, "plan", "research"],
            prompt: reviewPrompt(options.request, findings, plan, execution),
            submitTool: reviewTool(),
          });
          approved = verdict.submission?.approved ?? null;
          if (approved !== false || round >= maxCorrections) break;
          execution = await runStage<ExecutionReport>(context, {
            id: `correct-${round + 1}`, stage: "correct", role: "executor", toolset: "execute",
            parents: [reviewId, execution.artifact.id, "plan", "research"],
            prompt: correctionPrompt(options.request, findings, plan, execution, verdict.submission!),
            submitTool: reportTool(plan.steps),
            stepTracking: plan.steps,
          });
        }
      }
    }
  } catch (error) {
    if (!(error instanceof PipelineInterrupted)) throw error;
  } finally {
    await log.flush();
  }

  const interrupted = options.signal?.aborted ?? false;
  const status = interrupted ? "interrupted" : artifacts.every((artifact) => artifact.status === "submitted") ? "completed" : "incomplete";
  const durationMs = Date.now() - started;
  await log.record({ type: "run_end", status, durationMs });
  return {
    status, approved, artifacts, durationMs, provenanceFile: log.file,
    usage: sumUsage(artifacts.map((artifact) => artifact.usage)),
  };
}

interface StageContext {
  options: PipelineOptions;
  log: ProvenanceLog;
  artifacts: StageArtifact[];
  tracker: FileTracker | null;
}

interface StageSpec<T> {
  id: string;
  stage: StageName;
  role: AgentRole;
  toolset: Toolset;
  parents: string[];
  prompt: string;
  submitTool: (save: (value: T) => void) => ToolDefinition;
  /** Executor stages get begin_step so each later tool call is tagged with a plan step. */
  stepTracking?: PlanStep[];
}

interface StageOutcome<T> {
  artifact: StageArtifact;
  submission: T | undefined;
}

class PipelineInterrupted extends Error {
  constructor() { super("Pipeline interrupted"); }
}

async function runStage<T>(context: StageContext, spec: StageSpec<T>): Promise<StageOutcome<T>> {
  const { options, log } = context;
  if (options.signal?.aborted) throw new PipelineInterrupted();
  await log.record({
    type: "stage_start", id: spec.id, stage: spec.stage, role: spec.role, parents: spec.parents,
    prompt: spec.prompt, promptSha256: contentDigest(spec.prompt),
  });
  const startedAt = new Date();
  const before = await context.tracker?.snapshot() ?? null;

  let submission: T | undefined;
  let currentStep: string | null = null;
  const tools = [spec.submitTool((value) => { submission = value; })];
  if (spec.stepTracking) tools.push(beginStepTool(spec.stepTracking, (stepId) => { currentStep = stepId; }));

  const toolCalls: ToolCallRecord[] = [];
  let session: AgentSession | undefined;
  let error: string | null = null;
  try {
    session = await createRoleSession({
      cwd: options.workspace.cwd,
      modelsFile: options.modelsFile,
      role: spec.role,
      roles: options.roles,
      sessionManager: SessionManager.create(options.workspace.cwd, path.join(options.directory, "sessions")),
      customTools: tools,
      toolset: spec.toolset,
      workspace: options.workspace,
      commandLimits: options.commandLimits ?? PIPELINE_COMMAND_LIMITS,
    });
    const active = session;
    await log.record({ type: "stage_session", id: spec.id, sessionFile: active.sessionManager.getSessionFile() ?? null });
    const budget = options.toolCallBudgets?.[spec.stage] ?? DEFAULT_BUDGETS[spec.stage];
    const submitName = tools[0]!.name;
    let spent = 0;
    let total = 0;
    let overBudget = false;
    const starts = new Map<string, { args: unknown; stepId: string | null; startedAt: string }>();
    const unsubscribe = active.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        starts.set(event.toolCallId, { args: event.args, stepId: currentStep, startedAt: new Date().toISOString() });
      } else if (event.type === "tool_execution_end") {
        const start = starts.get(event.toolCallId);
        starts.delete(event.toolCallId);
        const call: ToolCallRecord = {
          toolCallId: event.toolCallId, tool: event.toolName,
          stepId: start?.stepId ?? currentStep, args: truncate(JSON.stringify(start?.args) ?? "", 2000),
          isError: event.isError, durationMs: event.durationMs ?? null,
          startedAt: start?.startedAt ?? new Date().toISOString(),
        };
        toolCalls.push(call);
        void log.record({ type: "tool_call", stageId: spec.id, call });
        void log.recordToolOutput({
          stageId: spec.id, toolCallId: call.toolCallId, tool: call.tool, stepId: call.stepId,
          args: start?.args ?? null, output: resultText(event.result), isError: call.isError,
          durationMs: call.durationMs, startedAt: call.startedAt, endedAt: new Date().toISOString(),
        });
        // Over budget, every further non-submit call stops the turn, including during the reminder.
        // The hard cap also stops a model that keeps resubmitting.
        const nonSubmit = event.toolName !== submitName;
        if (nonSubmit) spent++;
        if ((nonSubmit && spent > budget) || ++total > budget + SUBMIT_ALLOWANCE) {
          overBudget = true;
          void active.abort();
        }
      }
    });
    const onAbort = () => void active.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await active.prompt(spec.prompt);
      if (submission === undefined && !options.signal?.aborted) {
        await active.prompt(overBudget
          ? `You have used this stage's tool budget. Call ${submitName} now with what you have; do not call other tools.`
          : `You finished without calling ${submitName}. Call it now; the stage is not complete until you do.`);
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const fileChanges = await context.tracker?.changesSince(before) ?? null;
  const cwdPrefix = options.workspace.cwd.endsWith("/") ? options.workspace.cwd : `${options.workspace.cwd}/`;
  const endedAt = new Date();
  const artifact: StageArtifact = {
    id: spec.id,
    stage: spec.stage,
    role: spec.role,
    parents: spec.parents,
    status: submission !== undefined ? "submitted" : error ? "failed" : "missing",
    content: submission ?? null,
    sha256: submission === undefined ? null : contentDigest(submission),
    error,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    latencyMs: endedAt.getTime() - startedAt.getTime(),
    usage: session ? collectUsage(session) : sumUsage([]),
    toolCalls,
    changedFiles: fileChanges
      ? [...fileChanges.created, ...fileChanges.modified].filter((file) => file.startsWith(cwdPrefix)).sort()
      : null,
    fileChanges,
    sessionFile: session?.sessionManager.getSessionFile() ?? null,
  };
  if (session) {
    try { await session.abort(); } finally { session.dispose(); }
  }
  context.artifacts.push(artifact);
  await log.record({ type: "stage_end", artifact });
  return { artifact, submission };
}

// --- Submission tools --------------------------------------------------------------

function findingsTool(): StageSpec<Findings>["submitTool"] {
  return (save) => defineTool({
    name: "submit_findings",
    label: "Submit findings",
    description: "Submit the research findings for the planner. Each fact must be one checkable claim with its evidence (file path and line, or command and observed output). Facts are numbered F1, F2, ... in the order given. Calling again replaces the earlier submission.",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1 }),
      facts: Type.Array(Type.Object({
        claim: Type.String({ minLength: 1 }),
        evidence: Type.String({ minLength: 1 }),
      }), { minItems: 1 }),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const findings: Findings = {
        summary: params.summary,
        facts: params.facts.map((fact, index) => ({ id: `F${index + 1}`, claim: fact.claim, evidence: fact.evidence })),
      };
      save(findings);
      const ids = findings.facts.map((fact) => fact.id).join(", ");
      return { content: [{ type: "text", text: `Findings saved as ${ids}. Your stage is complete; reply with a one-line summary.` }], details: findings };
    },
  }) as unknown as ToolDefinition;
}

function planTool(findings: Findings): StageSpec<Plan>["submitTool"] {
  const factIds = new Set(findings.facts.map((fact) => fact.id));
  return (save) => defineTool({
    name: "submit_plan",
    label: "Submit plan",
    description: "Submit the ordered implementation plan for the executor. Each step lists the finding IDs (F1, F2, ...) it relies on in `uses`; use [] when a step needs none. Steps are numbered S1, S2, ... in the order given. Calling again replaces the earlier submission.",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1 }),
      steps: Type.Array(Type.Object({
        action: Type.String({ minLength: 1 }),
        uses: Type.Array(Type.String()),
        check: Type.String({ description: "How the executor can confirm the step worked" }),
      }), { minItems: 1 }),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const unknown = [...new Set(params.steps.flatMap((step) => step.uses))].filter((id) => !factIds.has(id));
      if (unknown.length) {
        throw new Error(`Unknown finding IDs: ${unknown.join(", ")}. Known IDs: ${[...factIds].join(", ") || "none"}.`);
      }
      const plan: Plan = {
        summary: params.summary,
        steps: params.steps.map((step, index) => ({ id: `S${index + 1}`, action: step.action, uses: [...new Set(step.uses)], check: step.check })),
      };
      save(plan);
      return { content: [{ type: "text", text: `Plan saved as ${plan.steps.map((step) => step.id).join(", ")}. Your stage is complete; reply with a one-line summary.` }], details: plan };
    },
  }) as unknown as ToolDefinition;
}

function beginStepTool(steps: PlanStep[], begin: (stepId: string) => void): ToolDefinition {
  const known = new Set([...steps.map((step) => step.id), UNPLANNED_STEP]);
  return defineTool({
    name: "begin_step",
    label: "Begin step",
    description: `Declare which plan step your next tool calls work on. Call it before starting each step. Use "${UNPLANNED_STEP}" for work outside the plan.`,
    parameters: Type.Object({ stepId: Type.String({ minLength: 1 }) }),
    executionMode: "sequential",
    async execute(_id, params) {
      if (!known.has(params.stepId)) throw new Error(`Unknown step ${params.stepId}. Known: ${[...known].join(", ")}.`);
      begin(params.stepId);
      return { content: [{ type: "text", text: `Now working on ${params.stepId}.` }], details: { stepId: params.stepId } };
    },
  }) as unknown as ToolDefinition;
}

function reportTool(steps: PlanStep[]): StageSpec<ExecutionReport>["submitTool"] {
  const known = new Set([...steps.map((step) => step.id), UNPLANNED_STEP]);
  return (save) => defineTool({
    name: "submit_report",
    label: "Submit report",
    description: "Submit what you did. For each plan step give its status and concrete evidence: files changed, commands run, and observed results. A check you did not run is not evidence. Calling again replaces the earlier submission.",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1 }),
      steps: Type.Array(Type.Object({
        stepId: Type.String({ minLength: 1 }),
        status: Type.Union([Type.Literal("done"), Type.Literal("skipped"), Type.Literal("failed")]),
        evidence: Type.String(),
      })),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      if (steps.length) {
        const unknown = params.steps.map((step) => step.stepId).filter((id) => !known.has(id));
        if (unknown.length) throw new Error(`Unknown step IDs: ${unknown.join(", ")}. Known: ${[...known].join(", ")}.`);
      }
      const report: ExecutionReport = { summary: params.summary, steps: params.steps };
      save(report);
      return { content: [{ type: "text", text: "Report saved. Your stage is complete; reply with a one-line summary." }], details: report };
    },
  }) as unknown as ToolDefinition;
}

function reviewTool(): StageSpec<Review>["submitTool"] {
  return (save) => defineTool({
    name: "submit_review",
    label: "Submit review",
    description: "Approve or reject the executor's work with an evidence-based reason. List each concrete problem the executor must fix when rejecting. Calling again replaces the earlier verdict.",
    parameters: Type.Object({
      approved: Type.Boolean(),
      reason: Type.String({ minLength: 1 }),
      problems: Type.Array(Type.String()),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const verdict: Review = { approved: params.approved, reason: params.reason, problems: params.problems };
      save(verdict);
      return { content: [{ type: "text", text: `Review ${params.approved ? "approval" : "rejection"} saved. Your stage is complete; reply with a one-line summary.` }], details: verdict };
    },
  }) as unknown as ToolDefinition;
}

// --- Stage prompts -----------------------------------------------------------------

const json = (value: unknown) => "```json\n" + JSON.stringify(value, null, 2) + "\n```";

function soloPrompt(request: string): string {
  return `# Task\n\n${request}\n\n# Your job\n\nComplete the task in the workspace. Finish by calling submit_report with what you did and the checks you ran.`;
}

function researchPrompt(request: string): string {
  return `# Task\n\n${request}\n\n# Your stage: research\n\nInvestigate the workspace and environment to learn what the planner needs: relevant files, data formats, interfaces, installed tools and versions, constraints, and how success can be checked. Do not change files or system state. Record each fact the plan will depend on as a separate checkable claim with evidence. Finish by calling submit_findings once with all facts.`;
}

function planPrompt(request: string, findings: Findings): string {
  return `# Task\n\n${request}\n\n# Research findings\n\n${json(findings)}\n\n# Your stage: planning\n\nYou have no workspace tools. Plan only from the task and these findings. Write ordered, concrete steps the executor can follow. In each step's \`uses\`, list the finding IDs that step depends on. Give each step a check the executor can run. Finish by calling submit_plan.`;
}

function executePrompt(request: string, findings: Findings, plan: Plan): string {
  return `# Task\n\n${request}\n\n# Research findings\n\n${json(findings)}\n\n# Plan\n\n${json(plan)}\n\n# Your stage: execution\n\nCarry out the plan in the workspace. Call begin_step with a step ID before working on that step, and "${UNPLANNED_STEP}" for anything outside the plan. Run each step's check. If a finding or step turns out to be wrong, adapt and say so in your report. Finish by calling submit_report.`;
}

function reviewPrompt(request: string, findings: Findings, plan: Plan, execution: StageOutcome<ExecutionReport>): string {
  const report = execution.submission ?? { summary: "The executor submitted no report.", steps: [] };
  return `# Task\n\n${request}\n\n# Research findings\n\n${json(findings)}\n\n# Plan\n\n${json(plan)}\n\n# Execution report\n\n${json(report)}\n\n# Files changed during execution\n\n${json(execution.artifact.changedFiles ?? "unknown")}\n\n# Your stage: review\n\nCheck whether the workspace now satisfies the task. Inspect the changed files and run read-only checks such as existing tests; do not modify files. Approve only if the task requirements are met. Finish by calling submit_review.`;
}

function correctionPrompt(
  request: string, findings: Findings, plan: Plan, execution: StageOutcome<ExecutionReport>, verdict: Review,
): string {
  const report = execution.submission ?? { summary: "The executor submitted no report.", steps: [] };
  return `# Task\n\n${request}\n\n# Research findings\n\n${json(findings)}\n\n# Plan\n\n${json(plan)}\n\n# Previous execution report\n\n${json(report)}\n\n# Reviewer rejection\n\n${json(verdict)}\n\n# Your stage: correction\n\nThe workspace already contains the previous execution's changes. Fix the problems the reviewer listed. Call begin_step before working on a plan step. Finish by calling submit_report.`;
}

// --- Helpers -----------------------------------------------------------------------

/** Text parts of a tool result; images and other parts are noted, not embedded. */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return JSON.stringify(result ?? null);
  return content
    .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : `[${part.type ?? "unknown"} content]`))
    .join("");
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

export function sumUsage(usages: Usage[]): Usage {
  const total: Usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const usage of usages) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key];
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
  }
  return total;
}
