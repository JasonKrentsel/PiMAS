import { spawn } from "node:child_process";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  boundedBashOperations,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  type CommandLimits,
} from "./execution-tools.js";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * One bash command in the task workspace. The pipeline never touches the workspace
 * filesystem directly, so the same tools work locally and inside a Harbor container.
 * Implementations enforce `timeoutSeconds` themselves and report a timeout as exit code 124.
 */
export interface Workspace {
  cwd: string;
  exec(command: string, options?: { timeoutSeconds?: number; signal?: AbortSignal }): Promise<ExecResult>;
}

export type WorkspaceToolName = "read" | "grep" | "find" | "ls" | "edit" | "write" | "bash";

const FILE_COMMAND_TIMEOUT_SECONDS = 60;
// Linux limits one argv string to 128 KiB, and Harbor passes each command as one argument.
const WRITE_CHUNK_BYTES = 48 * 1024;
const MAX_READ_BYTES = 50 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LISTED_FILES = 200_000;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Host bash, for tests and local experiments. Not a sandbox. */
export function localWorkspace(cwd: string): Workspace {
  return {
    cwd,
    exec(command, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ } };
        let timedOut = false;
        const timer = options.timeoutSeconds === undefined
          ? undefined
          : setTimeout(() => { timedOut = true; kill(); }, options.timeoutSeconds * 1000);
        const onAbort = () => kill();
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", reject);
        child.on("close", (code, signal) => {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          if (options.signal?.aborted) return reject(new Error("Command aborted"));
          resolve({
            exitCode: timedOut ? 124 : code ?? (signal ? 128 + 9 : 1),
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
      });
    },
  };
}

/** Pi bash operations that run in the workspace instead of on the host. */
export function workspaceBashOperations(workspace: Workspace): BashOperations {
  return {
    async exec(command, cwd, options) {
      // Merge streams like a terminal and keep only the tail the model can use.
      const wrapped = `set -o pipefail; cd ${shellQuote(cwd)} && { bash -c ${shellQuote(command)}; } 2>&1 | tail -c ${MAX_COMMAND_OUTPUT_BYTES}`;
      const result = await workspace.exec(wrapped, {
        ...(options.timeout === undefined ? {} : { timeoutSeconds: options.timeout }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const output = result.stdout + result.stderr;
      if (output) options.onData(Buffer.from(output));
      if (result.exitCode === 124) options.onData(Buffer.from(`\nCommand timed out after ${options.timeout} seconds\n`));
      return { exitCode: result.exitCode };
    },
  };
}

/** Pi's native tool definitions backed by workspace commands instead of the host filesystem. */
export function createWorkspaceTools(
  workspace: Workspace,
  names: readonly WorkspaceToolName[],
  limits: CommandLimits = { defaultSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS, maxSeconds: MAX_COMMAND_TIMEOUT_SECONDS },
): ToolDefinition[] {
  const run = async (command: string) => {
    const result = await workspace.exec(command, { timeoutSeconds: FILE_COMMAND_TIMEOUT_SECONDS });
    if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout).trim() || `Command failed with exit code ${result.exitCode}`);
    return result.stdout;
  };
  const succeeds = async (command: string) =>
    (await workspace.exec(command, { timeoutSeconds: FILE_COMMAND_TIMEOUT_SECONDS })).exitCode === 0;
  const readFile = async (file: string) => {
    const size = Number((await run(`wc -c < ${shellQuote(file)}`)).trim());
    if (size > MAX_READ_BYTES) throw new Error(`${file} is ${size} bytes; inspect it with bash (head, sed, grep) instead`);
    return Buffer.from((await run(`base64 < ${shellQuote(file)} | tr -d '\\n'`)).trim(), "base64");
  };
  const writeFile = async (file: string, content: string) => {
    const bytes = Buffer.from(content, "utf8");
    const temporary = `${file}.pimas-${process.pid}-${Date.now()}`;
    for (let offset = 0; offset === 0 || offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + WRITE_CHUNK_BYTES).toString("base64");
      await run(`printf %s ${shellQuote(chunk)} | base64 -d ${offset === 0 ? ">" : ">>"} ${shellQuote(temporary)}`);
    }
    // Copy into place so an existing file keeps its owner and mode.
    await run(`cat ${shellQuote(temporary)} > ${shellQuote(file)} && rm -f ${shellQuote(temporary)}`);
  };
  const directories = new Map<string, Set<string>>();

  const definitions: Record<WorkspaceToolName, () => ToolDefinition> = {
    read: () => createReadToolDefinition(workspace.cwd, { operations: {
      readFile,
      access: async (file) => { await run(`test -r ${shellQuote(file)}`); },
      detectImageMimeType: async (file) => {
        const header = Buffer.from((await run(`head -c 12 ${shellQuote(file)} | base64 | tr -d '\\n'`)).trim(), "base64");
        return imageMimeType(header);
      },
    } }) as unknown as ToolDefinition,
    write: () => createWriteToolDefinition(workspace.cwd, { operations: {
      writeFile,
      mkdir: async (dir) => { await run(`mkdir -p ${shellQuote(dir)}`); },
    } }) as unknown as ToolDefinition,
    edit: () => createEditToolDefinition(workspace.cwd, { operations: {
      readFile,
      writeFile,
      access: async (file) => { await run(`test -r ${shellQuote(file)} && test -w ${shellQuote(file)}`); },
    } }) as unknown as ToolDefinition,
    ls: () => createLsToolDefinition(workspace.cwd, { operations: {
      exists: (target) => succeeds(`test -e ${shellQuote(target)}`),
      stat: async (target) => {
        const parent = directories.get(path.posix.dirname(target));
        const name = path.posix.basename(target);
        if (parent?.has(name)) return { isDirectory: () => true };
        if (parent) return { isDirectory: () => false };
        const directory = await succeeds(`test -d ${shellQuote(target)}`);
        return { isDirectory: () => directory };
      },
      // One command per listing; `ls -p` marks directories so per-entry stats need no round trip.
      readdir: async (dir) => {
        const entries = (await run(`ls -1Ap ${shellQuote(dir)}`)).split("\n").filter(Boolean);
        directories.set(dir, new Set(entries.filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1))));
        return entries.map((entry) => entry.replace(/\/$/, ""));
      },
    } }) as unknown as ToolDefinition,
    find: () => createFindToolDefinition(workspace.cwd, { operations: {
      exists: (target) => succeeds(`test -e ${shellQuote(target)}`),
      glob: async (pattern, cwd, options) => {
        const listing = await run(
          `find ${shellQuote(cwd)} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | head -n ${MAX_LISTED_FILES}`,
        );
        const matches: string[] = [];
        for (const file of listing.split("\n")) {
          if (!file) continue;
          const relative = path.posix.relative(cwd, file);
          if (options.ignore.some((ignored) => path.posix.matchesGlob(relative, ignored))) continue;
          const subject = pattern.includes("/") ? relative : path.posix.basename(relative);
          if (path.posix.matchesGlob(subject, pattern)) matches.push(relative);
          if (matches.length >= options.limit) break;
        }
        return matches;
      },
    } }) as unknown as ToolDefinition,
    // Pi's grep always spawns a local ripgrep, so the workspace version shells out instead.
    grep: () => createWorkspaceGrepTool(workspace),
    bash: () => createBashToolDefinition(workspace.cwd, {
      operations: boundedBashOperations(workspaceBashOperations(workspace), limits),
      // Host PI_* variables would not reach the workspace anyway.
      exposeSessionEnvironment: false,
    }) as unknown as ToolDefinition,
  };
  return names.map((name) => {
    const definition = definitions[name]();
    if (name !== "bash") return definition;
    return defineTool({
      ...definition,
      executionMode: "sequential",
      description: `${definition.description} Timeout defaults to ${limits.defaultSeconds} seconds and is capped at ${limits.maxSeconds} seconds. A timeout stops the command; effects already performed are not undone.`,
    }) as unknown as ToolDefinition;
  });
}

