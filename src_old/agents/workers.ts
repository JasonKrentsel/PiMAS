import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness } from "@earendil-works/pi-durable";
import type { AppConfig } from "../config.js";
import type { AgentDriver, AgentTask } from "../orchestration/types.js";
import { askConversation } from "./conversation.js";
import { workerInstructions } from "./prompts.js";
import type { AgentTools } from "./tools.js";

interface WorkerOptions {
  harness: Harness;
  config: AppConfig;
  model: { provider: string; modelId: string };
  context: Context;
}

/** Manages the Pi conversation and cancellation lifecycle for each worker. */
export class WorkerSessions implements AgentDriver {
  readonly taskIds = new Map<ConversationId, string>();
  private readonly conversations = new Map<string, Conversation>();
  private tools?: AgentTools;

  constructor(private readonly options: WorkerOptions) {}

  // Tool handlers need the orchestrator, and the orchestrator needs this driver.
  // Connect the tools after constructing both, before starting any tasks.
  setTools(tools: AgentTools): void {
    this.tools = tools;
  }

  async run(task: AgentTask, taskContext: string, signal: AbortSignal): Promise<string> {
    const { harness, config, model, context } = this.options;
    const tools = this.tools;
    if (!tools) {
      throw new Error("Worker tools must be configured before starting tasks");
    }

    const taskSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(config.taskTimeoutMs),
    ]);
    const callContext = withAbortSignal(taskSignal, context);
    taskSignal.throwIfAborted();

    const conversation = await harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: {
        model,
        thinkingLevel: "off",
        cwd: config.cwd,
        extensions: [tools.extension],
        tools: tools.workers[task.role],
        instructions: workerInstructions(task.role),
      },
    }, callContext);

    this.taskIds.set(conversation.id, task.id);
    this.conversations.set(task.id, conversation);

    const abortConversation = () => {
      void conversation.abort(context).catch(() => {
        // The awaited cleanup below handles cancellation errors.
      });
    };
    taskSignal.addEventListener("abort", abortConversation, { once: true });

    try {
      taskSignal.throwIfAborted();
      return await askConversation(
        conversation,
        buildAssignment(task, taskContext),
        `Agent ${task.id}`,
        callContext,
      );
    } finally {
      taskSignal.removeEventListener("abort", abortConversation);
      if (taskSignal.aborted) {
        await conversation.abort(context);
      }
    }
  }

  async send(taskId: string, message: string): Promise<void> {
    const conversation = this.conversations.get(taskId);
    if (!conversation) {
      throw new Error(`Agent ${taskId} has not started yet; retry after its first update`);
    }

    await conversation.submit({
      type: "input",
      content: message,
      whenBusy: "steer",
    }, this.options.context);
  }

  async close(): Promise<void> {
    const aborts = [...this.conversations.values()].map(
      (conversation) => conversation.abort(this.options.context),
    );
    await Promise.allSettled(aborts);
  }
}

function buildAssignment(task: AgentTask, taskContext: string): string {
  return [
    `Task ${task.id}: ${task.title}`,
    task.instructions,
    `Assigned file/directory scopes: ${JSON.stringify(task.files)}`,
    "Orchestrator context:",
    taskContext,
  ].join("\n");
}
