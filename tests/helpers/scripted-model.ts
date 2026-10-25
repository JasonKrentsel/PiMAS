import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { OrchestratorStatus, Phase } from "../../src_old/orchestration/types.js";

interface ChatMessage {
  role: string;
  content?: string;
}

interface ChatRequest {
  messages: ChatMessage[];
  tools: { function: { name: string } }[];
}

interface ModelAction {
  text?: string;
  name?: string;
  args?: unknown;
}

const IMPLEMENTATION_PLAN: Phase[] = [
  {
    title: "Implement",
    tasks: ["frontend", "backend"].map((id) => ({
      id,
      title: `Build ${id}`,
      role: "executor",
      instructions: `Write ${id}.txt and verify the contract`,
      dependsOn: [],
      files: [`${id}.txt`],
    })),
  },
  {
    title: "Review",
    tasks: [{
      id: "review",
      title: "Inspect both files",
      role: "reviewer",
      instructions: "Read both files and verify GET /api/items",
      dependsOn: [],
      files: [],
    }],
  },
];

/** Deterministic role responses let the CLI test exercise real Pi tool calls. */
class ScriptedModel {
  readonly observedTools = new Set<string>();
  sawContinuation = false;
  sawRoutedAnswer = false;
  overlappingExecutors = false;

  private triedPrematureAnswer = false;
  private frontendStarted = false;
  private backendStarted = false;

  async respond(request: ChatRequest): Promise<ModelAction> {
    const toolNames = request.tools.map((tool) => tool.function.name);
    let action: ModelAction;

    if (toolNames.includes("set_plan")) {
      action = this.respondAsOrchestrator(request.messages);
    } else if (toolNames.includes("submit_review")) {
      action = this.respondAsReviewer(request.messages);
    } else if (toolNames.includes("write")) {
      action = await this.respondAsExecutor(request.messages);
    } else {
      action = this.respondAsPlanner(request.messages);
    }

    if (action.name) {
      this.observedTools.add(action.name);
    }
    return action;
  }

  private respondAsOrchestrator(messages: ChatMessage[]): ModelAction {
    this.sawContinuation ||= messages.some(
      (message) => message.role === "user" && message.content?.includes("Work is unfinished"),
    );

    if (!this.triedPrematureAnswer) {
      this.triedPrematureAnswer = true;
      return { text: "Premature success must be blocked" };
    }

    const status = latestStatus(messages);
    const lastTool = toolReplies(messages).at(-1);

    // A reply changes the mailbox. Fetch a fresh status before using it again.
    if (lastTool?.content?.includes("Reply delivered.")) {
      return { name: "wait_for_updates", args: {} };
    }

    const question = status?.pendingQuestions[0];
    if (question) {
      return {
        name: "reply_to_agent",
        args: {
          questionId: question.id,
          message: "Backend contract: GET /api/items",
        },
      };
    }

    if (status?.complete) {
      return { text: "Implemented frontend and backend; review approved." };
    }

    const plannerFinished = status?.tasks[0]?.status === "completed";
    if (status && status.phases.length === 0 && plannerFinished) {
      return { name: "set_plan", args: { phases: IMPLEMENTATION_PLAN } };
    }

    return { name: "wait_for_updates", args: {} };
  }

  private respondAsReviewer(messages: ChatMessage[]): ModelAction {
    const replies = toolReplies(messages);

    switch (replies.length) {
      case 0:
        return { name: "read", args: { path: "frontend.txt" } };
      case 1:
        return { name: "read", args: { path: "backend.txt" } };
      case 2:
        assert.ok(replies.every((reply) => reply.content?.includes("GET /api/items")));
        return {
          name: "submit_review",
          args: {
            approved: true,
            feedback: "Both files implement the shared contract",
          },
        };
      default:
        return { text: "Reviewed both files; approved." };
    }
  }

  private async respondAsExecutor(messages: ChatMessage[]): Promise<ModelAction> {
    const isFrontend = messages.some(
      (message) => message.role === "user" && message.content?.startsWith("Task frontend:"),
    );
    const replies = toolReplies(messages);

    if (isFrontend && replies.length === 0) {
      this.frontendStarted = true;
      this.overlappingExecutors ||= this.backendStarted;
      return {
        name: "message_orchestrator",
        args: {
          message: "Ask backend which endpoint the frontend should use",
          waitForReply: true,
        },
      };
    }

    if (isFrontend && replies.length === 1) {
      this.sawRoutedAnswer = replies[0]!.content?.includes("Backend contract: GET /api/items") ?? false;
      return {
        name: "write",
        args: { path: "frontend.txt", content: "Frontend calls GET /api/items" },
      };
    }

    if (!isFrontend && replies.length === 0) {
      this.backendStarted = true;
      this.overlappingExecutors ||= this.frontendStarted;
      // Keep the backend request live briefly while the frontend requests its contract.
      await delay(100);
      return {
        name: "write",
        args: { path: "backend.txt", content: "Backend serves GET /api/items" },
      };
    }

    const role = isFrontend ? "Frontend" : "Backend";
    return { text: `${role} implemented GET /api/items` };
  }

  private respondAsPlanner(messages: ChatMessage[]): ModelAction {
    if (toolReplies(messages).length === 0) {
      return { name: "list_files", args: { path: "." } };
    }
    return {
      text: "Implement frontend and backend in parallel with GET /api/items; review both files.",
    };
  }
}

function toolReplies(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role === "tool");
}

function latestStatus(messages: ChatMessage[]): OrchestratorStatus | undefined {
  for (const message of toolReplies(messages).reverse()) {
    try {
      const parsed = JSON.parse(message.content ?? "");
      const status = parsed.status ?? parsed;
      if (Array.isArray(status.tasks)) {
        return status as OrchestratorStatus;
      }
    } catch {
      // Most tool replies are plain text, not status snapshots.
    }
  }
  return undefined;
}

function sendAction(response: ServerResponse, action: ModelAction, sequence: number): void {
  let delta: unknown;

  if (action.name) {
    delta = {
      role: "assistant",
      tool_calls: [{
        index: 0,
        id: `call_${sequence}`,
        type: "function",
        function: { name: action.name, arguments: JSON.stringify(action.args) },
      }],
    };
  } else {
    delta = { role: "assistant", content: action.text };
  }

  response.writeHead(200, { "content-type": "text/event-stream" });
  writeChunk(delta, null);
  writeChunk({}, action.name ? "tool_calls" : "stop");
  response.end("data: [DONE]\n\n");

  function writeChunk(content: unknown, finishReason: string | null): void {
    const chunk = {
      id: `chat_${sequence}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: content, finish_reason: finishReason }],
    };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
}

export async function startScriptedModelServer() {
  const model = new ScriptedModel();
  let sequence = 0;
  let serverError: unknown;

  const server = createServer((request, response) => {
    async function handleRequest(): Promise<void> {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }

      const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatRequest;
      const action = await model.respond(body);
      sendAction(response, action, ++sequence);
    }

    void handleRequest().catch((error: unknown) => {
      serverError = error;
      response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    model,
    assertHealthy() {
      if (serverError) {
        throw serverError;
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
