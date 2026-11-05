import { readMessagesTokenUsage } from '../agent/tokenUsage';
import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../agent/messages/metadata';
import { getInteropZodObjectShape, isInteropZodObject } from '@langchain/core/utils/types';
import { getAgentRuntimeContext } from '../runtime/context';
import {
  composeSystemPrompt,
  createSystemPromptMiddleware,
  resolveSystemPromptSections,
  validateSystemPromptSections,
} from '../prompts/systemPrompt';
import { createHash, randomUUID } from 'node:crypto';
import type {
  SubagentInputState,
  SubagentResult,
  SubagentRunInput,
  SubagentRuntimeContext,
} from '../types/subagent';
import type { GuardDecisionRecord } from '../guards';
import {
  createAgent,
  createMiddleware,
  modelCallLimitMiddleware,
  summarizationMiddleware,
  type AnyAgentMiddleware,
} from 'langchain';
import {
  markSubagentGuardStop,
  readSubagentGuardStopReason,
} from './guardStop';
import { Command, END, StateSchema, type AnyStateSchema } from '@langchain/langgraph';
import { readReviewStopDecision } from '../agent/orchestrator/interrupt/reviewStop';
import { emitRuntimeEventToStreamWriter } from '../utils/streamWriterEvents';
import {
  SUBAGENT_CONTEXT_SUMMARY_GOVERNING_PROMPT,
  SUBAGENT_CONTEXT_SUMMARY_PREFIX,
  SUBAGENT_CONTEXT_SUMMARY_PROMPT,
} from './prompts/templates/contextSummary.prompt';
import { SUBAGENT_GOVERNING_PROMPT } from './prompts/templates/governing.prompt';
import { SUBAGENT_BUDGET_HANDOFF_PROMPT } from './prompts/templates/budgetHandoff.prompt';
import { messageHasToolCalls } from '../utils/messages';
import {
  subagentRuntimeContextSchema,
} from './runtimeContext';

// Fallback model-call budget when the caller does not pass maxIterations. The
// subagent iteration guard should stop gracefully first; LangGraph recursionLimit
// is a deliberately high last-resort breaker, not a normal control signal.
const DEFAULT_SUBAGENT_MAX_ITERATIONS = 100;
const SUBAGENT_HARD_RECURSION_LIMIT = 10_000;
const SUBAGENT_CONTEXT_SUMMARY_TRIGGER_RATIO = 0.65;
const SUBAGENT_CONTEXT_SUMMARY_KEEP_RATIO = 0.3;
const INVALID_CONTEXT_SUMMARY_MESSAGES = new Set([
  'No previous conversation history.',
  'Previous conversation was too long to summarize.',
]);
const CONTEXT_SUMMARY_ERROR_PREFIX = 'Error generating summary:';

/**
 * Runtime-event name carrying subagent guard decision records. Written to the
 * run's stream writer, so the records surface as `custom` events on the root
 * protocol stream (#322); consumers filter by this name.
 */
export const SUBAGENT_GUARD_DECISION_EVENT = 'subagent_guard_decision';

/**
 * Runtime-event name announcing the per-delegation tool-operation display
 * metadata (`SubagentRunInput.operations`). Root `tools` protocol events only
 * carry `tool_call_id`/`tool_name`; a consumer that joins display metadata
 * from a registry merges this map in so delegation-scoped toolkit operations
 * (which are not in any statically known toolkit) still resolve.
 */
export const SUBAGENT_OPERATIONS_EVENT = 'subagent_operations';
export const SUBAGENT_PROMPT_SECTIONS_EVENT = 'subagent_prompt_sections';
export const SUBAGENT_BUDGET_HANDOFF_EVENT = 'subagent_budget_handoff';

function readResultMessages(result: unknown): BaseMessage[] | null {
  if (
    typeof result === 'object'
    && result !== null
    && 'messages' in result
    && Array.isArray((result as { messages?: unknown }).messages)
  ) {
    return (result as { messages: BaseMessage[] }).messages;
  }
  return null;
}

function ensureSubagentMessageIds(messages: BaseMessage[]) {
  for (const message of messages) {
    if (!message.id) message.id = randomUUID();
  }
}

