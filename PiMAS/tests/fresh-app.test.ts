import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { SessionManager, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRoleSession } from "../src/agent.js";
import { AgentRuntime, createOrchestratorTools } from "../src/runtime.js";
import { RunStore } from "../src/run-store.js";
import { TaskRun } from "../src/task-run.js";
import { loadAgentConfig, type AgentRole } from "../src/agent-config.js";

interface ChatRequest {
  model: string;
  reasoning_effort?: string;
  messages: { role: string; content: unknown }[];
  tools: { function: { name: string } }[];
}

type Reply =
  | { text: string }
  | { tool: string; args: Record<string, unknown> }
  | { error: string; status?: number }
  | { hang: true };

/** Exercise the real SDK/HTTP path, but never contact a real model. */
async function fixture(t: TestContext, respond: (request: ChatRequest, count: number) => Reply) {
  const dataDirectory = path.resolve("data");
  await mkdir(dataDirectory, { recursive: true });
  const cwd = await mkdtemp(path.join(dataDirectory, "fresh-test-"));
  const requests: ChatRequest[] = [];
  const sessions = new Set<AgentSession>();
  const runtimes: AgentRuntime[] = [];
  const tasks: TaskRun[] = [];
  let serverError: unknown;
  let notifyRequest!: () => void;
  const receivedRequest = new Promise<void>((resolve) => { notifyRequest = resolve; });

  const server = createServer((request, response) => {
    async function handle(): Promise<void> {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatRequest;
      requests.push(body);
      const reply = respond(body, requests.length);
      if ("error" in reply) {
        response.writeHead(reply.status ?? 503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: reply.error } }));
      } else if ("hang" in reply) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": waiting for cancellation\n\n");
      } else {
        sendReply(response, reply, requests.length);
      }
      notifyRequest();
    }
    void handle().catch((error: unknown) => {
      serverError = error;
      response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }));
      notifyRequest();
    });
  });

  t.after(async () => {
    for (const task of tasks) await task.dispose();
    for (const runtime of runtimes) await runtime.dispose();
    for (const session of sessions) {
      try { await session.abort(); } finally { session.dispose(); }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
    if (serverError) throw serverError;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const modelsFile = path.join(cwd, "models.local.json");
  const config = JSON.parse(await readFile(new URL("../models.example.json", import.meta.url), "utf8"));
  config.providers.pimas.baseUrl = baseUrl;
  config.providers.pimas.apiKey = "test-secret";
  config.providers.pimas.models[0].id = "scripted-model";
  config.providers["fixture-provider"] = config.providers.pimas;
  delete config.providers.pimas;
  await writeFile(modelsFile, JSON.stringify(config));
  const agentsFile = path.join(cwd, "agents.local.json");
  const agentConfig = await loadAgentConfig(path.resolve("agents.example.json"));
  for (const profile of Object.values(agentConfig.roles)) {
    profile.provider = "fixture-provider";
    profile.model = "scripted-model";
  }
  await writeFile(agentsFile, JSON.stringify(agentConfig));
  const cliFlags = ["--models", modelsFile, "--agents", agentsFile];

  return {
    cwd,
    modelsFile,
    agentsFile,
    cliFlags,
    requests,
    receivedRequest,
    async task(request: string) {
      const { roles } = await loadAgentConfig(agentsFile);
      const task = await TaskRun.create({
        directory: await mkdtemp(path.join(cwd, "task-")), cwd, modelsFile, roles, request,
      });
      tasks.push(task);
      return task;
    },
    async resumeTask(directory: string) {
      const { roles } = await loadAgentConfig(agentsFile);
      const task = await TaskRun.resume({ directory, cwd, modelsFile, roles });
      tasks.push(task);
      return task;
    },
    async runtime(answerWaitMs?: number) {
      const { roles } = await loadAgentConfig(agentsFile);
      const runStore = await RunStore.create({
        directory: await mkdtemp(path.join(cwd, "run-")), cwd, modelsFile,
      });
      const runtime = new AgentRuntime({
        cwd, modelsFile, roles, runStore,
        ...(answerWaitMs === undefined ? {} : { answerWaitMs }),
      });
      runtimes.push(runtime);
      return runtime;
    },
    async orchestratorFor(runtime: AgentRuntime) {
      const { roles } = await loadAgentConfig(agentsFile);
      const session = await createRoleSession({
        cwd, modelsFile, role: "orchestrator", roles,
        sessionManager: SessionManager.create(cwd, path.join(runtime.runDirectory, "sessions")),
        customTools: createOrchestratorTools(runtime),
      });
      sessions.add(session);
      return session;
    },
    async resume(runtime: AgentRuntime) {
      const { roles } = await loadAgentConfig(agentsFile);
      const resumed = await AgentRuntime.resume({
        cwd, modelsFile, roles, runDirectory: runtime.runDirectory,
      });
      runtimes.push(resumed.runtime);
      return resumed;
    },
    async session(role: AgentRole = "orchestrator", manager = SessionManager.create(cwd, path.join(cwd, "sessions")), customTools?: ToolDefinition[]) {
      const { roles } = await loadAgentConfig(agentsFile);
      const session = await createRoleSession({
        cwd, modelsFile, role, roles, sessionManager: manager, customTools,
      });
      sessions.add(session);
      return session;
    },
    async closeSession(session: AgentSession) {
      try { await session.abort(); } finally { session.dispose(); sessions.delete(session); }
    },
    async bridge(state: string, message: Record<string, unknown>, containerId: string, resume = false) {
      const child = spawn(process.execPath, [
        "--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, path.resolve("src/container-bridge.ts"),
        "--models", modelsFile, "--agents", agentsFile, "--state", state, ...(resume ? ["--resume"] : []),
      ], { cwd, windowsHide: true, env: { ...process.env, PIMAS_CONTAINER_ID: containerId }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.stdin.end(JSON.stringify(message) + "\n");
      const timer = setTimeout(() => child.kill(), 25_000);
      try {
        const [code] = await once(child, "close");
        return { code, stdout, stderr };
      } finally { clearTimeout(timer); child.kill(); }
    },
    async cli(...args: string[]) {
      const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
        cwd: process.cwd(),
        windowsHide: true,
        env: {
          ...process.env,
          TSX_DISABLE_CACHE: "1",
          PIMAS_CWD: cwd,
          PIMAS_MODEL: "must-not-be-selected",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const timer = setTimeout(() => child.kill(), 25_000);
      try {
        const [code] = await once(child, "close");
        return { code, stdout, stderr };
      } finally {
        clearTimeout(timer);
        child.kill();
      }
    },
  };
}

function sendReply(response: ServerResponse, reply: Exclude<Reply, { error: string } | { hang: true }>, id: number) {
  const delta = "tool" in reply
    ? {
      role: "assistant",
      tool_calls: [{
        index: 0, id: `call_${id}`, type: "function",
        function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
      }],
    }
    : { role: "assistant", content: reply.text };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [content, reason] of [[delta, null], [{}, "tool" in reply ? "tool_calls" : "stop"]]) {
    response.write(`data: ${JSON.stringify({
      id: `chat_${id}`, object: "chat.completion.chunk", created: 1, model: "scripted-model",
      choices: [{ index: 0, delta: content, finish_reason: reason }],
    })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({
    id: `chat_${id}`, object: "chat.completion.chunk", created: 1, model: "scripted-model",
    choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

const TIMEOUT = { timeout: 40_000 };

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type ToolResult = Extract<AgentSession["messages"][number], { role: "toolResult" }>;

function toolResults(session: AgentSession, toolName: string): ToolResult[] {
  return session.messages.filter(
    (message): message is ToolResult => message.role === "toolResult" && message.toolName === toolName,
  );
}

test("fresh CLI prints usage without contacting a model or creating run storage", TIMEOUT, async (t) => {
  const app = await fixture(t, () => { throw new Error("Usage must not call the model"); });
  const result = await app.cli();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage: npm start/);
  assert.match(result.stdout, /no delegation or run resume yet/);
  assert.equal(app.requests.length, 0);
  await assert.rejects(access(path.join(app.cwd, "data", "runs")), { code: "ENOENT" });
});

test("CLI requires an explicit models path instead of discovering a file", TIMEOUT, async (t) => {
  const app = await fixture(t, () => { throw new Error("Missing configuration must not call the model"); });
  const result = await app.cli("Inspect the project");
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Provide --models <file>/);
  assert.equal(app.requests.length, 0);
});

test("CLI also requires an explicit agents file", TIMEOUT, async (t) => {
  const app = await fixture(t, () => { throw new Error("Missing roles must not call the model"); });
  const result = await app.cli("--models", app.modelsFile, "Inspect");
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Provide --agents <file>/);
  assert.equal(app.requests.length, 0);
});

test("role configuration selects the provider, thinking level, and custom Markdown prompt", TIMEOUT, async (t) => {
  const app = await fixture(t, (request) => {
    assert.equal(request.model, "scripted-model");
    assert.equal(request.reasoning_effort, "high");
    assert.match(JSON.stringify(request.messages), /CUSTOM_ROLE_PROMPT/);
    assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ["find", "grep", "ls", "read"]);
    return { text: "Used the configured profile." };
  });
  const models = JSON.parse(await readFile(app.modelsFile, "utf8"));
  models.providers["fixture-provider"].models[0].reasoning = true;
  models.providers["fixture-provider"].models[0].compat.supportsReasoningEffort = true;
  await writeFile(app.modelsFile, JSON.stringify(models));
  const agents = JSON.parse(await readFile(app.agentsFile, "utf8"));
  agents.roles.orchestrator.thinkingLevel = "high";
  agents.roles.orchestrator.systemPrompt = "custom.md";
  await writeFile(path.join(app.cwd, "custom.md"), "CUSTOM_ROLE_PROMPT: Inspect without modifying files.");
  await writeFile(app.agentsFile, JSON.stringify(agents));
  const result = await app.cli(...app.cliFlags, "Inspect");
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Model: fixture-provider\/scripted-model · thinking: high/);
  assert.doesNotMatch(result.stderr, /Warning: requested thinking/);
  assert.equal(app.requests.length, 1);
});

test("CLI reports when model capabilities clamp the requested thinking level", TIMEOUT, async (t) => {
  const app = await fixture(t, () => ({ text: "Thinking is unavailable on this model." }));
  const agents = JSON.parse(await readFile(app.agentsFile, "utf8"));
  agents.roles.orchestrator.thinkingLevel = "high";
  await writeFile(app.agentsFile, JSON.stringify(agents));
  const result = await app.cli(...app.cliFlags, "Inspect");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Warning: requested thinking level high was limited to off/);
  assert.equal(app.requests.length, 1);
});

test("missing or invalid model files fail without exposing config values", TIMEOUT, async (t) => {
  const app = await fixture(t, () => { throw new Error("Invalid configuration must not call the model"); });
  const missing = await app.cli("--agents", app.agentsFile, "--models", path.join(app.cwd, "missing.json"), "Inspect");
  assert.equal(missing.code, 1, missing.stderr);
  assert.match(missing.stderr, /ENOENT/);

  await writeFile(app.modelsFile, '{"providers": {"pimas": {"apiKey": "SENSITIVE_VALUE_DO_NOT_PRINT"');
  const malformed = await app.cli(...app.cliFlags, "Inspect");
  assert.equal(malformed.code, 1, malformed.stderr);
  assert.match(malformed.stderr, /Invalid models configuration/);
  assert.doesNotMatch(malformed.stderr + malformed.stdout, /SENSITIVE_VALUE_DO_NOT_PRINT/);

  await writeFile(app.modelsFile, JSON.stringify({ providers: { pimas: { apiKey: 123 } } }));
  const invalidSchema = await app.cli(...app.cliFlags, "Inspect");
  assert.equal(invalidSchema.code, 1, invalidSchema.stderr);
  assert.match(invalidSchema.stderr, /Invalid models configuration/);
  assert.equal(app.requests.length, 0);
});

test("fresh CLI reads a project file with only read tools and persists its conversation", TIMEOUT, async (t) => {
  const app = await fixture(t, (request, count) => {
    assert.equal(request.model, "scripted-model");
    assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ["find", "grep", "ls", "read"]);
    assert.doesNotMatch(JSON.stringify(request), /AMBIENT_INSTRUCTIONS/);
    if (count === 1) return { tool: "read", args: { path: "notes.txt" } };
    const reply = request.messages.find((message) => message.role === "tool");
    assert.match(JSON.stringify(reply), /Use GET \/api\/items/);
    return { text: "The project specifies GET /api/items. No implementation or review was performed." };
  });
  await writeFile(path.join(app.cwd, "notes.txt"), "Use GET /api/items");
  await mkdir(path.join(app.cwd, ".pi"), { recursive: true });
  await writeFile(path.join(app.cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["write"] }));
  await writeFile(path.join(app.cwd, ".pi", "APPEND_SYSTEM.md"), "AMBIENT_INSTRUCTIONS");
  await writeFile(path.join(app.cwd, "AGENTS.md"), "AMBIENT_INSTRUCTIONS");

  const result = await app.cli(...app.cliFlags, "Read notes.txt and explain the interface");
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Orchestrator > The project specifies GET \/api\/items/);
  assert.match(result.stderr, /delegation and run resume are not implemented/);
  assert.equal(app.requests.length, 2);
  assert.equal(await readFile(path.join(app.cwd, "notes.txt"), "utf8"), "Use GET /api/items");

  const runsDirectory = path.join(app.cwd, "data", "runs");
  const runs = await readdir(runsDirectory);
  assert.equal(runs.length, 1);
  const sessionDirectory = path.join(runsDirectory, runs[0]!, "sessions");
  const logs = await readdir(sessionDirectory);
  assert.equal(logs.length, 1);
  const sessionFile = path.join(sessionDirectory, logs[0]!);
  assert.ok(result.stderr.includes(sessionFile), "CLI must show the saved-session location");
  const transcript = await readFile(sessionFile, "utf8");
  assert.doesNotMatch(transcript, /test-secret/);
  const history = SessionManager.open(sessionFile).buildSessionContext().messages;
  assert.ok(history.some((message) => message.role === "user" && JSON.stringify(message).includes("Read notes.txt")));
  assert.ok(history.some((message) => message.role === "toolResult" && message.toolName === "read"));
  assert.equal(history.at(-1)?.role, "assistant");
});

test("independent Pi histories can be closed, reopened, and continued", TIMEOUT, async (t) => {
  const app = await fixture(t, (request, count) => {
    if (count === 3) {
      const context = JSON.stringify(request.messages);
      assert.match(context, /My word is alpha/);
      assert.match(context, /Remembered alpha/);
      assert.doesNotMatch(context, /My word is beta/);
      return { text: "Your word is alpha." };
    }
    return { text: count === 1 ? "Remembered alpha." : "Remembered beta." };
  });
  const first = await app.session();
  const second = await app.session();
  assert.notEqual(first.sessionFile, second.sessionFile);
  assert.deepEqual(first.getActiveToolNames().sort(), ["find", "grep", "ls", "read"]);
  const prompt = (await readFile(new URL("../prompts/orchestrator.md", import.meta.url), "utf8")).trim();
  assert.ok(first.systemPrompt.includes(prompt), "The application Markdown file must supply the system prompt");
  assert.equal(first.settingsManager.getRetryEnabled(), false);
  assert.equal(first.settingsManager.getProviderRetrySettings().maxRetries, 100);
  assert.equal(first.settingsManager.getCompactionEnabled(), true);
  assert.equal(first.settingsManager.getCacheWarmingMode(), "off");

  await first.prompt("My word is alpha");
  await second.prompt("My word is beta");
  const file = first.sessionFile!;
  await app.closeSession(first);
  const restored = await app.session("orchestrator", SessionManager.open(file));
  await restored.prompt("What is my word?");
  assert.equal(restored.getLastAssistantText(), "Your word is alpha.");
  assert.equal(second.getLastAssistantText(), "Remembered beta.");
  const saved = await readFile(file, "utf8");
  assert.match(saved, /Your word is alpha/);
  assert.doesNotMatch(saved, /test-secret/);
});

test("orchestrator and planner use their own profiles and isolated persisted conversations", TIMEOUT, async (t) => {
  const app = await fixture(t, (request) => {
    const context = JSON.stringify(request.messages);
    assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ["find", "grep", "ls", "read"]);
    if (request.model === "planner-model") {
      assert.equal(request.reasoning_effort, "high");
      assert.match(context, /You are a planning agent/);
      assert.match(context, /PLANNER_ONLY_CONTEXT/);
      assert.doesNotMatch(context, /ORCHESTRATOR_ONLY_CONTEXT/);
      return { text: "Planner findings." };
    }
    assert.equal(request.model, "scripted-model");
    assert.match(context, /You are the orchestrator/);
    assert.match(context, /ORCHESTRATOR_ONLY_CONTEXT/);
    assert.doesNotMatch(context, /PLANNER_ONLY_CONTEXT/);
    return { text: "Orchestrator findings." };
  });
  const models = JSON.parse(await readFile(app.modelsFile, "utf8"));
  const plannerProvider = structuredClone(models.providers["fixture-provider"]);
  plannerProvider.models[0].id = "planner-model";
  plannerProvider.models[0].reasoning = true;
  plannerProvider.models[0].compat.supportsReasoningEffort = true;
  models.providers["planner-provider"] = plannerProvider;
  await writeFile(app.modelsFile, JSON.stringify(models));
  const agents = JSON.parse(await readFile(app.agentsFile, "utf8"));
  agents.roles.planner.provider = "planner-provider";
  agents.roles.planner.model = "planner-model";
  agents.roles.planner.thinkingLevel = "high";
  await writeFile(app.agentsFile, JSON.stringify(agents));

  const orchestrator = await app.session("orchestrator");
  const planner = await app.session("planner");
  assert.equal(orchestrator.model?.provider, "fixture-provider");
  assert.equal(orchestrator.model?.id, "scripted-model");
  assert.equal(orchestrator.thinkingLevel, "off");
  assert.equal(planner.model?.provider, "planner-provider");
  assert.equal(planner.model?.id, "planner-model");
  assert.equal(planner.thinkingLevel, "high");
  const plannerPrompt = (await readFile(agents.roles.planner.systemPrompt, "utf8")).trim();
  assert.ok(planner.systemPrompt.includes(plannerPrompt));
  assert.notEqual(orchestrator.sessionFile, planner.sessionFile);
  assert.deepEqual(planner.getActiveToolNames().sort(), ["find", "grep", "ls", "read"]);
  assert.equal(planner.settingsManager.getProviderRetrySettings().maxRetries, 100);
  assert.equal(planner.settingsManager.getCompactionEnabled(), true);

  await orchestrator.prompt("ORCHESTRATOR_ONLY_CONTEXT");
  await planner.prompt("PLANNER_ONLY_CONTEXT");
  assert.equal(orchestrator.getLastAssistantText(), "Orchestrator findings.");
  assert.equal(planner.getLastAssistantText(), "Planner findings.");
  const orchestratorHistory = await readFile(orchestrator.sessionFile!, "utf8");
  const plannerHistory = await readFile(planner.sessionFile!, "utf8");
  assert.match(orchestratorHistory, /ORCHESTRATOR_ONLY_CONTEXT/);
  assert.doesNotMatch(orchestratorHistory, /PLANNER_ONLY_CONTEXT/);
  assert.match(plannerHistory, /PLANNER_ONLY_CONTEXT/);
  assert.doesNotMatch(plannerHistory, /ORCHESTRATOR_ONLY_CONTEXT|test-secret/);
  assert.equal(app.requests.length, 2);
});

test("executor and reviewer sessions remain disabled", TIMEOUT, async (t) => {
  const app = await fixture(t, () => { throw new Error("Disabled roles must not call the model"); });
  for (const role of ["executor", "reviewer"] as const) {
    await assert.rejects(app.session(role), /Only orchestrator and planner sessions are enabled/);
  }
  assert.equal(app.requests.length, 0);
});

test("the orchestrator spawns a planner asynchronously and collects its report", TIMEOUT, async (t) => {
  const app = await fixture(t, (request) => {
    const context = JSON.stringify(request.messages);
    if (context.includes("You are a planning agent")) {
      assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ["ask_orchestrator", "find", "grep", "ls", "read"]);
      assert.match(context, /Inspect notes.txt and report the interface/);
      assert.doesNotMatch(context, /ORCHESTRATOR_PRIVATE_CONTEXT/);
      if (!request.messages.some((message) => message.role === "tool")) {
        return { tool: "read", args: { path: "notes.txt" } };
      }
      assert.match(context, /Use GET \/api\/items/);
      return { text: "Planner findings: GET /api/items is the specified interface." };
    }
    assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ["answer_worker", "find", "grep", "ls", "read", "resume_agent", "spawn_agent", "wait_for_agents"]);
    if (!request.messages.some((message) => message.role === "tool")) {
      return { tool: "spawn_agent", args: { role: "planner", assignment: "Inspect notes.txt and report the interface" } };
    }
    if (context.includes("settled:")) {
      assert.match(context, /Planner findings: GET \/api\/items/);
      return { text: "The planner found GET /api/items. No changes were made." };
    }
    assert.match(context, /Spawned planner agent-1/);
    assert.doesNotMatch(context, /Planner findings/);
    return { tool: "wait_for_agents", args: {} };
  });
  await writeFile(path.join(app.cwd, "notes.txt"), "Use GET /api/items");
  const runtime = await app.runtime();
  const orchestrator = await app.orchestratorFor(runtime);
  await orchestrator.prompt("ORCHESTRATOR_PRIVATE_CONTEXT: commission an investigation.");
  assert.equal(orchestrator.getLastAssistantText(), "The planner found GET /api/items. No changes were made.");
  const spawn = orchestrator.messages.find((message) => message.role === "toolResult" && message.toolName === "spawn_agent");
  assert.ok(spawn?.role === "toolResult");
  assert.equal(spawn.isError, false);
  assert.match(JSON.stringify(spawn.content), /Spawned planner agent-1/);
  assert.equal((spawn.details as { agentId: string }).agentId, "agent-1");
  const collected = orchestrator.messages.find((message) => message.role === "toolResult" && message.toolName === "wait_for_agents");
  assert.ok(collected?.role === "toolResult");
  assert.equal(collected.isError, false);
  assert.equal(collected.usage?.input, 20);
  assert.equal(collected.usage?.output, 4);
  assert.equal(collected.usage?.totalTokens, 24);
  const details = collected.details as { sessionFile: string; role: string; report: string };
  assert.equal(details.role, "planner");
  assert.match(details.report, /Planner findings/);
  assert.notEqual(details.sessionFile, orchestrator.sessionFile);
  assert.equal(path.dirname(details.sessionFile), path.dirname(orchestrator.sessionFile!));
  const plannerHistory = await readFile(details.sessionFile, "utf8");
  assert.match(plannerHistory, /Inspect notes.txt and report the interface/);
  assert.match(plannerHistory, /Planner findings/);
  assert.doesNotMatch(plannerHistory, /ORCHESTRATOR_PRIVATE_CONTEXT|test-secret/);
  assert.equal((await readdir(path.dirname(details.sessionFile))).length, 2);
  assert.equal(app.requests.length, 5);
});

test("failed and empty planner reports arrive as failed wait results", TIMEOUT, async (t) => {
  for (const scenario of ["provider failure", "empty report"] as const) {
    await t.test(scenario, async (t) => {
      const app = await fixture(t, (request) => {
        if (JSON.stringify(request.messages).includes("You are a planning agent")) {
          return scenario === "provider failure"
            ? { error: "Planner authentication rejected", status: 401 }
            : { text: "" };
        }
        const context = JSON.stringify(request.messages);
        if (!request.messages.some((message) => message.role === "tool")) {
          return { tool: "spawn_agent", args: { role: "planner", assignment: "Investigate the project" } };
        }
        if (context.includes("failed:")) {
          return { text: "The planner failed; its findings are unavailable." };
        }
        return { tool: "wait_for_agents", args: {} };
      });
      const runtime = await app.runtime();
      const orchestrator = await app.orchestratorFor(runtime);
      await orchestrator.prompt("Request a planner investigation");
      const collected = orchestrator.messages.find((message) => message.role === "toolResult" && message.toolName === "wait_for_agents");
      assert.ok(collected?.role === "toolResult");
      assert.equal(collected.isError, true);
      assert.match(JSON.stringify(collected.content), scenario === "provider failure"
        ? /Planner authentication rejected/
        : /returned an empty answer/);
      const details = collected.details as { sessionFile: string };
      assert.ok(await readFile(details.sessionFile, "utf8"));
      assert.equal(app.requests.length, 4);
    });
  }
});

test("aborting the orchestrator stops its wait, and dispose aborts live agents", TIMEOUT, async (t) => {
  let notifyPlanner!: () => void;
  const plannerStarted = new Promise<void>((resolve) => { notifyPlanner = resolve; });
  const app = await fixture(t, (request) => {
    if (JSON.stringify(request.messages).includes("You are a planning agent")) {
      notifyPlanner();
      return { hang: true };
    }
    if (!request.messages.some((message) => message.role === "tool")) {
      return { tool: "spawn_agent", args: { role: "planner", assignment: "Wait for the planner model" } };
    }
    return { tool: "wait_for_agents", args: {} };
  });
  const runtime = await app.runtime();
  const orchestrator = await app.orchestratorFor(runtime);
  const work = orchestrator.prompt("Start a planner").catch((error: unknown) => error);
  await plannerStarted;
  await orchestrator.abort();
  await work;
  assert.equal(orchestrator.isIdle, true);
  await runtime.dispose();
  const directory = path.dirname(orchestrator.sessionFile!);
  const files = await readdir(directory);
  assert.equal(files.length, 2);
  const plannerFile = files.map((file) => path.join(directory, file)).find((file) => file !== orchestrator.sessionFile);
  assert.ok(plannerFile);
  const history = SessionManager.open(plannerFile).buildSessionContext().messages;
  assert.ok(history.some((message) => message.role === "user" && JSON.stringify(message).includes("Wait for the planner model")));
  const last = history.at(-1);
  assert.ok(last?.role === "assistant");
  assert.equal(last.stopReason, "aborted");
  assert.equal(app.requests.length, 3);
  const checkpoint = JSON.parse(await readFile(path.join(runtime.runDirectory, "run.json"), "utf8"));
  const [interrupted] = checkpoint.agents;
  assert.equal(interrupted.status, "interrupted");
  assert.ok(interrupted.sessionFile);
});

test("the runtime rejects spawning an orchestrator, an empty assignment, or a disabled role", TIMEOUT, async (t) => {
  const app = await fixture(t, () => { throw new Error("Invalid spawns must not call the model"); });
  const runtime = await app.runtime();
  await assert.rejects(runtime.spawn("orchestrator", "Do everything"), /cannot spawn another orchestrator/);
  await assert.rejects(runtime.spawn("planner", "   "), /must not be empty/);
  await assert.rejects(runtime.spawn("executor", "Edit a file"), /Only orchestrator and planner sessions are enabled/);
  assert.equal(app.requests.length, 0);
});

test("a planner's question reaches the orchestrator and its answer resumes the planner", TIMEOUT, async (t) => {
  const app = await fixture(t, (request) => {
    const context = JSON.stringify(request.messages);
    if (context.includes("You are a planning agent")) {
      assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ["ask_orchestrator", "find", "grep", "ls", "read"]);
      if (context.includes("/api/v2/items")) {
        assert.match(context, /Yes: use \/api\/v2\/items/);
        return { text: "Planner plan: use the versioned endpoint the orchestrator confirmed." };
      }
      return { tool: "ask_orchestrator", args: { question: "Should the endpoint be versioned?" } };
    }
    if (!request.messages.some((message) => message.role === "tool")) {
      return { tool: "spawn_agent", args: { role: "planner", assignment: "Propose the interface" } };
    }
    if (context.includes("Answered agent-1.")) {
      if (context.includes("settled:")) return { text: "The planner proposed the versioned endpoint." };
      if (context.includes("failed:")) return { text: "The planner failed after its question was answered." };
      return { tool: "wait_for_agents", args: {} };
    }
    if (context.includes("asks:")) {
      assert.match(context, /Should the endpoint be versioned\?/);
      return { tool: "answer_worker", args: { agentId: "agent-1", answer: "Yes: use /api/v2/items." } };
    }
    return { tool: "wait_for_agents", args: {} };
  });
  const runtime = await app.runtime();
  const orchestrator = await app.orchestratorFor(runtime);
  await orchestrator.prompt("Commission an interface plan.");
  const waits = toolResults(orchestrator, "wait_for_agents");
  assert.equal(waits.length, 2);
  assert.equal((waits[0]?.details as { type: string }).type, "question");
  assert.match(JSON.stringify(waits[0]?.content), /asks: Should the endpoint be versioned\?/);
  assert.equal((waits[1]?.details as { type: string }).type, "settled");
  assert.match(JSON.stringify(waits[1]?.content), /versioned endpoint the orchestrator confirmed/);
  const answered = orchestrator.messages.find((message) => message.role === "toolResult" && message.toolName === "answer_worker");
  assert.ok(answered?.role === "toolResult");
  assert.match(JSON.stringify(answered.content), /Answered agent-1/);
  assert.equal(orchestrator.getLastAssistantText(), "The planner proposed the versioned endpoint.");
  assert.equal(app.requests.length, 7);
  const checkpoint = JSON.parse(await readFile(path.join(runtime.runDirectory, "run.json"), "utf8"));
  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.cwd, app.cwd);
  assert.equal(checkpoint.modelsFile, app.modelsFile);
  assert.equal(checkpoint.agents.length, 1);
  const [agent] = checkpoint.agents;
  assert.equal(agent.id, "agent-1");
  assert.equal(agent.role, "planner");
  assert.equal(agent.assignment, "Propose the interface");
  assert.equal(agent.status, "settled");
  assert.equal(agent.question, "Should the endpoint be versioned?");
  assert.equal(agent.answer, "Yes: use /api/v2/items.");
  assert.match(agent.report, /versioned endpoint/);
  assert.ok(agent.sessionFile);
  await runtime.dispose();
  const resumed = await app.resume(runtime);
  assert.match(resumed.summary, /agent-1 \(planner\) settled/);
  assert.match(resumed.summary, /versioned endpoint/);
  await assert.rejects(resumed.runtime.resumeAgent("agent-1"), /not available to resume/);
});

test("an unanswered question produces a pause notification", TIMEOUT, async (t) => {
  const app = await fixture(t, (request) => {
    const context = JSON.stringify(request.messages);
    if (context.includes("You are a planning agent")) {
      return { tool: "ask_orchestrator", args: { question: "Which file should I change?" } };
    }
    if (!request.messages.some((message) => message.role === "tool")) {
      return { tool: "spawn_agent", args: { role: "planner", assignment: "Ask before planning" } };
    }
    if (context.includes("is paused")) {
      return { text: "The planner is paused; I will answer it later." };
    }
    return { tool: "wait_for_agents", args: {} };
  });
  const runtime = await app.runtime(50);
  const orchestrator = await app.orchestratorFor(runtime);
  await orchestrator.prompt("Spawn a planner and wait.");
  const waits = toolResults(orchestrator, "wait_for_agents");
  assert.equal(waits.length, 2);
  assert.equal((waits[0]?.details as { type: string }).type, "question");
  assert.equal((waits[1]?.details as { type: string }).type, "paused");
  assert.match(JSON.stringify(waits[1]?.content), /is paused/);
  assert.equal(app.requests.length, 5);
  const directory = path.dirname(orchestrator.sessionFile!);
  const plannerFile = (await readdir(directory)).map((file) => path.join(directory, file)).find((file) => file !== orchestrator.sessionFile);
  assert.ok(plannerFile);
  const messages = SessionManager.open(plannerFile).buildSessionContext().messages;
  const ask = messages.at(-1);
  assert.ok(ask?.role === "assistant");
  assert.ok(ask.content.some((part) => part.type === "toolCall" && part.name === "ask_orchestrator"));
  assert.ok(!messages.some((message) => message.role === "toolResult" && message.toolName === "ask_orchestrator"));
  const checkpoint = JSON.parse(await readFile(path.join(runtime.runDirectory, "run.json"), "utf8"));
  const [pausedAgent] = checkpoint.agents;
  assert.equal(pausedAgent.status, "waiting");
  assert.equal(pausedAgent.question, "Which file should I change?");
  assert.equal(pausedAgent.answer, undefined);
});

test("questions are pushed to an idle orchestrator as messages", TIMEOUT, async (t) => {
  const app = await fixture(t, (request) => {
    const context = JSON.stringify(request.messages);
    if (context.includes("You are a planning agent")) {
      return { tool: "ask_orchestrator", args: { question: "Which directory holds the sources?" } };
    }
    if (!request.messages.some((message) => message.role === "tool")) {
      return { tool: "spawn_agent", args: { role: "planner", assignment: "Find the sources" } };
    }
    return { text: "Noted the planner message." };
  });
  const runtime = await app.runtime(50);
  const orchestrator = await app.orchestratorFor(runtime);
  runtime.setNotifier((text) => {
    void orchestrator.sendUserMessage(text, { deliverAs: "followUp" }).catch(() => {});
  });
  await orchestrator.prompt("Spawn a planner.");
  await waitFor(() => app.requests.length === 5);
  await orchestrator.waitForIdle();
  const injected = orchestrator.messages.filter((message) => message.role === "user" && JSON.stringify(message).includes("planner"));
  assert.ok(injected.some((message) => JSON.stringify(message).includes("Which directory holds the sources?")));
  assert.ok(injected.some((message) => JSON.stringify(message).includes("is paused")));
  assert.equal(orchestrator.getLastAssistantText(), "Noted the planner message.");
});

test("resume marks live agents interrupted and continues their conversation", TIMEOUT, async (t) => {
  let plannerCalls = 0;
  const app = await fixture(t, (request) => {
    if (JSON.stringify(request.messages).includes("You are a planning agent")) {
      plannerCalls += 1;
      return plannerCalls === 1 ? { hang: true } : { text: "Recovered planner report after resume." };
    }
    if (!request.messages.some((message) => message.role === "tool")) {
      return { tool: "spawn_agent", args: { role: "planner", assignment: "Investigate the saved run" } };
    }
    return { tool: "wait_for_agents", args: {} };
  });
  const runtime = await app.runtime();
  const orchestrator = await app.orchestratorFor(runtime);
  const work = orchestrator.prompt("Start a planner").catch((error: unknown) => error);
  await waitFor(() => app.requests.length >= 2);
  await orchestrator.abort();
  await work;
  await runtime.dispose();

  const runFile = path.join(runtime.runDirectory, "run.json");
  const before = JSON.parse(await readFile(runFile, "utf8"));
  assert.equal(before.agents[0].status, "interrupted");
  assert.ok(before.agents[0].sessionFile);

  const resumed = await app.resume(runtime);
  assert.match(resumed.summary, /agent-1 \(planner\) interrupted/);
  assert.match(resumed.summary, /Investigate the saved run/);

  await resumed.runtime.resumeAgent("agent-1", "Report what you have so far.");
  const event = await resumed.runtime.next();
  assert.ok(event?.type === "settled");
  assert.match(event.report, /Recovered planner report after resume/);

  const history = await readFile(before.agents[0].sessionFile, "utf8");
  assert.match(history, /Investigate the saved run/);
  assert.match(history, /Report what you have so far/);
  assert.match(history, /Recovered planner report after resume/);
  const after = JSON.parse(await readFile(runFile, "utf8"));
  assert.equal(after.agents[0].status, "settled");
  assert.match(after.agents[0].report, /Recovered planner report/);
});

test("resume rejects missing, malformed, or unsupported run.json", TIMEOUT, async (t) => {
  const app = await fixture(t, () => { throw new Error("Resume validation must not call the model"); });
  const { roles } = await loadAgentConfig(app.agentsFile);
  const base = { cwd: app.cwd, modelsFile: app.modelsFile, roles };
  const missing = await mkdtemp(path.join(app.cwd, "run-"));
  await assert.rejects(AgentRuntime.resume({ ...base, runDirectory: missing }), /No run.json found/);
  const malformed = await mkdtemp(path.join(app.cwd, "run-"));
  await writeFile(path.join(malformed, "run.json"), "{ not json");
  await assert.rejects(AgentRuntime.resume({ ...base, runDirectory: malformed }), /not valid JSON/);
  const unsupported = await mkdtemp(path.join(app.cwd, "run-"));
  await writeFile(path.join(unsupported, "run.json"), JSON.stringify({ version: 99 }));
  await assert.rejects(AgentRuntime.resume({ ...base, runDirectory: unsupported }), /Unsupported run.json version: 99/);
  const invalidAgent = await mkdtemp(path.join(app.cwd, "run-"));
  await writeFile(path.join(invalidAgent, "run.json"), JSON.stringify({
    version: 1, runId: "run-1", cwd: app.cwd, modelsFile: app.modelsFile,
    agents: [{ id: "agent-1", role: "planner", assignment: "x", status: "unknown" }],
  }));
  await assert.rejects(AgentRuntime.resume({ ...base, runDirectory: invalidAgent }), /Invalid run.json/);
  assert.equal(app.requests.length, 0);
});

test("cancelled runtime waits cannot swallow later questions", TIMEOUT, async (t) => {
  const app = await fixture(t, () => ({ hang: true }));
  const runtime = await app.runtime();
  const id = await runtime.spawn("planner", "Wait for cancellation test");
  await app.receivedRequest;
  const controller = new AbortController();
  const abandoned = runtime.next(undefined, controller.signal);
  controller.abort();
  await assert.rejects(abandoned, /Wait aborted/);
  const answer = runtime.ask(id, "Still deliver this question", undefined);
  const event = await runtime.next();
  assert.equal(event?.type, "question");
  assert.equal(event?.agentId, id);
  await runtime.answer(id, "Continue");
  assert.equal(await answer, "Continue");
});

test("headless tasks persist the orchestrator before execution and never rerun completed work", TIMEOUT, async (t) => {
  const app = await fixture(t, (request) => {
    assert.match(JSON.stringify(request.messages), /ORIGINAL_AUTONOMOUS_TASK/);
    return { text: "Autonomous task report." };
  });
  const task = await app.task("ORIGINAL_AUTONOMOUS_TASK");
  const file = path.join(task.directory, "run.json");
  const before = JSON.parse(await readFile(file, "utf8"));
  assert.equal(before.request, "ORIGINAL_AUTONOMOUS_TASK");
  assert.equal(before.orchestrator.status, "ready");
  assert.match(await readFile(before.orchestrator.sessionFile, "utf8"), /ORIGINAL_AUTONOMOUS_TASK/);
  assert.equal(app.requests.length, 0);
  await task.dispose();
  const resumedBeforeLaunch = await app.resumeTask(task.directory);
  assert.equal(await resumedBeforeLaunch.execute(), "Autonomous task report.");
  await resumedBeforeLaunch.dispose();
  const completed = JSON.parse(await readFile(file, "utf8"));
  assert.equal(completed.orchestrator.sessionFile, before.orchestrator.sessionFile);
  assert.equal(completed.orchestrator.status, "settled");
  const calls = app.requests.length;
  const resumed = await app.resumeTask(task.directory);
  assert.equal(await resumed.execute(), "Autonomous task report.");
  assert.equal(app.requests.length, calls);
});

test("headless recovery preserves the orchestrator and resumes a worker interrupted on a question", TIMEOUT, async (t) => {
  const app = await fixture(t, (request) => {
    const context = JSON.stringify(request.messages);
    if (context.includes("You are a planning agent")) {
      return context.includes("Use /v2/items")
        ? { text: "Recovered worker inspected /v2/items." }
        : { tool: "ask_orchestrator", args: { question: "Which endpoint should I inspect?" } };
    }
    if (context.includes("authoritative workflow state")) {
      if (!context.includes('"Resumed agent-1.')) {
        return { tool: "resume_agent", args: { agentId: "agent-1", instruction: "Use /v2/items and report." } };
      }
      if (!context.includes("settled:")) return { tool: "wait_for_agents", args: {} };
      return { text: "Recovered autonomous task completed." };
    }
    if (!context.includes("Spawned planner")) {
      return { tool: "spawn_agent", args: { role: "planner", assignment: "Inspect the task endpoint" } };
    }
    if (!context.includes("asks:")) return { tool: "wait_for_agents", args: {} };
    return { hang: true };
  });
  const task = await app.task("Investigate the API autonomously; prefer /v2/items.");
  const work = task.execute().catch((error: unknown) => error);
  await waitFor(() => app.requests.some((request) => JSON.stringify(request.messages).includes("asks:")));
  const file = path.join(task.directory, "run.json");
  const waiting = JSON.parse(await readFile(file, "utf8"));
  assert.equal(waiting.orchestrator.status, "running");
  assert.equal(waiting.agents[0].status, "waiting");
  await task.dispose();
  assert.ok(await work instanceof Error);
  const stopped = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stopped.orchestrator.status, "interrupted");
  assert.equal(stopped.agents[0].status, "interrupted");
  // An unclean process exit leaves these live statuses, not dispose's markers.
  stopped.orchestrator.status = "running";
  stopped.agents[0].status = "waiting";
  await writeFile(file, JSON.stringify(stopped));
  const resumed = await app.resumeTask(task.directory);
  const recovered = JSON.parse(await readFile(file, "utf8"));
  assert.equal(recovered.orchestrator.status, "interrupted");
  assert.equal(recovered.agents[0].status, "interrupted");
  assert.equal(await resumed.execute(), "Recovered autonomous task completed.");
  const after = JSON.parse(await readFile(file, "utf8"));
  assert.equal(after.agents.length, 1);
  assert.equal(after.orchestrator.sessionFile, waiting.orchestrator.sessionFile);
  assert.equal(after.agents[0].sessionFile, waiting.agents[0].sessionFile);
  assert.equal(after.agents[0].status, "settled");
  const history = await readFile(after.orchestrator.sessionFile, "utf8");
  assert.match(history, /Investigate the API autonomously/);
  assert.match(history, /Which endpoint should I inspect/);
  assert.match(history, /authoritative workflow state/);
  assert.match(history, /Recovered autonomous task completed/);
  const worker = await readFile(after.agents[0].sessionFile, "utf8");
  assert.match(worker, /ask_orchestrator/);
  assert.match(worker, /Use \/v2\/items/);
});

test("headless recovery rejects identity mismatch and missing orchestrator history without inference", TIMEOUT, async (t) => {
  const app = await fixture(t, () => { throw new Error("Invalid recovery must not infer"); });
  const task = await app.task("Keep this task recoverable");
  await task.dispose();
  const file = path.join(task.directory, "run.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  const { roles } = await loadAgentConfig(app.agentsFile);
  await assert.rejects(TaskRun.resume({
    directory: task.directory, cwd: path.join(app.cwd, "different"), modelsFile: app.modelsFile, roles,
  }), /does not match/);
  assert.equal(await readFile(file, "utf8"), JSON.stringify(saved, null, 2));
  await rm(saved.orchestrator.sessionFile);
  await assert.rejects(app.resumeTask(task.directory), { code: "ENOENT" });
  assert.equal(app.requests.length, 0);
});

test("headless execution collects worker events even when the orchestrator stops without waiting", TIMEOUT, async (t) => {
  const app = await fixture(t, (request) => {
    const context = JSON.stringify(request.messages);
    if (context.includes("You are a planning agent")) return { text: "Background findings." };
    if (context.includes("Worker event (runtime data)")) return { text: "Task finished with background findings." };
    if (context.includes("Spawned planner")) return { text: "Waiting for background work." };
    return { tool: "spawn_agent", args: { role: "planner", assignment: "Inspect in background" } };
  });
  const task = await app.task("Collect background findings.");
  assert.equal(await task.execute(), "Task finished with background findings.");
  assert.ok(app.requests.some((request) => JSON.stringify(request.messages).includes("Background findings.")));
});

test("container bridge uses native reads and persists its attempt-bound orchestrator", TIMEOUT, async (t) => {
  const app = await fixture(t, (request) => JSON.stringify(request.messages).includes("BRIDGE_NATIVE_FILE")
    ? { text: "Bridge inspected the native task workspace." }
    : { tool: "read", args: { path: "bridge-input.txt" } });
  await writeFile(path.join(app.cwd, "bridge-input.txt"), "BRIDGE_NATIVE_FILE");
  const state = await mkdtemp(path.join(app.cwd, "mounted-state-"));
  await writeFile(path.join(state, "attempt.json"), JSON.stringify({ taskId: "bridge-test", attemptId: "attempt-1", containerId: "container-1" }));
  const message = { type: "task", task_id: "bridge-test", attempt_id: "attempt-1", container_id: "container-1", cwd: app.cwd, prompt: "Read bridge-input.txt and report." };
  const result = await app.bridge(state, message, "container-1");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '{"type":"done"}\n');
  const checkpoint = JSON.parse(await readFile(path.join(state, "run/run.json"), "utf8"));
  assert.equal(checkpoint.orchestrator.status, "settled");
  assert.match(await readFile(checkpoint.orchestrator.sessionFile, "utf8"), /BRIDGE_NATIVE_FILE/);
  const calls = app.requests.length;
  const resumed = await app.bridge(state, message, "container-1", true);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(app.requests.length, calls);
  const wrongContainer = await app.bridge(state, { ...message, container_id: "container-2" }, "container-2", true);
  assert.equal(wrongContainer.code, 1);
  assert.equal(wrongContainer.stdout, "");
  assert.match(wrongContainer.stderr, /identity does not match/);
});

test("container bridge rejects missing attempt identity before model calls", TIMEOUT, async (t) => {
  const app = await fixture(t, () => { throw new Error("Invalid bridge input must not infer"); });
  const state = await mkdtemp(path.join(app.cwd, "mounted-state-"));
  const result = await app.bridge(state, { type: "task", task_id: "x", cwd: app.cwd, prompt: "Inspect" }, "container-1");
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Expected one task message/);
  assert.equal(app.requests.length, 0);
});

test("a transient provider failure is retried successfully", TIMEOUT, async (t) => {
  const app = await fixture(t, (_request, count) => count === 1
    ? { error: "Scripted provider unavailable", status: 503 }
    : { text: "Recovered after a transient error." });
  const result = await app.cli(...app.cliFlags, "Inspect the project");
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Recovered after a transient error/);
  assert.equal(app.requests.length, 2);
});

test("non-retryable provider errors produce a failing CLI exit", TIMEOUT, async (t) => {
  const app = await fixture(t, () => ({ error: "Scripted authentication rejected", status: 401 }));
  const result = await app.cli(...app.cliFlags, "Inspect the project");
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /PiMAS error:.*Scripted authentication rejected/);
  assert.doesNotMatch(result.stdout, /Orchestrator >/);
  assert.equal(app.requests.length, 1);
});

test("empty final answers are failures rather than apparent success", TIMEOUT, async (t) => {
  const app = await fixture(t, () => ({ text: "" }));
  const result = await app.cli(...app.cliFlags, "Inspect the project");
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /empty answer/);
  assert.doesNotMatch(result.stdout, /Orchestrator >/);
});

test("input is saved before a response, and active Pi work can be aborted and disposed", TIMEOUT, async (t) => {
  const app = await fixture(t, () => ({ hang: true }));
  const session = await app.session();
  const work = session.prompt("Wait for the model").catch((error: unknown) => error);
  await app.receivedRequest;
  const saved = await readFile(session.sessionFile!, "utf8");
  assert.match(saved, /Wait for the model/);
  await session.abort();
  await work;
  assert.equal(session.isIdle, true);
  const last = session.messages.at(-1);
  assert.equal(last?.role, "assistant");
  if (last?.role === "assistant") assert.equal(last.stopReason, "aborted");
  assert.equal(app.requests.length, 1);
  await app.closeSession(session);
});
