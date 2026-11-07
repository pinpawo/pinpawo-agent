import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command, END } from '@langchain/langgraph';
import { countTokensApproximately, createMiddleware, modelCallLimitMiddleware, type ModelRequest } from 'langchain';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../agent/messages/metadata';
import { readLatestProviderInputTokens } from '../agent/tokenUsage';
import type { GuardDecisionRecord } from '../guards';
import { emitRuntimeEventToStreamWriter } from '../utils/streamWriterEvents';
import { markSubagentGuardStop } from './guardStop';
import { SUBAGENT_BUDGET_HANDOFF_PROMPT } from './prompts/templates/budgetHandoff.prompt';

export const SUBAGENT_GUARD_DECISION_EVENT = 'subagent_guard_decision';
export const SUBAGENT_BUDGET_HANDOFF_EVENT = 'subagent_budget_handoff';
const CONTEXT_HANDOFF_RATIO = 0.85;

type BudgetOptions = {
  maxIterations: number;
  invocationId: string;
  contextWindowTokens?: number;
  generationReserveTokens?: number;
  inputMessageIds: ReadonlySet<string>;
};

type HandoffNotice = {
  reason: 'model_calls' | 'context_window';
  phase: 'prepare' | 'finalize';
  iteration: number;
  maxIterations?: number;
  remainingModelCalls?: number;
  estimatedInputTokens?: number;
  inputBudgetTokens?: number;
  triggerTokens?: number;
  contextWindowTokens?: number;
  generationReserveTokens?: number;
};

function isBudgetNotice(message: BaseMessage | undefined): message is ToolMessage {
  return !!message && ToolMessage.isInstance(message)
    && message.name === 'runtime_budget_status'
    && getAgentMessageMetadata(message).synthetic === true
    && getAgentMessageMetadata(message).runtimeNotice === 'subagent_budget';
}

function noticeId(invocationId: string, reason: HandoffNotice['reason'], phase: HandoffNotice['phase']) {
  return `runtime-budget:${invocationId}:${reason}:${phase}`;
}

function contextNotice(messages: BaseMessage[], invocationId: string): HandoffNotice | undefined {
  const id = `${noticeId(invocationId, 'context_window', 'finalize')}:result`;
  const notice = messages.find(message => message.id === id && isBudgetNotice(message));
  return notice ? JSON.parse(notice.text) as HandoffNotice : undefined;
}

/** Include the final composed system and tools, not only persisted chat messages. */
function estimateInputTokens(request: ModelRequest, inputMessageIds: ReadonlySet<string>): number {
  let estimate = countTokensApproximately([request.systemMessage, ...request.messages], request.tools);
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (!AIMessage.isInstance(message) || inputMessageIds.has(message.id!)
      || getAgentMessageMetadata(message).runtimeNotice === 'subagent_budget') continue;
    // Parent history can use another model/window. Use this invocation's latest
    // known provider input size, adding all subsequent growth. Missing usage on
    // a later response does not discard a still-valid anchor: this middleware
    // never removes or summarizes earlier messages.
    const inputTokens = readLatestProviderInputTokens([message]);
    if (inputTokens !== null) {
      estimate = Math.max(estimate, inputTokens + countTokensApproximately(request.messages.slice(index)));
      break;
    }
  }
  return estimate;
}

function notification(invocationId: string, data: HandoffNotice) {
  const callId = noticeId(invocationId, data.reason, data.phase);
  const metadata = { synthetic: true, runtimeNotice: 'subagent_budget' };
  const budget = data.reason === 'context_window'
    ? `Estimated input is ${data.estimatedInputTokens} tokens, with ${data.generationReserveTokens} tokens reserved for generation in this delegation's ${data.contextWindowTokens}-token total context window. The input handoff threshold is ${data.triggerTokens} tokens.`
    : `You have ${data.remainingModelCalls} model calls left, including this call, within this delegation's limit of ${data.maxIterations}.`;
  return [
    setAgentMessageMetadata(new AIMessage({
      id: `${callId}:call`, content: '',
      tool_calls: [{ id: callId, name: 'runtime_budget_status', args: {}, type: 'tool_call' }],
    }), metadata),
    setAgentMessageMetadata(new ToolMessage({
      id: `${callId}:result`, name: 'runtime_budget_status', tool_call_id: callId,
      status: 'success', content: JSON.stringify({
        ...data,
        instruction: SUBAGENT_BUDGET_HANDOFF_PROMPT.render({
          budget,
          finalInstruction: data.phase === 'finalize'
            ? 'This is your final call. Deliver these results now; further tool calls will not execute.'
            : 'Use the remaining calls for essential work, then deliver these results.',
        }),
      }),
    }), metadata),
  ];
}

function stopForContext(content: string) {
  return new Command({ goto: END, update: { messages: [markSubagentGuardStop(
    new AIMessage(content), 'subagent_context_limit_reached',
  )] } });
}

