import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../messages';
import { supervisorControlSchemas } from './protocol';
import { identity, type SupervisorHandoffContext } from './controlContext';
import { resolveTranscript } from './controlTranscript';

/** Promote the Supervisor's request; never fabricate a second execution call. */
export function createSupervisorMessageHandoff(context: SupervisorHandoffContext, internalMessages: readonly BaseMessage[]) {
  return assembleHandoff(context, internalMessages, resolveTranscript(context, internalMessages));
}

function assembleHandoff(context: SupervisorHandoffContext, messages: readonly BaseMessage[],
  resolved: ReturnType<typeof resolveTranscript>) {
  return messages.flatMap((message, index) => {
    // The local acknowledgement only ends the Supervisor loop. Root returns the real result.
    if (resolved.executionCall && index === resolved.executionCall.index + 1) return [];
    const copy = AIMessage.isInstance(message) ? new AIMessage({ ...message })
      : ToolMessage.isInstance(message) ? new ToolMessage({ ...message }) : message;
    if (resolved.executionCall?.index === index && AIMessage.isInstance(copy)) {
      const id = identity('delegate', context.runId, resolved.executionCall.id);
      copy.id = id;
      copy.content = '';
      copy.tool_calls = [{ ...copy.tool_calls![0], id }];
      // The execution snapshot is internal data, not model-supplied tool arguments.
      copy.additional_kwargs = { ...copy.additional_kwargs, pinpawo: {
        runId: context.runId, traceId: context.traceId, source: 'supervisor',
        sourceToolCallId: resolved.executionCall.id, execution: resolved.execution,
      } };
      return [copy];
    }
    const call = AIMessage.isInstance(message) ? message.tool_calls?.[0] : undefined;
    copy.id = call?.id && Object.hasOwn(supervisorControlSchemas, call.name)
      ? identity('control', context.runId, call.id)
      : ToolMessage.isInstance(message) && Object.hasOwn(supervisorControlSchemas, message.name ?? '')
        ? identity('confirmation', context.runId, message.tool_call_id)
        : message.id ?? `supervisor-work:${randomUUID()}`;
    return [setAgentMessageMetadata(copy, { lane: 'supervisor', runId: context.runId, traceId: context.traceId })];
  });
}

export function acceptSupervisorMessageHandoff(context: SupervisorHandoffContext, messages: readonly BaseMessage[]) {
  const last = messages.at(-1);
  const hasDispatch = AIMessage.isInstance(last) && last.tool_calls?.[0]?.name === 'delegate_capability';
  if (hasDispatch && context.messages.some(message => message.id === last.id)) {
    throw new Error('Capability handoff was already accepted.');
  }
  const resolved = resolveTranscript(context, messages, 'handoff');
  const expected = assembleHandoff(context, messages, resolved);
  if (hasDispatch) {
    const dispatch = last as AIMessage;
    const expectedDispatch = expected.at(-1) as AIMessage;
    if (!resolved.execution || !isDeepStrictEqual(dispatch.tool_calls, expectedDispatch.tool_calls)
      || dispatch.id !== expectedDispatch.id
      || !isDeepStrictEqual(getAgentMessageMetadata(dispatch), getAgentMessageMetadata(expectedDispatch))) {
      throw new Error('Capability handoff does not match the executed control decision.');
    }
  }
  const reply = AIMessage.isInstance(last) && !last.tool_calls?.length && last.text.trim() ? last.text : null;
  return { runSupervisorState: resolved.state, messages: expected, reply };
}
