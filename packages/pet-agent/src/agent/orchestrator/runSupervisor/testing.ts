import { randomUUID } from 'node:crypto';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { RunSupervisorInput, RunSupervisorResult, RunSupervisorRunner } from './runner';
import { createSupervisorMessageHandoff, type SupervisorControl } from './messageHandoff';
import { supervisorHandoffContext } from './input';
import { setAgentMessageMetadata } from '../../messages';

/** Compact fixture notation only; the runtime seam always receives messages. */
export type ScriptedSupervisorDecision = (SupervisorControl | { reply: string }) & {
  capabilityDisclosure?: RunSupervisorInput['capabilityDisclosure'];
};
export type ScriptedSupervisorRunner = {
  invoke(input: RunSupervisorInput, config?: RunnableConfig): Promise<ScriptedSupervisorDecision>;
};

/** Script fixtures still exercise the same message handoff as the production agent. */
export function scriptedSupervisorResult(input: RunSupervisorInput,
  decision: SupervisorControl | { reply: string }): RunSupervisorResult {
  const id = `scripted:${randomUUID()}`;
  if ('reply' in decision) {
    return { reply: decision.reply, capabilityDisclosure: input.capabilityDisclosure,
      messages: [setAgentMessageMetadata(new AIMessage({ id, content: decision.reply }),
        { lane: 'supervisor', runId: input.runId, traceId: input.traceId })] };
  }
  return { capabilityDisclosure: input.capabilityDisclosure, messages: createSupervisorMessageHandoff(
    supervisorHandoffContext(input), [
      new AIMessage({ content: '', tool_calls: [{ id, name: decision.name, args: decision.args, type: 'tool_call' }] }),
      new ToolMessage({ name: decision.name, tool_call_id: id, content: 'Control decision submitted.' }),
    ],
  ) };
}

export function withScriptedDelegation(runner: ScriptedSupervisorRunner): RunSupervisorRunner {
  return { invoke: async (input, config) => {
    const decision = await runner.invoke(input, config);
    const result = scriptedSupervisorResult(input, decision);
    return { ...result, capabilityDisclosure: decision.capabilityDisclosure ?? result.capabilityDisclosure };
  } };
}
