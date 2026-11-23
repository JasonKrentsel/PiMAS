import assert from 'node:assert/strict';
import test from 'node:test';
import { TestCommandTracker, verificationMessage } from '../src/verification.js';
import type { ProbeOutcome } from '../src/probe-watchdog.js';

const probe: ProbeOutcome = { request: { stageId: 'execute', stepId: 'S1', triggerToolCallId: 'a', failures: 3, tool: 'bash' }, toolCallId: 'probe', outcome: 'failed', reason: 'test_failed' };
const base = { stageId: 'execute', toolCallId: 'test', tool: 'bash', args: { command: 'python3 -m pytest tests/test_fix.py', timeout: 30 }, output: '1 failed in 1s', isError: true, defaultTimeout: 600, maxTimeout: 3600 };

test('collects distinct failed commands across stages and deduplicates repetitions', () => {
  const tracker = new TestCommandTracker();
  tracker.observe({ ...base, output: '1 passed in 1s', isError: false });
  assert.equal(tracker.request(probe), null);
  tracker.observe(base);
  tracker.observe({ ...base, stageId: 'research', toolCallId: 'second', args: { command: 'python3 -m unittest another_test', timeout: 10 } });
  tracker.observe({ ...base, toolCallId: 'repeat', args: { command: 'python3 -m pytest tests/test_fix.py', timeout: 45 } });
  tracker.observe({ ...base, toolCallId: 'later', args: { command: 'echo hello' }, output: 'hello', isError: false });
  assert.deepEqual(tracker.request(probe)?.tests.map(({ stageId, toolCallId, command, timeout }) => ({ stageId, toolCallId, command, timeout })), [
    { stageId: 'execute', toolCallId: 'repeat', command: 'python3 -m pytest tests/test_fix.py', timeout: 45 },
    { stageId: 'research', toolCallId: 'second', command: 'python3 -m unittest another_test', timeout: 10 },
  ]);
});

test('associates each failed log with the command that wrote it', () => {
  const tracker = new TestCommandTracker();
  tracker.observe({ ...base, toolCallId: 'one', args: { command: 'pytest one > /tmp/one.log', timeout: 30 }, output: '', isError: false });
  tracker.observe({ ...base, toolCallId: 'two', args: { command: 'pytest two > /tmp/two.log', timeout: 30 }, output: '', isError: false });
  tracker.observe({ ...base, tool: 'read', args: { path: '/tmp/one.log' }, output: 'FAILED test_x', isError: false });
  tracker.observe({ ...base, tool: 'read', args: { path: '/tmp/two.log' }, output: 'FAILED test_y', isError: false });
  assert.deepEqual(tracker.request(probe)?.tests.map((test) => test.command), ['pytest one > /tmp/one.log', 'pytest two > /tmp/two.log']);
});

test('includes a test whose full log is incomplete after a timeout', () => {
  const tracker = new TestCommandTracker();
  tracker.observe({ ...base, args: { command: 'pytest > /tmp/test.log', timeout: 30 }, output: '', isError: false });
  tracker.observe({ ...base, args: { command: 'sleep 1' }, output: 'Command timed out after 10 seconds', isError: true });
  tracker.observe({ ...base, tool: 'read', args: { path: '/tmp/test.log' }, output: '', isError: false });
  assert.equal(tracker.request(probe)?.tests[0]?.command, 'pytest > /tmp/test.log');
});

test('includes completed results when another test is inconclusive', () => {
  const message = verificationMessage({ status: 'inconclusive', reason: 'one or more tests could not be verified', tests: [
    { stageId: 'execute', toolCallId: 'one', command: 'pytest one', timeout: 10, status: 'completed', exit_code: 0, stdout: 'OK' },
    { stageId: 'execute', toolCallId: 'two', command: 'pytest two', timeout: 10, status: 'inconclusive', reason: 'timeout' },
  ] });
  assert.match(message, /pytest one\nExit code: 0/);
  assert.match(message, /pytest two\nInconclusive: timeout/);
});
