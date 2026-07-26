import { randomUUID } from 'node:crypto';
import type { AgentSessionMessageInput } from '@pinpawo/agent-session';

export function createTuiMessage<
  T extends Omit<AgentSessionMessageInput, 'createdAt'>,
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
