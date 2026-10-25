import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createOrchestratorSession } from "../src/agent.js";

interface ChatRequest {
  model: string;
  messages: { role: string; content: unknown }[];
  tools: { function: { name: string } }[];
}

type Reply =
  | { text: string }
  | { tool: string; args: Record<string, unknown> }
  | { error: string }
  | { hang: true };

/** Exercise the real SDK/HTTP path, but never contact a real model. */
async function fixture(t: TestContext, respond: (request: ChatRequest, count: number) => Reply) {
  const dataDirectory = path.resolve("data");
  await mkdir(dataDirectory, { recursive: true });
  const cwd = await mkdtemp(path.join(dataDirectory, "fresh-test-"));
  const requests: ChatRequest[] = [];
  const sessions = new Set<AgentSession>();
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
        response.writeHead(503, { "content-type": "application/json" });
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

  return {
    cwd,
    requests,
    receivedRequest,
    async session(manager = SessionManager.create(cwd, path.join(cwd, "sessions"))) {
      const session = await createOrchestratorSession({
        cwd, baseUrl, modelId: "scripted-model", apiKey: "test-secret", sessionManager: manager,
      });
      sessions.add(session);
      return session;
    },
    async closeSession(session: AgentSession) {
      try { await session.abort(); } finally { session.dispose(); sessions.delete(session); }
    },
    async cli(...args: string[]) {
      const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
        cwd: process.cwd(),
        windowsHide: true,
        env: {
          ...process.env,
          TSX_DISABLE_CACHE: "1",
          PIMAS_CWD: cwd,
          PIMAS_BASE_URL: baseUrl,
          PIMAS_MODEL: "scripted-model",
          OPENAI_API_KEY: "test-secret",
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
  response.end("data: [DONE]\n\n");
}

const TIMEOUT = { timeout: 40_000 };

test("fresh CLI prints usage without contacting a model or creating run storage", TIMEOUT, async (t) => {
  const app = await fixture(t, () => { throw new Error("Usage must not call the model"); });
  const result = await app.cli();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage: npm start/);
  assert.match(result.stdout, /no delegation or run resume yet/);
  assert.equal(app.requests.length, 0);
  await assert.rejects(access(path.join(app.cwd, "data", "runs")), { code: "ENOENT" });
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

  const result = await app.cli("Read notes.txt and explain the interface");
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
  assert.match(first.systemPrompt, /cannot edit files, run commands, or delegate yet/);
  assert.equal(first.settingsManager.getRetryEnabled(), false);
  assert.equal(first.settingsManager.getProviderRetrySettings().maxRetries, 0);
  assert.equal(first.settingsManager.getCompactionEnabled(), false);
  assert.equal(first.settingsManager.getCacheWarmingMode(), "off");

  await first.prompt("My word is alpha");
  await second.prompt("My word is beta");
  const file = first.sessionFile!;
  await app.closeSession(first);
  const restored = await app.session(SessionManager.open(file));
  await restored.prompt("What is my word?");
  assert.equal(restored.getLastAssistantText(), "Your word is alpha.");
  assert.equal(second.getLastAssistantText(), "Remembered beta.");
  const saved = await readFile(file, "utf8");
  assert.match(saved, /Your word is alpha/);
  assert.doesNotMatch(saved, /test-secret/);
});

test("provider errors produce a failing CLI exit and are not retried", TIMEOUT, async (t) => {
  const app = await fixture(t, () => ({ error: "Scripted provider unavailable" }));
  const result = await app.cli("Inspect the project");
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /PiMAS error:.*Scripted provider unavailable/);
  assert.doesNotMatch(result.stdout, /Orchestrator >/);
  assert.equal(app.requests.length, 1);
});

test("empty final answers are failures rather than apparent success", TIMEOUT, async (t) => {
  const app = await fixture(t, () => ({ text: "" }));
  const result = await app.cli("Inspect the project");
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
