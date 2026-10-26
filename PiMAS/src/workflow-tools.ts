import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunStore } from "./run-store.js";
import { acceptPlan, completionProblem, resolveAssignment, submitReview } from "./workflow.js";

export function createWorkflowTools(store: RunStore): ToolDefinition[] {
  return [
    defineTool({
      name: "accept_plan",
      label: "Accept plan",
      description: "Accept a self-contained implementation plan backed by completed planner reports. Include scope, interfaces, acceptance criteria, and verification. Required before spawning executors. Changing the plan after execution requires fresh execution and review.",
      parameters: Type.Object({
        plannerIds: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
        plan: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        await acceptPlan(store, params.plannerIds, params.plan);
        return { content: [{ type: "text", text: "Plan accepted and saved. Executors may now be spawned." }], details: { revision: store.workflow.revision } };
      },
    }),
    defineTool({
      name: "workflow_status",
      label: "Workflow status",
      description: "Inspect saved plan, worker outcomes, execution revision, explicit review verdicts, and any completion blocker. Check this before a final answer. Analysis-only work may finish without execution; implementation requires current independent approval.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        const state = { ...store.workflow, agents: store.agents(), completionBlocker: completionProblem(store) ?? null };
        return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }], details: state };
      },
    }),
    defineTool({
      name: "resolve_agent",
      label: "Retire unresolved assignment",
      description: "Record why a failed or interrupted assignment is no longer required, for example because replacement work covers it. This does not cancel active work, undo effects, or erase the original status/report/error. Retired assignments cannot resume.",
      parameters: Type.Object({ agentId: Type.String(), reason: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params) {
        await resolveAssignment(store, params.agentId, params.reason);
        return { content: [{ type: "text", text: `Retired ${params.agentId}; original evidence retained.` }], details: { agentId: params.agentId } };
      },
    }),
  ];
}

export function createSubmitReviewTool(store: RunStore, agentId: string): ToolDefinition {
  return defineTool({
    name: "submit_review",
    label: "Submit review",
    description: "Save your explicit approval or rejection of this execution revision with concrete evidence and limitations. Only your own verdict is recorded. You must also finish with a review report. A new execution invalidates this approval; do not claim unobserved checks.",
    parameters: Type.Object({ approved: Type.Boolean(), reason: Type.String({ minLength: 1 }) }),
    executionMode: "sequential",
    async execute(_id, params) {
      await submitReview(store, agentId, params.approved, params.reason);
      return { content: [{ type: "text", text: `Review ${params.approved ? "approval" : "rejection"} saved. Finish your review report.` }], details: { agentId, approved: params.approved } };
    },
  });
}
