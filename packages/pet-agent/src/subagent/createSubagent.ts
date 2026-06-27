import { type BaseMessage } from '@langchain/core/messages';
import type {
  SubagentInput,
  SubagentResult,
  SubagentToolLifecycleEvent,
} from '../types/subagent';
import { createAgent, createMiddleware } from 'langchain';
import { SubagentToolEventTracker } from './toolEventTracker';
import { estimateMessagesTokens } from '../agent/orchestrator/contextCompaction';
import {
  buildContextPolicyStateUpdate,
  rewriteMessagesForContextPolicy,
} from './contextPolicy';
import { isGraphRecursionLimitError } from '../utils/graphErrors';
import {
  createContextWindowFuseGuard,
  createRepeatedInputGuard,
  createSubagentLoopGuardMiddleware,
  isLoopGuardStopMessage,
  type SubagentLoopGuard,
} from './loopGuards';

// Fallback iteration budget when the caller does not pass maxIterations. Used as
// the inner ReAct agent's LangGraph recursionLimit (graph super-steps; one
// model→tool iteration is ~2 steps). With loop guards (#280) the expected stop is
// a guard's graceful stop, so this is a generous last-resort breaker. See P4 / #281.
const DEFAULT_SUBAGENT_MAX_ITERATIONS = 100;
const DEFAULT_CONTEXT_FUSE_RATIO = 0.85;

const SUBAGENT_GOVERNING_PROMPT = [
  '你是任务执行器，负责精确完成分配给你的任务。',
  '',
  '## 工作流程',
  '1. **理解任务**：仔细阅读任务描述，识别所有需要完成的步骤。',
  '2. **制定计划**：如果任务包含多个步骤，先在心里列出步骤清单。',
  '3. **逐步执行**：按计划依次完成每个步骤。',
  '4. **核验完整性**：所有步骤都完成后，再返回结果。',
  '',
  '## 注意',
  '- 不要只完成部分步骤就返回——确保任务描述中的每一项都已处理。',
  '- 选择工具时优先使用语义最具体的工具；shell/run_shell 这类通用命令执行工具只作为兜底。',
  '- 返回明确、具体的结果。',
].join('\n');

const CONTEXT_POLICY_GOVERNING_PROMPT = '较早的工具原始输出可能会被淘汰，重要发现要随时写进你的回复里。';

function readMessagesFromValuesChunk(chunk: unknown): BaseMessage[] | null {
  if (
    typeof chunk === 'object'
    && chunk !== null
    && 'messages' in chunk
    && Array.isArray((chunk as { messages?: unknown }).messages)
  ) {
    return (chunk as { messages: BaseMessage[] }).messages;
  }
  return null;
}

function readMessageChunkText(message: { content?: unknown }) {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function isSubagentToolLifecycleEvent(payload: unknown): payload is SubagentToolLifecycleEvent {
  const event = payload && typeof payload === 'object'
    ? (payload as { event?: unknown }).event
    : null;
  return Boolean(
    payload
      && typeof payload === 'object'
      && 'event' in payload
      && 'name' in payload
      && (
        event === 'on_tool_start'
        || event === 'on_tool_event'
        || event === 'on_tool_end'
        || event === 'on_tool_error'
      )
      && typeof (payload as { name?: unknown }).name === 'string',
  );
}

function buildContextFuseLimit(contextWindowTokens: number | undefined): number | null {
  if (!contextWindowTokens || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return null;
  }
  return Math.max(1, Math.floor(contextWindowTokens * DEFAULT_CONTEXT_FUSE_RATIO));
}

/**
 * Assemble the subagent loop guards (the hard pass/block predicates that stop the
 * ReAct loop). RepeatedInputGuard catches a loop spinning on identical input; the
 * context-window fuse catches token exhaustion. Both block by gracefully ending
 * the agent (see loopGuards.ts) so createSubagent reports `limit_reached` instead
 * of throwing.
 */
function buildSubagentLoopGuards(contextWindowTokens: number | undefined): SubagentLoopGuard[] {
  const guards: SubagentLoopGuard[] = [createRepeatedInputGuard()];
  const fuseLimit = buildContextFuseLimit(contextWindowTokens);
  if (fuseLimit) {
    guards.push(createContextWindowFuseGuard(fuseLimit));
  }
  return guards;
}

function createContextPolicyMiddleware(input: SubagentInput) {
  const policy = input.contextPolicy;
  if (!policy) return null;
  let iterationCount = 0;
  const operations = input.operations ?? {};
  return createMiddleware({
    name: 'SubagentContextPolicy',
    beforeModel: async (state) => {
      iterationCount += 1;
      const messages = state.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return undefined;
      }
      const context = {
        estimateMessagesTokens,
        iterationCount,
        operations,
        ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
        ...(input.artifactSink ? { artifactSink: input.artifactSink } : {}),
      };
      const rewritten = policy.rewriteAsync
        ? await policy.rewriteAsync(messages as BaseMessage[], context)
        : rewriteMessagesForContextPolicy(messages as BaseMessage[], policy, context);
      return buildContextPolicyStateUpdate(messages as BaseMessage[], rewritten);
    },
  });
}

