import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { createAgentTools } from "../src_old/agents/tools.js";
import { Orchestrator } from "../src_old/orchestration/orchestrator.js";
import { scopesOverlap } from "../src_old/orchestration/plan.js";
import type { AgentTask, Phase, TaskSpec } from "../src_old/orchestration/types.js";

function task(id: string, options: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: id,
    role: "executor",
    instructions: `Do ${id}`,
    files: [id],
    dependsOn: [],
    ...options,
  };
}

function plan(tasks: TaskSpec[], reviewId = "review"): Phase[] {
  return [
    { title: "Build", tasks },
    {
      title: "Review",
      tasks: [task(reviewId, { role: "reviewer", files: [] })],
    },
  ];
}

interface PendingWorker {
  resolve(text: string): void;
  reject(error: Error): void;
}

async function fixture(limit = 4) {
  const active = new Map<string, PendingWorker>();
  const started: AgentTask[] = [];
  const sent: { id: string; message: string }[] = [];
  const runtime = new Orchestrator("Build the feature", {
    run: async (assignment) => {
      started.push(assignment);
      return new Promise<string>((resolve, reject) => {
        active.set(assignment.id, { resolve, reject });
      });
    },
    send: async (id, message) => {
      sent.push({ id, message });
    },
  }, { maxParallel: limit });
  // Resolve planning first so each test can focus on its executor/reviewer plan.
  runtime.start();
  await setImmediate();
  active.get("planner")!.resolve("Build frontend and backend in parallel, then review.");
  await setImmediate();
  return { runtime, active, started, sent };
}

test("starts independent workers up to the limit; review waits for the whole build phase", async () => {
  const { runtime, active, started } = await fixture(2);
  runtime.setPlan(plan([task("frontend"), task("backend"), task("docs")]));
  await setImmediate();
  assert.deepEqual(started.map((item) => item.id), ["planner", "frontend", "backend"]);
  active.get("frontend")!.resolve("frontend done");
  await setImmediate();
  assert.equal(started.at(-1)!.id, "docs");
  active.get("docs")!.resolve("docs done");
  await setImmediate();
  assert.ok(!started.some((item) => item.id === "review"));
  active.get("backend")!.resolve("backend done");
  await setImmediate();
  assert.equal(started.at(-1)!.id, "review");
  assert.ok(runtime.finalBlocker());
  runtime.review("review", { approved: true, feedback: "Meets acceptance criteria" });
  active.get("review")!.resolve("approved");
  await setImmediate();
  assert.equal(runtime.isComplete(), true);
  assert.equal(runtime.finalBlocker(), undefined);
});

test("dependencies and overlapping directories serialize executors", async () => {
  const { runtime, active, started } = await fixture();
  runtime.setPlan(plan([
    task("api", { files: ["src/api"] }),
    task("handler", { files: ["src/api/handler.ts"] }),
    task("client", { files: ["src/client"], dependsOn: ["api"] }),
  ]));
  await setImmediate();
  assert.deepEqual(started.map((item) => item.id), ["planner", "api"]);
  active.get("api")!.resolve("API contract ready");
  await setImmediate();
  assert.deepEqual(started.slice(-2).map((item) => item.id), ["handler", "client"]);
  runtime.stop("test ended");
});

test("questions wake the orchestrator early; peers communicate only through its relay", async () => {
  const { runtime, active, sent } = await fixture();
  runtime.setPlan(plan([task("frontend"), task("backend")]));
  await setImmediate();
  await runtime.waitForUpdates();
  const updates = runtime.waitForUpdates();
  const question = runtime.messageOrchestrator("frontend", "Ask backend: which endpoint?", true);
  const received = await updates;
  assert.equal(received[0]!.type, "question");
  assert.equal(runtime.snapshot().tasks.find((item) => item.id === "frontend")!.status, "waiting");
  await runtime.send("backend", "Frontend asks which endpoint to use");
  assert.deepEqual(sent, [{ id: "backend", message: "Message from the orchestrator:\nFrontend asks which endpoint to use" }]);
  await runtime.messageOrchestrator("backend", "Use GET /api/items", false);
  runtime.reply(received[0]!.questionId!, "Backend says GET /api/items");
  assert.equal(await question, "Backend says GET /api/items");
  assert.equal(runtime.snapshot().pendingQuestions.length, 0);
  active.get("backend")!.resolve("done");
  runtime.stop("test ended");
});

