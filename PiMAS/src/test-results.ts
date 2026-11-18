/** Shared recognition of test-run output, independent of fault injection. */
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

export function testResults(text: string): boolean {
  const plain = text.replace(ANSI, "");
  return UNITTEST_RAN.test(plain) || UNITTEST_INLINE.test(plain) || PYTEST_SUMMARY.test(plain) || SYMPY_SUMMARY.test(plain) || TEST_PASSED.test(plain) || TEST_FAILED.test(plain);
}
