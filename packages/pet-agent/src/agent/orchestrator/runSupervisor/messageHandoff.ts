import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool, ToolInputParsingException, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { createMiddleware, ToolInvocationError } from 'langchain';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../messages';
import { executionsForTask } from '../executionMessages';
import { capabilityHandoffSchema, controlSchema, supervisorControlSchemas, type SupervisorControl } from './protocol';
import { currentSupervisorTask, updateSupervisorTask, type RunSupervisorState } from './state';
export { supervisorControlSchemas, type SupervisorControl } from './protocol';

export type SupervisorHandoffContext = {
  state: RunSupervisorState;
  runId: string;
  traceId: string;
  userRequest: string;
  mode: 'entry' | 'boundary';
  hasNewUserInput: boolean;
  allowedCapabilityNames: readonly string[];
  /** Root-owned records, never the model's proposed transcript. */
  messages: readonly BaseMessage[];
};

const controlNames = ['submit_plan', 'review_current', 'adjust_plan', 'execute_current'] as const;

/** Plan/review tools return facts to the model. Only explicit execution yields to Root. */
export function createMessageSupervisorControlTools(context: SupervisorHandoffContext, messageOffset = 0): StructuredTool[] {
  return controlNames.map((name) => tool(async (args, runtime: ToolRuntime) => {
    const messages = (((runtime.state ?? {}) as { messages?: BaseMessage[] }).messages ?? []).slice(messageOffset);
    const current = resolveTranscript(context, messages, true);
    const control = controlSchema.parse({ name, args });
    const resolved = resolveControl({ ...context, state: current.state }, control, runtime.toolCallId!);
    return new ToolMessage({ name, tool_call_id: runtime.toolCallId,
      content: JSON.stringify({ plan: resolved.state, execution: resolved.execution }) });
  }, {
    name,
    schema: supervisorControlSchemas[name],
    verboseParsingErrors: true,
    description: name === 'submit_plan' ? '建立计划并返回计划事实，由你继续决定下一步。'
      : name === 'adjust_plan' ? '调整计划并返回更新后的事实，由你继续决定下一步。'
      : name === 'review_current' ? '验收当前交付并记录结论。返回计划事实，不触发执行；之后由你决定执行、调整或直接回复。'
      : '执行当前计划项，将控制权交给 Capability；返回交付后由你继续判断。',
  }));
}

export function createSupervisorControlValidationMiddleware() {
  return createMiddleware({
    name: 'SupervisorControlValidation',
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (error) {
        // ToolNode validates arguments before invoking the tool body. Keep its
        // feedback, but mark failures explicitly so they cannot commit controls.
        if (!(error instanceof ToolInvocationError)
          || !(error.toolError instanceof ToolInputParsingException)) throw error;
        return new ToolMessage({
          name: request.toolCall.name, tool_call_id: request.toolCall.id!, status: 'error',
          content: error.toolError.message,
        });
      }
    },
    beforeModel: {
      canJumpTo: ['end'],
      hook: (state) => {
        const last = state.messages.at(-1);
        // Failed execution requests must reach the model for correction too.
        if (ToolMessage.isInstance(last) && last.name === 'execute_current' && last.status !== 'error') {
          return { jumpTo: 'end' as const };
        }
      },
    },
    wrapModelCall: async (request, handler) => {
      const response = await handler(request);
      if (!AIMessage.isInstance(response) || response.invalid_tool_calls?.length) {
        throw new Error('Supervisor must produce a valid AIMessage.');
      }
      const calls = response.tool_calls ?? [];
      // ToolNode returns unknown-tool errors with the available names. Do not
      // intercept those here: the model needs the normal tool feedback to retry.
      if (calls.some((call) => !call.id)) throw new Error('Supervisor tool call requires a tool call id.');
      const controls = calls.filter((call) => Object.hasOwn(supervisorControlSchemas, call.name));
      if (controls.length) {
        if (calls.length !== 1) throw new Error('Supervisor control must be the only tool call.');
      }
      return response;
    },
  });
}

