import { AIMessage } from '@langchain/core/messages';
import type { RunSupervisorInput, RunSupervisorResult, RunSupervisorRunner } from './runner';

/** Scripted model equivalent for graph tests; never used by production runners. */
export function scriptedDelegation(input: RunSupervisorInput): RunSupervisorResult | null {
  const pending = input.pendingDelegation;
  if (!pending) return null;
  const toolCallId = `scripted:${input.runId}:${input.inputId}:${input.supervisorSession.messages?.length ?? 0}`;
  return {
    action: 'delegate_capability', toolCallId, delegationId: pending.delegationId,
    messages: [...(input.supervisorSession.messages ?? []), new AIMessage({
      id: `model:${toolCallId}`, content: '', tool_calls: [{
        id: toolCallId, name: 'delegate_capability',
        args: { capability: pending.capability, task: pending.task }, type: 'tool_call',
      }],
    })],
  };
}

export function withScriptedDelegation(runner: RunSupervisorRunner): RunSupervisorRunner {
  return { invoke: async (input, config) => scriptedDelegation(input) ?? runner.invoke(input, config) };
}
