import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  type ConversationId,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { Orchestrator } from "../orchestration/orchestrator.js";
import type { AgentRole } from "../orchestration/types.js";

export interface AgentTools {
  rootTools: ToolRegistration[];
  workers: Record<AgentRole, ToolRegistration[]>;
  extension: Extension;
}

const taskSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  role: Type.Union([
    Type.Literal("planner"),
    Type.Literal("executor"),
    Type.Literal("reviewer"),
  ]),
  instructions: Type.String(),
  dependsOn: Type.Array(Type.String()),
  files: Type.Array(Type.String()),
});

/** Tool lists enforce the hub-and-spoke communication model. */
export function createAgentTools(
  orchestrator: Orchestrator,
  rootId: ConversationId,
  workerIds: ReadonlyMap<ConversationId, string>,
): AgentTools {
  function requireWorkerTask(conversationId: ConversationId): string {
    const taskId = workerIds.get(conversationId);
    if (!taskId) {
      throw new Error("Only registered workers can use this tool");
    }
    return taskId;
  }

  const messageOrchestrator = defineTool({
    name: "message_orchestrator",
    description: "Send a message only to the orchestrator. For peer input, describe " +
      "the question and intended peer here. waitForReply=true pauses until the orchestrator answers.",
    parameters: Type.Object({
      message: Type.String({ minLength: 1 }),
      waitForReply: Type.Boolean(),
    }),
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const taskId = requireWorkerTask(api.conversationId);
      const reply = await orchestrator.messageOrchestrator(
        taskId,
        args.message,
        args.waitForReply,
        context.abortSignal,
      );
      return textResult(reply);
    },
  });

  const submitReview = defineTool({
    name: "submit_review",
    description: "Record your review verdict and actionable feedback. Required before a reviewer finishes.",
    parameters: Type.Object({
      approved: Type.Boolean(),
      feedback: Type.String(),
    }),
    execute: async (args, api) => {
      const taskId = requireWorkerTask(api.conversationId);
      orchestrator.review(taskId, args);
      return textResult("Review recorded. Finish with a concise report.");
    },
  });

  const read = createReadTool();
  const listFiles = createListFilesTool();
  const shell = process.platform === "win32" ? createPowerShellTool() : createBashTool();
  const executorTools: ToolRegistration[] = [
    read,
    listFiles,
    createWriteTool(),
    createEditTool(),
    shell,
    messageOrchestrator,
  ];
  const rootTools = createOrchestratorTools(orchestrator, rootId);
  const workers: Record<AgentRole, ToolRegistration[]> = {
    planner: [read, listFiles, messageOrchestrator],
    executor: executorTools,
    reviewer: [read, listFiles, messageOrchestrator, submitReview],
  };

  const extension = defineExtension({
    name: "pimas",
    tools: [...rootTools, ...executorTools, submitReview],
    hooks: [hook(GenerationTask, {
      onYield: (_answer, api) => {
        if (api.conversationId !== rootId) {
          return;
        }

        const blocker = orchestrator.finalBlocker();
        if (blocker) {
          return { continue: blocker };
        }
      },
    })],
  });

  return { rootTools, workers, extension };
}

function createOrchestratorTools(
  orchestrator: Orchestrator,
  rootId: ConversationId,
): ToolRegistration[] {
  function requireOrchestrator(conversationId: ConversationId): void {
    if (conversationId !== rootId) {
      throw new Error("Only the orchestrator can route messages or change the plan");
    }
  }

  return [
    defineTool({
      name: "set_plan",
      description: "Set ordered phases and tasks after planning. Starts ready agents " +
        "automatically, up to the parallel limit. Replace only when no agents are active; " +
        "use new task IDs. Executors need relative file/directory scopes, without globs. " +
        "Final phase: reviewers only.",
      parameters: Type.Object({
        phases: Type.Array(Type.Object({
          title: Type.String(),
          tasks: Type.Array(taskSchema),
        })),
      }),
      executionMode: "sequential",
      execute: async (args, api) => {
        requireOrchestrator(api.conversationId);
        orchestrator.setPlan(args.phases);
        return textResult(orchestrator.snapshot());
      },
    }),
    defineTool({
      name: "task_status",
      description: "Get phases, all task results, review verdicts, and unanswered questions.",
      parameters: Type.Object({}),
      execute: async (_args, api) => {
        requireOrchestrator(api.conversationId);
        return textResult(orchestrator.snapshot());
      },
    }),
    defineTool({
      name: "wait_for_updates",
      description: "Wait up to 15 seconds for worker messages, questions, or completions. " +
        "Returns early on a question so you can route a reply while other agents run.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async (_args, api, context) => {
        requireOrchestrator(api.conversationId);
        const updates = await orchestrator.waitForUpdates(context.abortSignal);
        return textResult({ updates, status: orchestrator.snapshot() });
      },
    }),
    defineTool({
      name: "reply_to_agent",
      description: "Answer a pending question using its questionId. Unblocks the worker.",
      parameters: Type.Object({
        questionId: Type.String(),
        message: Type.String(),
      }),
      executionMode: "sequential",
      execute: async (args, api) => {
        requireOrchestrator(api.conversationId);
        orchestrator.reply(args.questionId, args.message);
        return textResult("Reply delivered.");
      },
    }),
    defineTool({
      name: "message_agent",
      description: "Send guidance or relay another agent's question to an active worker. " +
        "Questions waiting on reply_to_agent must be answered using that tool. " +
        "Completed workers' reports are in task_status.",
      parameters: Type.Object({
        taskId: Type.String(),
        message: Type.String(),
      }),
      executionMode: "sequential",
      execute: async (args, api) => {
        requireOrchestrator(api.conversationId);
        await orchestrator.send(args.taskId, args.message);
        return textResult("Message delivered from the orchestrator.");
      },
    }),
    defineTool({
      name: "stop_work",
      description: "Cancel unfinished work when blocked or unable to complete. " +
        "Then explain the incomplete result to the user.",
      parameters: Type.Object({ reason: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      execute: async (args, api) => {
        requireOrchestrator(api.conversationId);
        orchestrator.stop(args.reason);
        return textResult("Stopped. Report the blocker and any completed work honestly.");
      },
    }),
  ];
}

function createListFilesTool(): ToolRegistration {
  return defineTool({
    name: "list_files",
    description: "List files and directories directly inside a path. Use . for the project root.",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (args, api, context) => {
      if (!api.env) {
        throw new Error("No file environment");
      }

      const result = await api.env.listDir(args.path, context);
      if (!result.ok) {
        throw result.error;
      }

      const entries = result.value.slice(0, 300).map(({ name, kind }) => ({ name, kind }));
      return textResult(entries);
    },
  });
}

function textResult(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { output: [{ type: "text" as const, text }] };
}
