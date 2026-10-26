import {
  createBashToolDefinition,
  createLocalBashOperations,
  defineTool,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
export const MAX_COMMAND_TIMEOUT_SECONDS = 300;

/** Policy sits beneath the tool so omitted or oversized model timeouts cannot bypass it. */
export function boundedBashOperations(delegate: BashOperations = createLocalBashOperations()): BashOperations {
  return {
    async exec(command, cwd, options) {
      const requested = options.timeout ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
      if (!Number.isFinite(requested) || requested <= 0) {
        throw new Error("Command timeout must be a finite positive number of seconds");
      }
      return delegate.exec(command, cwd, {
        ...options,
        timeout: Math.min(requested, MAX_COMMAND_TIMEOUT_SECONDS),
      });
    },
  };
}

/** Native Pi bash, including its output truncation and process-tree cancellation. */
export function createExecutorBashTool(cwd: string) {
  const tool = createBashToolDefinition(cwd, { operations: boundedBashOperations() });
  return defineTool({
    ...tool,
    executionMode: "sequential",
    description: `${tool.description} Timeout defaults to ${DEFAULT_COMMAND_TIMEOUT_SECONDS} seconds and is capped at ${MAX_COMMAND_TIMEOUT_SECONDS} seconds. Timeouts and cancellation stop the local process tree; effects already performed are not undone.`,
  });
}
