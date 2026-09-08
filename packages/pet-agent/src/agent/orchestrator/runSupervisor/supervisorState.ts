import { ReducedValue, StateSchema } from '@langchain/langgraph';
import { z as z4 } from 'zod/v4';
import type { RunSupervisorInput } from './runner';
import type { SupervisorCommand } from './protocol';

/** Private invocation state used by the Supervisor model and command-tool middleware. */
export const supervisorInvocationStateSchema = z4.object({
  currentInput: z4.custom<RunSupervisorInput>(),
  supervisorCommand: z4.custom<SupervisorCommand>().nullable().default(null),
});

/** Parallel detail reads merge names, without keeping call or round history. */
export const supervisorDisclosureStateSchema = new StateSchema({
  disclosedCapabilityNames: new ReducedValue(z4.array(z4.string()).default([]) as never, {
    inputSchema: z4.array(z4.string()).default([]) as never,
    reducer: (current: string[], next: string[]) => [...new Set([...current, ...next])],
  }),
});

export type SupervisorInvocationState = {
  currentInput: RunSupervisorInput;
  supervisorCommand: SupervisorCommand | null;
  disclosedCapabilityNames: string[];
};

export function currentSupervisorInput(state: Partial<SupervisorInvocationState>) {
  if (!state.currentInput) {
    throw new Error('Supervisor invocation state has no current input.');
  }
  return state.currentInput;
}

/** Keep every command-tool validation path on the same immutable catalog. */
export function supervisorCommandContext(input: RunSupervisorInput) {
  return {
    mode: input.mode,
    activeDelegation: input.activeDelegation,
    allowedCapabilityNames: input.catalog.capabilityNames,
  };
}
