import type { AgentRole } from "./agent-config.js";
import type { CheckpointAgent, RunStore } from "./run-store.js";

function required(store: RunStore): readonly CheckpointAgent[] {
  return store.agents().filter((agent) => !agent.resolution);
}

/** The orchestrator accepts evidence, not just a plan it wrote without a planner. */
export async function acceptPlan(store: RunStore, plannerIds: string[], text: string): Promise<void> {
  const plan = text.trim();
  if (!plan || !plannerIds.length || new Set(plannerIds).size !== plannerIds.length) {
    throw new Error("A nonempty plan and unique settled planner ids are required");
  }
  for (const id of plannerIds) {
    const agent = store.agent(id);
    if (!agent || agent.role !== "planner" || agent.status !== "settled" || !agent.report || agent.resolution) {
      throw new Error(`Plan evidence ${id} is not a required settled planner report`);
    }
  }
  if (required(store).some((agent) => (agent.role === "executor" || agent.role === "reviewer") && agent.status !== "settled")) {
    throw new Error("Resolve unfinished execution/review before replacing the accepted plan");
  }
  // Replacing a plan after execution requires fresh execution and fresh review.
  if (store.agents().some((agent) => agent.role === "executor")) store.workflow.revision++;
  store.workflow.plan = { text: plan, plannerIds: [...plannerIds] };
  await store.save();
}

export function assertWorkerAllowed(store: RunStore, role: AgentRole): void {
  if (role === "orchestrator") throw new Error("The orchestrator cannot spawn another orchestrator");
  if (role === "executor" && !store.workflow.plan) {
    throw new Error("Accept a plan backed by settled planner reports before execution");
  }
  if (role === "reviewer") {
    const executors = required(store).filter((agent) => agent.role === "executor");
    if (!store.workflow.plan || !executors.length || executors.some((agent) => agent.status !== "settled" || !agent.report) ||
        !executors.some((agent) => agent.revision === store.workflow.revision)) {
      throw new Error("Review requires settled execution evidence for the current accepted plan/revision");
    }
  }
}

/** Called immediately before adding/resuming the worker and saving its launch. */
export function beginWorker(store: RunStore, role: AgentRole): number | undefined {
  assertWorkerAllowed(store, role);
  if (role === "executor") return ++store.workflow.revision;
  return role === "reviewer" ? store.workflow.revision : undefined;
}

/** A verdict is only completion evidence after this reviewer also settles. */
export async function submitReview(store: RunStore, agentId: string, approved: boolean, reason: string): Promise<void> {
  const agent = store.agent(agentId);
  const explanation = reason.trim();
  if (!agent || agent.role !== "reviewer" || agent.status !== "running" || !agent.revision || agent.resolution) {
    throw new Error("Only a running reviewer can submit its own verdict");
  }
  if (!explanation) throw new Error("A review reason is required");
  if (agent.revision !== store.workflow.revision) throw new Error("Execution changed during review; this review is stale");
  agent.review = { approved, reason: explanation, revision: agent.revision };
  await store.save();
}

export async function resolveAssignment(store: RunStore, agentId: string, reason: string): Promise<void> {
  const agent = store.agent(agentId);
  if (!agent || !["failed", "interrupted"].includes(agent.status)) {
    throw new Error("Only failed or interrupted assignments can be retired; active work must not be abandoned");
  }
  if (!reason.trim()) throw new Error("Explain why this assignment is no longer required");
  agent.resolution = reason.trim();
  await store.save();
}

/** No tool/final prose can turn unfinished or unreviewed execution into success. */
export function completionProblem(store: RunStore): string | undefined {
  const agents = required(store);
  const unfinished = agents.filter((agent) => agent.status !== "settled");
  if (unfinished.length) return `Unresolved assignments: ${unfinished.map((agent) => `${agent.id} (${agent.status})`).join(", ")}`;
  const executors = agents.filter((agent) => agent.role === "executor");
  if (!executors.length && store.workflow.revision === 0) return undefined; // Inspection/planning only.
  if (!store.workflow.plan || !executors.some((agent) => agent.revision === store.workflow.revision)) {
    return "No current execution evidence for the accepted plan";
  }
  const reviewers = agents.filter((agent) => agent.role === "reviewer" && agent.revision === store.workflow.revision);
  if (!reviewers.length) return "Current execution has no independent review";
  if (reviewers.some((agent) => !agent.review?.approved || agent.review.revision !== store.workflow.revision)) {
    return "Every reviewer of the current revision must explicitly approve";
  }
  return undefined;
}
