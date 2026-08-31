import { HumanMessage } from '@langchain/core/messages';
import { ensureAgentMessageId, setAgentMessageMetadata } from '../messages';

export type InvocationContextMessageInput = {
  readonly name: string;
  readonly content: string;
  readonly id?: string;
  readonly source?: string;
};

/**
 * Materialize one domain-owned invocation context as a non-authoritative model
 * message. The caller still owns the visible schema and content; this helper
 * only gives every invocation-only input the same transport metadata.
 */
export function createInvocationContextMessage(
  input: InvocationContextMessageInput,
): HumanMessage {
  if (!input.name.trim()) {
    throw new Error('Invocation Context message name must be non-empty.');
  }
  if (!input.content.trim()) {
    throw new Error(`Invocation Context message "${input.name}" content must be non-empty.`);
  }
  const message = new HumanMessage({
    ...(input.id ? { id: input.id } : {}),
    content: input.content,
  });
  message.name = input.name;
  ensureAgentMessageId(message);
  setAgentMessageMetadata(message, {
    source: input.source ?? input.name,
    synthetic: true,
    invocationOnly: true,
    authority: 'none',
  });
  return message;
}