function readInvocationOutput(messages: BaseMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message._getType() !== 'ai') continue;
    if (readSubagentGuardStopReason(message)) continue;
    if (messageHasToolCalls(message)) continue;
    const text = message.text;
    if (!text.trim()) continue;
    return text;
  }
  return null;
}

function assertValidContextSummaryUpdate(update: unknown) {
  if (!update || typeof update !== 'object' || !('messages' in update)) {
    return;
  }
  const messages = (update as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return;
  }
  const summary = messages.find(
    (message): message is BaseMessage => typeof message === 'object'
      && message !== null
      && 'content' in message
      && 'additional_kwargs' in message
      && (message as BaseMessage).additional_kwargs?.lc_source === 'summarization',
  );
  if (!summary) {
    return;
  }

  const content = summary.text;
  const prefix = `${SUBAGENT_CONTEXT_SUMMARY_PREFIX}\n\n`;
  const summaryText = content.startsWith(prefix) ? content.slice(prefix.length) : content;
  if (
    summaryText.trim().length === 0
    || INVALID_CONTEXT_SUMMARY_MESSAGES.has(summaryText)
    || summaryText.startsWith(CONTEXT_SUMMARY_ERROR_PREFIX)
  ) {
    throw new Error(`Subagent context summarization failed: ${summaryText || 'empty summary'}`);
  }
}

function failFastOnInvalidContextSummary(
  middleware: AnyAgentMiddleware,
): AnyAgentMiddleware {
  const beforeModel = middleware.beforeModel;
  if (!beforeModel) {
    throw new Error('LangChain summarization middleware has no beforeModel hook.');
  }
  const hook = typeof beforeModel === 'function' ? beforeModel : beforeModel.hook;
  const wrappedHook: typeof hook = async (state, runtime) => {
    const update = await hook(state, runtime);
    // LangChain currently represents summarization failures as summary text
    // inside a destructive RemoveMessage update. Reject that update before the
    // graph can commit it, preserving the existing transcript on failure.
    assertValidContextSummaryUpdate(update);
    return update;
  };
  middleware.beforeModel = typeof beforeModel === 'function'
    ? wrappedHook
    : { ...beforeModel, hook: wrappedHook };
  return middleware;
}

function createSubagentSummarizationMiddleware(
  inputState: SubagentInputState,
  model: SubagentRunInput['model'],
): AnyAgentMiddleware | null {
  const contextWindowTokens = inputState.contextWindowTokens;
  if (!contextWindowTokens || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return null;
  }

  const rawGenerationReserveTokens = inputState.generationReserveTokens;
  const generationReserveTokens = typeof rawGenerationReserveTokens === 'number'
    && Number.isFinite(rawGenerationReserveTokens)
    ? Math.max(0, Math.floor(rawGenerationReserveTokens))
    : 0;
  const usableInputTokens = Math.max(1, contextWindowTokens - generationReserveTokens);
  const triggerTokens = Math.max(1, Math.floor(
    usableInputTokens * SUBAGENT_CONTEXT_SUMMARY_TRIGGER_RATIO,
  ));
  const keepTokens = Math.max(1, Math.floor(
    usableInputTokens * SUBAGENT_CONTEXT_SUMMARY_KEEP_RATIO,
  ));

  return failFastOnInvalidContextSummary(summarizationMiddleware({
    model,
    trigger: { tokens: triggerTokens },
    keep: { tokens: keepTokens },
    // LangChain defaults this to 4k tokens, which would inspect only a small
    // slice when our model window is large. The derived budget covers the
    // expected summarized prefix while leaving room for the summary prompt.
    trimTokensToSummarize: Math.max(1, Math.floor(usableInputTokens * 0.5)),
    summaryPrompt: SUBAGENT_CONTEXT_SUMMARY_PROMPT,
    summaryPrefix: SUBAGENT_CONTEXT_SUMMARY_PREFIX,
  }));
}

function isBudgetNotice(message: BaseMessage | undefined): message is ToolMessage {
  return !!message && ToolMessage.isInstance(message)
    && message.name === 'runtime_budget_status'
    && getAgentMessageMetadata(message).synthetic === true
    && getAgentMessageMetadata(message).runtimeNotice === 'subagent_budget';
}

