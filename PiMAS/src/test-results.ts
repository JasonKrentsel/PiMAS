/**
 * Recognizing test runs and their results in tool output. Shared by the fault injector (src/faults.ts), which
 * rewrites results, and the watchdog (src/watchdog/), which judges them; neither reads the other's records.
 */
export const UNITTEST_RAN = /^Ran (\d+) tests? in [\d.]+s$/m;
// "Ran N tests in Xs" and its OK on one line, as an agent's own echo or `tr` can print them.
export const UNITTEST_INLINE = /\bRan \d+ tests? in [\d.]+s\b.*?\bOK\b(?: \(([^)\n]*)\))?/;
// Summaries are found anywhere in a line: agents often print them after their own text ("run 1: 10 passed in 0.04s").
export const PYTEST_SUMMARY = /^(.*?)\b((?:\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?|warns?|rerun)(?:, )?)+) in [\d.]+ ?s(?:econds)?\b.*$/m;
/** Per-test lines, which tell the truth even when the summary was cut off (e.g. `| head`). */
export const TEST_PASSED = /^(?:\S+::\S+ PASSED\b|.* \.\.\. ok$)/m;
export const TEST_FAILED = /^(?:\S+::\S+ (?:FAILED|ERROR)\b|.* \.\.\. (?:FAIL|ERROR)$)/m;
// pytest colours its output; results are found and rewritten in the plain text.
export const ANSI = /\x1b\[[0-9;]*m/g;
export const SYMPY_SUMMARY = /^(.*?)tests finished: (\d+) passed(.*?)( ?=*)$/m;

/** Whether the text shows test results (passing or failing) in a format we know. */
export function testResults(text: string): boolean {
  const plain = text.replace(ANSI, "");
  return UNITTEST_RAN.test(plain) || UNITTEST_INLINE.test(plain) || PYTEST_SUMMARY.test(plain) || SYMPY_SUMMARY.test(plain) || TEST_PASSED.test(plain) || TEST_FAILED.test(plain);
}

// A failing result in unittest, pytest or sympy form. pytest before 5.0 ends its summary "in 0.04 seconds".
const SHOWS_FAILURE = /(?:^|\n)(?:FAILED \((?:failures|errors)=|\S+::\S+ (?:FAILED|ERROR)\b|(?:FAILED|ERROR) \S+::\S+|.* \.\.\. (?:FAIL|ERROR)\b|.*\b\d+ (?:failed|errors?)\b.* in [\d.]+ ?s(?:econds)?\b|.*tests finished:.*\b\d+ (?:failed|exceptions?)\b)/m;

export function showsFailure(text: string): boolean {
  return SHOWS_FAILURE.test(text.replace(ANSI, ""));
}

/** The message Pi's bash tool returns when a command runs past its time limit. */
export function reportsTimeout(text: string): boolean {
  return /(?:^|\n)Command timed out after \d+(?:\.\d+)? seconds\b/.test(text);
}

// Common test runners, and Python test files run directly.
const TEST_RUNNER = /(?:^|[\s/;|(&])(?:pytest|py\.test|unittest|nose2?|tox|runtests\.py|bin\/test)(?:[\s/;|)&]|$)/i;
const TEST_SCRIPT = /\bpython(?:3(?:\.\d+)?)?\s+(?:-\S+\s+)*(?:\S*\/)?(?:manage\.py\s+test\b|(?:run_?tests?|test_[\w.-]+)\.py(?:\s|$))/i;

/** Whether a shell command runs tests, judged from the command alone. */
export function isTestCommand(command: string): boolean {
  return TEST_RUNNER.test(command) || TEST_SCRIPT.test(command);
}
