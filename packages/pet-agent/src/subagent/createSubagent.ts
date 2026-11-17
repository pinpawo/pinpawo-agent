import { readMessagesTokenUsage } from '../agent/tokenUsage';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
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
import { createAgent, type AnyAgentMiddleware } from 'langchain';
import { readSubagentGuardStopReason } from './guardStop';
import { StateSchema, type AnyStateSchema } from '@langchain/langgraph';
import { readReviewStopDecision } from '../agent/orchestrator/interrupt/reviewStop';
import { emitRuntimeEventToStreamWriter } from '../utils/streamWriterEvents';
import { SUBAGENT_GOVERNING_PROMPT } from './prompts/templates/governing.prompt';
import { createSubagentBudgetMiddleware } from './budgetMiddleware';
import { messageHasToolCalls } from '../utils/messages';
import {
  subagentRuntimeContextSchema,
} from './runtimeContext';

export { SUBAGENT_BUDGET_HANDOFF_EVENT, SUBAGENT_GUARD_DECISION_EVENT } from './budgetMiddleware';

// Fallback model-call budget when the caller does not pass maxIterations. The
// subagent iteration guard should stop gracefully first; LangGraph recursionLimit
// is a deliberately high last-resort breaker, not a normal control signal.
const DEFAULT_SUBAGENT_MAX_ITERATIONS = 100;
const SUBAGENT_HARD_RECURSION_LIMIT = 10_000;

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
    modelInputModalities: childRuntimeContext.modelInputModalities ?? ['text'],
  };
  const frameworkSections = [
    { id: 'framework:governing', owner: 'framework', content: SUBAGENT_GOVERNING_PROMPT },
  ];
  const systemPromptSections = [
    ...frameworkSections,
    ...resolveSystemPromptSections(runtimeContext, inputState.promptSections),
  ];
  validateSystemPromptSections(systemPromptSections);
  const systemPrompt = composeSystemPrompt(new SystemMessage(''), {}, frameworkSections);
  const budget = createSubagentBudgetMiddleware({
    maxIterations,
    invocationId: runtimeContext.executionScope?.delegationId ?? inputState.messages.at(-1)?.id ?? randomUUID(),
    contextWindowTokens: inputState.contextWindowTokens,
    generationReserveTokens: inputState.generationReserveTokens,
    inputMessageIds,
  });
  const middleware: AnyAgentMiddleware[] = [
    budget.guard,
    ...(input.middleware ?? []),
    createSystemPromptMiddleware(inputState.promptSections),
    budget.counter,
    budget.handoff,
  ];
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
