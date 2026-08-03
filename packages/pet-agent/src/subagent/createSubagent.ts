import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createHash, randomUUID } from 'node:crypto';
import type {
  SubagentInputState,
  SubagentResult,
  SubagentRunInput,
  SubagentRuntimeContext,
} from '../types/subagent';
import {
  evaluateGuard,
  type GuardDecisionEmitter,
} from '../guards';
import {
  createAgent,
  createMiddleware,
  summarizationMiddleware,
  type AnyAgentMiddleware,
} from 'langchain';
import { isGraphRecursionLimitError } from '../utils/graphErrors';
import {
  SUBAGENT_GUARD_POSITION,
  subagentIterationLimitGuard,
} from './guardDefinitions';
import {
  buildSubagentIterationLimitStopNotice,
  readSubagentGuardStopReason,
} from './guardStop';
import { readToolkitReviewRunControl } from '../agent/orchestrator/review/reviewRunControl';
import { Command, END } from '@langchain/langgraph';
import { emitRuntimeEventToStreamWriter } from '../utils/streamWriterEvents';
import {
  SUBAGENT_CONTEXT_SUMMARY_GOVERNING_PROMPT,
  SUBAGENT_CONTEXT_SUMMARY_PREFIX,
  SUBAGENT_CONTEXT_SUMMARY_PROMPT,
} from './prompts/templates/contextSummary.prompt';
import { SUBAGENT_GOVERNING_PROMPT } from './prompts/templates/governing.prompt';
import { messageHasToolCalls } from '../utils/messages';
import {
  subagentRuntimeContextSchema,
} from './runtimeContext';
import { isTransientModelMedia } from './transientModelMedia';

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

function readMessageText(message: BaseMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item === 'object' && item !== null && 'text' in item) {
        return typeof item.text === 'string' ? item.text : '';
      }
      return '';
    })
    .join('');
}

function findLatestDeliverableMessageId(
  messages: BaseMessage[],
  inputMessageIds: ReadonlySet<string>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.id && inputMessageIds.has(message.id)) continue;
    if (message._getType() !== 'ai') continue;
    if (readSubagentGuardStopReason(message)) continue;
    if (messageHasToolCalls(message)) continue;
    if (!readMessageText(message).trim()) continue;
    return message.id ?? null;
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

  const content = readMessageText(summary);
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

/**
 * Stand-in used while summarization inspects history. Keeps the message id so
 * the original can be restored if summarization preserves rather than folds it.
 */
function redactTransientModelMedia(message: BaseMessage): BaseMessage {
  const redacted = new HumanMessage({
    content: '[screenshot image omitted from summary]',
    additional_kwargs: message.additional_kwargs,
  });
  redacted.id = message.id;
  return redacted;
}

/**
 * Summarization returns the full replacement message list. Any transient media
 * it preserved comes back redacted, so swap the originals back in; anything it
 * folded into the summary is intentionally gone.
 */
