import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyEdits, editCheckPlugin, firstDifference } from "../src/watchdog/edit-check.js";
import { freshCopy } from "../src/watchdog/rerun.js";
import { createWatchdog } from "../src/watchdog/monitor.js";
import { FAILING_PROBE, PASSING_PROBE, classify, testRunnerPlugin } from "../src/watchdog/test-runner.js";
import type { ToolCall, ToolOutcome, WatchdogEvent, WatchdogTools } from "../src/watchdog/types.js";
import { localWorkspace } from "../src/workspace.js";

// Unit tests for the watchdog's plug-ins and loop, without a model. End-to-end runs under the Phase 1 faults are in
// pipeline.test.ts ("the watchdog ...").

const PASS = "test_x (t.T) ... ok\n\n----------------------------------------------------------------------\nRan 1 test in 0.001s\n\nOK";
const FAIL = "test_x (t.T) ... FAIL\n\n----------------------------------------------------------------------\nRan 1 test in 0.001s\n\nFAILED (failures=1)";
const TIMEOUT = "test_x (t.T) ...\nCommand timed out after 600 seconds\n\n\nCommand exited with code 124";

let calls = 0;
const call = (tool: string, args: Record<string, unknown>): ToolCall =>
  ({ stageId: "execute", stepId: "S1", toolCallId: `call-${++calls}`, tool, args });
const testRun = call.bind(null, "bash", { command: "python3 -m unittest -v t" });

/** Tools for a plug-in, with a probe that answers as the given (possibly broken) runner would. */
function fakeTools(runner: (command: string) => ToolOutcome, fresh = PASS): WatchdogTools & { probes: string[]; reruns: number[] } {
  const probes: string[] = [];
  const reruns: number[] = []; // the timeout of each rerun
  return {
    probes,
    reruns,
    workspace: localWorkspace(tmpdir()),
    agentBash: async (command) => { probes.push(command); return runner(command); },
    rerun: async (_command, timeoutSeconds) => { reruns.push(timeoutSeconds); return { exitCode: 0, stdout: "", stderr: fresh }; },
    timeoutFor: (requested) => Math.min(typeof requested === "number" ? requested : 600, 3600),
  };
}
const honest = (command: string) => command === FAILING_PROBE ? { output: FAIL, isError: true } : { output: PASS, isError: false };

test("test outcomes are read from what the run printed", () => {
  assert.equal(classify({ output: PASS, isError: false }), "passed");
  assert.equal(classify({ output: FAIL, isError: true }), "failed");
  assert.equal(classify({ output: TIMEOUT, isError: true }), "timeout");
  assert.equal(classify({ output: "1 failed, 3 passed in 0.2s", isError: true }), "failed");
  assert.equal(classify({ output: "ModuleNotFoundError: x", isError: true }), "failed");
  assert.equal(classify({ output: "hello", isError: false }), "unknown");
});

test("test runner: the first test result after each edit is checked, with a probe answering the opposite", async () => {
  const plugin = testRunnerPlugin();
  const tools = fakeTools(honest);
  const first = await plugin.detect(testRun(), { output: FAIL, isError: true }, tools);
  assert.deepEqual(first?.data, { expect: "passed" }, "after a failure, a test that must pass");
  assert.equal((await plugin.confirm(first!, testRun(), tools)).confirmed, false, "a healthy runner passes it");
  assert.equal(plugin.detect(testRun(), { output: FAIL, isError: true }, tools), null, "already checked since the last edit");
  assert.equal(plugin.detect(call("bash", { command: "ls" }), { output: "a.py", isError: false }, tools), null, "not a test run");
  plugin.detect(call("edit", { path: "a.py", edits: [] }), { output: "ok", isError: false }, tools);
  const afterEdit = await plugin.detect(testRun(), { output: PASS, isError: false }, tools);
  assert.deepEqual(afterEdit?.data, { expect: "failed" }, "after a pass, a test that must fail");
  assert.equal((await plugin.confirm(afterEdit!, testRun(), tools)).confirmed, false);
  assert.deepEqual(tools.probes, [PASSING_PROBE, FAILING_PROBE]);
});

