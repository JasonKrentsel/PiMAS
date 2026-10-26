import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadAgentConfig } from "./agent-config.js";
import { TaskRun } from "./task-run.js";

interface TaskMessage {
  type: "task";
  task_id: string;
  attempt_id: string;
  container_id: string;
  cwd: string;
  prompt: string;
}

async function readTask(): Promise<TaskMessage> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      const task: unknown = JSON.parse(line);
      if (!task || typeof task !== "object") break;
      const value = task as Record<string, unknown>;
      if (value.type !== "task" ||
          !["task_id", "attempt_id", "container_id", "cwd", "prompt"].every(
            (key) => typeof value[key] === "string" && (value[key] as string).trim())) break;
      if (path.resolve(value.cwd as string) !== process.cwd()) {
        throw new Error("Task workspace does not match the bridge working directory");
      }
      return value as unknown as TaskMessage;
    }
    throw new Error("Expected one task message with task, attempt, and container identity");
  } finally {
    input.close();
    process.stdin.pause();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    models: { type: "string" }, agents: { type: "string" },
    state: { type: "string", default: "/pimas-state" }, resume: { type: "boolean", default: false },
  } });
  if (!values.models || !values.agents) throw new Error("Provide explicit --models and --agents files");
  const task = await readTask();
  const state = path.resolve(values.state);
  const expected = { taskId: task.task_id, attemptId: task.attempt_id, containerId: task.container_id };
  const attempt = JSON.parse(await readFile(path.join(state, "attempt.json"), "utf8"));
  if (process.env.PIMAS_CONTAINER_ID !== expected.containerId ||
      Object.entries(expected).some(([key, value]) => attempt[key] !== value)) {
    throw new Error("Task attempt or container identity does not match mounted state");
  }
  const bindingFile = path.join(state, "run-binding.json");
  if (values.resume) {
    const binding = JSON.parse(await readFile(bindingFile, "utf8"));
    if (Object.entries(expected).some(([key, value]) => binding[key] !== value)) {
      throw new Error("Cannot resume this conversation against another task attempt or container");
    }
  } else {
    await writeFile(bindingFile, JSON.stringify(expected, null, 2), { flag: "wx" });
  }
  const { roles } = await loadAgentConfig(path.resolve(values.agents));
  const options = { directory: path.join(state, "run"), cwd: task.cwd, modelsFile: path.resolve(values.models), roles };
  let run: TaskRun | undefined;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    void run?.dispose().catch((error: unknown) => console.error("PiMAS shutdown:", error));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    run = values.resume ? await TaskRun.resume(options) : await TaskRun.create({ ...options, request: task.prompt });
    if (interrupted) throw new Error("Task attempt interrupted during setup");
    const report = await run.execute();
    if (interrupted) throw new Error("Task attempt interrupted");
    await writeFile(path.join(state, "report.txt"), report + "\n");
  } finally {
    try { await run?.dispose(); } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}

// SDK diagnostics must never become wire-protocol messages.
const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
try {
  await main();
  protocolWrite(JSON.stringify({ type: "done" }) + "\n");
} catch (error) {
  console.error(`PiMAS attempt failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
