import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type Conversation,
  type Registry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { askConversation } from "./agents/conversation.js";
import { createModelCatalog } from "./agents/models.js";
import { ORCHESTRATOR_INSTRUCTIONS } from "./agents/prompts.js";
import { createAgentTools } from "./agents/tools.js";
import { WorkerSessions } from "./agents/workers.js";
import type { AppConfig } from "./config.js";
import { Orchestrator } from "./orchestration/orchestrator.js";
import type { AgentUpdate } from "./orchestration/types.js";
import { cancelInterruptedWork } from "./storage/recovery.js";

const context = BACKGROUND_CONTEXT;

/** Connects storage, Pi sessions, and one orchestrator per user request. */
export class Application {
  private currentRequest?: Orchestrator;

  private constructor(
    private readonly config: AppConfig,
    private readonly harness: Harness,
    private readonly root: Conversation,
    private readonly registry: Registry,
    private readonly model: { provider: string; modelId: string },
  ) {}

  static async open(config: AppConfig): Promise<Application> {
    const { models, model } = createModelCatalog(config.model);
    const registry = createRegistry();
    const storage = config.storage === "memory"
      ? new MemoryStorage()
      : await openNodeJsonlStorage(config.storageDirectory, context);

    const harness = await Harness.open(storage, {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.cwd }),
      settings: {
        toolExecution: "sequential",
        stream: { timeoutMs: 120_000 },
        retry: { maxRetries: 1 },
      },
    }, context);

    try {
      // The mailbox is not persisted. Cancel old work while scheduling is paused,
      // before a new submission can accidentally restart it.
      if (await cancelInterruptedWork(harness, context)) {
        console.error("Cancelled interrupted work from the previous run. Conversation history was retained.");
      }

      const root = await harness.root(context);
      return new Application(config, harness, root, registry, model);
    } catch (error) {
      await harness.close(context);
      throw error;
    }
  }

  async run(prompt: string): Promise<string> {
    const workers = new WorkerSessions({
      harness: this.harness,
      config: this.config,
      model: this.model,
      context,
    });
    const orchestrator = new Orchestrator(prompt, workers, {
      maxParallel: this.config.maxParallel,
      onUpdate: printWorkerUpdate,
    });
    const tools = createAgentTools(orchestrator, this.root.id, workers.taskIds);

    workers.setTools(tools);
    this.registry.install(tools.extension);
    await this.root.configure({
      model: this.model,
      thinkingLevel: "off",
      cwd: this.config.cwd,
      extensions: [tools.extension],
      tools: tools.rootTools,
      instructions: ORCHESTRATOR_INSTRUCTIONS,
    }, context);

    this.currentRequest = orchestrator;
    orchestrator.start();

    try {
      return await askConversation(this.root, prompt, "Orchestrator", context);
    } finally {
      orchestrator.stop("Request ended");
      await orchestrator.drain();
      await workers.close();
      this.currentRequest = undefined;
    }
  }

  async interrupt(): Promise<void> {
    this.currentRequest?.stop("Interrupted by user");
    await this.root.abort(context);
  }

  async close(): Promise<void> {
    this.currentRequest?.stop("Session closed");
    await this.harness.close(context);
  }
}

function printWorkerUpdate(update: AgentUpdate): void {
  switch (update.type) {
    case "started":
      console.error(`[${update.taskId}] ${update.text}`);
      break;
    case "completed":
    case "failed":
      console.error(`[${update.taskId}] ${update.type}`);
      break;
    case "message":
    case "question":
      console.error(`[${update.taskId} → orchestrator] ${update.text}`);
      break;
  }
}
