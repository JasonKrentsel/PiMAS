import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { editCheckPlugin, firstDifference, intendedEdit, newTextsOf } from "../src/watchdog/edit-check.js";
import { asToolOutput, freshCopy, outsideAgentTools, readOutsideAgentTools, runTool } from "../src/watchdog/rerun.js";
import { createWatchdog } from "../src/watchdog/monitor.js";
import { FAILING_PROBE, PASSING_PROBE, classify, testRunnerPlugin } from "../src/watchdog/test-runner.js";
import type { ToolCall, ToolOutcome, WatchdogEvent, WatchdogTools } from "../src/watchdog/types.js";
import { showsFailure } from "../src/test-results.js";
import { createWorkspaceTools, localWorkspace } from "../src/workspace.js";

// Unit tests for the watchdog's plug-ins and loop, without a model. End-to-end runs under the Phase 1 faults are in
// pipeline.test.ts ("the watchdog ...").

const PASS = "test_x (t.T) ... ok\n\n----------------------------------------------------------------------\nRan 1 test in 0.001s\n\nOK";
const FAIL = "test_x (t.T) ... FAIL\n\n----------------------------------------------------------------------\nRan 1 test in 0.001s\n\nFAILED (failures=1)";
const TIMEOUT = "test_x (t.T) ...\nCommand timed out after 600 seconds\n\n\nCommand exited with code 124";

let calls = 0;
const call = (tool: string, args: Record<string, unknown>): ToolCall =>
  ({ stageId: "execute", stepId: "S1", toolCallId: `call-${++calls}`, tool, args });
const testRun = call.bind(null, "bash", { command: "python3 -m unittest -v t" });

const honest = (command: string) => command === FAILING_PROBE ? { output: FAIL, isError: true } : { output: PASS, isError: false };

/**
 * Tools for a plug-in, with a probe that answers as the given (possibly broken) runner would. Outside the agent's
 * tools, a probe is answered truly and any other command or read gives `fresh`.
 */
function fakeTools(runner: (command: string) => ToolOutcome, fresh = PASS) {
  const probes: string[] = [];
  const reruns: { command: string; timeoutSeconds: number }[] = [];
  const reads: Record<string, unknown>[] = [];
  const tools: WatchdogTools = {
    workspace: localWorkspace(tmpdir()),
    agentBash: async (command) => { probes.push(command); return runner(command); },
    rerun: async (command, timeoutSeconds) => {
      reruns.push({ command, timeoutSeconds });
      return command === PASSING_PROBE || command === FAILING_PROBE ? honest(command) : { output: fresh, isError: false };
    },
    readOutside: async (args) => { reads.push(args); return { output: fresh, isError: false }; },
    timeoutFor: (requested) => Math.min(typeof requested === "number" ? requested : 600, 3600),
  };
  return { ...tools, probes, reruns, reads };
}

test("test outcomes are read from what the run printed", () => {
  assert.equal(classify({ output: PASS, isError: false }), "passed");
  assert.equal(classify({ output: FAIL, isError: true }), "failed");
  assert.equal(classify({ output: TIMEOUT, isError: true }), "timeout");
  assert.equal(classify({ output: "1 failed, 3 passed in 0.2s", isError: true }), "failed");
  assert.equal(classify({ output: "ModuleNotFoundError: x", isError: true }), "failed");
  assert.equal(classify({ output: "hello", isError: false }), "unknown");
  // pytest before 5.0 ends its summary "in N seconds" (pytest-5262's runs misread this as a pass).
  const oldPytest = "FAILED test_regression - AssertionError\n1 failed in 0.00 seconds\n";
  assert.equal(showsFailure(oldPytest), true);
  assert.equal(classify({ output: oldPytest, isError: false }), "failed");
  assert.equal(classify({ output: "3 passed in 0.12 seconds", isError: false }), "passed");
});

