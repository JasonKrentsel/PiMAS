import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAgentConfig } from "./agent-config.js";
import { runPipeline, type PipelineResult } from "./pipeline.js";
import type { ExecResult, Workspace } from "./workspace.js";

/**
 * Host-side pipeline process for the Harbor agent. Wire protocol, one JSON object per line:
 *   in:  {"type":"task","prompt":string,"cwd":string}           (first line)
 *   out: {"type":"exec","id":number,"command":string,"timeout":number|null}
 *   in:  {"type":"exec_result","id":number,"exit_code":number,"stdout":string,"stderr":string}
 *   out: {"type":"cancel","id":number}                          (an aborted tool call)
 *   out: {"type":"done","status":string}
 * The relay runs each command in the task container; this process never sees that filesystem.
 */

type Send = (message: Record<string, unknown>) => void;

interface PendingExec {
  resolve: (result: ExecResult) => void;
  reject: (error: Error) => void;
}

function relayWorkspace(cwd: string, send: Send, pending: Map<number, PendingExec>, stopped: AbortSignal): Workspace {
  let nextId = 1;
  return {
    cwd,
    exec(command, options = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        // After shutdown starts the relay no longer answers, so fail fast instead of waiting.
        if (stopped.aborted) return reject(new Error("The relay has stopped"));
        if (options.signal?.aborted) return reject(new Error("Command aborted"));
        const onAbort = () => {
          pending.delete(id);
          send({ type: "cancel", id });
          reject(new Error("Command aborted"));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          resolve: (result) => { options.signal?.removeEventListener("abort", onAbort); resolve(result); },
          reject: (error) => { options.signal?.removeEventListener("abort", onAbort); reject(error); },
        });
        send({ type: "exec", id, command, timeout: options.timeoutSeconds ?? null });
      });
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

async function main(send: Send): Promise<PipelineResult> {
  const { values } = parseArgs({ options: {
    models: { type: "string" }, agents: { type: "string" }, state: { type: "string" },
    mode: { type: "string", default: "pipeline" }, review: { type: "boolean", default: false },
    "max-corrections": { type: "string", default: "1" },
    // Directory tracked for per-stage file changes inside the workspace; "none" disables it.
    "snapshot-root": { type: "string", default: "/" },
  } });
  if (!values.models || !values.agents || !values.state) throw new Error("Provide explicit --models, --agents, and --state");
  if (values.mode !== "pipeline" && values.mode !== "single") throw new Error("--mode must be pipeline or single");
  const maxCorrections = Number(values["max-corrections"]);
  if (!Number.isInteger(maxCorrections) || maxCorrections < 0) throw new Error("--max-corrections must be a non-negative integer");
  const state = path.resolve(values.state);
  await mkdir(state, { recursive: true });
  const { roles } = await loadAgentConfig(path.resolve(values.agents));

  const pending = new Map<number, PendingExec>();
  let task: { prompt: string; cwd: string } | undefined;
  let taskReady!: () => void;
  let inputFailed!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { taskReady = resolve; inputFailed = reject; });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const closePending = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  input.on("line", (line) => {
    try {
      const message = record(JSON.parse(line));
      if (!task) {
        if (message.type !== "task" || typeof message.prompt !== "string" || typeof message.cwd !== "string" || !message.cwd.startsWith("/")) {
          throw new Error("The first message must be a task with a prompt and an absolute cwd");
        }
        task = { prompt: message.prompt, cwd: message.cwd };
        taskReady();
      } else if (message.type === "exec_result" && typeof message.id === "number") {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        entry?.resolve({
          exitCode: typeof message.exit_code === "number" ? message.exit_code : 1,
          stdout: typeof message.stdout === "string" ? message.stdout : "",
          stderr: typeof message.stderr === "string" ? message.stderr : "",
        });
      } else {
        throw new Error(`Unexpected relay message type ${String(message.type)}`);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      inputFailed(failure);
      closePending(failure);
    }
  });
  input.on("close", () => {
    const failure = new Error("The relay closed its input");
    inputFailed(failure);
    closePending(failure);
  });
  await ready;

  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    closePending(new Error("The relay has stopped"));
  };
  input.on("close", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runPipeline({
      directory: state,
      workspace: relayWorkspace(task!.cwd, send, pending, controller.signal),
      modelsFile: path.resolve(values.models),
      roles,
      request: task!.prompt,
      mode: values.mode,
      review: values.review,
      maxCorrections,
      snapshotRoot: values["snapshot-root"] === "none" ? null : values["snapshot-root"],
      signal: controller.signal,
    });
    await writeFile(path.join(state, "summary.json"), JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    input.close();
  }
}

// SDK diagnostics must never become wire-protocol messages.
const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
const send: Send = (message) => { protocolWrite(JSON.stringify(message) + "\n"); };
try {
  const result = await main(send);
  send({ type: "done", status: result.status });
} catch (error) {
  console.error(`PiMAS pipeline failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  send({ type: "done", status: "error" });
  process.exitCode = 1;
}
