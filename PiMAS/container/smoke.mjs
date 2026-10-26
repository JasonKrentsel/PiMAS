import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// No external inference. The scripted model must observe a real native read.
const marker = `native-smoke-${randomUUID()}`;
const input = "/app/.pimas-smoke-input.txt";
const configDirectory = "/pimas-state/smoke-config";
await mkdir(configDirectory, { recursive: true });
await writeFile(input, marker);
let calls = 0;
let serverError;
const server = createServer((request, response) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.url, "/v1/chat/completions");
    const observed = JSON.stringify(body.messages).includes(marker);
    const delta = observed ? { role: "assistant", content: marker } : {
      role: "assistant", tool_calls: [{ index: 0, id: `read_${++calls}`, type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: input }) } }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [data, reason] of [[delta, null], [{}, observed ? "stop" : "tool_calls"]]) {
      response.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1,
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
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(output, '{"type":"done"}\n');
  assert.equal((await readFile("/pimas-state/report.txt", "utf8")).trim(), marker);
  const checkpoint = JSON.parse(await readFile("/pimas-state/run/run.json", "utf8"));
  assert.equal(checkpoint.orchestrator.status, "settled");
  assert.ok(calls >= 1);
  if (serverError) throw serverError;
  console.error("PiMAS smoke passed: native read, attempt binding, protocol, and persisted orchestrator.");
  process.stdout.write(output);
} finally {
  child?.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(input, { force: true });
}
