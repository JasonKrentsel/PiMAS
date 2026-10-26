import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// No external inference: reports require observed native tool results.
const implementation = process.argv.includes("--implementation");
const marker = `native-smoke-${randomUUID()}`;
const input = "/app/.pimas-smoke-input.txt";
const outputFile = "/app/.pimas-smoke-output.txt";
const expected = `${marker}-verified\n`;
const configDirectory = "/pimas-state/smoke-config";
await mkdir(configDirectory, { recursive: true });
await writeFile(input, marker);
let calls = 0;
let orchestratorTurn = 0;
let serverError;

function reply(body) {
  const results = body.messages.filter((message) => message.role === "tool");
  const lastResult = JSON.stringify(results.at(-1));
  const names = body.tools.map((tool) => tool.function.name).sort();
  const tool = (name, args) => ({ tool: name, args });
  if (!implementation) {
    return JSON.stringify(body.messages).includes(marker) ? { text: marker } : tool("read", { path: input });
  }
  if (names.includes("write")) {
    assert.deepEqual(names, ["ask_orchestrator", "bash", "edit", "find", "grep", "ls", "read", "write"]);
    if (results.length === 0) return tool("write", { path: outputFile, content: `${marker}-initial\n` });
    if (results.length === 1) return tool("edit", { path: outputFile, edits: [{ oldText: `${marker}-initial`, newText: `${marker}-verified` }] });
    if (results.length === 2) {
      const source = `const fs=require("node:fs");if(fs.readFileSync(${JSON.stringify(outputFile)},"utf8")!==${JSON.stringify(expected)})process.exit(7);console.log("COMMAND_CHECK_PASSED")`;
      return tool("bash", { command: `"${process.execPath}" -e '${source}'`, timeout: 5 });
    }
    if (results.length === 3) {
      assert.match(lastResult, /COMMAND_CHECK_PASSED/);
      return tool("bash", { command: `"${process.execPath}" -e 'setInterval(() => {}, 1000)'`, timeout: 0.2 });
    }
    assert.match(lastResult, /Command timed out after 0.2 seconds/);
    return { text: `Execution evidence ${marker}: native write/edit completed; exact-content shell check passed; long-running timeout probe stopped as expected.` };
  }
  if (names.includes("submit_review")) {
    assert.deepEqual(names, ["ask_orchestrator", "find", "grep", "ls", "read", "submit_review"]);
    if (results.length === 0) return tool("read", { path: outputFile });
    if (results.length === 1) {
      assert.ok(lastResult.includes(`${marker}-verified`));
      return tool("submit_review", { approved: true, reason: "Read the expected output and inspected supplied successful command/timeout evidence; no independent shell execution." });
    }
    assert.match(lastResult, /Review approval saved/);
    return { text: `Review evidence ${marker}: inspected native output and supplied checks; explicit approval saved.` };
  }
  if (!names.includes("spawn_agent")) {
    if (results.length === 0) return tool("read", { path: input });
    assert.ok(lastResult.includes(marker));
    return { text: `Plan evidence ${marker}: create output, edit it to the verified marker, run an exact-content check and timeout probe, then independently review.` };
  }
  switch (orchestratorTurn++) {
    case 0: return tool("spawn_agent", { role: "planner", assignment: `Read ${input}; plan the implementation smoke with verification and independent review.` });
    case 1: return tool("wait_for_agents", { agentId: "agent-1" });
    case 2:
      assert.ok(lastResult.includes(`Plan evidence ${marker}`));
      return tool("accept_plan", { plannerIds: ["agent-1"], plan: `Create ${outputFile}, edit to ${marker}-verified plus newline, run an exact-content check and a short timeout probe, then obtain independent review.` });
    case 3: return tool("spawn_agent", { role: "executor", assignment: `Execute the accepted smoke plan for ${outputFile}; expected content is ${marker}-verified plus newline. Report actual native tool evidence.` });
    case 4: return tool("wait_for_agents", { agentId: "agent-2" });
    case 5:
      assert.ok(lastResult.includes(`Execution evidence ${marker}`));
      return tool("spawn_agent", { role: "reviewer", assignment: `Accepted plan: ${outputFile} must contain ${marker}-verified plus newline. Executor evidence: exact-content shell check passed; long-running timeout probe stopped. Inspect the file and supplied evidence and submit an explicit verdict; do not run commands.` });
    case 6: return tool("wait_for_agents", { agentId: "agent-3" });
    case 7:
      assert.ok(lastResult.includes(`Review evidence ${marker}`));
      return tool("workflow_status", {});
    case 8:
      assert.match(lastResult, /completionBlocker/);
      assert.match(lastResult, /null/);
      return { text: marker };
    default: throw new Error("Unexpected smoke continuation");
  }
}

