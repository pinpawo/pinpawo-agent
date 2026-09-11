import { randomUUID } from 'node:crypto';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { RunSupervisorInput, RunSupervisorResult, RunSupervisorRunner } from './runner';
import { createSupervisorMessageHandoff, type SupervisorControl } from './messageHandoff';
import { supervisorHandoffContext } from './input';
import { setAgentMessageMetadata } from '../../messages';
import { controlSchema, type SupervisorControl as Control } from './protocol';

type SupervisorCommand =
  | ({ action: 'execute_plan' } & Extract<Control, { name: 'submit_plan' }>['args'])
  | ({ action: 'review_current' } & Extract<Control, { name: 'review_current' }>['args'])
  | ({ action: 'adjust_plan' } & Extract<Control, { name: 'adjust_plan' }>['args']);

export function readScriptedCommand(value: unknown): SupervisorCommand {
  const control = controlSchema.parse(value);
  if (control.name === 'submit_plan') return { action: 'execute_plan', ...control.args };
  if (control.name === 'review_current') return { action: 'review_current', ...control.args };
  return { action: 'adjust_plan', ...control.args };
}

/** Compact fixture notation only; the runtime seam always receives messages. */
export type ScriptedSupervisorDecision = SupervisorControl | SupervisorCommand | { reply: string };
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
    const raw = await runner.invoke(input, config);
    const { capabilityDisclosure, ...decision } = raw as ScriptedSupervisorDecision & {
      capabilityDisclosure?: RunSupervisorInput['capabilityDisclosure'];
    };
    if ('action' in decision) {
      const { action, ...args } = decision;
      const result = scriptedSupervisorResult(input, { name: action === 'execute_plan' ? 'submit_plan' : action, args } as SupervisorControl);
      return { ...result, capabilityDisclosure: capabilityDisclosure ?? result.capabilityDisclosure };
    }
    return scriptedSupervisorResult(input, decision);
  } };
}