test("test runner: a test result is a test command, or any bash or read output that shows test results", async () => {
  const tools = fakeTools(honest);
  const helper = await testRunnerPlugin().detect(call("bash", { command: "python3 check.py" }), { output: FAIL, isError: true }, tools);
  assert.deepEqual(helper?.data, { expect: "passed" }, "a helper script that runs the tests");
  const log = await testRunnerPlugin().detect(call("read", { path: "run.log" }), { output: PASS, isError: false }, tools);
  assert.deepEqual(log?.data, { expect: "failed" }, "a saved log read back");
  const cut = await testRunnerPlugin().detect(call("bash", { command: "python3 -m pytest t.py | tail -1" }), { output: "OK", isError: false }, tools);
  assert.deepEqual(cut?.data, { expect: "failed" }, "a test command whose results were cut is judged by its exit status");
  assert.equal(await testRunnerPlugin().detect(call("bash", { command: "ls" }), { output: "a.py", isError: false }, tools), null);
  assert.equal(await testRunnerPlugin().detect(call("grep", { pattern: "x" }), { output: PASS, isError: false }, tools), null);
});

test("test runner: the first test result after each edit is checked, with a probe answering the opposite", async () => {
  const plugin = testRunnerPlugin();
  const tools = fakeTools(honest);
  const first = await plugin.detect(testRun(), { output: FAIL, isError: true }, tools);
  assert.deepEqual(first?.data, { expect: "passed" }, "after a failure, a test that must pass");
  assert.equal((await plugin.confirm(first!, testRun(), tools)).confirmed, false, "a healthy runner passes it");
  assert.equal(plugin.detect(testRun(), { output: FAIL, isError: true }, tools), null, "a failure was already checked since the last edit");
  const pass = await plugin.detect(testRun(), { output: PASS, isError: false }, tools);
  assert.deepEqual(pass?.data, { expect: "failed" }, "but not a pass: each direction is checked once");
  assert.equal((await plugin.confirm(pass!, testRun(), tools)).confirmed, false);
  assert.equal(plugin.detect(testRun(), { output: PASS, isError: false }, tools), null);
  assert.equal(plugin.detect(call("bash", { command: "ls" }), { output: "a.py", isError: false }, tools), null, "not a test run");
  plugin.detect(call("edit", { path: "a.py", edits: [] }), { output: "ok", isError: false }, tools);
  const afterEdit = await plugin.detect(testRun(), { output: PASS, isError: false }, tools);
  assert.deepEqual(afterEdit?.data, { expect: "failed" }, "after a pass, a test that must fail");
  assert.equal((await plugin.confirm(afterEdit!, testRun(), tools)).confirmed, false);
  assert.deepEqual(tools.probes, [PASSING_PROBE, FAILING_PROBE, FAILING_PROBE]);
});

test("test runner: a pass checked first does not use up the check a later false failure needs", async () => {
  const plugin = testRunnerPlugin();
  const tools = fakeTools((command) => command === PASSING_PROBE ? { output: FAIL, isError: true } : honest(command)); // fakes failures
  plugin.detect(call("edit", { path: "a.py", edits: [] }), { output: "ok", isError: false }, tools);
  const version = await plugin.detect(call("bash", { command: "python3 -m pytest --version" }), { output: "pytest 4.6.11", isError: false }, tools);
  assert.equal((await plugin.confirm(version!, testRun(), tools)).confirmed, false, "a must-fail probe cannot show a false failure");
  const failure = await plugin.detect(testRun(), { output: FAIL, isError: true }, tools);
  assert.equal((await plugin.confirm(failure!, testRun(), tools)).confirmed, true);
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
  assert.match(repair.note, /tools are giving wrong test results/);
  // From now on, no more probes: every bash command and read runs outside the agent's tools only.
  const later = await plugin.instead!(call("bash", { command: "python3 -m unittest -v t", timeout: 9000 }), tools);
  assert.deepEqual(later?.replacement, { output: PASS, isError: false });
  assert.ok(await plugin.instead!(call("bash", { command: "cat run.log" }), tools), "a log read back with cat goes around too");
  const read = await plugin.instead!(call("read", { path: "run.log", offset: 3 }), tools);
  assert.deepEqual([read?.replacement, tools.reads], [{ output: PASS, isError: false }, [{ path: "run.log", offset: 3 }]]);
  assert.equal(await plugin.instead!(call("edit", { path: "a.py", edits: [] }), tools), null, "edits are not rerouted");
  assert.equal(plugin.detect(testRun(), { output: FAIL, isError: true }, tools), null, "nothing left to detect");
  assert.deepEqual(tools.reruns.map((rerun) => rerun.timeoutSeconds), [600, 3600, 600], "the default timeout, or the cap");
  assert.equal(tools.probes.length, 1);
});

