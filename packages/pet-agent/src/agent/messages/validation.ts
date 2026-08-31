import { SystemMessage, type BaseMessage } from '@langchain/core/messages';

export function findCanonicalSystemMessage(
  messages: readonly BaseMessage[],
): { message: SystemMessage; index: number } | null {
  const index = messages.findIndex((message) => SystemMessage.isInstance(message));
  if (index < 0) return null;
  return { message: messages[index] as SystemMessage, index };
}

/** Root history cannot supply a second instruction-authority channel. */
export function assertCanonicalAgentMessages(messages: readonly BaseMessage[]) {
  const systemMessage = findCanonicalSystemMessage(messages);
  if (!systemMessage) return;
  throw new Error(
    `Canonical Agent messages must not contain a SystemMessage (index ${systemMessage.index.toString()}). Use the node-owned System Policy channel instead.`,
  );
}