function createSubagentModelCallBudget(maxIterations: number, invocationId: string) {
  // Preserve the existing disabled/fractional-limit contract. The framework
  // owns the counter in checkpoint state, scoped to this child invocation.
  const runLimit = Number.isFinite(maxIterations) && maxIterations > 0
    ? Math.floor(maxIterations) : undefined;
  const handoffCalls = runLimit ? Math.min(10, Math.ceil(runLimit * 0.1)) : 0;
  const limiter = modelCallLimitMiddleware({ runLimit, exitBehavior: 'end' });
  const beforeModel = limiter.beforeModel!;
  const checkBudget = typeof beforeModel === 'function' ? beforeModel : beforeModel.hook;

  limiter.name = 'SubagentIterationGuard';
  // maxIterations owns this budget; unrelated caller context keys must not
  // override it or add a thread-wide limit.
  limiter.contextSchema = undefined;
  limiter.beforeModel = undefined;
  // afterModel hooks run in reverse order: handoff handles notification-only
  // steps first; the native counter then records real rounds before Review.
  const counter = { ...limiter, name: 'SubagentIterationCounter', afterAgent: undefined };
  limiter.afterModel = undefined;
  limiter.wrapModelCall = async (request, handler) => {
    // Review Respond jumps straight to the model node, skipping beforeModel
    // hooks. Run the official check at the model-call boundary for every path.
    const update = await checkBudget(request.state, {
      ...request.runtime,
      context: { runLimit, threadLimit: undefined, exitBehavior: 'end' },
    });
    const iterationCount = request.state.runModelCallCount + 1;
    const stopped = update?.jumpTo === 'end';
    const remainingModelCalls = runLimit === undefined ? undefined : runLimit - request.state.runModelCallCount;
    if (!stopped && remainingModelCalls !== undefined
      && (remainingModelCalls === handoffCalls || remainingModelCalls === 1)) {
      const phase = remainingModelCalls === 1 ? 'finalize' : 'prepare';
      const callId = `runtime-budget:${invocationId}:${phase}`;
      if (!request.state.messages.some(message => message.id === `${callId}:result`)) {
        const data = { iteration: iterationCount, maxIterations: runLimit!, remainingModelCalls, phase };
        const metadata = { synthetic: true, runtimeNotice: 'subagent_budget' };
        const notification = [
          setAgentMessageMetadata(new AIMessage({
            id: `${callId}:call`, content: '',
            tool_calls: [{ id: callId, name: 'runtime_budget_status', args: {}, type: 'tool_call' }],
          }), metadata),
          setAgentMessageMetadata(new ToolMessage({
            id: `${callId}:result`, name: 'runtime_budget_status', tool_call_id: callId,
            status: 'success', content: JSON.stringify({
              ...data,
              instruction: SUBAGENT_BUDGET_HANDOFF_PROMPT.render({
                remainingModelCalls: String(remainingModelCalls),
                maxIterations: String(runLimit),
                finalInstruction: phase === 'finalize'
                  ? 'This is your final call. Return the handoff text now using the evidence already gathered. Further tool calls will not execute.'
                  : 'Finish only essential work that fits the remaining budget, then return the handoff without further tool calls.',
              }),
            }),
          }), metadata),
        ];
        writeSubagentRuntimeEvent(SUBAGENT_BUDGET_HANDOFF_EVENT, data);
        // Commit the whole pair before calling the model, including when Review
        // Respond jumps past beforeModel. Handoff routes this step back to
        // the model without counting it or dispatching the synthetic call.
        return new Command({ update: { messages: notification } });
      }
    }
    writeSubagentRuntimeEvent(SUBAGENT_GUARD_DECISION_EVENT, {
      guard: 'subagent_iteration_limit',
      position: 'subagent.before_model_iteration',
      outcome: stopped
        ? { kind: 'stop', reason: 'subagent_iteration_limit_reached', details: { iterationCount, maxIterations } }
        : { kind: 'proceed' },
      iteration: iterationCount,
    } satisfies GuardDecisionRecord);
    if (stopped) {
      const notice = update.messages?.find(AIMessage.isInstance);
      if (!notice) throw new Error('LangChain model-call limit returned no AI stop message.');
      markSubagentGuardStop(notice, 'subagent_iteration_limit_reached');
      return new Command({
        goto: END,
        update: { messages: update.messages },
      });
    }
    const response = await handler(request);
    if (iterationCount === runLimit && AIMessage.isInstance(response)
      && (response.tool_calls?.length || response.invalid_tool_calls?.length
        || (Array.isArray(response.additional_kwargs.tool_calls) && response.additional_kwargs.tool_calls.length))) {
      // A provider or caller middleware can ignore the final-call restriction. Never
      // execute another operation with the call reserved for the handoff, or
      // persist unmatched tool calls as if they were a valid delivery.
      const notice = markSubagentGuardStop(new AIMessage({
        content: 'The final budgeted model call did not return a text handoff.',
        usage_metadata: response.usage_metadata,
      }), 'subagent_iteration_limit_reached');
      // Replace the invalid response with a terminal notice, without keeping
      // an unpaired tool call in this invocation's messages.
      return notice;
    }
    return response;
  };
  // Keep definitions stable for prefix caching. The local guard remains the
  // enforcement boundary if a provider ignores the tool-choice restriction.
  const handoff = createMiddleware({
    name: 'SubagentBudgetHandoff',
    stateSchema: limiter.stateSchema,
    afterModel: {
      hook: (state) => {
        // This step only committed the notice. Skip the counter and Review,
        // then re-enter the model with the persisted pair in its input.
        if (isBudgetNotice(state.messages.at(-1))) return { jumpTo: 'model' as const };
      },
      canJumpTo: ['model'],
    },
    wrapModelCall: (request, handler) => {
      const finalCall = runLimit !== undefined && request.state.runModelCallCount === runLimit - 1;
      return handler(finalCall ? { ...request, toolChoice: 'none' } : request);
    },
  });
  return { guard: limiter, counter, handoff };
}

