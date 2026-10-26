import { access, readFile } from "node:fs/promises";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentRole } from "./agent-config.js";
import { createExecutorBashTool } from "./execution-tools.js";

interface RoleSessionOptions {
  cwd: string;
  modelsFile: string;
  role: AgentRole;
  roles: AgentConfig["roles"];
  sessionManager: SessionManager;
  customTools?: ToolDefinition[];
}

/** The caller owns prompting, local history, and abort/dispose of each Pi session. */
export async function createRoleSession(options: RoleSessionOptions): Promise<AgentSession> {
  const profile = options.roles[options.role];
  const systemPrompt = (await readFile(profile.systemPrompt, "utf8")).trim();
  if (!systemPrompt) throw new Error(`System prompt is empty: ${profile.systemPrompt}`);

  // Pi treats a missing models file as optional; this application requires it.
  await access(options.modelsFile);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: options.modelsFile,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  if (modelRuntime.getError()) {
    // Do not echo parser diagnostics that might contain credential values.
    throw new Error(`Invalid models configuration: ${options.modelsFile}. Check JSON syntax and Pi's models schema.`);
  }
  const model = modelRuntime.getModel(profile.provider, profile.model);
  if (!model) {
    throw new Error(`Model ${profile.provider}/${profile.model} is unavailable in ${options.modelsFile}`);
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    // Use one retry budget, at the provider-request layer rather than both layers.
    retry: { enabled: false, provider: { maxRetries: 100 } },
    cacheWarming: "off",
    enableAnalytics: false,
  });

  // Explicit resources keep personal/project extensions and settings out of this baseline.
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const suppliedTools = options.customTools ?? [];
  const nativeNames = new Set(["read", "grep", "find", "ls", "write", "edit", "bash", "powershell"]);
  if (suppliedTools.some((tool) => nativeNames.has(tool.name))) {
    throw new Error("Custom tools cannot replace native role permissions");
  }
  const customTools: ToolDefinition[] = [
    ...suppliedTools,
    ...(options.role === "executor" ? [createExecutorBashTool(options.cwd)] : []),
  ];
  const { session } = await createAgentSession({
    cwd: options.cwd,
    modelRuntime,
    model,
    thinkingLevel: profile.thinkingLevel,
    tools: ["read", "grep", "find", "ls", ...(options.role === "executor" ? ["edit", "write"] : []), ...customTools.map((tool) => tool.name)],
    customTools,
    sessionManager: options.sessionManager,
    settingsManager,
    resourceLoader,
  });
  return session;
}