function createWorkspaceGrepTool(workspace: Workspace): ToolDefinition {
  return defineTool({
    name: "grep",
    label: "Grep",
    description: "Search file contents in the workspace. Uses ripgrep when installed, otherwise grep -rn. Returns file:line:text matches.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
      path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
      glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
      context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matching lines to return (default: 100)" })),
    }),
    async execute(_id, params, signal) {
      const target = shellQuote(path.posix.resolve(workspace.cwd, params.path ?? "."));
      const limit = Math.max(1, Math.floor(params.limit ?? 100));
      const context = Math.max(0, Math.floor(params.context ?? 0));
      const pattern = shellQuote(params.pattern);
      const rg = ["rg", "-n", "--no-heading", "--color=never", "-C", String(context),
        params.ignoreCase ? "-i" : "", params.literal ? "-F" : "",
        params.glob ? `-g ${shellQuote(params.glob)}` : "", "-e", pattern, target].filter(Boolean).join(" ");
      const grep = ["grep", "-rn", params.literal ? "-F" : "-E", "-C", String(context), "--exclude-dir=.git", "--exclude-dir=node_modules",
        params.ignoreCase ? "-i" : "",
        params.glob ? `--include=${shellQuote(path.posix.basename(params.glob))}` : "", "-e", pattern, target].filter(Boolean).join(" ");
      const result = await workspace.exec(
        `if command -v rg >/dev/null 2>&1; then ${rg}; else ${grep}; fi | head -n ${limit * (2 * context + 2)}`,
        { timeoutSeconds: FILE_COMMAND_TIMEOUT_SECONDS, ...(signal ? { signal } : {}) },
      );
      const text = result.stdout.trim() || (result.stderr.trim() ? `grep failed: ${result.stderr.trim()}` : "No matches found");
      return { content: [{ type: "text", text }], details: undefined };
    },
  }) as unknown as ToolDefinition;
}

function imageMimeType(header: Buffer): string | undefined {
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (header.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}