function restoreTransientModelMedia<TUpdate>(
  update: TUpdate,
  originalMessages: readonly BaseMessage[],
): TUpdate {
  if (!update || typeof update !== 'object' || !('messages' in update)) return update;
  const messages = (update as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return update;
  const originalById = new Map<string, BaseMessage>();
  for (const message of originalMessages) {
    if (isTransientModelMedia(message) && message.id) {
      originalById.set(message.id, message);
    }
  }
  if (originalById.size === 0) return update;
  return {
    ...update,
    messages: (messages as BaseMessage[]).map(
      (message) => (message?.id ? originalById.get(message.id) ?? message : message),
    ),
  };
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
    // Summarization renders the summarized span with `getBufferString`, which
    // would inline a base64 image as plain text. Replace transient media with a
    // text stand-in so the summarizer sees that a screenshot happened without
    // the payload. Messages the summarizer preserves keep their real content,
    // because summarization replaces graph state with exactly what it returns.
    const originalMessages: BaseMessage[] = state.messages;
    const redactedMessages = originalMessages.map((message) => (
      isTransientModelMedia(message) ? redactTransientModelMedia(message) : message
    ));
    const update = await hook(
      redactedMessages.some((message, index) => message !== originalMessages[index])
        ? { ...state, messages: redactedMessages }
        : state,
      runtime,
    );
    // LangChain currently represents summarization failures as summary text
    // inside a destructive RemoveMessage update. Reject that update before the
    // graph can commit it, preserving the existing transcript on failure.
    assertValidContextSummaryUpdate(update);
    return restoreTransientModelMedia(update, originalMessages);
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

function createSubagentIterationGuardMiddleware(
  maxIterations: number,
  emitGuardDecision?: GuardDecisionEmitter,
) {
  let iterationCount = 0;

  return createMiddleware({
    name: 'SubagentIterationGuard',
    wrapModelCall: async (request, handler) => {
      iterationCount += 1;
      const outcome = evaluateGuard(subagentIterationLimitGuard, {
        state: { iterationCount, maxIterations },
        config: {},
        position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
      }, { emit: emitGuardDecision, iteration: iterationCount });
      if (outcome.kind === 'stop') {
        return new Command({
          goto: END,
          update: {
            messages: [buildSubagentIterationLimitStopNotice(iterationCount, maxIterations)],
          },
        });
      }
      return handler(request);
    },
  });
}

function writeSubagentRuntimeEvent(name: string, data: unknown) {
  emitRuntimeEventToStreamWriter({ event: 'on_runtime_event', name, data });
}

export async function createSubagent(input: SubagentRunInput): Promise<SubagentResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_SUBAGENT_MAX_ITERATIONS;
  // Parent lane reconciliation is identity-based because summarization may
  // replace or shrink the transcript. Stable ids distinguish preserved input
  // messages from summaries and model responses returned by the child graph.
  ensureSubagentMessageIds(input.messages);
  const inputState: SubagentInputState = {
    promptSections: input.promptSections,
    operations: input.operations,
    messages: input.messages,
    maxIterations: input.maxIterations,
    contextWindowTokens: input.contextWindowTokens,
    generationReserveTokens: input.generationReserveTokens,
    artifacts: input.artifacts,
  };
  const inputMessageIds = new Set(inputState.messages.map((message) => message.id as string));
  const systemPromptSections = [
    {
      id: 'framework:governing',
      owner: 'framework',
      content: SUBAGENT_GOVERNING_PROMPT,
    },
    ...(inputState.contextWindowTokens
      ? [{
          id: 'framework:context-summary',
          owner: 'framework',
          content: SUBAGENT_CONTEXT_SUMMARY_GOVERNING_PROMPT,
        }]
      : []),
    ...inputState.promptSections,
  ];
  const sectionIds = new Set<string>();
  for (const section of systemPromptSections) {
    if (!section.id.trim()) {
      throw new Error('Subagent prompt section id must be non-empty');
    }
    if (!section.content.trim()) {
      throw new Error(`Subagent prompt section "${section.id}" content must be non-empty`);
    }
    if (sectionIds.has(section.id)) {
      throw new Error(`Duplicate subagent prompt section id: ${section.id}`);
    }
    sectionIds.add(section.id);
  }
  const systemPrompt = systemPromptSections
    .map((section) => section.content)
    .join('\n\n');
  // Decision records must never fail the run.
  const emitGuardDecision: GuardDecisionEmitter = (record) => {
    writeSubagentRuntimeEvent(SUBAGENT_GUARD_DECISION_EVENT, record);
  };
  const contextSummaryMiddleware = createSubagentSummarizationMiddleware(inputState, input.model);
  const iterationGuardMiddleware = createSubagentIterationGuardMiddleware(maxIterations, emitGuardDecision);
  const middleware: AnyAgentMiddleware[] = [
    contextSummaryMiddleware,
    iterationGuardMiddleware,
    ...(input.middleware ?? []),
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  // No checkpointer here: the child inherits the parent's through the runnable
  // config, so its state checkpoints under the parent's namespaced thread and a
  // bare Command({ resume }) against the parent re-enters the child (#322).
  const agent = createAgent({
    model: input.model,
    tools: input.tools,
    systemPrompt,
    contextSchema: subagentRuntimeContextSchema,
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
  try {
    const parentRuntimeContext = (
      input.runnableConfig as (RunnableConfig & {
        context?: SubagentRuntimeContext;
      }) | undefined
    )?.context;
    const runtimeContext: SubagentRuntimeContext = {
      ...parentRuntimeContext,
      ...input.runtimeContext,
    };
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
        signal: input.signal,
        // Normal stopping is controlled by the subagent iteration guard.
        // LangGraph recursionLimit stays intentionally high as a final breaker.
        recursionLimit: SUBAGENT_HARD_RECURSION_LIMIT,
      },
    );
    latestMessages = readResultMessages(result) ?? latestMessages;
    ensureSubagentMessageIds(latestMessages);
    const reviewRunControl = readToolkitReviewRunControl(result);

    // A guard may have gracefully ended the agent by appending its stop
    // notice as the FINAL message (via Command goto END). That is a clean "limit
    // reached" stop, not natural completion. Check only the last message — a stop
    // marker buried in the input history must not be misread as our stop, and
    // Summarization may rewrite the list so an index-based slice is unreliable.
    const lastMessage = latestMessages.at(-1);
    const stopReason = lastMessage ? readSubagentGuardStopReason(lastMessage) : null;
    const announceMessageId = reviewRunControl
      ? null
      : stopReason
      ? findLatestDeliverableMessageId(latestMessages, inputMessageIds)
      : lastMessage?._getType() === 'ai'
        && !messageHasToolCalls(lastMessage)
        ? lastMessage.id ?? null
        : null;
    return {
      messages: latestMessages,
      artifacts: inputState.artifacts ?? [],
      completionReason: reviewRunControl
        ? 'interrupted'
        : stopReason === 'subagent_iteration_limit_reached'
          ? 'limit_reached'
          : 'natural',
      announceMessageId,
    };
  } catch (err) {
    // The agent's hard recursion breaker (recursionLimit) fired. The iteration
    // guard is meant to stop before this, but keep it as a graceful last-resort:
    // degrade to limit_reached instead of throwing through the orchestrator.
    if (isGraphRecursionLimitError(err)) {
      ensureSubagentMessageIds(latestMessages);
      return {
        messages: latestMessages,
        artifacts: inputState.artifacts ?? [],
        completionReason: 'limit_reached',
        announceMessageId: findLatestDeliverableMessageId(latestMessages, inputMessageIds),
      };
    }
    throw err;
  }
}