test("test runner: a runner that fails a known-passing test is broken, and every later test run goes around it", async () => {
  const plugin = testRunnerPlugin();
  const tools = fakeTools(() => ({ output: FAIL, isError: true })); // reports every test as failing
  const trigger = testRun();
  const suspicion = await plugin.detect(trigger, { output: FAIL, isError: true }, tools);
  const evidence = await plugin.confirm(suspicion!, trigger, tools);
  assert.deepEqual([evidence.confirmed, evidence.reason], [true, "a test that must pass came back failed"]);
  const repair = await plugin.repair(evidence, trigger, { output: FAIL, isError: true }, tools);
  assert.deepEqual(repair.replacement, { output: PASS, isError: false });
  assert.match(repair.note, /bash tool is giving wrong test results/);
  // From now on, no more probes: every test command runs outside the agent's tools only, with the tool's timeout.
  assert.equal(await plugin.instead!(call("bash", { command: "ls" }), tools), null, "not a test run: the tool runs");
  const later = await plugin.instead!(call("bash", { command: "python3 -m unittest -v t", timeout: 9000 }), tools);
  assert.deepEqual(later?.replacement, { output: PASS, isError: false });
  assert.equal(plugin.detect(testRun(), { output: FAIL, isError: true }, tools), null, "nothing left to detect");
  assert.deepEqual(tools.reruns, [600, 3600], "the default timeout, then the cap");
  assert.equal(tools.probes.length, 1);
});

test("test runner: a healthy runner's test commands are never handled in its place", async () => {
  const plugin = testRunnerPlugin();
  const tools = fakeTools(honest);
  const suspicion = await plugin.detect(testRun(), { output: FAIL, isError: true }, tools);
  await plugin.confirm(suspicion!, testRun(), tools);
  assert.equal(await plugin.instead!(testRun(), tools), null);
});

test("test runner: a runner that hides failures shows a known-failing probe as passing", async () => {
  const plugin = testRunnerPlugin();
  const tools = fakeTools(() => ({ output: PASS, isError: false }));
  const suspicion = await plugin.detect(testRun(), { output: PASS, isError: false }, tools);
  const evidence = await plugin.confirm(suspicion!, testRun(), tools);
  assert.deepEqual([evidence.confirmed, evidence.reason], [true, "a test that must fail came back passed"]);
  assert.deepEqual(tools.probes, [FAILING_PROBE]);
});

test("test runner: a probe that prints no test results is inconclusive, not proof of a broken runner", async () => {
  const plugin = testRunnerPlugin();
  const tools = fakeTools(() => ({ output: "bash: python3: command not found\n\nCommand exited with code 127", isError: true }));
  const suspicion = await plugin.detect(testRun(), { output: FAIL, isError: true }, tools);
  const evidence = await plugin.confirm(suspicion!, testRun(), tools);
  assert.deepEqual([evidence.confirmed, evidence.reason], [false, "probe printed no test results; inconclusive"]);
});

test("edit check: the agent's edits are applied exactly, and a difference is named by its line", () => {
  assert.equal(applyEdits("a = 1\nb = 2\n", [{ oldText: "b = 2", newText: "b = 3" }]), "a = 1\nb = 3\n");
  assert.equal(applyEdits("x\nx\n", [{ oldText: "x", newText: "y" }]), null, "an old text that is not unique cannot be applied");
  assert.equal(applyEdits("x\n", [{ oldText: "z", newText: "y" }]), null);
  assert.equal(firstDifference("a\nb != 3\n", "a\nb == 3\n"), `line 2 reads "b != 3" instead of "b == 3"`);
});

test("edit check: a file that does not hold what the agent wrote is restored; a faithful edit is left alone", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "watchdog-edit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tools = { ...fakeTools(honest), workspace: localWorkspace(dir) };
  const plugin = editCheckPlugin();
  await writeFile(path.join(dir, "a.py"), "ok = False\n");

  const edit = call("edit", { path: "a.py", edits: [{ oldText: "ok = False", newText: "ok = 1 == 1" }] });
  await plugin.before!(edit, tools);
  await writeFile(path.join(dir, "a.py"), "ok = 1 != 1\n"); // the edit as a fault delivered it
  const suspicion = await plugin.detect(edit, { output: "Edited a.py", isError: false }, tools);
  assert.ok(suspicion);
  const evidence = await plugin.confirm(suspicion, edit, tools);
  assert.equal(evidence.reason, `line 1 reads "ok = 1 != 1" instead of "ok = 1 == 1"`);
  const repair = await plugin.repair(evidence, edit, { output: "", isError: false }, tools);
  assert.match(repair.note, /restored to the content you intended/);
  assert.equal(await readFile(path.join(dir, "a.py"), "utf8"), "ok = 1 == 1\n");

  const faithful = call("write", { path: "b.py", content: "b = 2\n" });
  await plugin.before!(faithful, tools);
  await writeFile(path.join(dir, "b.py"), "b = 2\n");
  assert.equal(await plugin.detect(faithful, { output: "Wrote b.py", isError: false }, tools), null);
});