function writeSubagentRuntimeEvent(name: string, data: unknown) {
  emitRuntimeEventToStreamWriter({ event: 'on_runtime_event', name, data });
}

function assertSubagentStateSchema(
  stateSchema: AnyStateSchema | undefined,
  middleware: AnyAgentMiddleware[],
) {
  if (stateSchema === undefined) return;
  if (!StateSchema.isInstance(stateSchema)) {
    throw new Error('Subagent stateSchema must be a native StateSchema');
  }
  const owners = new Map([
    'messages', 'jumpTo', 'structuredResponse', ...Object.getOwnPropertyNames(Object.prototype),
  ].map(field => [field, 'the agent framework']));
  for (const item of middleware) {
    const schema = item.stateSchema;
    const fields = StateSchema.isInstance(schema) ? Object.keys(schema.fields)
      : isInteropZodObject(schema) ? Object.keys(getInteropZodObjectShape(schema)) : [];
    for (const field of fields) {
      if (!owners.has(field)) owners.set(field, `middleware "${item.name}"`);
    }
  }
  for (const field of Object.keys(stateSchema.fields)) {
    const owner = owners.get(field);
    if (owner !== undefined) {
      throw new Error(`Subagent state field "${field}" conflicts with ${owner}`);
    }
  }
}

export async function createSubagent(input: SubagentRunInput): Promise<SubagentResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_SUBAGENT_MAX_ITERATIONS;
  // Stable IDs distinguish this invocation's output and usage from its input.
  ensureSubagentMessageIds(input.messages);
  const inputState: SubagentInputState = {
    promptSections: input.promptSections,
    operations: input.operations,
    messages: input.messages,
    maxIterations: input.maxIterations,
    contextWindowTokens: input.contextWindowTokens,
    generationReserveTokens: input.generationReserveTokens,
  };
  const inputMessageIds = new Set(inputState.messages.map((message) => message.id as string));
  const parentRuntimeContext = input.runnableConfig?.context;
  // Preparation hints belong to the parent invocation, never to a child override.
  const { hint: _childHint, ...childRuntimeContext } = input.runtimeContext ?? {};
  const runtimeContext: SubagentRuntimeContext = {
    ...parentRuntimeContext,
    ...childRuntimeContext,
    // Common context belongs to the root invocation, never to a child override.
    ...getAgentRuntimeContext(input.runnableConfig),
  };
  const frameworkSections = [
    { id: 'framework:governing', owner: 'framework', content: SUBAGENT_GOVERNING_PROMPT },
    ...(inputState.contextWindowTokens ? [{
      id: 'framework:context-summary',
      owner: 'framework',
      content: SUBAGENT_CONTEXT_SUMMARY_GOVERNING_PROMPT,
    }] : []),
  ];
  const systemPromptSections = [
    ...frameworkSections,
    ...resolveSystemPromptSections(runtimeContext, inputState.promptSections),
  ];
  validateSystemPromptSections(systemPromptSections);
  const systemPrompt = composeSystemPrompt(new SystemMessage(''), {}, frameworkSections);
  const contextSummaryMiddleware = createSubagentSummarizationMiddleware(inputState, input.model);
  const iterationBudget = createSubagentModelCallBudget(maxIterations,
    runtimeContext.executionScope?.delegationId ?? inputState.messages.at(-1)?.id ?? randomUUID());
  const middleware: AnyAgentMiddleware[] = [
    contextSummaryMiddleware,
    iterationBudget.guard,
    ...(input.middleware ?? []),
    createSystemPromptMiddleware(inputState.promptSections),
    iterationBudget.counter,
    iterationBudget.handoff,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));
  assertSubagentStateSchema(input.stateSchema, middleware);

  // No checkpointer here: the child inherits the parent's through the runnable
  // config, so its state checkpoints under the parent's namespaced thread and a
  // bare Command({ resume }) against the parent re-enters the child (#322).
  const agent = createAgent({
    model: input.model,
    tools: input.tools,
    systemPrompt,
    contextSchema: subagentRuntimeContextSchema,
    ...(input.stateSchema ? { stateSchema: input.stateSchema } : {}),
    ...(middleware.length > 0 ? { middleware } : {}),
  });

  writeSubagentRuntimeEvent(SUBAGENT_PROMPT_SECTIONS_EVENT, {
    sections: systemPromptSections.map((section) => ({
      id: section.id,
      owner: section.owner ?? null,
      digest: createHash('sha256').update(section.content, 'utf8').digest('hex'),
    })),
  });
  if (inputState.operations && Object.keys(inputState.operations).length > 0) {
    writeSubagentRuntimeEvent(SUBAGENT_OPERATIONS_EVENT, { operations: inputState.operations });
  }

  let latestMessages = inputState.messages;
  // The crucial #322 shape: invoke with the parent config passed through
  // untouched, instead of consuming a child streamEvents() run behind a
  // stripped config and a cleared ALS scope. Tokens, tool lifecycle,
  // custom events and interrupts all surface on the ROOT stream with the
  // child's namespace; the double-tracer class of bugs (#313/#316) cannot
  // occur because there is no second stream consumer.
  const result = await agent.invoke(
    { messages: inputState.messages },
    {
      ...input.runnableConfig,
      context: runtimeContext,
      signal: input.signal ?? input.runnableConfig?.signal,
      // Normal stopping is controlled by the subagent iteration guard.
      // LangGraph recursionLimit stays intentionally high as a final breaker.
      recursionLimit: SUBAGENT_HARD_RECURSION_LIMIT,
    },
  );
  latestMessages = readResultMessages(result) ?? latestMessages;
  ensureSubagentMessageIds(latestMessages);
  const invocationMessages = latestMessages.filter(message => !inputMessageIds.has(message.id!));
  const tokenUsage = readMessagesTokenUsage(invocationMessages);
  const reviewDecision = readReviewStopDecision(invocationMessages.at(-1));
  return {
    state: result,
    messages: latestMessages, tokenUsage,
    output: reviewDecision ? null : readInvocationOutput(invocationMessages),
    ...(reviewDecision ? { reviewDecision } : {}),
  };
}
