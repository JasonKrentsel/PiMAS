import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createOrchestratorSession } from "./agent.js";
import { loadAgentConfig } from "./agent-config.js";

try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      models: { type: "string" },
      agents: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  const request = positionals.join(" ").trim();
  if (values.help || !request) {
    console.log('Usage: npm start -- --models ./models.local.json --agents ./agents.local.json "Inspect this project and suggest a plan"');
    console.log("Current stage: one read-only agent with local conversation history; no delegation or run resume yet.");
  } else {
    if (!values.models) throw new Error("Provide --models <file>; use models.example.json as a starting point.");
    if (!values.agents) throw new Error("Provide --agents <file>; use agents.example.json as a starting point.");
    await runRequest(request, resolve(values.models), resolve(values.agents));
  }
} catch (error) {
  console.error(`PiMAS error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function runRequest(prompt: string, modelsFile: string, agentsFile: string): Promise<void> {
  const { roles } = await loadAgentConfig(agentsFile);
  const cwd = resolve(process.env.PIMAS_CWD ?? process.cwd());
  const sessionDirectory = join(cwd, "data", "runs", randomUUID(), "sessions");
  let session: AgentSession | undefined;
  let interrupted = false;

  function interrupt(): void {
    interrupted = true;
    process.exitCode = 130;
    console.error("Interrupted. Any saved conversation remains on disk.");
    void session?.abort().catch((error: unknown) => console.error("Abort failed:", error));
  }

  process.once("SIGINT", interrupt);
  try {
    await mkdir(sessionDirectory, { recursive: true });
    const sessionManager = SessionManager.create(cwd, sessionDirectory);
    session = await createOrchestratorSession({
      cwd,
      modelsFile,
      profile: roles.orchestrator,
      sessionManager,
    });
    if (interrupted) return;

    console.error("PiMAS · read-only foundation · delegation and run resume are not implemented yet");
    console.error(`Session: ${session.sessionFile}`);
    console.error(`Model: ${session.model?.provider}/${session.model?.id} · thinking: ${session.thinkingLevel}`);
    if (session.thinkingLevel !== roles.orchestrator.thinkingLevel) {
      console.error(`Warning: requested thinking level ${roles.orchestrator.thinkingLevel} was limited to ${session.thinkingLevel} by model capabilities.`);
    }
    await session.prompt(prompt);
    if (interrupted) return;

    // Pi can settle with an error message instead of rejecting prompt().
    const last = session.messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop") {
      const reason = last?.role === "assistant"
        ? last.errorMessage ?? `Model response ended with ${last.stopReason}`
        : "The model did not return a final answer";
      throw new Error(reason);
    }
    const answer = session.getLastAssistantText()?.trim();
    if (!answer) throw new Error("The model returned an empty answer");
    console.log(`\nOrchestrator > ${answer}`);
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    try {
      await session?.abort();
    } finally {
      session?.dispose();
      process.removeListener("SIGINT", interrupt);
    }
  }
}
