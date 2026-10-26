import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Pi may settle with an error message instead of rejecting prompt(). */
export function getFinalAnswer(session: AgentSession): string {
  const last = session.messages.at(-1);
  if (last?.role !== "assistant" || last.stopReason !== "stop") {
    const reason = last?.role === "assistant"
      ? last.errorMessage ?? `Model response ended with ${last.stopReason}`
      : "The model did not return a final answer";
    throw new Error(reason);
  }
  const answer = session.getLastAssistantText()?.trim();
  if (!answer) throw new Error("The model returned an empty answer");
  return answer;
}
