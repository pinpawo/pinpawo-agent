import { createHash } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';
import type { z } from 'zod';
import type { capabilityExecutionSnapshotSchema } from './protocol';
import type { RunSupervisorState } from './state';

export type SupervisorHandoffContext = {
  state: RunSupervisorState;
  runId: string;
  traceId: string;
  userRequest: string;
  mode: 'entry' | 'boundary';
  hasNewUserInput: boolean;
  allowedCapabilityNames: readonly string[];
  /** Root-owned records, never the model's proposed transcript. */
  messages: readonly BaseMessage[];
};

/** A valid tool call whose requested transition is not available in the current plan. */
export class SupervisorDecisionError extends Error {}

export type SupervisorDecision = {
  state: RunSupervisorState;
  execution: z.infer<typeof capabilityExecutionSnapshotSchema> | null;
};

export function identity(kind: string, ...parts: string[]) {
  return `${kind}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}
