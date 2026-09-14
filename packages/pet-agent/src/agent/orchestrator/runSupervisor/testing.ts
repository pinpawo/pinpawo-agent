import { randomUUID } from 'node:crypto';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { RunSupervisorInput, RunSupervisorResult, RunSupervisorRunner } from './runner';
import { createSupervisorMessageHandoff } from './messageHandoff';
import type { SupervisorControl } from './protocol';
import { supervisorHandoffContext } from './input';
import { setAgentMessageMetadata } from '../../messages';

/** Compact fixture notation only; the runtime seam always receives messages. */
export type ScriptedSupervisorDecision = (SupervisorControl | { name: 'review_current'; args: { completed?: boolean; reason: string; reply?: string } } | { reply: string }) & {
  capabilityDisclosure?: RunSupervisorInput['capabilityDisclosure'];
};
export type ScriptedSupervisorRunner = {
  invoke(input: RunSupervisorInput, config?: RunnableConfig): Promise<ScriptedSupervisorDecision>;
};

/** Script fixtures still exercise the same message handoff as the production agent. */
export function scriptedSupervisorResult(input: RunSupervisorInput,
  decision: ScriptedSupervisorDecision): RunSupervisorResult {
  const id = `scripted:${randomUUID()}`;
  const messages: BaseMessage[] = [];
  const call = (control: SupervisorControl) => {
    const callId = `${id}:${messages.length}`;
    messages.push(new AIMessage({ content: '', tool_calls: [{ id: callId, name: control.name, args: control.args, type: 'tool_call' }] }),
      new ToolMessage({ name: control.name, tool_call_id: callId, content: 'Scenario tool result.' }));
  };
  let reply: string | undefined;
  if ('reply' in decision) reply = decision.reply;
  else if (decision.name === 'review_current') {
    if (decision.args.completed !== undefined) call({ name: 'review_current', args: {
      completed: decision.args.completed, reason: decision.args.reason,
    } });
    reply = 'reply' in decision.args ? decision.args.reply : undefined;
    if (!reply) {
      call({ name: 'delegate_capability', args: {} });
    }
  } else {
    call(decision);
    if (decision.name !== 'delegate_capability') call({ name: 'delegate_capability', args: {} });
  }
  if (reply !== undefined) messages.push(new AIMessage({ id: `${id}:reply`, content: reply }));
  return { capabilityDisclosure: input.capabilityDisclosure, ...(reply !== undefined ? { reply } : {}),
    messages: createSupervisorMessageHandoff(supervisorHandoffContext(input), messages) };
}

export function withScriptedDelegation(runner: ScriptedSupervisorRunner): RunSupervisorRunner {
  return { invoke: async (input, config) => {
    const decision = await runner.invoke(input, config);
    const result = scriptedSupervisorResult(input, decision);
    return { ...result, capabilityDisclosure: decision.capabilityDisclosure ?? result.capabilityDisclosure };
  } };
}
