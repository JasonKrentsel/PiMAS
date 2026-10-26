import assert from "node:assert/strict";
import test from "node:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  boundedBashOperations,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
} from "../src/execution-tools.js";

const TIMEOUT = { timeout: 15_000 };
const idleCommand = `"${process.execPath.replaceAll("\\", "/")}" -e 'setInterval(() => {}, 1000)'`;

test("shell policy defaults, caps, and preserves shorter timeouts and cancellation", async () => {
  const observed: Parameters<BashOperations["exec"]>[2][] = [];
  const delegate: BashOperations = {
    async exec(command, cwd, options) {
      assert.equal(command, "fixture command");
      assert.equal(cwd, process.cwd());
      observed.push(options);
      return { exitCode: 0 };
    },
  };
  const ops = boundedBashOperations(delegate);
  const controller = new AbortController();
  const onData = () => {};
  for (const timeout of [undefined, 0.5, 900]) {
    await ops.exec("fixture command", process.cwd(), {
      onData, signal: controller.signal, env: { FIXTURE: "yes" },
      ...(timeout === undefined ? {} : { timeout }),
    });
  }
  assert.deepEqual(observed.map((options) => options.timeout), [DEFAULT_COMMAND_TIMEOUT_SECONDS, 0.5, MAX_COMMAND_TIMEOUT_SECONDS]);
  for (const options of observed) {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.onData, onData);
    assert.deepEqual(options.env, { FIXTURE: "yes" });
  }
});

test("invalid shell timeouts fail before starting a process", async () => {
  const ops = boundedBashOperations({ exec: async () => { throw new Error("Must not execute"); } });
  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(ops.exec("unused", process.cwd(), { onData: () => {}, timeout }), /finite positive/);
  }
});

test("native shell stops a real long-running command on timeout", TIMEOUT, async () => {
  await assert.rejects(
    boundedBashOperations().exec(idleCommand, process.cwd(), { onData: () => {}, timeout: 0.2 }),
    /timeout:0.2/,
  );
});

test("native shell stops a real command on cancellation", TIMEOUT, async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    await assert.rejects(
      boundedBashOperations().exec(idleCommand, process.cwd(), { onData: () => {}, signal: controller.signal }),
      /aborted/,
    );
  } finally {
    clearTimeout(timer);
  }
});
