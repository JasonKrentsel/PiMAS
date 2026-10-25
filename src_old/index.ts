import { createInterface } from "node:readline/promises";
import { Application } from "./application.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await Application.open(config);
const prompt = process.argv.slice(2).join(" ").trim();

let terminal: ReturnType<typeof createInterface> | undefined;
let interrupted = false;

function interrupt(): void {
  interrupted = true;
  terminal?.close();
  void app.interrupt().catch(reportError);
}

process.once("SIGINT", interrupt);

try {
  if (prompt) {
    await answer(prompt);
  } else {
    await chat();
  }
} finally {
  terminal?.close();
  process.removeListener("SIGINT", interrupt);
  await app.close();
}

async function answer(input: string): Promise<void> {
  const response = await app.run(input);
  console.log(`\nOrchestrator > ${response}`);
}

async function chat(): Promise<void> {
  terminal = createInterface({ input: process.stdin, output: process.stdout });
  terminal.on("SIGINT", interrupt);

  console.log(`PiMAS · orchestrator · up to ${config.maxParallel} parallel workers`);
  console.log("Type /exit to quit.");

  while (!interrupted) {
    let input: string;

    try {
      input = (await terminal.question("\nYou > ")).trim();
    } catch {
      // Closing the terminal (including Ctrl+C) cancels a pending question.
      break;
    }

    if (input === "/exit" || input === "/quit") {
      break;
    }
    if (!input) {
      continue;
    }

    try {
      await answer(input);
    } catch (error) {
      reportError(error);
    }
  }
}

function reportError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
}
