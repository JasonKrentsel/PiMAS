/**
 * Step 2 of the Phase 2 plan, for the test-runner plug-in: replay the saved runs' tool calls through its detector
 * and see when it would have caught the fault, and how often it probes when nothing is wrong.
 *
 * Usage, from PiMAS/ (so tsx and the Pi SDK resolve):
 *   node --import tsx ../experiments/phase2/replay-watchdog.mts ../experiments/phase2/results \
 *     ../jobs/phase1/control-rp ../jobs/phase1/tool-*  ../jobs/phase2/tool-false-pass-all ...
 *
 * The detector sees each saved call as the agent saw it. A probe cannot be rerun on a saved run, so its answer is
 * simulated: a healthy runner answers it truly, and a tool fault that would be active at that moment (armed by
 * an edit, and persistent or not yet used) answers it the way it answers the agent: a false failure or pass, a
 * timeout, or the fault's text in place of the results. Outside the agent's tools the probe is always answered
 * truly. Replay stops at the first confirmation, because from there the watchdog changes what the agent sees and
 * the saved run no longer applies. Tokens after the catch are the model's usage in sessions/*.jsonl from then on,
 * compaction included.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FAILING_PROBE, testRunnerPlugin } from "../../PiMAS/src/watchdog/test-runner.ts";
import type { ToolOutcome, WatchdogTools } from "../../PiMAS/src/watchdog/types.ts";
import { localWorkspace } from "../../PiMAS/src/workspace.ts";

const PASS = "probe (x) ... ok\n\n----------------------------------------------------------------------\nRan 1 test in 0.000s\n\nOK";
const FAIL = "probe (x) ... FAIL\n\n----------------------------------------------------------------------\nRan 1 test in 0.000s\n\nFAILED (failures=1)";
const TIMEOUT = "probe (x) ...\nCommand timed out after 10 seconds\n\n\nCommand exited with code 124";

interface Call { stageId: string; toolCallId: string; tool: string; args: Record<string, unknown>; output: string; isError: boolean; startedAt: string; endedAt: string }
interface Row {
  condition: string; trial: string; injected: boolean; probes: number; confirmedAt: number | null; injectedAt: number | null; minutes: number;
  outAfter: number | null; inAfter: number | null;
}
interface Usage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

/** Output and input tokens the model used after a moment, from the run's session files; null if it has none. */
function tokensAfter(state: string, at: string): { out: number; in: number } | null {
  const directory = path.join(state, "sessions");
  const files = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".jsonl")) : [];
  if (!files.length) return null;
  const usages: Usage[] = files.flatMap((name) => jsonl(path.join(directory, name)))
    .filter((entry) => typeof entry.timestamp === "string" && Date.parse(entry.timestamp) > Date.parse(at))
    .flatMap((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage ? [entry.message.usage]
      : entry.type === "compaction" && entry.usage ? [entry.usage] : []);
  return {
    out: usages.reduce((sum, usage) => sum + (usage.output ?? 0), 0),
    in: usages.reduce((sum, usage) => sum + (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0), 0),
  };
}

const jsonl = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

async function replay(trial: string, condition: string): Promise<Row> {
  const state = path.join(trial, "agent/pimas");
  const result = existsSync(path.join(trial, "result.json")) ? JSON.parse(readFileSync(path.join(trial, "result.json"), "utf8")) : {};
  const began = Date.parse(result.agent_execution?.started_at ?? "");
  const ended = Date.parse(result.agent_execution?.finished_at ?? "");
  const minutesAt = (stamp: string) => (Date.parse(stamp) - began) / 60000;
  const events = jsonl(path.join(state, "provenance.jsonl"));
  const spec = events.find((event) => event.type === "run_start")?.settings?.condition?.fault ?? null;
  const injections: string[] = events.filter((event) => event.type === "fault").map((event) => event.injection.at);
  const toolFault = spec?.target?.kind === "tool" && spec.target.results ? spec : null;

  const plugin = testRunnerPlugin();
  let armed = false;
  let now = "";
  let probes = 0;
  const truth = (command: string): ToolOutcome => command === FAILING_PROBE ? { output: FAIL, isError: true } : { output: PASS, isError: false };
  // A probe's answer through the agent's tool: the truth, unless a test-results fault is active right now.
  const probe = async (command: string): Promise<ToolOutcome> => {
    probes++;
    const mustFail = command === FAILING_PROBE;
    const used = injections.some((at) => at <= now);
    const active = toolFault && armed && (toolFault.target.persistent || !used);
    if (!active) return truth(command);
    switch (toolFault.action) {
      case "timeout": return { output: TIMEOUT, isError: true };
      case "fail": return mustFail ? truth(command) : { output: FAIL, isError: true };
      case "pass": return mustFail ? { output: PASS, isError: false } : truth(command);
      case "replace": return { output: toolFault.text, isError: toolFault.isError === true };
      case "append": return { output: `${truth(command).output}\n${toolFault.text}`, isError: truth(command).isError };
      default: throw new Error(`The replay does not model how a ${toolFault.action} fault answers a probe`);
    }
  };
  const tools: WatchdogTools = {
    workspace: localWorkspace("/"),
    agentBash: probe,
    rerun: async (command) => truth(command), // outside the agent's tools, only probes are rerun before a catch
    readOutside: async () => { throw new Error("The replay stops at the first catch, before any read is repaired"); },
    timeoutFor: () => 600,
  };

  let confirmedAt: number | null = null;
  let after: { out: number; in: number } | null = null;
  for (const call of jsonl(path.join(state, "tool-calls.jsonl")) as Call[]) {
    now = call.endedAt;
    if ((call.tool === "edit" || call.tool === "write") && !call.isError) armed = true; // as the fault arms (faults.ts)
    const call_ = { stageId: call.stageId, stepId: null, toolCallId: call.toolCallId, tool: call.tool, args: call.args ?? {} };
    const suspicion = await plugin.detect(call_, { output: call.output ?? "", isError: call.isError }, tools);
    if (!suspicion) continue;
    if ((await plugin.confirm(suspicion, call_, tools)).confirmed) {
      confirmedAt = minutesAt(call.endedAt);
      after = tokensAfter(state, call.endedAt);
      break;
    }
  }
  return {
    condition, trial: path.basename(trial), injected: injections.length > 0, probes, confirmedAt,
    injectedAt: injections.length ? minutesAt(injections[0]!) : null, minutes: (ended - began) / 60000,
    outAfter: after?.out ?? null, inAfter: after?.in ?? null,
  };
}