test("a fresh copy runs the command on a copy of the workspace and leaves the original alone", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "watchdog-fresh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "answer.txt"), "42\n");
  const run = freshCopy(localWorkspace(dir));
  const result = await run(`cat answer.txt && pwd && echo changed > ${dir}/answer.txt && cat ${dir}/answer.txt`, 10);
  assert.equal(result.exitCode, 0);
  const [answer, where, changed] = result.stdout.trim().split("\n");
  assert.deepEqual([answer, changed], ["42", "changed"]);
  assert.notEqual(where, dir, "the command ran in the copy, even when it named the workspace by absolute path");
  assert.equal(await readFile(path.join(dir, "answer.txt"), "utf8"), "42\n");
  assert.equal((await run("exit 3", 10)).exitCode, 3);
});

test("the watchdog loop appends repair notes and replacements to what the agent gets, and records each step", async () => {
  const events: WatchdogEvent[] = [];
  const watchdog = createWatchdog({
    workspace: localWorkspace(tmpdir()),
    commandLimits: { defaultSeconds: 600, maxSeconds: 3600 },
    rerun: async () => ({ exitCode: 0, stdout: "real", stderr: "" }),
    record: (event) => { events.push(event); },
    plugins: [{
      name: "always",
      detect: (c) => c.args.command === "check" ? { reason: "looks off" } : null,
      confirm: async () => ({ confirmed: true, reason: "it is" }),
      repair: async () => ({ note: "[watchdog] fixed", replacement: { output: "real", isError: false } }),
    }],
  });
  const bash = watchdog.forStage("execute", () => "S1")({
    name: "bash", label: "bash", description: "", parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "fake" }], details: undefined, isError: true }),
  } as unknown as ToolDefinition);
  const untouched = await bash.execute("c1", { command: "ls" }, undefined, undefined, undefined as never);
  assert.deepEqual(untouched.content, [{ type: "text", text: "fake" }]);
  const repaired = await bash.execute("c2", { command: "check" }, undefined, undefined, undefined as never);
  assert.deepEqual([repaired.content, (repaired as { isError?: boolean }).isError], [[{ type: "text", text: "real\n\n[watchdog] fixed" }], false]);
  assert.deepEqual(events.map((event) => event.phase), ["suspected", "confirmed", "repaired"]);
  assert.deepEqual(watchdog.summary, { plugins: ["always"], suspected: 1, confirmed: 1, repaired: 1 });
});

test("the watchdog loop runs a call a plug-in handles instead without the agent's tool", async () => {
  const events: WatchdogEvent[] = [];
  let ran = 0;
  const watchdog = createWatchdog({
    workspace: localWorkspace(tmpdir()),
    commandLimits: { defaultSeconds: 600, maxSeconds: 3600 },
    rerun: async () => ({ exitCode: 0, stdout: "real", stderr: "" }),
    record: (event) => { events.push(event); },
    plugins: [{
      name: "around",
      instead: (c) => c.args.command === "test" ? { reason: "known broken", note: "[watchdog] ran outside", replacement: { output: "real", isError: false } } : null,
      detect: () => null,
      confirm: async () => ({ confirmed: false, reason: "" }),
      repair: async () => ({ note: "" }),
    }],
  });
  const bash = watchdog.forStage("execute", () => "S1")({
    name: "bash", label: "bash", description: "", parameters: {},
    execute: async () => { ran++; return { content: [{ type: "text", text: "fake" }], details: undefined, isError: true }; },
  } as unknown as ToolDefinition);
  const handled = await bash.execute("c1", { command: "test" }, undefined, undefined, undefined as never);
  assert.deepEqual(handled.content, [{ type: "text", text: "real\n\n[watchdog] ran outside" }]);
  assert.equal(ran, 0, "the agent's tool did not run");
  await bash.execute("c2", { command: "ls" }, undefined, undefined, undefined as never);
  assert.equal(ran, 1);
  assert.deepEqual(events.map((event) => [event.phase, event.reason]), [["rerouted", "known broken"]]);
  assert.equal(watchdog.summary.repaired, 1);
});
