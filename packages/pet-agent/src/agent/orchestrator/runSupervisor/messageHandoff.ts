import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../messages';
import { controlSchema, supervisorControlSchemas, type SupervisorControl } from './protocol';
export { supervisorControlSchemas, type SupervisorControl } from './protocol';
import { currentSupervisorTask, updateSupervisorTask, type RunSupervisorState } from './state';


const executionSchema = z.object({
  taskId: z.string().min(1),
  delegationId: z.string().min(1),
  capability: z.string().min(1),
  task: z.string().min(1),
  mode: z.enum(['initial', 'continue']),
  guidance: z.string().nullable(),
}).strict();

/** Root's actual tool input, not a second model-selected tool or a pending slot. */
export const capabilityHandoffSchema = z.object({
  control: controlSchema,
  execution: executionSchema,
}).strict();

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

/** These tools finish their own call; the exit adapter exports a separate execution call. */
export function createMessageSupervisorControlTools(context: SupervisorHandoffContext): StructuredTool[] {
  const names = context.mode === 'entry' ? ['submit_plan'] as const
    : context.hasNewUserInput ? ['review_current', 'adjust_plan'] as const : ['review_current'] as const;
  return names.map((name) => tool(async (args, runtime: ToolRuntime) => {
    const control = controlSchema.parse({ name, args });
    resolveControl(context, control, runtime.toolCallId);
    return new ToolMessage({ name, tool_call_id: runtime.toolCallId, content: 'Control decision submitted.' });
  }, {
    name,
    schema: supervisorControlSchemas[name],
    description: name === 'submit_plan' ? '提交计划并交接第一项执行。必须独占本次工具响应。'
      : name === 'adjust_plan' ? '按用户要求调整未完成计划，保留已完成进度并交接当前任务执行。必须独占本次工具响应。'
      : '根据计划与执行结果验收、继续或推进；已返回任务继续调度需明确 completed。填写 reply 则停止执行并回复，可暂缓验收。必须独占本次工具响应。',
    returnDirect: true,
  }));
}

/** Reject mixed control responses before createAgent executes any of their tools. */
export function createMessageSupervisorMiddleware(context: SupervisorHandoffContext) {
  return createMiddleware({
    name: 'SupervisorMessageHandoff',
    wrapModelCall: async (request, handler) => {
      const response = await handler(request);
      if (!AIMessage.isInstance(response) || response.invalid_tool_calls?.length) {
        throw new Error('Supervisor must produce a valid AIMessage.');
      }
      const calls = response.tool_calls ?? [];
      if (calls.some((call) => !Object.hasOwn(supervisorControlSchemas, call.name)
        && !(call.name === 'capability_details' && (context.mode === 'entry' || context.hasNewUserInput)))) {
        throw new Error('Supervisor called a tool unavailable in this invocation.');
      }
      const controls = calls.filter((call) => Object.hasOwn(supervisorControlSchemas, call.name));
      if (controls.length) {
        if (calls.length !== 1) throw new Error('Supervisor control must be the only tool call.');
        const call = controls[0];
        const control = controlSchema.parse({ name: call.name, args: call.args });
        resolveControl(context, control, call.id ?? '');
      }
      return response;
    },
  });
}

