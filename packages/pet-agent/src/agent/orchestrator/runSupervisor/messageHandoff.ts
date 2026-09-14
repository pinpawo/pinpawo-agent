import { randomUUID } from 'node:crypto';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../messages';
import { capabilityExecutionSnapshotSchema, supervisorControlSchemas } from './protocol';
import { currentSupervisorTask, runSupervisorStateSchema } from './state';
import type { RunSupervisorResult } from './runner';
import { readCapabilityExecutionCall } from '../executionMessages';
import { identity, type SupervisorHandoffContext } from './controlContext';

/** Promote the Supervisor's request; never fabricate a second execution call. */
export function createSupervisorMessageHandoff(context: SupervisorHandoffContext, internalMessages: readonly BaseMessage[]) {
  const last = internalMessages.at(-1);
  const request = internalMessages.at(-2);
  const dispatch = ToolMessage.isInstance(last) && last.name === 'delegate_capability' && last.status !== 'error';
  if (dispatch && (!AIMessage.isInstance(request) || request.tool_calls?.length !== 1
    || request.tool_calls[0].name !== 'delegate_capability' || request.tool_calls[0].id !== last.tool_call_id)) {
    throw new Error('Capability handoff requires its matching exclusive tool call.');
  }
  const execution = dispatch ? capabilityExecutionSnapshotSchema.parse(last.artifact) : null;
  const messages = dispatch ? internalMessages.slice(0, -1) : internalMessages;
  return messages.map((message, index) => {
    const copy = AIMessage.isInstance(message) ? new AIMessage({ ...message })
      : ToolMessage.isInstance(message) ? new ToolMessage({ ...message }) : message;
    if (dispatch && index === messages.length - 1 && AIMessage.isInstance(copy)) {
      const id = identity('delegate', context.runId, last.tool_call_id);
      copy.id = id;
      copy.content = '';
      copy.tool_calls = [{ ...copy.tool_calls![0], id }];
      // The execution snapshot is internal data, not model-supplied tool arguments.
      copy.additional_kwargs = { ...copy.additional_kwargs, pinpawo: {
        runId: context.runId, traceId: context.traceId, source: 'supervisor',
        sourceToolCallId: last.tool_call_id, execution,
      } };
      return copy;
    }
    const call = AIMessage.isInstance(message) ? message.tool_calls?.[0] : undefined;
    copy.id = call?.id && Object.hasOwn(supervisorControlSchemas, call.name)
      ? identity('control', context.runId, call.id)
      : ToolMessage.isInstance(message) && Object.hasOwn(supervisorControlSchemas, message.name ?? '')
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
