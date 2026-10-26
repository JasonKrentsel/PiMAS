import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentRole } from "../src/agent-config.js";
import { RunStore, type AgentStatus, type CheckpointAgent } from "../src/run-store.js";
import { acceptPlan, assertWorkerAllowed, beginWorker, completionProblem, resolveAssignment, submitReview } from "../src/workflow.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pimas-workflow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return RunStore.create({ directory, cwd: directory, modelsFile: path.join(directory, "models.json") });
}

function add(store: RunStore, id: string, role: AgentRole, status: AgentStatus = "settled"): CheckpointAgent {
  const revision = beginWorker(store, role);
  const agent: CheckpointAgent = { id, role, status, assignment: `Assignment ${id}`, report: `Evidence ${id}` };
  if (revision !== undefined) agent.revision = revision;
  store.addAgent(agent);
  return agent;
}

async function execution(t: TestContext) {
  const store = await fixture(t);
  add(store, "planner", "planner");
  await acceptPlan(store, ["planner"], "Implement and test the requested feature.");
  add(store, "executor", "executor");
  return store;
}

test("execution requires an accepted plan backed by a settled planner", async (t) => {
  const store = await fixture(t);
  assert.throws(() => assertWorkerAllowed(store, "executor"), /Accept a plan/);
  assert.throws(() => assertWorkerAllowed(store, "reviewer"), /settled execution/);
  await assert.rejects(acceptPlan(store, ["missing"], "Invented plan"), /not a required settled planner/);
  const planner = add(store, "planner", "planner", "running");
  await assert.rejects(acceptPlan(store, ["planner"], "Premature plan"), /settled planner/);
  planner.status = "settled";
  await acceptPlan(store, ["planner"], "Implement and test.");
  assert.doesNotThrow(() => assertWorkerAllowed(store, "executor"));
  assert.throws(() => assertWorkerAllowed(store, "reviewer"), /settled execution/);
  const reopened = await RunStore.open(store.directory);
  assert.equal(reopened.workflow.plan?.text, "Implement and test.");
});

test("review needs settled execution and verdict alone cannot finish a running reviewer", async (t) => {
  const store = await execution(t);
  store.agent("executor")!.status = "running";
  assert.throws(() => assertWorkerAllowed(store, "reviewer"), /settled execution/);
  store.agent("executor")!.status = "settled";
  assert.match(completionProblem(store)!, /no independent review/);
  const reviewer = add(store, "reviewer", "reviewer", "running");
  await submitReview(store, reviewer.id, true, "Inspected the implementation and saved test evidence.");
  assert.match(completionProblem(store)!, /Unresolved/);
  reviewer.status = "settled";
  assert.equal(completionProblem(store), undefined);
  await store.save();
  assert.equal(completionProblem(await RunStore.open(store.directory)), undefined);
});

test("all current reviewers must approve; a new execution invalidates both approvals and rejections", async (t) => {
  const store = await execution(t);
  const first = add(store, "review-1", "reviewer", "running");
  await submitReview(store, first.id, true, "Looks correct.");
  first.status = "settled";
  const second = add(store, "review-2", "reviewer", "running");
  await submitReview(store, second.id, false, "Missing an edge case.");
  second.status = "settled";
  assert.match(completionProblem(store)!, /Every reviewer/);
  add(store, "correction", "executor");
  assert.match(completionProblem(store)!, /no independent review/);
  const fresh = add(store, "review-3", "reviewer", "running");
  await submitReview(store, fresh.id, true, "Edge case fixed and test evidence checked.");
  fresh.status = "settled";
  assert.equal(completionProblem(store), undefined);
});

test("execution can overlap without a worker cap; review is stale if execution restarts", async (t) => {
  const store = await execution(t);
  const reviewer = add(store, "reviewer", "reviewer", "running");
  const a = add(store, "exec-a", "executor", "running");
  const b = add(store, "exec-b", "executor", "running");
  assert.equal(b.revision, a.revision! + 1);
  await assert.rejects(submitReview(store, reviewer.id, true, "Old workspace."), /stale/);
  assert.match(completionProblem(store)!, /Unresolved/);
});

test("interrupted/failed work needs explicit resolution, and settled rejected review cannot be retired", async (t) => {
  const store = await fixture(t);
  const planner = add(store, "planner", "planner", "interrupted");
  assert.match(completionProblem(store)!, /interrupted/);
  await assert.rejects(resolveAssignment(store, planner.id, ""), /Explain why/);
  await resolveAssignment(store, planner.id, "Task changed; this investigation is no longer needed.");
  assert.equal(completionProblem(store), undefined);
  const implemented = await execution(t);
  add(implemented, "reviewer", "reviewer");
  await assert.rejects(resolveAssignment(implemented, "reviewer", "Ignore its rejection"), /Only failed or interrupted/);
  assert.match(completionProblem(implemented)!, /explicitly approve/);
});

test("changing the accepted plan after execution requires fresh execution", async (t) => {
  const store = await execution(t);
  await acceptPlan(store, ["planner"], "Revised scope needs another change.");
  assert.match(completionProblem(store)!, /No current execution evidence/);
  assert.throws(() => assertWorkerAllowed(store, "reviewer"), /current accepted plan/);
});

test("version-1 migration preserves history without manufacturing review evidence", async (t) => {
  const store = await fixture(t);
  const legacy = JSON.parse(await readFile(store.file, "utf8"));
  legacy.version = 1;
  delete legacy.workflow;
  await writeFile(store.file, JSON.stringify(legacy));
  const opened = await RunStore.open(store.directory);
  assert.deepEqual(opened.workflow, { revision: 0 });
  await opened.save();
  assert.equal(JSON.parse(await readFile(store.file, "utf8")).version, 2);
});

test("malformed workflow state is rejected on reopen", async (t) => {
  const store = await fixture(t);
  const state = JSON.parse(await readFile(store.file, "utf8"));
  for (const workflow of [{ revision: -1 }, { revision: 0, plan: { text: "Plan", plannerIds: ["missing"] } }]) {
    await writeFile(store.file, JSON.stringify({ ...state, workflow }));
    await assert.rejects(RunStore.open(store.directory), /Invalid workflow checkpoint/);
  }
});