function identity(kind: string, ...parts: string[]) {
  return `${kind}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

export function executionsForTask(context: Pick<SupervisorHandoffContext, 'messages'>, taskId: string) {
  return context.messages.flatMap((message) => {
    if (!AIMessage.isInstance(message) || getAgentMessageMetadata(message).lane) return [];
    const metadata = getAgentMessageMetadata(message);
    return (message.tool_calls ?? []).flatMap((call) => {
      if (call.name !== 'delegate_capability') return [];
      const parsed = capabilityHandoffSchema.safeParse(call.args);
      return parsed.success && parsed.data.execution.taskId === taskId
        ? [{ call, metadata, execution: parsed.data.execution }] : [];
    });
  });
}

function hasDelivery(context: SupervisorHandoffContext, taskId: string) {
  const calls = executionsForTask(context, taskId);
  return context.messages.some((message) => {
    if (!ToolMessage.isInstance(message) || getAgentMessageMetadata(message).lane
      || message.name !== 'delegate_capability') return false;
    const execution = calls.find(({ call }) => call.id === message.tool_call_id);
    if (!execution) return false;
    if (typeof message.content !== 'string') return false;
    try {
      const result = JSON.parse(message.content);
      return result.status === 'returned' && typeof result.delivery?.text === 'string'
        && result.delivery.text.trim().length > 0
        && result.delivery.scope?.runId === execution.metadata.runId
        && result.delivery.scope?.traceId === execution.metadata.traceId
        && result.delivery.scope?.delegationId === execution.execution.delegationId
        && result.delivery.scope?.lane === `capability:${execution.execution.capability}`;
    } catch { return false; }
  });
}

/** One domain transition, used at the Supervisor exit and checked again at Root. */
function resolveControl(context: SupervisorHandoffContext, control: SupervisorControl, controlCallId: string) {
  if (!context.runId || !context.traceId || !controlCallId) throw new Error('Handoff requires run and call identities.');
  if (context.mode === 'entry' ? control.name !== 'submit_plan' : control.name === 'submit_plan') {
    throw new Error('Supervisor control is invalid in this mode.');
  }
  if (control.name === 'adjust_plan' && !context.hasNewUserInput) {
    throw new Error('Plan adjustment requires fresh user input.');
  }
  let state: RunSupervisorState = { goal: context.state.goal ?? context.userRequest, plan: [...context.state.plan] };
  const current = currentSupervisorTask(state);
  let guidance: string | null = null;
  let reply: string | null = null;
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
      || (task.status !== 'pending' && !(reuse && task.id === current?.id)))
      .map((task) => task.status === 'completed' ? task : { ...task, status: 'superseded' as const });
    state = {
      goal: control.name === 'adjust_plan' ? control.args.goal : context.userRequest,
      plan: [...retained, ...tasks.map((task, index) => ({
        ...task,
        id: reuse && index === 0 && current ? current.id : identity('task', context.runId, controlCallId, String(index)),
        status: 'pending' as const,
      }))],
    };
    guidance = control.name === 'adjust_plan' ? control.args.reason : null;
  } else {
    const { completed, reason } = control.args;
    reply = control.args.reply ?? null;
    if (completed === true) {
      if (!current || current.status !== 'returned' || !hasDelivery(context, current.id)) {
        throw new Error('Accepting a task requires its returned delivery.');
      }
      state = updateSupervisorTask(state, current.id, 'completed');
    } else if (completed === false) {
      if (!current) throw new Error('There is no task to continue.');
      if (reply) throw new Error('Ask directly instead of combining retry with a reply.');
      guidance = reason;
    } else if (current?.status === 'returned' && !reply) {
      throw new Error('Review must decide whether the returned task is complete.');
    }
  }
  const next = currentSupervisorTask(state);
  if (reply) return { state, execution: null, reply };
  if (!next) throw new Error('No planned work remains; a final reply is required.');
  if (!context.allowedCapabilityNames.includes(next.capability)) throw new Error('Capability is no longer available.');
  const previous = executionsForTask(context, next.id).filter(({ metadata }) => metadata.runId === context.runId).at(-1);
  if (previous && !context.messages.some((message) => ToolMessage.isInstance(message)
    && message.tool_call_id === previous.call.id && !getAgentMessageMetadata(message).lane)) {
    throw new Error('Cannot dispatch again while the current execution has no result.');
  }
  return {
    state: updateSupervisorTask(state, next.id, 'executing'),
    execution: {
      taskId: next.id,
      delegationId: previous?.execution.delegationId ?? identity('delegation', context.runId, next.id),
      capability: next.capability,
      task: next.task,
      mode: previous ? 'continue' as const : 'initial' as const,
      guidance,
    },
    reply: null,
  };
}

function completedControl(messages: readonly BaseMessage[]) {
  const confirmation = messages.at(-1);
  const request = messages.at(-2);
  if (!ToolMessage.isInstance(confirmation) || !AIMessage.isInstance(request)
    || confirmation.status === 'error' || request.invalid_tool_calls?.length || request.tool_calls?.length !== 1) {
    throw new Error('Supervisor handoff requires a completed exclusive control call.');
  }
  const call = request.tool_calls[0];
  if (!call.id || confirmation.tool_call_id !== call.id || confirmation.name !== call.name) {
    throw new Error('Supervisor control confirmation does not match its call.');
  }
  return { request, confirmation, call, control: controlSchema.parse({ name: call.name, args: call.args }) };
}

/** No proposal state: derive the Root AIMessage from the executed internal tool pair. */
export function createSupervisorMessageHandoff(context: SupervisorHandoffContext, internalMessages: readonly BaseMessage[]) {
  const { request, confirmation, call, control } = completedControl(internalMessages);
  const resolved = resolveControl(context, control, call.id!);
  const working = [new AIMessage({ ...request }), new ToolMessage({ ...confirmation })].map((message) =>
    setAgentMessageMetadata(message, { lane: 'supervisor', runId: context.runId, traceId: context.traceId }));
  working[0].id = identity('control', context.runId, call.id!);
  working[1].id = identity('confirmation', context.runId, call.id!);
  if (!resolved.execution) return working;
  const id = identity('execute', context.runId, call.id!);
  const dispatch = setAgentMessageMetadata(new AIMessage({ id, content: '', tool_calls: [{
    id, name: 'delegate_capability', args: { control, execution: resolved.execution }, type: 'tool_call',
  }] }), { runId: context.runId, traceId: context.traceId, sourceControlCallId: call.id, runtimeGenerated: true });
  return [...working, dispatch];
}

/** Root accepts the handoff message itself; it never persists a proposal/pending slot. */
export function acceptSupervisorMessageHandoff(context: SupervisorHandoffContext, messages: readonly BaseMessage[]) {
  const last = messages.at(-1);
  const hasDispatch = AIMessage.isInstance(last) && last.tool_calls?.[0]?.name === 'delegate_capability';
  if (hasDispatch && context.messages.some((message) => message.id === last.id)) {
    throw new Error('Capability handoff was already accepted.');
  }
  const internal = hasDispatch ? messages.slice(0, -1) : messages;
  const { control, call } = completedControl(internal);
  if (context.messages.some((message) => AIMessage.isInstance(message)
    && getAgentMessageMetadata(message).lane === 'supervisor'
    && getAgentMessageMetadata(message).runId === context.runId
    && message.tool_calls?.some((previous) => previous.id === call.id))) {
    throw new Error('Supervisor control call was already accepted.');
  }
  const expected = createSupervisorMessageHandoff(context, internal);
  if (hasDispatch) {
    const dispatch = last as AIMessage;
    const expectedDispatch = expected.at(-1) as AIMessage;
    capabilityHandoffSchema.parse(dispatch.tool_calls![0].args);
    if (!isDeepStrictEqual(dispatch.tool_calls, expectedDispatch.tool_calls)
      || dispatch.id !== expectedDispatch.id
      || !isDeepStrictEqual(getAgentMessageMetadata(dispatch), getAgentMessageMetadata(expectedDispatch))) {
      throw new Error('Capability handoff does not match the executed control decision.');
    }
  } else if (expected.length !== 2) {
    throw new Error('Supervisor omitted the execution call from its handoff.');
  }
  const resolved = resolveControl(context, control, call.id!);
  return { runSupervisorState: resolved.state, messages: expected, reply: resolved.reply };
}
