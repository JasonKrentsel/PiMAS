import path from "node:path";

export interface AppConfig {
  cwd: string;
  maxParallel: number;
  taskTimeoutMs: number;
  storage: "memory" | "jsonl";
  storageDirectory: string;
  model: {
    baseUrl: string;
    id: string;
    apiKey: string;
  };
}

/** Read environment variables once, before starting conversations. */
export function loadConfig(): AppConfig {
  const cwd = path.resolve(process.env.PIMAS_CWD ?? process.cwd());

  return {
    cwd,
    maxParallel: readPositiveInteger("PIMAS_MAX_PARALLEL", 4, 32),
    taskTimeoutMs: readPositiveInteger("PIMAS_TASK_TIMEOUT_MS", 300_000, 2_147_483_647),
    storage: process.env.PIMAS_STORAGE === "memory" ? "memory" : "jsonl",
    storageDirectory: path.resolve(cwd, process.env.PIMAS_STORAGE_DIR ?? "data/sessions"),
    model: {
      baseUrl: process.env.PIMAS_BASE_URL ?? "http://127.0.0.1:1234/v1",
      id: process.env.PIMAS_MODEL ?? "local-model",
      apiKey: process.env.OPENAI_API_KEY ?? "local",
    },
  };
}

function readPositiveInteger(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }

  return value;
}
