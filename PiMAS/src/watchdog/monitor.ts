import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CommandLimits } from "../execution-tools.js";
import type { Workspace } from "../workspace.js";
import { readOutsideAgentTools, type Rerun } from "./rerun.js";
import type { ToolCall, ToolOutcome, WatchdogEvent, WatchdogPlugin, WatchdogSummary, WatchdogTools } from "./types.js";

export interface WatchdogOptions {
  workspace: Workspace;
  plugins: WatchdogPlugin[];
  /** Where commands are rerun outside the agent's tools (rerun.ts). */
  rerun: Rerun;
  /** The agent's bash timeouts (default and cap), so a rerun gets the timeout the agent's command would. */
  commandLimits: CommandLimits;
  record: (event: WatchdogEvent) => void | Promise<void>;
}

export type Watchdog = ReturnType<typeof createWatchdog>;

/**
 * The watchdog loop. It wraps every agent tool (outside any fault wrapper, so it sees what the agent sees). Before a
 * call, a plug-in may handle it in place of the tool (`instead`); after it, every plug-in gets the chance to detect,
 * confirm and repair. Notes from repairs are appended to the result the agent gets.
 */
export function createWatchdog(options: WatchdogOptions) {
  const summary: WatchdogSummary = { plugins: options.plugins.map((plugin) => plugin.name), suspected: 0, confirmed: 0, repaired: 0 };
  let probes = 0;
  const readOutside = readOutsideAgentTools(options.workspace);

  // Pi runs the calls of one turn in parallel unless one is bash, so two edits to the same file can overlap. Calls
  // that change the same file run one at a time here, so a plug-in's copy of a file before a call is the file that
  // call changed (Pi applies them one at a time anyway).
  const queues = new Map<string, Promise<unknown>>();
  const changedFile = (tool: string, args: Record<string, unknown>) =>
    (tool === "edit" || tool === "write") && typeof args.path === "string"
      ? path.posix.resolve(options.workspace.cwd, args.path.replace(/^@/, "")) : null;
  async function oneAtATime<T>(file: string | null, run: () => Promise<T>): Promise<T> {
    if (file === null) return run();
    const current = (queues.get(file) ?? Promise.resolve()).catch(() => {}).then(run);
    const settled = current.catch(() => {});
    queues.set(file, settled);
    try { return await current; } finally { if (queues.get(file) === settled) queues.delete(file); }
  }

  /** Wrap one stage's tools. Call once per tool; the stage's bash tool is kept for probes. */
  function forStage(stageId: string, currentStep: () => string | null) {
    let bash: ToolDefinition | null = null;
    let lastContext: unknown;

    const agentBash = async (command: string, timeoutSeconds: number): Promise<ToolOutcome> => {
      if (!bash) throw new Error("No bash tool in this stage");
      try {
        const result = await bash.execute(`watchdog-probe-${++probes}`, { command, timeout: timeoutSeconds }, undefined, undefined, lastContext as never);
        return { output: resultText(result), isError: (result as { isError?: boolean }).isError === true };
      } catch (error) {
        // Pi's bash tool throws on a nonzero exit; the message holds the output.
        return { output: error instanceof Error ? error.message : String(error), isError: true };
      }
    };

    return (tool: ToolDefinition): ToolDefinition => {
      if (tool.name === "bash") bash = tool;
      return {
        ...tool,
        execute(toolCallId, params, signal, onUpdate, ctx) {
          const args = (params ?? {}) as Record<string, unknown>;
          return oneAtATime(changedFile(tool.name, args), () => watched(args, toolCallId, params, signal, onUpdate, ctx));
        },
      } as ToolDefinition;

      /** One call, watched: before, instead, the tool itself, then detect, confirm and repair. */
      async function watched(args: Record<string, unknown>, ...[toolCallId, params, signal, onUpdate, ctx]: Parameters<ToolDefinition["execute"]>) {
          lastContext = ctx;
          const call: ToolCall = { stageId, stepId: currentStep(), toolCallId, tool: tool.name, args };
          const tools: WatchdogTools = {
            workspace: options.workspace,
            agentBash: bash ? agentBash : null,
            rerun: (command, timeoutSeconds) => options.rerun(command, timeoutSeconds, signal),
            readOutside: (args) => readOutside(args, signal),
            timeoutFor: (requested) => Math.min(
              typeof requested === "number" ? requested : options.commandLimits.defaultSeconds, options.commandLimits.maxSeconds),
          };
          for (const plugin of options.plugins) await plugin.before?.(call, tools);

          // A plug-in that already knows the tool is broken may handle the call itself; the tool does not run.
          for (const plugin of options.plugins) {
            const handled = await plugin.instead?.(call, tools);
            if (!handled) continue;
            summary.repaired++;
            await options.record({ stageId, toolCallId, plugin: plugin.name, phase: "rerouted", reason: handled.reason });
            return toolResult(handled.replacement, [handled.note]);
          }

          let result: Awaited<ReturnType<ToolDefinition["execute"]>> | undefined;
          let thrown: unknown;
          try { result = await tool.execute(toolCallId, params, signal, onUpdate, ctx); }
          catch (error) { thrown = error; }
          let outcome: ToolOutcome = thrown === undefined
            ? { output: resultText(result), isError: (result as { isError?: boolean } | undefined)?.isError === true }
            : { output: thrown instanceof Error ? thrown.message : String(thrown), isError: true };

          const notes: string[] = [];
          for (const plugin of options.plugins) {
            const event = (phase: WatchdogEvent["phase"], reason: string) =>
              options.record({ stageId, toolCallId, plugin: plugin.name, phase, reason });
            const suspicion = await plugin.detect(call, outcome, tools);
            if (!suspicion) continue;
            summary.suspected++;
            await event("suspected", suspicion.reason);
            const evidence = await plugin.confirm(suspicion, call, tools);
            if (!evidence.confirmed) {
              await event("dismissed", evidence.reason);
              continue;
            }
            summary.confirmed++;
            await event("confirmed", evidence.reason);
            const repair = await plugin.repair(evidence, call, outcome, tools);
            summary.repaired++;
            await event("repaired", repair.note);
            notes.push(repair.note);
            if (repair.replacement) outcome = repair.replacement;
          }

          // Nothing to add: hand back exactly what the tool returned.
          if (!notes.length) {
            if (thrown !== undefined) throw thrown;
            return result!;
          }
          return toolResult(outcome, notes);
      }
    };
  }

  return { forStage, summary };
}

/** A tool result holding an outcome with the watchdog's notes after it. */
function toolResult(outcome: ToolOutcome, notes: string[]) {
  const note = { type: "text" as const, text: `\n\n${notes.join("\n\n")}` };
  return {
    // An outcome with more than text (an image read outside the agent's tools) keeps all its parts.
    content: outcome.content ? [...outcome.content, note] : [{ type: "text" as const, text: `${outcome.output}${note.text}` }],
    details: undefined,
    isError: outcome.isError,
  } as Awaited<ReturnType<ToolDefinition["execute"]>>;
}

export function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : "")).join("");
}