test("failed work blocks review; replacement plans cancel obsolete queued tasks", async () => {
  const { runtime, active, started } = await fixture(1);
  runtime.setPlan(plan([task("broken"), task("obsolete", { dependsOn: ["broken"] })]));
  await setImmediate();
  active.get("broken")!.reject(new Error("Build failed"));
  await setImmediate();
  assert.ok(runtime.finalBlocker());
  assert.ok(!started.some((item) => item.id === "review"));
  runtime.setPlan(plan([task("fix")], "re-review"));
  await setImmediate();
  assert.equal(runtime.snapshot().tasks.find((item) => item.id === "obsolete")!.status, "cancelled");
  assert.equal(started.at(-1)!.id, "fix");
  runtime.stop("test ended");
});

test("review rejection requires a fix plan and a new approved review", async () => {
  const { runtime, active } = await fixture();
  runtime.setPlan(plan([task("build")]));
  await setImmediate();
  active.get("build")!.resolve("done");
  await setImmediate();
  runtime.review("review", { approved: false, feedback: "Missing validation" });
  active.get("review")!.resolve("rejected");
  await setImmediate();
  assert.equal(runtime.isComplete(), false);
  runtime.setPlan(plan([task("fix")], "review2"));
  await setImmediate();
  active.get("fix")!.resolve("fixed");
  await setImmediate();
  runtime.review("review2", { approved: true, feedback: "Validated" });
  active.get("review2")!.resolve("approved");
  await setImmediate();
  assert.equal(runtime.isComplete(), true);
});

test("a reviewer cannot silently finish without a structured verdict", async () => {
  const { runtime, active } = await fixture();
  runtime.setPlan(plan([task("build")]));
  await setImmediate();
  active.get("build")!.resolve("done");
  await setImmediate();
  active.get("review")!.resolve("looks good");
  await setImmediate();
  assert.equal(runtime.snapshot().tasks.at(-1)!.status, "failed");
  assert.equal(runtime.isComplete(), false);
});

test("validates cycles, future dependencies, unsafe scopes, and missing review before starting work", async () => {
  const { runtime, started } = await fixture();
  assert.throws(() => runtime.setPlan(plan([task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })])), /cycle/);
  assert.throws(() => runtime.setPlan(plan([task("a", { dependsOn: ["review"] })])), /Invalid dependency/);
  assert.throws(() => runtime.setPlan(plan([task("a", { files: ["../outside"] })])), /relative/);
  assert.throws(() => runtime.setPlan([{ title: "Only build", tasks: [task("a")] }]), /final phase/);
  assert.equal(started.length, 1);
  runtime.stop("test ended");
});

test("cancellation rejects pending questions and prevents queued work from starting", async () => {
  const { runtime, active, started } = await fixture(1);
  runtime.setPlan(plan([task("a"), task("b")]));
  await setImmediate();
  const question = runtime.messageOrchestrator("a", "Need help", true);
  const rejection = assert.rejects(question, /User stopped/);
  runtime.stop("User stopped");
  await rejection;
  active.get("a")!.resolve("late answer");
  await setImmediate();
  assert.equal(started.length, 2);
  assert.equal(runtime.snapshot().tasks.find((item) => item.id === "a")!.status, "cancelled");
  assert.equal(runtime.finalBlocker(), undefined);
});

test("worker toolsets cannot route messages, spawn peers, or edit plans", async () => {
  const { runtime } = await fixture();
  const rootId = 1 as ConversationId;
  const workerId = 2 as ConversationId;
  const tools = createAgentTools(runtime, rootId, new Map([[workerId, "planner"]]));
  for (const workerTools of Object.values(tools.workers)) {
    assert.ok(workerTools.some((tool) => tool.name === "message_orchestrator"));
    assert.ok(!workerTools.some((tool) => ["message_agent", "set_plan", "reply_to_agent", "stop_work"].includes(tool.name)));
  }
  for (const role of ["planner", "reviewer"] as const) {
    assert.ok(!tools.workers[role].some((tool) => ["write", "edit", "bash", "powershell"].includes(tool.name)));
  }
  const api = { conversationId: workerId } as ToolExecutionApi;
  const route = tools.rootTools.find((tool) => tool.name === "message_agent")!;
  await assert.rejects(route.execute({ taskId: "other", message: "bypass" }, api, BACKGROUND_CONTEXT), /Only the orchestrator/);
  runtime.stop("test ended");
});

test("scope matching recognizes directories without confusing sibling prefixes", () => {
  assert.equal(scopesOverlap(["src/api"], ["src/api/index.ts"]), true);
  assert.equal(scopesOverlap(["."], ["anything"]), true);
  assert.equal(scopesOverlap(["src/api"], ["src/api-client"]), false);
  assert.equal(scopesOverlap(["src\\api"], ["src/api/index.ts"]), true);
});
