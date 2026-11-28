// The scripted-model pipeline harness shared by pipeline.test.ts and watchdog.test.ts.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import type { TestContext } from "node:test";
import { loadAgentConfig, type AgentConfig } from "../src/agent-config.js";
import { parseCondition } from "../src/faults.js";
import { runPipeline } from "../src/pipeline.js";
import { localWorkspace } from "../src/workspace.js";

export interface ChatRequest {
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
}

export type Reply = { text: string } | { tool: string; args: Record<string, unknown> };
export type Script = (stage: string, turn: number, request: ChatRequest) => Reply;

export const TIMEOUT = { timeout: 40_000 };

/** Real SDK and HTTP path against a scripted model; the stage is inferred from its submit tool. */
export async function fixture(t: TestContext, script: Script) {
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

export function sendReply(response: ServerResponse, reply: Reply, id: number) {
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
export function happyPath(stage: string, turn: number, request: ChatRequest): Reply {
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

export const REPLAYED_RESEARCH = { summary: "Input holds one number.", facts: [{ id: "F1", claim: "input.txt contains 41", evidence: "cat input.txt -> 41" }] };
export const REPLAYED_PLAN = { summary: "Write the successor.", steps: [{ id: "S1", action: "Write 42 to answer.txt", uses: ["F1"], check: "cat answer.txt" }] };
export const REQUEST = "Write the successor of the number in input.txt to answer.txt.";

export function executorCalling(calls: { tool: string; args: Record<string, unknown> }[]): Script {
  return (stage, turn, request) => {
    if (stage !== "execute") return happyPath(stage, turn, request);
    const replies: Reply[] = [
      { tool: "begin_step", args: { stepId: "S1" } },
      ...calls,
      { tool: "submit_report", args: { summary: "done", steps: [{ stepId: "S1", status: "done", evidence: "ran" }] } },
    ];
    return replies[turn] ?? { text: "execute done." };
  };
}

export const ANSWER_TEST = "import unittest\n\nclass T(unittest.TestCase):\n    def test_answer(self):\n        self.assertEqual(open('answer.txt').read().strip(), '42')\n";
export const RUN_TEST = "python3 -m unittest -v test_answer";

/** A fault exactly as the experiments ran it, from its condition file. */
export async function experimentFault(condition: string) {
  const file = new URL(`../../experiments/phase1/conditions/${condition}/django__django-14608.json`, import.meta.url);
  return JSON.parse(await readFile(file, "utf8")).fault;
}

/** Run the pipeline with the watchdog on, the given files in the workspace and an executor making the given calls. */
export async function runWatched(t: TestContext, fault: unknown, files: Record<string, string>, calls: { tool: string; args: Record<string, unknown> }[]) {
  const app = await fixture(t, executorCalling(calls));
  await writeFile(path.join(app.workspaceDir, "input.txt"), "41\n");
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(app.workspaceDir, name), content);
  const result = await runPipeline({
    directory: app.state, workspace: localWorkspace(app.workspaceDir), modelsFile: app.modelsFile, roles: app.roles,
    snapshotRoot: app.workspaceDir, request: REQUEST, watchdog: true,
    condition: parseCondition({ source: "baseline/trial-1", replay: { research: REPLAYED_RESEARCH, plan: REPLAYED_PLAN }, ...(fault ? { fault } : {}) }),
  });
  const events = (await readFile(result.provenanceFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const outputs = (await readFile(path.join(app.state, "tool-calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const tests = outputs.filter((entry) => entry.tool === "bash" && entry.args?.command === RUN_TEST);
  const watchdog = events.filter((event) => event.type === "watchdog").map((event) => `${event.plugin}:${event.phase}`);
  return { app, result, events, outputs, tests, watchdog };
}