const [out, ...jobs] = process.argv.slice(2);
if (!out || !jobs.length) throw new Error("Usage: replay-watchdog.mts <out-dir> <job-dir>...");
const rows: Row[] = [];
for (const job of jobs) {
  if (!existsSync(job) || !statSync(job).isDirectory() || path.basename(job).includes("+")) continue; // skip logs; always-verify runs are a different pipeline
  for (const name of readdirSync(job).sort()) {
    if (name.includes("__") && existsSync(path.join(job, name, "agent/pimas/tool-calls.jsonl"))) rows.push(await replay(path.join(job, name), path.basename(job)));
  }
}

const fmt = (value: number | null) => value === null ? "–" : value.toFixed(1);
const lines = [
  "# Test-runner watchdog replayed on the saved runs",
  "",
  "Each saved run's tool calls go through the test-runner plug-in's detector (`PiMAS/src/watchdog/test-runner.ts`). " +
  "Probe answers are simulated (see `replay-watchdog.mts`), and replay stops at the first confirmation. *Probes* counts " +
  "probes before the first confirmation (every probe, on a run that is never confirmed); on runs without the fault " +
  "each one is a false alarm that costs one short test run. *After catch* is the run's remaining agent minutes when " +
  "the fault was confirmed: the most a repair could save. *Tokens after catch* are the model's output and input " +
  "tokens from then on (input counts the whole context again on every call), each the median of its own column. " +
  "Fault rows count only runs where the fault fired.",
  "",
  "| Condition | Runs | Caught | Probes per run | Minutes from fault to catch (median) | After catch (median) | Output tokens after catch (median) | Input tokens after catch (median) | Run minutes (median) |",
  "|---|---|---|---|---|---|---|---|---|",
];
const tokens = (values: (number | null)[], unit: number, suffix: string) => {
  const known = median(values.filter((value): value is number => value !== null));
  return known === null ? "–" : `${(known / unit).toFixed(unit === 1e3 ? 1 : 2)}${suffix}`;
};
for (const condition of [...new Set(rows.map((row) => row.condition))]) {
  const all = rows.filter((row) => row.condition === condition);
  const runs = condition.startsWith("control") ? all : all.filter((row) => row.injected);
  if (!runs.length) continue;
  const caught = runs.filter((row) => row.confirmedAt !== null);
  lines.push(`| ${condition} | ${runs.length} | ${caught.length}/${runs.length} | ${(runs.reduce((sum, row) => sum + row.probes, 0) / runs.length).toFixed(1)} | ` +
    `${fmt(median(caught.filter((row) => row.injectedAt !== null).map((row) => row.confirmedAt! - row.injectedAt!)))} | ` +
    `${fmt(median(caught.map((row) => row.minutes - row.confirmedAt!)))} | ` +
    `${tokens(caught.map((row) => row.outAfter), 1e3, "K")} | ${tokens(caught.map((row) => row.inAfter), 1e6, "M")} | ${fmt(median(runs.map((row) => row.minutes)))} |`);
}
const text = lines.join("\n") + "\n";
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "watchdog-replay.md"), text);
writeFileSync(path.join(out, "watchdog-replay.csv"), ["condition,trial,injected,probes,injected_at_min,confirmed_at_min,run_min,out_tokens_after_catch,in_tokens_after_catch",
  ...rows.map((row) => [row.condition, row.trial, row.injected, row.probes, fmt(row.injectedAt), fmt(row.confirmedAt), fmt(row.minutes),
    row.outAfter ?? "–", row.inAfter ?? "–"].join(","))].join("\n") + "\n");
console.log(text);
