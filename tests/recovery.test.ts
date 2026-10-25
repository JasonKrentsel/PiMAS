import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { cancelInterruptedWork } from "../src_old/storage/recovery.js";

test("startup cancels interrupted JSONL work after reopening its storage", async () => {
  const context = BACKGROUND_CONTEXT;
  const dataDirectory = path.resolve("data");
  await mkdir(dataDirectory, { recursive: true });
  const storageDirectory = await mkdtemp(path.join(dataDirectory, "recovery-test-"));
  let executed = false;
  let aborted = false;
  const task = defineTask<null, { phase: "work" }, null>({
    name: "saved-worker",
    version: 1,
    initial: () => ({ phase: "work" }),
    phases: {
      work: async (_task, runtime, callContext) => {
        executed = true;
        await runtime.commit(() => ({
          status: "terminal",
          outcome: { status: "completed", result: null },
        }), callContext);
      },
    },
    abort: async (_task, runtime, callContext) => {
      aborted = true;
      await runtime.commit(() => ({
        status: "terminal",
        outcome: { status: "aborted" },
      }), callContext);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "saved-worker", tasks: [task] }));
  let harness: Harness | undefined;

  async function openHarness(): Promise<Harness> {
    const storage = await openNodeJsonlStorage(storageDirectory, context);
    return Harness.open(storage, { models: createModels(), registry }, context);
  }

  try {
    harness = await openHarness();
    const root = await harness.root(context);
    const id = await root.commit((tx) => tx.createTask(task, null, {
      ownership: { kind: "conversation" },
    }), context);
    assert.equal((await harness.inspect(context)).scheduling, "paused");

    // Leave the task pending on disk, then simulate the next process opening it.
    await harness.close(context);
    harness = await openHarness();

    assert.equal(await cancelInterruptedWork(harness, context), true);
    assert.equal(executed, false);
    assert.equal(aborted, true);
    assert.equal((await harness.getTask(id, context))!.state.status, "terminal");
    assert.equal(await cancelInterruptedWork(harness, context), false);
  } finally {
    await harness?.close(context);
    assert.equal(path.dirname(storageDirectory), dataDirectory);
    await rm(storageDirectory, { recursive: true, force: true });
  }
});
