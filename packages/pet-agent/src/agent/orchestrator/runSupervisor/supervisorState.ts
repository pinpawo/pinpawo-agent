import type { BaseMessage } from '@langchain/core/messages';
import { ReducedValue, StateSchema } from '@langchain/langgraph';
import { z as z4 } from 'zod/v4';
import type { CapabilitySearchObservation } from './capabilityDisclosure';
import type { RunSupervisorInput } from './runner';
import type { SupervisorCommand } from './protocol';

function mergeCapabilitySearchObservation(
  current: CapabilitySearchObservation[],
  next: CapabilitySearchObservation | CapabilitySearchObservation[],
) {
  const additions = Array.isArray(next) ? next : [next];
  const knownToolCallIds = new Set(current.map(({ toolCallId }) => toolCallId));
  return [
    ...current,
    ...additions.filter(({ toolCallId }) => !knownToolCallIds.has(toolCallId)),
  ];
}

const capabilitySearchObservationSchema = z4.object({
  modelMessageId: z4.string(),
  toolCallId: z4.string(),
  disclosedCapabilityNames: z4.array(z4.string()),
});

/** Private invocation state used by the Supervisor model and command-tool middleware. */
export const supervisorInvocationStateSchema = z4.object({
  currentInput: z4.custom<RunSupervisorInput>(),
  supervisorCommand: z4.custom<SupervisorCommand>().nullable().default(null),
});

/**
 * Search is the one Supervisor concern that needs a reducer: parallel tool calls
 * append observations into the same model round. Keep it as a distinct graph
 * state channel so it does not change the existing middleware-private state.
 */
export const supervisorSearchStateSchema = new StateSchema({
  // Each search tool call writes one observation. The reducer preserves every
  // parallel result so empty search *rounds* can be derived by model message.
  capabilitySearchObservations: new ReducedValue(
    z4.array(capabilitySearchObservationSchema).default([]) as never,
    {
      // LangGraph's StateSchema currently types its schemas more narrowly
      // than the Zod v4 compatibility surface used by this workspace.
      // The input schema also initializes the channel. It therefore accepts
      // both one tool update and the empty persisted value.
      inputSchema: z4.union([
        capabilitySearchObservationSchema,
        z4.array(capabilitySearchObservationSchema),
      ]).default([]) as never,
      reducer: mergeCapabilitySearchObservation,
    },
  ),
});

export type SupervisorInvocationState = {
  currentInput: RunSupervisorInput;
  supervisorCommand: SupervisorCommand | null;
  capabilitySearchObservations: CapabilitySearchObservation[];
};

export type SupervisorSearchToolState = SupervisorInvocationState & {
  messages?: BaseMessage[];
};

export function currentSupervisorInput(state: Partial<SupervisorInvocationState>) {
  if (!state.currentInput) {
    throw new Error('Supervisor invocation state has no current input.');
  }
  return state.currentInput;
}

/** Keep every command-tool validation path on the same immutable workspace. */
export function supervisorCommandContext(input: RunSupervisorInput) {
  return {
    mode: input.mode,
    activeDelegation: input.activeDelegation,
    allowedCapabilityNames: input.workspace.capabilityNames,
  };
}
