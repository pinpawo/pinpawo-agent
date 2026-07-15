import { randomUUID } from 'node:crypto';
import type { LocalAgentSessionMessageInput } from '../localAgentSession';

export function createTuiMessage<
  T extends Omit<LocalAgentSessionMessageInput, 'createdAt'>,
>(
  input: T,
  now = Date.now(),
): T & { id: string; createdAt: string } {
  return {
    ...input,
    id: input.id ?? `message:${randomUUID()}`,
    createdAt: new Date(now).toISOString(),
  };
}
