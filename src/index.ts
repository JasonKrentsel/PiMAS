import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createOrchestratorSession } from "./agent.js";

const request = process.argv.slice(2).join(" ").trim();

if (!request || request === "--help" || request === "-h") {
  console.log('Usage: npm start -- "Inspect this project and suggest a plan"');
  console.log("Current stage: one read-only agent with local conversation history; no delegation or run resume yet.");
} else {
  try {
    await runRequest(request);
  } catch (error) {
    console.error(`PiMAS error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function runRequest(prompt: string): Promise<void> {
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
      baseUrl: process.env.PIMAS_BASE_URL ?? "http://127.0.0.1:1234/v1",
      modelId: process.env.PIMAS_MODEL ?? "local-model",
      apiKey: process.env.OPENAI_API_KEY ?? "local",
      sessionManager,
    });
    if (interrupted) return;

    console.error("PiMAS · read-only foundation · delegation and run resume are not implemented yet");
    console.error(`Session: ${session.sessionFile}`);
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
