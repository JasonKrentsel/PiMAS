import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRoleSession } from "../src/agent.js";
import { loadAgentConfig, type AgentConfig } from "../src/agent-config.js";
import { runPipeline } from "../src/pipeline.js";
import { FileTracker, SNAPSHOT_DIR } from "../src/filesystem.js";
import { createWorkspaceTools, localWorkspace } from "../src/workspace.js";

interface ChatRequest {
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
}

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };
type Script = (stage: string, turn: number, request: ChatRequest) => Reply;

const TIMEOUT = { timeout: 40_000 };

/** Real SDK and HTTP path against a scripted model; the stage is inferred from its submit tool. */
async function fixture(t: TestContext, script: Script) {
  const dataDirectory = path.resolve("data");
  await mkdir(dataDirectory, { recursive: true });
  const root = await mkdtemp(path.join(dataDirectory, "pipeline-test-"));
  const workspaceDir = path.join(root, "app");
  await mkdir(workspaceDir);
  const requests: ChatRequest[] = [];
  let serverError: unknown;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatRequest;
      requests.push(body);
      const names = (body.tools ?? []).map((tool) => tool.function.name);
      const stage = names.includes("submit_findings") ? "research"
        : names.includes("submit_plan") ? "plan"
        : names.includes("submit_review") ? "review"
        : names.includes("begin_step") ? "execute"
        : names.includes("submit_report") ? "solve" : "other";
      const turn = body.messages.filter((message) => message.role === "assistant").length;
      sendReply(response, script(stage, turn, body), requests.length);
    })().catch((error: unknown) => {
      serverError = error;
      response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    if (serverError) throw serverError;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const modelsFile = path.join(root, "models.json");
  const models = JSON.parse(await readFile(new URL("../models.example.json", import.meta.url), "utf8"));
  models.providers.pimas.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  models.providers.pimas.models[0].id = "scripted-model";
  await writeFile(modelsFile, JSON.stringify(models));
  const config = await loadAgentConfig(path.resolve("agents.example.json"));
  const prompts = path.resolve("prompts/pipeline");
  const roles: AgentConfig["roles"] = {
    ...config.roles,
    researcher: { ...config.roles.planner, systemPrompt: path.join(prompts, "researcher.md") },
    planner: { ...config.roles.planner, systemPrompt: path.join(prompts, "planner.md") },
    executor: { ...config.roles.executor, systemPrompt: path.join(prompts, "executor.md") },
    reviewer: { ...config.roles.reviewer, systemPrompt: path.join(prompts, "reviewer.md") },
  };
  for (const profile of Object.values(roles)) profile.model = "scripted-model";
  const agentsFile = path.join(root, "agents.json");
  await writeFile(agentsFile, JSON.stringify({ roles }));
  return { root, workspaceDir, modelsFile, agentsFile, roles, requests, state: path.join(root, "state") };
}

function sendReply(response: ServerResponse, reply: Reply, id: number) {
  const delta = "tool" in reply
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }
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

/** A well-behaved run: each stage makes its tool calls, then submits, then says it is done. */
function happyPath(stage: string, turn: number, request: ChatRequest): Reply {
  const lastTool = [...request.messages].reverse().find((message) => message.role === "tool");
  const steps: Record<string, Reply[]> = {
    research: [
      { tool: "bash", args: { command: "cat input.txt" } },
      { tool: "submit_findings", args: { summary: "Input holds one number.", facts: [{ claim: "input.txt contains 41", evidence: "cat input.txt -> 41" }] } },
    ],
    plan: [
      { tool: "submit_plan", args: { summary: "Write the successor.", steps: [{ action: "Write 42 to answer.txt", uses: ["F1"], check: "cat answer.txt" }] } },
    ],
    execute: [
      { tool: "begin_step", args: { stepId: "S1" } },
      { tool: "write", args: { path: "answer.txt", content: "42\n" } },
      { tool: "bash", args: { command: "cat answer.txt" } },
      { tool: "submit_report", args: { summary: "Wrote answer.txt.", steps: [{ stepId: "S1", status: "done", evidence: "cat answer.txt -> 42" }] } },
    ],
    review: [
      { tool: "read", args: { path: "answer.txt" } },
      { tool: "submit_review", args: { approved: true, reason: "answer.txt contains 42.", problems: [] } },
    ],
  };
  const script = steps[stage] ?? [];
  if (lastTool && typeof lastTool.content === "string" && lastTool.content.startsWith("Unknown")) {
    throw new Error(`Unexpected tool error in ${stage}: ${lastTool.content}`);
  }
  return script[turn] ?? { text: `${stage} done.` };
}

test("workspace tools read, write, edit, list, find, grep, and run bash through workspace commands", TIMEOUT, async (t) => {
  const app = await fixture(t, happyPath);
  const workspace = localWorkspace(app.workspaceDir);
  const tools = new Map(createWorkspaceTools(workspace, ["read", "grep", "find", "ls", "edit", "write", "bash"], { defaultSeconds: 5, maxSeconds: 2 })
    .map((tool) => [tool.name, tool]));
  const call = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.get(name) as ToolDefinition;
    const result = await tool.execute(`call-${name}`, params as never, undefined, undefined, {} as never);
    return result.content.map((part) => ("text" in part ? part.text : "")).join("");
  };

  // Larger than one write chunk, with bytes that need quoting and a multi-byte character.
  const content = `it's "quoted" $HOME \`tick\` é\n`.repeat(4000);
  await call("write", { path: "nested/data.txt", content });
  assert.equal(await readFile(path.join(app.workspaceDir, "nested/data.txt"), "utf8"), content);
  assert.match(await call("read", { path: "nested/data.txt", limit: 1 }), /it's "quoted" \$HOME/);

  await call("edit", { path: "nested/data.txt", edits: [{ oldText: `${content.slice(0, -1)}`, newText: "short" }] });
  assert.equal(await readFile(path.join(app.workspaceDir, "nested/data.txt"), "utf8"), "short\n");

  await writeFile(path.join(app.workspaceDir, "main.py"), "def answer():\n    return 42\n");
  assert.match(await call("ls", {}), /nested\//);
  assert.match(await call("ls", {}), /main\.py/);
  assert.match(await call("find", { pattern: "*.txt" }), /nested\/data\.txt/);
  assert.match(await call("find", { pattern: "**/*.py" }), /main\.py/);
  assert.match(await call("grep", { pattern: "return 4[0-9]" }), /main\.py:2:/);
  assert.match(await call("grep", { pattern: "(", literal: true }), /main\.py:1:/);

  assert.match(await call("bash", { command: "echo out; echo err >&2; pwd" }), /out[\s\S]*err[\s\S]*\/app/);
  // Requests above the cap are clamped to it, and the workspace reports the timeout.
  const started = Date.now();
  assert.match(await call("bash", { command: "sleep 10", timeout: 60 }), /timed out after 2 seconds/);
  assert.ok(Date.now() - started < 8_000);
});

test("the pipeline runs fixed stages and records provenance, step tags, and changed files", TIMEOUT, async (t) => {
  const app = await fixture(t, happyPath);
  await writeFile(path.join(app.workspaceDir, "input.txt"), "41\n");
  const result = await runPipeline({
    directory: app.state, workspace: localWorkspace(app.workspaceDir), modelsFile: app.modelsFile,
    roles: app.roles, snapshotRoot: app.workspaceDir, request: "Write the successor of the number in input.txt to answer.txt.", review: true,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.approved, true);
  assert.deepEqual(result.artifacts.map((artifact) => [artifact.id, artifact.status, artifact.parents]), [
    ["research", "submitted", []],
    ["plan", "submitted", ["research"]],
    ["execute", "submitted", ["plan", "research"]],
    ["review", "submitted", ["execute", "plan", "research"]],
  ]);
  assert.equal(await readFile(path.join(app.workspaceDir, "answer.txt"), "utf8"), "42\n");

  const [research, plan, execute, review] = result.artifacts;
  assert.deepEqual((research!.content as { facts: { id: string }[] }).facts.map((fact) => fact.id), ["F1"]);
  assert.deepEqual((plan!.content as { steps: { id: string; uses: string[] }[] }).steps, [
    { id: "S1", action: "Write 42 to answer.txt", uses: ["F1"], check: "cat answer.txt" },
  ]);
  assert.match(plan!.sha256 ?? "", /^[0-9a-f]{64}$/);
  // The planner sees findings but has no workspace tools.
  const planRequest = app.requests.find((request) => request.tools?.some((tool) => tool.function.name === "submit_plan"));
  assert.deepEqual(planRequest?.tools?.map((tool) => tool.function.name), ["submit_plan"]);
  assert.match(JSON.stringify(planRequest?.messages), /input.txt contains 41/);

  assert.deepEqual(execute!.toolCalls.map((call) => [call.tool, call.stepId]), [
    ["begin_step", "S1"], ["write", "S1"], ["bash", "S1"], ["submit_report", "S1"],
  ]);
  assert.deepEqual(execute!.changedFiles, [path.join(app.workspaceDir, "answer.txt")]);
  assert.deepEqual(execute!.fileChanges?.created, [path.join(app.workspaceDir, "answer.txt")]);
  assert.deepEqual([execute!.fileChanges?.modified, execute!.fileChanges?.deleted], [[], []]);
  assert.ok((execute!.fileChanges?.overheadMs ?? -1) >= 0);
  assert.deepEqual(research!.changedFiles, []);
  assert.deepEqual(review!.changedFiles, []);
  assert.ok(execute!.usage.input > 0);

  // Full tool inputs and outputs are kept separately from the compact provenance stream.
  const outputs = (await readFile(path.join(app.state, "tool-calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const bash = outputs.find((entry) => entry.stageId === "execute" && entry.tool === "bash");
  assert.deepEqual(bash.args, { command: "cat answer.txt" });
  assert.match(bash.output, /42/);
  assert.equal(bash.stepId, "S1");
  assert.equal(outputs.length, 2 + 1 + 4 + 2);

  const events = (await readFile(result.provenanceFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type).filter((type) => type !== "tool_call"), [
    "run_start",
    ...["research", "plan", "execute", "review"].flatMap(() => ["stage_start", "stage_session", "stage_end"]),
    "run_end",
  ]);
  const runStart = events[0];
  assert.equal(runStart.settings.toolCallBudgets.execute, 400);
  assert.equal(runStart.settings.roles.researcher.model, "scripted-model");
  const planStart = events.find((event) => event.type === "stage_start" && event.id === "plan");
  assert.match(planStart.prompt, /input.txt contains 41/);
  assert.match(planStart.promptSha256, /^[0-9a-f]{64}$/);
  const planSession = events.find((event) => event.type === "stage_session" && event.id === "plan");
  assert.equal(planSession.sessionFile, plan!.sessionFile);
  assert.equal(events.filter((event) => event.type === "tool_call").length, 2 + 1 + 4 + 2);
});

test("a rejected review triggers one correction and a fresh review", TIMEOUT, async (t) => {
  let reviews = 0;
  const app = await fixture(t, (stage, turn, request) => {
    if (stage === "review") {
      if (turn > 0) return { text: "review done." };
      reviews++;
      return { tool: "submit_review", args: reviews === 1
        ? { approved: false, reason: "Wrong value.", problems: ["answer.txt must contain 42"] }
        : { approved: true, reason: "Fixed.", problems: [] } };
    }
    return happyPath(stage, turn, request);
  });
  await writeFile(path.join(app.workspaceDir, "input.txt"), "41\n");
  const result = await runPipeline({
    directory: app.state, workspace: localWorkspace(app.workspaceDir), modelsFile: app.modelsFile,
    roles: app.roles, snapshotRoot: app.workspaceDir, request: "Write the successor.", review: true, maxCorrections: 1,
  });
  assert.equal(result.approved, true);
  assert.deepEqual(result.artifacts.map((artifact) => [artifact.id, artifact.parents]), [
    ["research", []], ["plan", ["research"]], ["execute", ["plan", "research"]],
    ["review", ["execute", "plan", "research"]],
    ["correct-1", ["review", "execute", "plan", "research"]],
    ["review-2", ["correct-1", "plan", "research"]],
  ]);
  const correction = app.requests.find((request) => JSON.stringify(request.messages).includes("Your stage: correction"));
  assert.match(JSON.stringify(correction?.messages), /answer.txt must contain 42/);
});

test("plans citing unknown findings are rejected, and a stage without a submission is recorded as missing", TIMEOUT, async (t) => {
  const app = await fixture(t, (stage, turn, request) => {
    if (stage === "plan" && turn === 0) {
      return { tool: "submit_plan", args: { summary: "Bad.", steps: [{ action: "x", uses: ["F9"], check: "none" }] } };
    }
    if (stage === "plan" && turn === 1) {
      assert.match(JSON.stringify(request.messages), /Unknown finding IDs: F9/);
      return { tool: "submit_plan", args: { summary: "Good.", steps: [{ action: "x", uses: ["F1"], check: "none" }] } };
    }
    if (stage === "execute") return { text: "I will not report." };
    return happyPath(stage, turn, request);
  });
  await writeFile(path.join(app.workspaceDir, "input.txt"), "41\n");
  const result = await runPipeline({
    directory: app.state, workspace: localWorkspace(app.workspaceDir), modelsFile: app.modelsFile,
    roles: app.roles, snapshotRoot: app.workspaceDir, request: "Task.",
  });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.artifacts.map((artifact) => artifact.status), ["submitted", "submitted", "missing"]);
  // The executor was reminded once to submit.
  const executeRequests = app.requests.filter((request) => request.tools?.some((tool) => tool.function.name === "begin_step"));
  assert.equal(executeRequests.length, 2);
  assert.match(JSON.stringify(executeRequests[1]!.messages), /without calling submit_report/);
});

test("a stage over its tool budget is stopped and told to submit", TIMEOUT, async (t) => {
  const app = await fixture(t, (stage, turn, request) => {
    if (stage === "research") {
      const history = JSON.stringify(request.messages);
      if (history.includes("Findings saved")) return { text: "research done." };
      return history.includes("tool budget")
        ? { tool: "submit_findings", args: { summary: "Partial.", facts: [{ claim: "c", evidence: "e" }] } }
        : { tool: "ls", args: {} };
    }
    return happyPath(stage, turn, request);
  });
  const result = await runPipeline({
    directory: app.state, workspace: localWorkspace(app.workspaceDir), modelsFile: app.modelsFile,
    roles: app.roles, snapshotRoot: app.workspaceDir, request: "Task.", toolCallBudgets: { research: 2 },
  });
  const research = result.artifacts[0]!;
  assert.equal(research.status, "submitted");
  assert.equal(research.toolCalls.filter((call) => call.tool === "ls").length, 3);
});

test("a planner session works when the workspace path does not exist on the host", TIMEOUT, async (t) => {
  const app = await fixture(t, () => ({ text: "plan only" }));
  const session = await createRoleSession({
    cwd: "/pimas-test-missing/app", modelsFile: app.modelsFile, role: "planner", roles: app.roles,
    sessionManager: SessionManager.create("/pimas-test-missing/app", path.join(app.root, "sessions")),
    customTools: [], toolset: "none", workspace: { cwd: "/pimas-test-missing/app", exec: () => Promise.reject(new Error("unused")) },
  });
  try {
    assert.deepEqual(session.getActiveToolNames(), []);
    await session.prompt("Plan.");
    assert.equal(session.getLastAssistantText(), "plan only");
  } finally {
    session.dispose();
  }
});

test("the bridge relays every workspace command and writes a summary", TIMEOUT, async (t) => {
  const app = await fixture(t, (stage, turn, request) => {
    if (stage === "solve") {
      return [
        { tool: "bash", args: { command: "echo 42 > answer.txt" } },
        { tool: "submit_report", args: { summary: "done", steps: [] } },
      ][turn] ?? { text: "done" };
    }
    return happyPath(stage, turn, request);
  });
  const child = spawn(process.execPath, [
    "--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, path.resolve("src/pipeline-bridge.ts"),
    "--models", app.modelsFile, "--agents", app.agentsFile, "--state", app.state, "--mode", "single",
    "--snapshot-root", app.workspaceDir,
  ], { cwd: app.root, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const timer = setTimeout(() => child.kill(), 25_000);
  t.after(() => { clearTimeout(timer); child.kill(); });

  // The test plays the Harbor relay, running each command with local bash.
  const workspace = localWorkspace(app.workspaceDir);
  const relayed: string[] = [];
  let done: Record<string, unknown> | undefined;
  child.stdin.write(JSON.stringify({ type: "task", prompt: "Write 42 to answer.txt.", cwd: app.workspaceDir }) + "\n");
  for await (const line of createInterface({ input: child.stdout })) {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type === "done") { done = message; break; }
    assert.equal(message.type, "exec");
    relayed.push(String(message.command));
    const result = await workspace.exec(String(message.command), message.timeout ? { timeoutSeconds: Number(message.timeout) } : {});
    child.stdin.write(JSON.stringify({
      type: "exec_result", id: message.id, exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr,
    }) + "\n");
  }
  child.stdin.end();
  await once(child, "close");

  assert.deepEqual(done, { type: "done", status: "completed" }, stderr);
  assert.equal(await readFile(path.join(app.workspaceDir, "answer.txt"), "utf8"), "42\n");
  assert.ok(relayed.some((command) => command.includes("echo 42 > answer.txt")));
  const summary = JSON.parse(await readFile(path.join(app.state, "summary.json"), "utf8"));
  assert.deepEqual(summary.artifacts.map((artifact: { id: string }) => artifact.id), ["solve"]);
});

test("file tracking reports created, modified, and deleted files and ignores its own manifests", TIMEOUT, async (t) => {
  const app = await fixture(t, happyPath);
  const workspace = localWorkspace(app.workspaceDir);
  await writeFile(path.join(app.workspaceDir, "keep.txt"), "same");
  await writeFile(path.join(app.workspaceDir, "edit.txt"), "short");
  await writeFile(path.join(app.workspaceDir, "gone.txt"), "x");
  const tracker = new FileTracker(workspace, app.workspaceDir, `test-${process.pid}`);
  const before = await tracker.snapshot();
  assert.ok(before?.file.startsWith(SNAPSHOT_DIR));
  await writeFile(path.join(app.workspaceDir, "edit.txt"), "a longer body");
  await rm(path.join(app.workspaceDir, "gone.txt"));
  await mkdir(path.join(app.workspaceDir, "new dir"));
  await writeFile(path.join(app.workspaceDir, "new dir", "made.txt"), "y");
  const changes = await tracker.changesSince(before);
  assert.deepEqual(changes && {
    created: changes.created, modified: changes.modified, deleted: changes.deleted, total: changes.total, truncated: changes.truncated,
  }, {
    created: [path.join(app.workspaceDir, "new dir", "made.txt")],
    modified: [path.join(app.workspaceDir, "edit.txt")],
    deleted: [path.join(app.workspaceDir, "gone.txt")],
    total: 3,
    truncated: false,
  });
});
