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
} from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "./agent-config.js";

interface OrchestratorOptions {
  cwd: string;
  modelsFile: string;
  profile: AgentProfile;
  sessionManager: SessionManager;
}

/** The caller owns prompting, local history, and abort/dispose of this Pi session. */
export async function createOrchestratorSession(options: OrchestratorOptions): Promise<AgentSession> {
  const systemPrompt = (await readFile(options.profile.systemPrompt, "utf8")).trim();
  if (!systemPrompt) throw new Error(`System prompt is empty: ${options.profile.systemPrompt}`);

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
  const model = modelRuntime.getModel(options.profile.provider, options.profile.model);
  if (!model) {
    throw new Error(`Model ${options.profile.provider}/${options.profile.model} is unavailable in ${options.modelsFile}`);
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

  const { session } = await createAgentSession({
    cwd: options.cwd,
    modelRuntime,
    model,
    thinkingLevel: options.profile.thinkingLevel,
    tools: ["read", "grep", "find", "ls"],
    sessionManager: options.sessionManager,
    settingsManager,
    resourceLoader,
  });
  return session;
}