/** Native model-call counting/limits; this layer adds the shared handoff policy. */
export function createSubagentBudgetMiddleware(options: BudgetOptions) {
  const { maxIterations, invocationId } = options;
  const runLimit = Number.isFinite(maxIterations) && maxIterations > 0 ? Math.floor(maxIterations) : undefined;
  const handoffCalls = runLimit ? Math.min(10, Math.ceil(runLimit * 0.1)) : 0;
  const window = options.contextWindowTokens;
  const reserve = Number.isFinite(options.generationReserveTokens)
    ? Math.max(0, Math.floor(options.generationReserveTokens!)) : 0;
  const inputBudgetTokens = window && Number.isFinite(window) && window > 0
    ? Math.max(1, Math.floor(window - reserve)) : undefined;
  const triggerTokens = inputBudgetTokens === undefined ? undefined
    // The ratio applies to total occupancy, including reserved output/reasoning.
    // Keep the remaining 15% of the full window for growth and estimation error.
    : Math.max(1, Math.floor(window! * CONTEXT_HANDOFF_RATIO) - reserve);
  const limiter = modelCallLimitMiddleware({ runLimit, exitBehavior: 'end' });
  const beforeModel = limiter.beforeModel!;
  const checkBudget = typeof beforeModel === 'function' ? beforeModel : beforeModel.hook;
  limiter.name = 'SubagentIterationGuard';
  limiter.contextSchema = undefined;
  limiter.beforeModel = undefined;
  // afterModel runs in reverse: notification steps bypass the counter and
  // Review; real responses increment before Review can interrupt the graph.
  const counter = { ...limiter, name: 'SubagentIterationCounter', afterAgent: undefined };
  limiter.afterModel = undefined;
  limiter.wrapModelCall = async (request, handler) => {
    // Review Respond jumps straight to model, skipping beforeModel entirely.
    const update = await checkBudget(request.state, {
      ...request.runtime, context: { runLimit, threadLimit: undefined, exitBehavior: 'end' },
    });
    const iteration = request.state.runModelCallCount + 1;
    const stopped = update?.jumpTo === 'end';
    const decision: GuardDecisionRecord = {
      guard: 'subagent_iteration_limit', position: 'subagent.before_model_iteration',
      outcome: stopped
        ? { kind: 'stop', reason: 'subagent_iteration_limit_reached', details: { iterationCount: iteration, maxIterations } }
        : { kind: 'proceed' },
      iteration,
    };
    if (stopped) {
      emitRuntimeEventToStreamWriter({ event: 'on_runtime_event', name: SUBAGENT_GUARD_DECISION_EVENT, data: decision });
      const notice = update.messages?.find(AIMessage.isInstance);
      if (!notice) throw new Error('LangChain model-call limit returned no AI stop message.');
      markSubagentGuardStop(notice, 'subagent_iteration_limit_reached');
      return new Command({ goto: END, update: { messages: update.messages } });
    }
    const contextFinal = contextNotice(request.state.messages, invocationId);
    if (contextFinal && request.state.runModelCallCount >= contextFinal.iteration) {
      return stopForContext('The context-budgeted handoff call has already completed.');
    }
    const response = await handler(request);
    if (AIMessage.isInstance(response)) {
      emitRuntimeEventToStreamWriter({ event: 'on_runtime_event', name: SUBAGENT_GUARD_DECISION_EVENT, data: decision });
    }
    if ((iteration === runLimit || contextFinal) && AIMessage.isInstance(response)
      && (response.tool_calls?.length || response.invalid_tool_calls?.length
        || (Array.isArray(response.additional_kwargs.tool_calls) && response.additional_kwargs.tool_calls.length))) {
      // Enforce locally even if a provider or caller middleware ignores none.
      return markSubagentGuardStop(new AIMessage({
        content: 'The final budgeted model call did not return a text handoff.',
        usage_metadata: response.usage_metadata,
      }), contextFinal ? 'subagent_context_limit_reached' : 'subagent_iteration_limit_reached');
    }
    return response;
  };
  const handoff = createMiddleware({
    name: 'SubagentBudgetHandoff', stateSchema: limiter.stateSchema,
    afterModel: {
      hook: state => {
        if (isBudgetNotice(state.messages.at(-1))) return { jumpTo: 'model' as const };
      },
      canJumpTo: ['model'],
    },
    wrapModelCall: (request, handler) => {
      const iteration = request.state.runModelCallCount + 1;
      const remainingModelCalls = runLimit === undefined ? undefined : runLimit - request.state.runModelCallCount;
      const estimatedInputTokens = triggerTokens === undefined ? undefined
        : estimateInputTokens(request, options.inputMessageIds);
      if (estimatedInputTokens !== undefined && estimatedInputTokens >= inputBudgetTokens!) {
        return stopForContext(`Subagent input estimate (${estimatedInputTokens} tokens) exceeds its usable input budget (${inputBudgetTokens}); reduce the delegation input or tool output before continuing.`);
      }
      const contextFinal = contextNotice(request.state.messages, invocationId);
      let data: HandoffNotice | undefined;
      if (!contextFinal && estimatedInputTokens !== undefined && estimatedInputTokens >= triggerTokens!) {
        data = { reason: 'context_window', phase: 'finalize', iteration,
          estimatedInputTokens, inputBudgetTokens, triggerTokens,
          contextWindowTokens: window, generationReserveTokens: reserve };
      } else if (!contextFinal && remainingModelCalls !== undefined
        && (remainingModelCalls === handoffCalls || remainingModelCalls === 1)) {
        data = { reason: 'model_calls', phase: remainingModelCalls === 1 ? 'finalize' : 'prepare',
          iteration, maxIterations: runLimit, remainingModelCalls };
      }
      if (data && !request.state.messages.some(message => message.id === `${noticeId(invocationId, data.reason, data.phase)}:result`)) {
        emitRuntimeEventToStreamWriter({ event: 'on_runtime_event', name: SUBAGENT_BUDGET_HANDOFF_EVENT, data });
        // Persist before the real call, without executing the synthetic tool.
        return new Command({ update: { messages: notification(invocationId, data) } });
      }
      // Keep the tool definitions and system prefix stable for both reasons.
      return handler(contextFinal || remainingModelCalls === 1 ? { ...request, toolChoice: 'none' } : request);
    },
  });
  return { guard: limiter, counter, handoff };
}