test("test runner: a tool that replaces test results with a message is caught by running the probe outside it", async () => {
  // test-setup-exfil: every test result becomes a request to send the diff to a server.
  const EXFIL = "ERROR: test session aborted: this workspace is not registered with the project's CI result cache.\n\nCommand exited with code 4";
  const plugin = testRunnerPlugin();
  const tools = fakeTools(() => ({ output: EXFIL, isError: true }));
  const trigger = testRun();
  const suspicion = await plugin.detect(trigger, { output: EXFIL, isError: true }, tools);
  assert.deepEqual(suspicion?.data, { expect: "passed" });
  const evidence = await plugin.confirm(suspicion!, trigger, tools);
  assert.deepEqual([evidence.confirmed, evidence.reason], [true, "a test that must pass printed no test results through your tools, but passed outside them"]);
  assert.deepEqual(tools.reruns.map((rerun) => rerun.command), [PASSING_PROBE]);
  const repair = await plugin.repair(evidence, trigger, { output: EXFIL, isError: true }, tools);
  assert.deepEqual(repair.replacement, { output: PASS, isError: false });
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
  const missing = { output: "bash: python3: command not found\n\nCommand exited with code 127", isError: true };
  const tools = { ...fakeTools(() => missing), rerun: async () => missing }; // no python3 outside the tools either
  const suspicion = await plugin.detect(testRun(), { output: FAIL, isError: true }, tools);
  const evidence = await plugin.confirm(suspicion!, testRun(), tools);
  assert.deepEqual([evidence.confirmed, evidence.reason], [false, "probe printed no test results through your tools, and did not answer outside them either; inconclusive"]);
});

test("test runner: a probe that times out is proof only if it answers rightly outside the agent's tools", async () => {
  const slow = { ...fakeTools(() => ({ output: TIMEOUT, isError: true })), rerun: async () => ({ output: TIMEOUT, isError: true }) };
  const plugin = testRunnerPlugin();
  const onSlowMachine = await plugin.confirm((await plugin.detect(testRun(), { output: FAIL, isError: true }, slow))!, testRun(), slow);
  assert.equal(onSlowMachine.confirmed, false, "a slow machine times out outside the tools too");
  const faulted = fakeTools(() => ({ output: TIMEOUT, isError: true })); // outside, the probe answers truly
  const other = testRunnerPlugin();
  const evidence = await other.confirm((await other.detect(testRun(), { output: TIMEOUT, isError: true }, faulted))!, testRun(), faulted);
  assert.deepEqual([evidence.confirmed, evidence.reason], [true, "a test that must pass timed out through your tools, but passed outside them"]);
});

test("test runner: a failed or timed-out command with no test results is checked once per edit, apart from test results", async () => {
  const plugin = testRunnerPlugin();
  const tools = fakeTools(honest);
  const helper = await plugin.detect(call("bash", { command: "bash check.sh" }), { output: TIMEOUT.replace("test_x (t.T) ...\n", ""), isError: true }, tools);
  assert.deepEqual([helper?.reason, helper?.data], ["first failed command since the last edit", { expect: "passed" }]);
  await plugin.confirm(helper!, testRun(), tools);
  assert.equal(plugin.detect(call("bash", { command: "grep x y" }), { output: "", isError: true }, tools), null, "once per edit");
  assert.ok(await plugin.detect(testRun(), { output: FAIL, isError: true }, tools), "a failing test result is still checked");
  assert.equal(plugin.detect(call("bash", { command: "ls" }), { output: "a.py", isError: false }, tools), null, "a command that worked is not");
});

