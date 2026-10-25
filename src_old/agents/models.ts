import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { AppConfig } from "../config.js";

/** All agentroles  share this one OpenAI-compatible provider. */
export function createModelCatalog(config: AppConfig["model"]) {
  const provider = "custom";
  const models = createModels();

  models.setProvider(createProvider({
    id: provider,
    name: "OpenAI-compatible server",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "API key",
        async resolve() {
          return {
            auth: { apiKey: config.apiKey },
            source: "OPENAI_API_KEY",
          };
        },
      },
    },
    api: openAICompletionsApi(),
    models: [{
      id: config.id,
      name: config.id,
      api: "openai-completions",
      provider,
      baseUrl: config.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 128_000,
      maxTokens: 4_096,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
      },
    }],
  }));

  return {
    models,
    model: { provider, modelId: config.id },
  };
}