const server = createServer((request, response) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.url, "/v1/chat/completions");
    const action = reply(body);
    const id = ++calls;
    const delta = action.tool ? {
      role: "assistant", tool_calls: [{ index: 0, id: `smoke_${id}`, type: "function",
        function: { name: action.tool, arguments: JSON.stringify(action.args) } }],
    } : { role: "assistant", content: action.text };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [data, reason] of [[delta, null], [{}, action.tool ? "tool_calls" : "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: `smoke_${id}`, object: "chat.completion.chunk", created: 1,
        model: "local-model", choices: [{ index: 0, delta: data, finish_reason: reason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  })().catch((error) => { serverError = error; response.writeHead(401).end(); });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const models = JSON.parse(await readFile("/opt/pimas/models.example.json", "utf8"));
models.providers.pimas.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const agents = JSON.parse(await readFile("/opt/pimas/agents.example.json", "utf8"));
for (const profile of Object.values(agents.roles)) profile.systemPrompt = `/opt/pimas/${profile.systemPrompt}`;
await writeFile(`${configDirectory}/models.json`, JSON.stringify(models));
await writeFile(`${configDirectory}/agents.json`, JSON.stringify(agents));
let child;
try {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let task;
  try { for await (const line of reader) { task = JSON.parse(line); break; } }
  finally { reader.close(); process.stdin.pause(); }
  assert.equal(task?.type, "task");
  child = spawn(process.execPath, ["--import", pathToFileURL("/opt/pimas/node_modules/tsx/dist/loader.mjs").href,
    "/opt/pimas/src/container-bridge.ts", "--models", `${configDirectory}/models.json`,
    "--agents", `${configDirectory}/agents.json`], { cwd: "/app", stdio: ["pipe", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end(JSON.stringify(task) + "\n");
  const [code] = await once(child, "close");
  if (serverError) throw serverError;
  assert.equal(code, 0);
  assert.equal(output, '{"type":"done"}\n');
  assert.equal((await readFile("/pimas-state/report.txt", "utf8")).trim(), marker);
  const checkpoint = JSON.parse(await readFile("/pimas-state/run/run.json", "utf8"));
  assert.equal(checkpoint.orchestrator.status, "settled");
  assert.ok(calls >= 2);
  if (implementation) {
    assert.equal(await readFile(outputFile, "utf8"), expected);
    assert.deepEqual(checkpoint.agents.map((agent) => agent.role), ["planner", "executor", "reviewer"]);
    assert.ok(checkpoint.agents.every((agent) => agent.status === "settled"));
    assert.equal(checkpoint.agents[2].review?.approved, true);
    assert.equal(checkpoint.agents[2].review.revision, checkpoint.workflow.revision);
  }
  console.error(`PiMAS smoke passed: ${implementation ? "native write/edit/bash timeout, independent approval" : "native read"}, attempt binding, protocol, and persisted workflow.`);
  process.stdout.write(output);
} finally {
  child?.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(input, { force: true });
  if (implementation) await rm(outputFile, { force: true });
}
