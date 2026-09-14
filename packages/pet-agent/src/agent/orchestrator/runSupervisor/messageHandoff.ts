import { randomUUID } from 'node:crypto';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../messages';
import { isSupervisorControlTool, type CapabilityExecutionInput } from './protocol';
import { currentSupervisorTask, runSupervisorStateSchema } from './state';
import type { RunSupervisorResult } from './runner';
import { readCapabilityExecutionCall } from '../executionMessages';
import { identity, type SupervisorHandoffContext } from './controlContext';

/** Attach execution inputs to the original request; no local execution result is fabricated. */
export function prepareCapabilityHandoff(context: SupervisorHandoffContext, request: AIMessage,
  execution: CapabilityExecutionInput): AIMessage {
  const call = request.tool_calls?.[0];
  if (!request.id || request.tool_calls?.length !== 1 || call?.name !== 'delegate_capability' || !call.id) {
    throw new Error('Handoff requires an identified exclusive delegation request.');
  }
  return new AIMessage({ ...request, additional_kwargs: { ...request.additional_kwargs, pinpawo: {
    runId: context.runId, traceId: context.traceId, source: 'supervisor', sourceToolCallId: call.id, execution,
  } } });
}

/** Persist new work and normalize the same delegation request for Root. */
export function createSupervisorMessageHandoff(context: SupervisorHandoffContext, messages: readonly BaseMessage[]) {
  const last = messages.at(-1);
  const dispatch = last && readCapabilityExecutionCall(last);
  return messages.map((message, index) => {
    const copy = AIMessage.isInstance(message) ? new AIMessage({ ...message })
      : ToolMessage.isInstance(message) ? new ToolMessage({ ...message }) : message;
    if (dispatch && index === messages.length - 1 && AIMessage.isInstance(copy)) {
      const id = identity('delegate', context.runId, dispatch.call.id!);
      copy.id = id;
      copy.content = '';
      copy.tool_calls = [{ ...copy.tool_calls![0], id }];
      return copy;
    }
    const call = AIMessage.isInstance(message) ? message.tool_calls?.[0] : undefined;
    copy.id = call?.id && isSupervisorControlTool(call.name)
      ? identity('control', context.runId, call.id)
      : ToolMessage.isInstance(message) && isSupervisorControlTool(message.name ?? '')
        ? identity('confirmation', context.runId, message.tool_call_id)
        : message.id ?? `supervisor-work:${randomUUID()}`;
    return setAgentMessageMetadata(copy, { lane: 'supervisor', runId: context.runId, traceId: context.traceId });
  });
}

/** Root trusts tool-maintained state, and validates only the cross-graph handoff. */
export function acceptSupervisorMessageHandoff(context: SupervisorHandoffContext,
  result: Pick<RunSupervisorResult, 'messages' | 'runSupervisorState'>) {
  const state = runSupervisorStateSchema.parse(result.runSupervisorState);
  const messages = result.messages;
  const last = messages.at(-1);
  if (AIMessage.isInstance(last) && last.tool_calls?.some(call => call.name === 'delegate_capability')) {
    const record = readCapabilityExecutionCall(last);
    if (!record) throw new Error('Invalid Capability handoff.');
    const { call, metadata, execution } = record;
    if (context.messages.some(message => AIMessage.isInstance(message)
      && message.tool_calls?.some(previous => previous.id === call.id))) {
      throw new Error('Capability handoff was already accepted.');
    }
    const current = currentSupervisorTask(state);
    if (!current || current.id !== execution.taskId || current.capability !== execution.capability
      || current.task !== execution.task || !context.allowedCapabilityNames.includes(execution.capability)
      || metadata.runId !== context.runId || metadata.traceId !== context.traceId
      || typeof metadata.sourceToolCallId !== 'string' || !metadata.sourceToolCallId
      || last.id !== call.id || call.id !== identity('delegate', context.runId, metadata.sourceToolCallId)) {
      throw new Error('Capability handoff does not match the current task or invocation.');
    }
  }
  const reply = AIMessage.isInstance(last) && !last.tool_calls?.length && last.text.trim() ? last.text : null;
  return { runSupervisorState: state, messages, reply };
}
