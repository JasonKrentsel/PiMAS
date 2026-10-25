import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const AGENT_ROLES = ["orchestrator", "planner", "executor", "reviewer"] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export interface AgentProfile {
  provider: string;
  model: string;
  thinkingLevel: AgentSession["thinkingLevel"];
  systemPrompt: string;
}

export interface AgentConfig {
  roles: Record<AgentRole, AgentProfile>;
}

const THINKING_LEVELS: readonly AgentProfile["thinkingLevel"][] = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

/** Role preferences only: tool permissions are enforced by the application. */
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
  checkFields(roles, AGENT_ROLES, "roles");
  const directory = dirname(configFile);
  return {
    roles: {
      orchestrator: profile(roles.orchestrator, "orchestrator", directory),
      planner: profile(roles.planner, "planner", directory),
      executor: profile(roles.executor, "executor", directory),
      reviewer: profile(roles.reviewer, "reviewer", directory),
    },
  };
}

function profile(value: unknown, role: AgentRole, directory: string): AgentProfile {
  const label = `roles.${role}`;
  const entry = object(value, label);
  checkFields(entry, ["provider", "model", "thinkingLevel", "systemPrompt"], label);
  const thinkingLevel = string(entry.thinkingLevel, `${label}.thinkingLevel`);
  if (!THINKING_LEVELS.includes(thinkingLevel as AgentProfile["thinkingLevel"])) {
    throw new Error(`${label}.thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return {
    provider: string(entry.provider, `${label}.provider`),
    model: string(entry.model, `${label}.model`),
    thinkingLevel: thinkingLevel as AgentProfile["thinkingLevel"],
    systemPrompt: resolve(directory, string(entry.systemPrompt, `${label}.systemPrompt`)),
  };
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
