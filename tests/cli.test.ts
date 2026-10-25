import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { startScriptedModelServer } from "./helpers/scripted-model.js";

test("CLI runs parallel workers, routes questions, and waits for review", {
  timeout: 45_000,
}, async () => {
  const dataDirectory = path.resolve("data");
  await mkdir(dataDirectory, { recursive: true });
  const workspace = await mkdtemp(path.join(dataDirectory, "cli-test-"));
  const server = await startScriptedModelServer();

  const child = spawn(process.execPath, [
    "--import", "tsx", "src_old/index.ts", "Build a frontend and backend",
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      TSX_DISABLE_CACHE: "1",
      PIMAS_STORAGE: "jsonl",
      PIMAS_STORAGE_DIR: "data/sessions",
      PIMAS_CWD: workspace,
      PIMAS_BASE_URL: server.url,
      PIMAS_MODEL: "test-model",
      PIMAS_MAX_PARALLEL: "2",
      PIMAS_TASK_TIMEOUT_MS: "15000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const timeout = setTimeout(() => child.kill(), 35_000);

  try {
    const [exitCode] = await once(child, "close");
    server.assertHealthy();
    assert.equal(exitCode, 0, `${stdout}\n${stderr}`);

    const model = server.model;
    assert.equal(model.sawContinuation, true, "premature success must be blocked");
    assert.equal(model.sawRoutedAnswer, true, "the worker must receive the orchestrator's reply");
    assert.equal(model.overlappingExecutors, true, "worker conversations must overlap");
    assert.match(stdout, /Orchestrator > Implemented frontend and backend; review approved/);
    assert.doesNotMatch(stdout, /Premature success/);

    const expectedTools = [
      "list_files", "set_plan", "wait_for_updates", "message_orchestrator",
      "reply_to_agent", "write", "read", "submit_review",
    ];
    for (const toolName of expectedTools) {
      assert.ok(model.observedTools.has(toolName), `Expected tool: ${toolName}`);
    }

    const frontend = await readFile(path.join(workspace, "frontend.txt"), "utf8");
    const backend = await readFile(path.join(workspace, "backend.txt"), "utf8");
    assert.equal(frontend, "Frontend calls GET /api/items");
    assert.equal(backend, "Backend serves GET /api/items");

    // Reopen the actual CLI log to verify history survives process exit.
    const storageDirectory = path.join(workspace, "data/sessions");
    const log = await readFile(path.join(storageDirectory, "main.jsonl"), "utf8");
    const records = log.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(records.length > 0, "the CLI must write a JSONL commit log");

    const context = BACKGROUND_CONTEXT;
    const storage = await openNodeJsonlStorage(storageDirectory, context);
    const reopened = await Harness.open(storage, {
      models: createModels(),
      registry: createRegistry(),
    }, context);
    try {
      const root = await reopened.root(context);
      const history = await root.context(context);
      const lastMessage = history.messages[history.messages.length - 1]!;
      assert.equal(lastMessage.role, "assistant");
      assert.match(JSON.stringify(lastMessage), /Implemented frontend and backend; review approved/);
    } finally {
      await reopened.close(context);
    }
  } finally {
    clearTimeout(timeout);
    child.kill();
    await server.close();

    // Delete only the temporary directory created by this test, inside data/.
    assert.equal(path.dirname(workspace), dataDirectory);
    await rm(workspace, { recursive: true, force: true });
  }
});
