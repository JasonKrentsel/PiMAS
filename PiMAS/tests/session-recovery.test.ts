import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openSavedSession } from "../src/recovery.js";
import { RunStore } from "../src/run-store.js";

test("creating a run never overwrites an existing checkpoint", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pimas-checkpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, cwd: directory, modelsFile: path.join(directory, "models.json") };
  const store = await RunStore.create(options);
  const before = await readFile(store.file, "utf8");
  await assert.rejects(RunStore.create(options), { code: "EEXIST" });
  assert.equal(await readFile(store.file, "utf8"), before);
});

test("recovery closes unfinished tool calls once without replay", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pimas-recovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = SessionManager.create(cwd, cwd);
  manager.appendMessage({ role: "user", content: "Do the task", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", content: [{ type: "toolCall", id: "pending-call", name: "spawn_agent", arguments: { role: "planner", assignment: "Inspect" } }],
    api: "openai-completions", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const file = manager.getSessionFile()!;
  const reopened = await openSavedSession(file, cwd);
  const results = reopened.buildSessionContext().messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.toolCallId, "pending-call");
  assert.equal(results[0]?.isError, true);
  assert.match(JSON.stringify(results), /not replayed/);
  const before = await readFile(file, "utf8");
  await openSavedSession(file, cwd);
  assert.equal(await readFile(file, "utf8"), before);
});

test("required history cannot silently become a new or truncated conversation", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pimas-recovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await assert.rejects(openSavedSession(path.join(cwd, "missing.jsonl"), cwd), { code: "ENOENT" });
  const file = path.join(cwd, "bad.jsonl");
  const header = JSON.stringify({ type: "session", version: 3, id: "test", cwd });
  await writeFile(file, `${header}\n{partial`);
  await assert.rejects(openSavedSession(file, cwd), /Invalid saved session/);
  assert.equal(await readFile(file, "utf8"), `${header}\n{partial`);
  await writeFile(file, JSON.stringify({ type: "session", id: "test", cwd: path.join(cwd, "other") }));
  await assert.rejects(openSavedSession(file, cwd), /Invalid saved session/);
});
