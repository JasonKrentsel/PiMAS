import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";

/** Call while scheduling is paused, before new input can restart saved work. */
export async function cancelInterruptedWork(harness: Harness, context: Context): Promise<boolean> {
  const previous = await harness.inspect(context);
  for (const task of previous.tasks) {
    await harness.abortTask(task.record.id, context);
  }
  for (const submission of previous.submissions) {
    await harness.abortSubmission(submission.id, context);
  }
  const found = previous.tasks.length > 0 || previous.submissions.length > 0;
  if (found) {
    await harness.waitForIdle(context);
  }
  return found;
}
