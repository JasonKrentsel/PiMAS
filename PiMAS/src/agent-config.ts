import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const AGENT_ROLES = ["orchestrator", "planner", "executor", "reviewer"] as const;
/** Used only by the fixed-stage pipeline; TaskRun configurations may omit it. */
export const OPTIONAL_ROLES = ["researcher"] as const;
export type AgentRole = typeof AGENT_ROLES[number] | typeof OPTIONAL_ROLES[number];

export interface AgentProfile {
  provider: string;
  model: string;
  thinkingLevel: AgentSession["thinkingLevel"];
  systemPrompt: string;
  extensions?: string[];
}

export interface AgentConfig {
  roles: Record<typeof AGENT_ROLES[number], AgentProfile> & Partial<Record<typeof OPTIONAL_ROLES[number], AgentProfile>>;
}

const THINKING_LEVELS: readonly AgentProfile["thinkingLevel"][] = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

/** Explicit role profiles. Extensions are trusted executable code, not permission settings. */
export async function loadAgentConfig(file: string): Promise<AgentConfig> {
  const configFile = resolve(file);
  const content = await readFile(configFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid agents configuration: ${configFile}. Expected valid JSON.`);
  }
  const root = object(parsed, "agents configuration");
  checkFields(root, ["roles"], "agents configuration");
  const roles = object(root.roles, "roles");
  checkFields(roles, [...AGENT_ROLES, ...OPTIONAL_ROLES], "roles");
  const directory = dirname(configFile);
  return {
    roles: {
      orchestrator: profile(roles.orchestrator, "orchestrator", directory),
      planner: profile(roles.planner, "planner", directory),
      executor: profile(roles.executor, "executor", directory),
      reviewer: profile(roles.reviewer, "reviewer", directory),
      ...(roles.researcher === undefined ? {} : { researcher: profile(roles.researcher, "researcher", directory) }),
    },
  };
}

function profile(value: unknown, role: AgentRole, directory: string): AgentProfile {
  const label = `roles.${role}`;
  const entry = object(value, label);
  checkFields(entry, ["provider", "model", "thinkingLevel", "systemPrompt", "extensions"], label);
  const thinkingLevel = string(entry.thinkingLevel, `${label}.thinkingLevel`);
  if (!THINKING_LEVELS.includes(thinkingLevel as AgentProfile["thinkingLevel"])) {
    throw new Error(`${label}.thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return {
    provider: string(entry.provider, `${label}.provider`),
    model: string(entry.model, `${label}.model`),
    thinkingLevel: thinkingLevel as AgentProfile["thinkingLevel"],
    systemPrompt: resolve(directory, string(entry.systemPrompt, `${label}.systemPrompt`)),
    extensions: extensionPaths(entry.extensions, `${label}.extensions`, directory),
  };
}

function extensionPaths(value: unknown, label: string, directory: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of paths`);
  return value.map((entry, index) => resolve(directory, string(entry, `${label}[${index}]`)));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function checkFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
}