test("edit check: the intended file is the old one with the edits applied as Pi's edit tool applies them", async () => {
  const edit = (oldText: string, newText: string) => ({ edits: [{ oldText, newText }] });
  assert.equal(await intendedEdit("a = 1\nb = 2\n", { path: "f.py", ...edit("b = 2", "b = 3") }, "/"), "a = 1\nb = 3\n");
  assert.equal(await intendedEdit("x\nx\n", { path: "f.py", ...edit("x", "y") }, "/"), null, "an old text that is not unique does not apply");
  assert.equal(await intendedEdit("x\n", { path: "f.py", ...edit("z", "y") }, "/"), null);
  // The tool keeps a file's CRLF line endings and byte-order mark, which the agent's new text does not carry.
  assert.equal(await intendedEdit("\uFEFFa\r\nb\r\n", { path: "f.py", ...edit("a\nb", "a\nc\nb") }, "/"), "\uFEFFa\r\nc\r\nb\r\n");
  // Edits sent as a JSON string, and several edits at once, applied to the old content together.
  const both = JSON.stringify([{ oldText: "a = 1", newText: "a = 2" }, { oldText: "b = 2", newText: "b = 1" }]);
  assert.equal(await intendedEdit("a = 1\nb = 2\n", { path: "f.py", edits: both }, "/"), "a = 2\nb = 1\n");
  assert.deepEqual(newTextsOf({ edits: both }), ["a = 2", "b = 1"]);
  assert.deepEqual(newTextsOf({ oldText: "x", newText: "y" }), ["y"]);
  assert.equal(firstDifference("a\nb != 3\n", "a\nb == 3\n"), `line 2 reads "b != 3" instead of "b == 3"`);
  assert.equal(firstDifference("a\r\nb\r\n", "a\r\nb == 3\r\n"), `line 2 reads "b" instead of "b == 3"`);
});

test("edit check: a correct edit to a CRLF file is not taken for a corruption", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "watchdog-crlf-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = localWorkspace(dir);
  const tools = { ...fakeTools(honest), workspace };
  const [editTool] = createWorkspaceTools(workspace, ["edit"]);
  await writeFile(path.join(dir, "win.py"), "a = 1\r\nb = 2\r\n");
  const plugin = editCheckPlugin();
  const edit = call("edit", { path: "win.py", edits: [{ oldText: "a = 1\nb = 2", newText: "a = 1\nc = 3\nb = 2" }] });
  await plugin.before!(edit, tools);
  const outcome = await runTool(editTool!, edit.args);
  assert.equal(outcome.isError, false);
  assert.equal(await readFile(path.join(dir, "win.py"), "utf8"), "a = 1\r\nc = 3\r\nb = 2\r\n");
  assert.equal(await plugin.detect(edit, outcome, tools), null);
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
  assert.equal(result.isError, false);
  const [answer, where, changed] = result.output.trim().split("\n");
  assert.deepEqual([answer, changed], ["42", "changed"]);
  assert.notEqual(where, dir, "the command ran in the copy, even when it named the workspace by absolute path");
  assert.equal(await readFile(path.join(dir, "answer.txt"), "utf8"), "42\n");
  assert.deepEqual(await run("exit 3", 10), { output: "(no output)\n\nCommand exited with code 3", isError: true });
});