function identity(kind: string, ...parts: string[]) {
  return `${kind}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

/** One domain transition, used at the Supervisor exit and checked again at Root. */
function resolveControl(context: SupervisorHandoffContext, control: SupervisorControl, controlCallId: string) {
  if (!context.runId || !context.traceId || !controlCallId) throw new Error('Handoff requires run and call identities.');
  if (control.name === 'adjust_plan' && !context.hasNewUserInput
    && control.args.goal !== (context.state.goal ?? context.userRequest)) {
    throw new Error('Changing the goal requires fresh user input.');
  }
  let state: RunSupervisorState = { goal: context.state.goal ?? context.userRequest, plan: [...context.state.plan] };
  const current = currentSupervisorTask(state);
  if (control.name === 'submit_plan' || control.name === 'adjust_plan') {
    const tasks = control.args.tasks;
    if (tasks.some((task) => !context.allowedCapabilityNames.includes(task.capability))) {
      throw new Error('Plan selects a capability outside the current catalog.');
    }
    if (control.name === 'submit_plan' && current && !context.hasNewUserInput) {
      throw new Error('Replacing unfinished work requires fresh user input.');
    }
    const reuse = control.name === 'adjust_plan' && control.args.currentDelegation === 'continue';
    if (reuse && current && current.capability !== tasks[0].capability) {
      throw new Error('Continuing a task must keep its capability.');
    }
    const retained = (control.name === 'submit_plan' ? [] : state.plan).filter((task) => task.status === 'completed' || task.status === 'superseded'
      || (executionsForTask(context, task.id).length > 0 && !(reuse && task.id === current?.id)))
      .map((task) => task.status === 'completed' ? task : { ...task, status: 'superseded' as const });
    state = {
      goal: control.name === 'adjust_plan' ? control.args.goal : context.userRequest,
      plan: [...retained, ...tasks.map((task, index) => ({
        ...task,
        id: reuse && index === 0 && current ? current.id : identity('task', context.runId, controlCallId, String(index)),
        status: 'pending' as const,
      }))],
    };
  } else if (control.name === 'review_current') {
    const latestResult = current ? executionsForTask(context, current.id).at(-1)?.result : null;
    if (!current) throw new Error('There is no task to review.');
    if (control.args.completed) {
      if (!latestResult || latestResult.status !== 'returned' || !latestResult.delivery) {
        throw new Error('Accepting a task requires its returned delivery.');
      }
      state = updateSupervisorTask(state, current.id, 'completed');
    }
  }
  if (control.name !== 'execute_current') return { state, execution: null };
  const next = currentSupervisorTask(state);
  if (!next) throw new Error('There is no planned task to execute.');
  const guidance = control.args.guidance ?? null;
  if (!context.allowedCapabilityNames.includes(next.capability)) throw new Error('Capability is no longer available.');
  const previous = executionsForTask(context, next.id).filter(({ metadata }) => metadata.runId === context.runId).at(-1);
  if (previous && !context.messages.some((message) => ToolMessage.isInstance(message)
    && message.tool_call_id === previous.call.id && !getAgentMessageMetadata(message).lane)) {
    throw new Error('Cannot dispatch again while the current execution has no result.');
  }
  return {
    state,
    execution: {
      taskId: next.id,
      delegationId: previous?.execution.delegationId ?? identity('delegation', context.runId, next.id),
      capability: next.capability,
      task: next.task,
      mode: previous ? 'continue' as const : 'initial' as const,
      guidance,
    },
  };
}

/** Fold this invocation's successful control pairs; Root remains the commit owner. */
function resolveTranscript(context: SupervisorHandoffContext, messages: readonly BaseMessage[], allowPending = false) {
  let state = context.state;
  let execution: ReturnType<typeof resolveControl>['execution'] = null;
  let executionCall: { id: string; control: SupervisorControl } | null = null;
  const seen = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const result = messages[index];
    if (AIMessage.isInstance(result) && result.tool_calls?.some((call) => Object.hasOwn(supervisorControlSchemas, call.name))) {
      if (result.tool_calls.length !== 1) throw new Error('Supervisor handoff requires an exclusive control call.');
      const confirmation = messages[index + 1];
      if (ToolMessage.isInstance(confirmation)) {
        const call = result.tool_calls[0];
        if (call.name !== confirmation.name || call.id !== confirmation.tool_call_id) {
          throw new Error('Supervisor control confirmation does not match its call.');
        }
      } else if (!(allowPending && index === messages.length - 1)) {
        throw new Error('Supervisor handoff requires a completed exclusive control call.');
      }
    }
    if (!ToolMessage.isInstance(result) || !Object.hasOwn(supervisorControlSchemas, result.name ?? '')) continue;
    const request = messages[index - 1];
    if (!AIMessage.isInstance(request) || request.invalid_tool_calls?.length || request.tool_calls?.length !== 1) {
      throw new Error('Supervisor handoff requires an exclusive control call.');
    }
    const call = request.tool_calls[0];
    if (!call.id || call.id !== result.tool_call_id || call.name !== result.name) {
      throw new Error('Supervisor control confirmation does not match its call.');
    }
    if (seen.has(call.id) || context.messages.some((message) => AIMessage.isInstance(message)
      && getAgentMessageMetadata(message).lane === 'supervisor'
      && getAgentMessageMetadata(message).runId === context.runId
      && message.tool_calls?.some((previous) => previous.id === call.id))) {
      throw new Error('Supervisor control call was already accepted.');
    }
    seen.add(call.id);
    if (result.status === 'error') continue;
    if (executionCall) throw new Error('Supervisor must yield after requesting execution.');
    const control = controlSchema.parse({ name: call.name, args: call.args });
    const resolved = resolveControl({ ...context, state }, control, call.id);
    state = resolved.state;
    execution = resolved.execution;
    if (execution) executionCall = { id: call.id, control };
  }
  return { state, execution, executionCall };
}

/** Keep all internal decisions; only an explicit execute call derives a Root tool call. */
export function createSupervisorMessageHandoff(context: SupervisorHandoffContext, internalMessages: readonly BaseMessage[]) {
  return assembleHandoff(context, internalMessages, resolveTranscript(context, internalMessages));
}

function assembleHandoff(context: SupervisorHandoffContext, internalMessages: readonly BaseMessage[],
  resolved: ReturnType<typeof resolveTranscript>) {
  const working = internalMessages.map((message) => {
    const copy = AIMessage.isInstance(message) ? new AIMessage({ ...message })
      : ToolMessage.isInstance(message) ? new ToolMessage({ ...message }) : message;
    const call = AIMessage.isInstance(message) ? message.tool_calls?.[0] : undefined;
    copy.id = call?.id && Object.hasOwn(supervisorControlSchemas, call.name)
      ? identity('control', context.runId, call.id)
      : ToolMessage.isInstance(message) && Object.hasOwn(supervisorControlSchemas, message.name ?? '')
        ? identity('confirmation', context.runId, message.tool_call_id)
        : message.id ?? `supervisor-work:${randomUUID()}`;
    return setAgentMessageMetadata(copy, { lane: 'supervisor', runId: context.runId, traceId: context.traceId });
  });
  if (!resolved.execution || !resolved.executionCall) return working;
  const { id: callId, control } = resolved.executionCall;
  const id = identity('execute', context.runId, callId);
  const dispatch = setAgentMessageMetadata(new AIMessage({ id, content: '', tool_calls: [{
    id, name: 'delegate_capability', args: { control, execution: resolved.execution }, type: 'tool_call',
  }] }), { runId: context.runId, traceId: context.traceId, sourceControlCallId: callId, runtimeGenerated: true });
  return [...working, dispatch];
}

export function acceptSupervisorMessageHandoff(context: SupervisorHandoffContext, messages: readonly BaseMessage[]) {
  const last = messages.at(-1);
  const hasDispatch = AIMessage.isInstance(last) && last.tool_calls?.[0]?.name === 'delegate_capability';
  if (hasDispatch && context.messages.some((message) => message.id === last.id)) {
    throw new Error('Capability handoff was already accepted.');
  }
  const internal = hasDispatch ? messages.slice(0, -1) : messages;
  const resolved = resolveTranscript(context, internal);
  const expected = assembleHandoff(context, internal, resolved);
  if (hasDispatch) {
    const dispatch = last as AIMessage;
    const expectedDispatch = expected.at(-1) as AIMessage;
    capabilityHandoffSchema.parse(dispatch.tool_calls![0].args);
    if (!resolved.execution || !isDeepStrictEqual(dispatch.tool_calls, expectedDispatch.tool_calls)
      || dispatch.id !== expectedDispatch.id
      || !isDeepStrictEqual(getAgentMessageMetadata(dispatch), getAgentMessageMetadata(expectedDispatch))) {
      throw new Error('Capability handoff does not match the executed control decision.');
    }
  } else if (resolved.execution) {
    throw new Error('Supervisor omitted the execution call from its handoff.');
  }
  const reply = AIMessage.isInstance(last) && !last.tool_calls?.length && last.text.trim() ? last.text : null;
  return { runSupervisorState: resolved.state, messages: expected, reply };
}
