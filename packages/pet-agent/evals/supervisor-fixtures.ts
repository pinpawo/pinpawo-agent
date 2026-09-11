import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { RunSupervisorInput, RunSupervisorResult } from '../src/agent/orchestrator/runSupervisor/runner';
import { supervisorControlSchemas } from '../src/agent/orchestrator/runSupervisor/messageHandoff';
import { createCapabilityDisclosureState } from '../src/agent/orchestrator/runSupervisor/capabilityDisclosure';
import { setAgentMessageMetadata } from '../src/agent/messages';

/** Read the original model decision, not the programmatically derived execution call. */
export function readSupervisorDecision(result: RunSupervisorResult) {
  if (result.reply !== undefined) return { reply: result.reply, action: undefined };
  const message = result.messages.filter((message) => AIMessage.isInstance(message)
    && message.tool_calls?.some((call) => Object.hasOwn(supervisorControlSchemas, call.name))).at(-1) as AIMessage | undefined;
  const call = message?.tool_calls?.[0];
  if (!call) throw new Error('Evaluation result has no internal control decision.');
  if (call.name === 'submit_plan') return { action: 'execute_plan' as const, ...supervisorControlSchemas.submit_plan.parse(call.args) };
  if (call.name === 'review_current') return { action: 'review_current' as const, ...supervisorControlSchemas.review_current.parse(call.args) };
  return { action: 'adjust_plan' as const, ...supervisorControlSchemas.adjust_plan.parse(call.args) };
}
export type SupervisorDecision = ReturnType<typeof readSupervisorDecision>;

/** Evaluation-only factual checkpoint, without invoking any executor. */
export function supervisorFixture(params: {
  catalog: RunSupervisorInput['catalog'];
  runId: string;
  goal: string;
  task?: string;
  capability?: string;
  evidence?: string;
  remaining?: Array<{ capability: string; task: string }>;
  freshUserInput?: boolean;
}): RunSupervisorInput {
  const capability = params.capability ?? 'general';
  const messages = [new HumanMessage(params.goal)];
  const input: RunSupervisorInput = {
    mode: params.task ? 'boundary' : 'entry',
    inputId: !params.task || params.freshUserInput ? `human:${params.runId}` : params.runId,
    runId: params.runId, traceId: params.runId, userRequest: params.goal, messages,
    catalog: params.catalog, capabilityDisclosure: createCapabilityDisclosureState({ catalog: params.catalog }),
    state: { goal: params.goal, plan: [
      ...(params.task ? [{ id: 'current', task: params.task, capability, status: 'pending' as const }] : []),
      ...(params.remaining ?? []).map((task, i) => ({ ...task, id: `next:${i}`, status: 'pending' as const })),
    ] },
  };
  if (!params.task || !params.evidence) return input;
  const id = `execute-fixture:${params.runId}`;
  const metadata = { runId: params.runId, traceId: params.runId };
  return { ...input, messages: [...messages,
    setAgentMessageMetadata(new AIMessage({ content: '', tool_calls: [{
      id, name: 'delegate_capability', type: 'tool_call', args: {
        control: { name: 'submit_plan', args: { tasks: [{ capability, task: params.task }] } },
        execution: { taskId: 'current', delegationId: 'delegation-fixture', capability, task: params.task, mode: 'initial', guidance: null },
      },
    }] }), metadata),
    setAgentMessageMetadata(new ToolMessage({ name: 'delegate_capability', tool_call_id: id, content: JSON.stringify({
      status: 'returned', delivery: { id: `delivery:${id}`, task: params.task, text: params.evidence,
        scope: { ...metadata, lane: `capability:${capability}`, delegationId: 'delegation-fixture' } },
    }) }), metadata),
  ] };
}