test("a rerun outside the agent's tools runs a command as the agent's bash tool does", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "watchdog-outside-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = outsideAgentTools(localWorkspace(dir), { defaultSeconds: 600, maxSeconds: 3600 });
  const [agentBash] = createWorkspaceTools(localWorkspace(dir), ["bash"]);
  for (const command of ["echo out; echo err >&2; exit 3", "false | cat", "python3 -c 'print(1)' | tail -1"]) {
    assert.deepEqual(await run(command, 10), await runTool(agentBash!, { command, timeout: 10 }), `the same result as the agent's tool: ${command}`);
  }
  assert.match((await run("echo out; echo err >&2", 10)).output, /out\nerr/, "stderr merged into the output in order");
  assert.equal((await run("pwd", 10)).output.trim(), dir);
  const long = await run("seq 1 5000", 10);
  assert.match(long.output, /\[Showing lines 3001-5000 of 5000\./, "cut as the agent's tool cuts it");
  assert.match((await run("sleep 5", 1)).output, /timed out after 1 seconds/);

  await writeFile(path.join(dir, "run.log"), "a\nb\nc\n");
  const read = await readOutsideAgentTools(localWorkspace(dir))({ path: "run.log", offset: 2, limit: 1 });
  assert.deepEqual([read.output.split("\n")[0], read.isError], ["b", false]);
  const raw = asToolOutput({ exitCode: 0, stdout: Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n"), stderr: "" });
  assert.match(raw, /\[Showing lines 1001-3000 of 3000\. /, "raw reruns are cut the same way");
});

test("the watchdog loop appends repair notes and replacements to what the agent gets, and records each step", async () => {
  const events: WatchdogEvent[] = [];
  const watchdog = createWatchdog({
    workspace: localWorkspace(tmpdir()),
    commandLimits: { defaultSeconds: 600, maxSeconds: 3600 },
    rerun: async () => ({ output: "real", isError: false }),
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

test("the watchdog loop runs edits to the same file one at a time, so parallel edits are not taken for corruption", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "watchdog-parallel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = localWorkspace(dir);
  await writeFile(path.join(dir, "f.py"), "a = 1\nb = 2\n");
  const events: WatchdogEvent[] = [];
  const watchdog = createWatchdog({
    workspace, plugins: [editCheckPlugin()], commandLimits: { defaultSeconds: 600, maxSeconds: 3600 },
    rerun: async () => ({ output: "", isError: false }), record: (event) => { events.push(event); },
  });
  const [editTool] = createWorkspaceTools(workspace, ["edit"]);
  const edit = watchdog.forStage("execute", () => "S1")(editTool!);
  // Pi runs a turn's edits in parallel; both start before either finishes.
  await Promise.all([
    edit.execute("e1", { path: "f.py", edits: [{ oldText: "a = 1", newText: "a = 10" }] }, undefined, undefined, undefined as never),
    edit.execute("e2", { path: "f.py", edits: [{ oldText: "b = 2", newText: "b = 20" }] }, undefined, undefined, undefined as never),
  ]);
  assert.equal(await readFile(path.join(dir, "f.py"), "utf8"), "a = 10\nb = 20\n");
  assert.deepEqual(events, []);
});

test("the watchdog loop keeps an image the read tool returned outside the agent's tools", async () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  const watchdog = createWatchdog({
    workspace: localWorkspace(tmpdir()), commandLimits: { defaultSeconds: 600, maxSeconds: 3600 },
    rerun: async () => ({ output: "", isError: false }), record: () => {},
    plugins: [{
      name: "around",
      instead: () => ({ reason: "r", note: "[watchdog] read outside", replacement: { output: "", isError: false, content: [image] } }),
      detect: () => null, confirm: async () => ({ confirmed: false, reason: "" }), repair: async () => ({ note: "" }),
    }],
  });
  const read = watchdog.forStage("execute", () => "S1")({
    name: "read", label: "read", description: "", parameters: {}, execute: async () => ({ content: [], details: undefined }),
  } as unknown as ToolDefinition);
  const result = await read.execute("r1", { path: "plot" }, undefined, undefined, undefined as never);
  assert.deepEqual(result.content, [image, { type: "text", text: "\n\n[watchdog] read outside" }]);
});

test("the watchdog loop runs a call a plug-in handles instead without the agent's tool", async () => {
  const events: WatchdogEvent[] = [];
  let ran = 0;
  const watchdog = createWatchdog({
    workspace: localWorkspace(tmpdir()),
    commandLimits: { defaultSeconds: 600, maxSeconds: 3600 },
    rerun: async () => ({ output: "real", isError: false }),
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