export async function createSubagent(input: SubagentInput): Promise<SubagentResult> {
  const systemPrompt = [
    SUBAGENT_GOVERNING_PROMPT,
    input.contextPolicy ? CONTEXT_POLICY_GOVERNING_PROMPT : null,
    ...input.instructions,
  ].filter((item): item is string => Boolean(item)).join('\n\n');
  const maxIterations = input.maxIterations ?? DEFAULT_SUBAGENT_MAX_ITERATIONS;
  const loopGuardMiddleware = createSubagentLoopGuardMiddleware(
    buildSubagentLoopGuards(input.contextWindowTokens),
    systemPrompt,
  );
  const contextPolicyMiddleware = createContextPolicyMiddleware(input);
  // contextPolicy runs first (compress old tool output), then loop guards decide
  // whether to stop — so the fuse guard sees the already-compressed footprint.
  const middleware = [
    contextPolicyMiddleware,
    loopGuardMiddleware,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  const agent = createAgent({
    model: input.model,
    tools: input.tools,
    systemPrompt,
    ...(middleware.length > 0 ? { middleware } : {}),
    ...(input.checkpoint ? { checkpointer: input.checkpoint } : {}),
  });

  let latestMessages = input.messages;
  const toolEvents = new SubagentToolEventTracker();
  const emitToolEvent = async (event: SubagentToolLifecycleEvent) => {
    const operation = event.operation ?? input.operations?.[event.name];
    await input.onToolEvent?.(toolEvents.accept(operation ? { ...event, operation } : event));
  };
  const finishToolEvents = async (outcome: 'completed' | 'failed', error?: unknown) => {
    for (const event of toolEvents.finishActive(outcome, error)) {
      await input.onToolEvent?.(event);
    }
  };
  let streamedSubagentText = '';
  const emitSubagentMessageDelta = async (message: BaseMessage) => {
    if (message._getType() !== 'ai') {
      return;
    }
    const chunkText = readMessageChunkText(message);
    if (!chunkText) {
      return;
    }
    const token = chunkText.startsWith(streamedSubagentText)
      ? chunkText.slice(streamedSubagentText.length)
      : chunkText;
    if (!token) {
      return;
    }
    streamedSubagentText += token;
    await input.onToolEvent?.({
      event: 'on_runtime_event',
      name: 'subagent_message_delta',
      data: { text: token },
    });
  };

  try {
    const stream = await agent.stream(
      { messages: input.messages },
      {
        ...input.runnableConfig,
        signal: input.signal,
        // maxIterations is the budget in LangGraph super-steps (one model→tool
        // iteration ≈ 2 steps). This is the last-resort breaker; loop guards are
        // expected to stop the loop gracefully first.
        recursionLimit: maxIterations,
        streamMode: ['messages', 'values', 'tools'],
      },
    );

    for await (const chunk of stream) {
      if (Array.isArray(chunk) && chunk.length === 2) {
        const [mode, payload] = chunk as [string, unknown];
        if (mode === 'values') {
          latestMessages = readMessagesFromValuesChunk(payload) ?? latestMessages;
        }
        if (mode === 'messages' && Array.isArray(payload)) {
          await emitSubagentMessageDelta(payload[0] as BaseMessage);
        }
        if (mode === 'tools' && isSubagentToolLifecycleEvent(payload)) {
          await emitToolEvent(payload);
        }
        continue;
      }

      latestMessages = readMessagesFromValuesChunk(chunk) ?? latestMessages;
    }

    // A loop guard may have gracefully ended the agent by appending its stop
    // notice as the FINAL message (via Command goto END). That is a clean "limit
    // reached" stop, not natural completion. Check only the last message — a stop
    // marker buried in the input history must not be misread as our stop, and
    // contextPolicy may rewrite the list so an index-based slice is unreliable.
    const lastMessage = latestMessages.at(-1);
    const stoppedByGuard = lastMessage ? isLoopGuardStopMessage(lastMessage) : false;
    await finishToolEvents('completed');
    return {
      messages: latestMessages,
      artifacts: input.artifacts ?? [],
      completionReason: stoppedByGuard ? 'limit_reached' : 'natural',
    };
  } catch (err) {
    // The agent's hard recursion breaker (recursionLimit) fired. Loop guards are
    // meant to stop before this, but keep it as a graceful last-resort: degrade
    // to limit_reached instead of throwing through the orchestrator.
    if (isGraphRecursionLimitError(err)) {
      await finishToolEvents('failed', err);
      return {
        messages: latestMessages,
        artifacts: input.artifacts ?? [],
        completionReason: 'limit_reached',
      };
    }

    await finishToolEvents('failed', err);
    throw err;
  }
}
