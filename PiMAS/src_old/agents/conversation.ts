import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";

/** Submit a prompt and return the final text, or surface Pi's unanswered reason. */
export async function askConversation(
  conversation: Conversation,
  prompt: string,
  label: string,
  context: Context,
): Promise<string> {
  const submission = await conversation.submit({ type: "input", content: prompt }, context);
  const settled = await submission.wait(context);

  if (settled.status === "unanswered") {
    throw new Error(`${label} did not answer: ${settled.reason}`);
  }

  const history = await conversation.context(context);
  return lastAssistantText(history.messages);
}

function lastAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant") {
      continue;
    }

    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  return "";
}
