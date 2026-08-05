import {
  hasOnlyKeys,
  isJsonObject,
  readNonEmptyString,
} from './json';
import type { HumanReviewRequest } from './interaction';
import type { AgentStateSnapshot } from './state';

/** The stable text input supported by the core agent invocation boundary. */
export type AgentInput = {
  kind: 'text';
  text: string;
};

export type AgentInvocationRequest = {
  invocationId: string;
  threadId?: string;
  input: AgentInput;
};

export type AgentInvocationEvent =
  | { type: 'output.delta'; invocationId: string; text: string }
  | { type: 'output.completed'; invocationId: string; text: string }
  | { type: 'interaction.requested'; invocationId: string; interaction: HumanReviewRequest }
  | { type: 'state.updated'; invocationId: string; state: AgentStateSnapshot };

export type AgentInvocationResult = {
  invocationId: string;
  status: 'completed' | 'cancelled' | 'failed';
  output?: string;
};

function parseAgentInput(value: unknown): AgentInput | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['kind', 'text'])) return null;
  return value.kind === 'text' && typeof value.text === 'string'
    ? { kind: 'text', text: value.text }
    : null;
}

export function parseAgentInvocationRequest(value: unknown): AgentInvocationRequest | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['invocationId', 'threadId', 'input'])) {
    return null;
  }
  const input = parseAgentInput(value.input);
  const invocationId = readNonEmptyString(value.invocationId);
  const threadId = value.threadId === undefined ? undefined : readNonEmptyString(value.threadId);
  if (
    invocationId === null
    || (value.threadId !== undefined && threadId === null)
    || !input
  ) {
    return null;
  }
  return {
    invocationId,
    ...(threadId ? { threadId } : {}),
    input,
  };
}

export function isAgentInvocationRequest(value: unknown): value is AgentInvocationRequest {
  return parseAgentInvocationRequest(value) !== null;
}
