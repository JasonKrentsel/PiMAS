import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AGENT_ROLES, loadAgentConfig } from "../src/agent-config.js";

async function fixture(t: TestContext) {
  const data = path.resolve("data");
  await mkdir(data, { recursive: true });
  const directory = await mkdtemp(path.join(data, "agent-config-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "agents.local.json");
  const config = JSON.parse(await readFile(new URL("../agents.example.json", import.meta.url), "utf8"));
  return {
    directory, file, config,
    async save() { await writeFile(file, JSON.stringify(config)); },
  };
}

test("the root example defines four roles with existing Markdown prompts", async () => {
  const config = await loadAgentConfig(path.resolve("agents.example.json"));
  assert.deepEqual(Object.keys(config.roles), [...AGENT_ROLES]);
  for (const role of AGENT_ROLES) {
    assert.equal(config.roles[role].provider, "pimas");
    assert.equal(config.roles[role].model, "local-model");
    assert.equal(config.roles[role].thinkingLevel, "off");
    assert.deepEqual(config.roles[role].extensions, []);
    assert.ok((await readFile(config.roles[role].systemPrompt, "utf8")).trim());
  }
});

test("roles have independent preferences and prompts resolve beside their config", async (t) => {
  const app = await fixture(t);
  app.config.roles.planner.provider = "planning-provider";
  app.config.roles.planner.model = "planning-model";
  app.config.roles.planner.thinkingLevel = "high";
  app.config.roles.executor.thinkingLevel = "low";
  app.config.roles.reviewer.thinkingLevel = "max";
  await app.save();
  const { roles } = await loadAgentConfig(app.file);
  assert.equal(roles.planner.provider, "planning-provider");
  assert.equal(roles.planner.model, "planning-model");
  assert.equal(roles.planner.thinkingLevel, "high");
  assert.equal(roles.executor.thinkingLevel, "low");
  assert.equal(roles.reviewer.thinkingLevel, "max");
  assert.equal(roles.orchestrator.thinkingLevel, "off");
  assert.equal(roles.planner.systemPrompt, path.join(app.directory, "prompts", "planner.md"));
});

test("extension paths resolve beside the config and remain role-specific", async (t) => {
  const app = await fixture(t);
  const absolute = path.join(app.directory, "absolute-extension.ts");
  app.config.roles.planner.extensions = ["extensions/inject.ts", absolute];
  app.config.roles.executor.extensions = [];
  await app.save();
  const { roles } = await loadAgentConfig(app.file);
  assert.deepEqual(roles.planner.extensions, [path.join(app.directory, "extensions", "inject.ts"), absolute]);
  assert.deepEqual(roles.executor.extensions, []);
  assert.deepEqual(roles.reviewer.extensions, []);
});

test("invalid extension lists are rejected", async (t) => {
  const app = await fixture(t);
  for (const value of [null, "inject.ts", {}, [""], [" "], [123]]) {
    app.config.roles.planner.extensions = value;
    await app.save();
    await assert.rejects(loadAgentConfig(app.file), /roles\.planner\.extensions/);
  }
});

test("missing roles and empty required fields are errors", async (t) => {
  const app = await fixture(t);
  const reviewer = app.config.roles.reviewer;
  delete app.config.roles.reviewer;
  await app.save();
  await assert.rejects(loadAgentConfig(app.file), /roles\.reviewer must be an object/);
  app.config.roles.reviewer = reviewer;
  app.config.roles.executor.model = " ";
  await app.save();
  await assert.rejects(loadAgentConfig(app.file), /roles\.executor\.model must be a non-empty string/);
});

test("unsupported thinking levels and permission fields are rejected", async (t) => {
  const app = await fixture(t);
  app.config.roles.planner.thinkingLevel = "ultra";
  await app.save();
  await assert.rejects(loadAgentConfig(app.file), /roles\.planner\.thinkingLevel must be one of/);
  app.config.roles.planner.thinkingLevel = "high";
  app.config.roles.planner.tools = ["write", "bash"];
  await app.save();
  await assert.rejects(loadAgentConfig(app.file), /roles\.planner contains unsupported fields/);
});

test("unknown roles and non-object configurations are errors", async (t) => {
  const app = await fixture(t);
  app.config.roles.unrecognized = app.config.roles.planner;
  await app.save();
  await assert.rejects(loadAgentConfig(app.file), /roles contains unsupported fields/);
  await writeFile(app.file, "[]");
  await assert.rejects(loadAgentConfig(app.file), /agents configuration must be an object/);
});

test("missing and malformed files fail without echoing JSON values", async (t) => {
  const app = await fixture(t);
  await assert.rejects(loadAgentConfig(app.file), { code: "ENOENT" });
  await writeFile(app.file, '{"roles": "SENSITIVE_VALUE_DO_NOT_PRINT"');
  await assert.rejects(loadAgentConfig(app.file), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Invalid agents configuration/);
    assert.doesNotMatch(error.message, /SENSITIVE_VALUE_DO_NOT_PRINT/);
    return true;
  });
});
