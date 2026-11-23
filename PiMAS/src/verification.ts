import type { ProbeOutcome } from "./probe-watchdog.js";
import { WATCHDOG_PROBE_COMMAND } from "./probe-watchdog.js";
import { testResults } from "./test-results.js";
import { incompleteTestLogAlert, reportsBashTimeout } from "./timeout-watchdog.js";

export interface FailedTestCommand {
  stageId: string;
  toolCallId: string;
  command: string;
  timeout: number;
}

export interface VerificationRequest {
  stageId: string;
  toolCallId: string;
  tests: FailedTestCommand[];
  probe: ProbeOutcome;
  paths?: string[];
}

export interface VerifiedTest {
  stageId: string;
  toolCallId: string;
  command: string;
  timeout: number;
  status: "completed" | "inconclusive";
  reason?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  duration_seconds?: number;
}

export interface VerificationResult {
  status: "completed" | "inconclusive";
  reason?: string;
  tests?: VerifiedTest[];
  snapshot?: { sha256: string; bytes: number; paths: string[] };
  metrics?: Record<string, number | boolean>;
}

/** Track distinct failed task tests throughout the run, never the watchdog's own probes. */
export class TestCommandTracker {
  private readonly failed = new Map<string, FailedTestCommand>();
  private readonly recent: FailedTestCommand[] = [];
  private sawTimeout = false;
  private remember(test: FailedTestCommand) {
    const previous = this.failed.get(test.command);
    this.failed.set(test.command, { ...test, timeout: Math.max(test.timeout, previous?.timeout ?? 0) });
  }
  observe(input: { stageId: string; toolCallId: string; tool: string; args: unknown; output: string; isError: boolean; defaultTimeout: number; maxTimeout: number }) {
    if (!input.args || typeof input.args !== "object") return;
    if (reportsBashTimeout(input.tool, input.isError, input.output)) this.sawTimeout = true;
    const failedOutput = /(?:\bFAIL(?:ED)?\b|\bERROR\b|\b\d+ failed\b)/i.test(input.output);
    if (input.tool === "read") {
      const readPath = (input.args as { path?: unknown }).path;
      const incomplete = incompleteTestLogAlert({ ...input, stepId: null, sawTimeout: this.sawTimeout }) !== null;
      if (typeof readPath === "string" && (input.isError || failedOutput || incomplete)) {
        const match = [...this.recent].reverse().find((test) => test.stageId === input.stageId && test.command.includes(readPath));
        if (match) this.remember(match);
      }
      return;
    }
    if (input.tool !== "bash") return;
    const args = input.args as { command?: unknown; timeout?: unknown };
    if (typeof args.command !== "string" || args.command.includes(WATCHDOG_PROBE_COMMAND)) return;
    const recognized = /(?:^|[\s/;|(&])(?:pytest|py\.test|unittest|nose2?|tox|vitest|jest|mocha|go test|cargo test|npm (?:run )?test|yarn test|make test)(?:[\s/;|)&]|$)/i.test(args.command)
      || /\bpython(?:3(?:\.\d+)?)?\s+(?:-\S+\s+)*(?:\S*\/)?(?:manage\.py\s+test\b|(?:run_?tests?|test_[\w.-]+)\.py(?:\s|$))/i.test(args.command)
      || testResults(input.output);
    if (!recognized) return;
    const requested = typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : input.defaultTimeout;
    const test = { stageId: input.stageId, toolCallId: input.toolCallId, command: args.command, timeout: Math.max(1, Math.min(requested, input.maxTimeout)) };
    this.recent.push(test);
    if (input.isError || failedOutput) this.remember(test);
  }
  request(outcome: ProbeOutcome): VerificationRequest | null {
    if (!this.failed.size) return null;
    return { stageId: outcome.request.stageId, toolCallId: outcome.toolCallId ?? outcome.request.triggerToolCallId, tests: [...this.failed.values()], probe: outcome };
  }
}

export function verificationMessage(result: VerificationResult): string {
  const tests = result.tests ?? [];
  const header = result.status === "completed"
    ? `Independent verification of snapshot ${result.snapshot?.sha256 ?? "unknown"} completed.`
    : `Independent verification was inconclusive: ${result.reason ?? "one or more tests could not be verified"}.`;
  if (!tests.length) return `${header} Do not treat this as a pass or failure. Use verify_test with the test command or additional absolute paths if needed.`;
  const details = tests.map((test, i) => {
    const resultLine = test.status === "completed" ? `Exit code: ${test.exit_code}` : `Inconclusive: ${test.reason ?? "no reliable result"}`;
    const excerpt = (value: string | undefined) => !value ? "" : value.length <= 4000 ? value : `[Output excerpt; full captured output is in verification records.]\n${value.slice(-4000)}`;
    return `Test ${i + 1}: ${test.command}\n${resultLine}\nstdout:\n${excerpt(test.stdout)}\nstderr:\n${excerpt(test.stderr)}`;
  }).join("\n\n");
  return `${header} Results apply only to this snapshot.\n\n${details}\nA missing dependency or setup error is not evidence that the solution itself failed.`;
}
