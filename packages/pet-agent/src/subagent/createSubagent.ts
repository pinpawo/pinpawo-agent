import { type BaseMessage } from '@langchain/core/messages';
import type {
  SubagentInputState,
  SubagentResult,
  SubagentRunInput,
  SubagentToolLifecycleEvent,
} from '../types/subagent';
import type {
  GuardRunOptions,
  GuardRunResult,
} from '../guards';
import { createAgent, createMiddleware } from 'langchain';
import { SubagentToolEventTracker } from './toolEventTracker';
import {
  buildContextPolicyStateUpdate,
  rewriteMessagesForContextPolicy,
} from './contextPolicy';
import { isGraphRecursionLimitError } from '../utils/graphErrors';
import {
  createSubagentGuardRegistry,
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type SubagentGuardConfig,
  type SubagentGuardName,
  type SubagentGuardPosition,
  type SubagentGuardUpdate,
  type SubagentState,
} from './guardDefinitions';
import { isSubagentGuardStopMessage } from './guardStop';
import { Command, END } from '@langchain/langgraph';

// Fallback model-call budget when the caller does not pass maxIterations. The
// subagent iteration guard should stop gracefully first; LangGraph recursionLimit
// is a deliberately high last-resort breaker, not a normal control signal.
const DEFAULT_SUBAGENT_MAX_ITERATIONS = 100;
const SUBAGENT_HARD_RECURSION_LIMIT = 10_000;

type SubagentGuardRunOptions = GuardRunOptions<
  SubagentState,
  SubagentGuardConfig,
  SubagentGuardPosition,
  SubagentGuardUpdate
>;

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

function buildContextPolicyContext(
  state: SubagentState,
) {
  return {
    iterationCount: state.iterationCount,
    operations: state.operations ?? {},
    ...(state.contextWindowTokens ? { contextWindowTokens: state.contextWindowTokens } : {}),
    ...(state.artifactSink ? { artifactSink: state.artifactSink } : {}),
  };
}

function snapshotSubagentStateForMiddleware(
  inputState: SubagentInputState,
  messages: BaseMessage[],
  iterationCount: number,
  maxIterations: number,
): SubagentState {
  return {
    ...inputState,
    iterationCount,
    maxIterations,
    messages,
  };
}

function createContextPolicyMiddleware(inputState: SubagentInputState, maxIterations: number) {
  let iterationCount = 0;
  const registry = createSubagentGuardRegistry();
  async function runSubagentGuard(
    name: SubagentGuardName,
    position: SubagentGuardPosition,
    messages: BaseMessage[],
    runOptions?: SubagentGuardRunOptions,
  ): Promise<GuardRunResult<SubagentGuardUpdate>> {
    const subagentState = snapshotSubagentStateForMiddleware(inputState, messages, iterationCount, maxIterations);
    return registry.run(name, {
      state: subagentState,
      config: {},
      position,
    }, runOptions);
  }

  return createMiddleware({
    name: 'SubagentContextPolicy',
    beforeModel: async (state) => {
      iterationCount += 1;
      const policy = inputState.contextPolicy;
      if (!policy) {
        return undefined;
      }
      const messages = state.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return undefined;
      }
      const baseMessages = messages as BaseMessage[];
      const { update } = await runSubagentGuard(
        SUBAGENT_GUARD_NAME.CONTEXT_REWRITE_WATERMARK,
        SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY,
        baseMessages,
        {
          onBlock: async ({ state }) => {
            const context = buildContextPolicyContext(state);
            const rewritten = policy.rewriteAsync
              ? await policy.rewriteAsync(state.messages, context)
              : rewriteMessagesForContextPolicy(state.messages, policy, context);
            return buildContextPolicyStateUpdate(state.messages, rewritten) ?? null;
          },
        },
      );
      return update ?? undefined;
    },
  });
}

function createSubagentIterationGuardMiddleware(inputState: SubagentInputState, maxIterations: number) {
  let iterationCount = 0;
  const registry = createSubagentGuardRegistry();
  async function runSubagentGuard(
    name: SubagentGuardName,
    position: SubagentGuardPosition,
    messages: BaseMessage[],
    runOptions?: SubagentGuardRunOptions,
  ): Promise<GuardRunResult<SubagentGuardUpdate>> {
    const subagentState = snapshotSubagentStateForMiddleware(inputState, messages, iterationCount, maxIterations);
    return registry.run(name, {
      state: subagentState,
      config: {},
      position,
    }, runOptions);
  }

  return createMiddleware({
    name: 'SubagentIterationGuard',
    wrapModelCall: async (request, handler) => {
      iterationCount += 1;
      const { result, update } = await runSubagentGuard(
        SUBAGENT_GUARD_NAME.ITERATION_LIMIT,
        SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
        request.messages ?? [],
      );
      if (result.status === 'block') {
        return new Command({ goto: END, update: update ?? {} });
      }
      return handler(request);
    },
  });
}

export async function createSubagent(input: SubagentRunInput): Promise<SubagentResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_SUBAGENT_MAX_ITERATIONS;
  const inputState: SubagentInputState = {
    instructions: input.instructions,
    operations: input.operations,
    messages: input.messages,
    maxIterations: input.maxIterations,
    contextWindowTokens: input.contextWindowTokens,
    contextPolicy: input.contextPolicy,
    artifacts: input.artifacts,
    artifactSink: input.artifactSink,
  };
  const systemPrompt = [
    SUBAGENT_GOVERNING_PROMPT,
    inputState.contextPolicy ? CONTEXT_POLICY_GOVERNING_PROMPT : null,
    ...inputState.instructions,
  ].filter((item): item is string => Boolean(item)).join('\n\n');
  const contextPolicyMiddleware = createContextPolicyMiddleware(inputState, maxIterations);
  const iterationGuardMiddleware = createSubagentIterationGuardMiddleware(inputState, maxIterations);
  const middleware = [
    contextPolicyMiddleware,
    iterationGuardMiddleware,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  const agent = createAgent({
    model: input.model,
    tools: input.tools,
    systemPrompt,
    ...(middleware.length > 0 ? { middleware } : {}),
    ...(input.checkpoint ? { checkpointer: input.checkpoint } : {}),
  });

  let latestMessages = inputState.messages;
  const toolEvents = new SubagentToolEventTracker();
  const emitToolEvent = async (event: SubagentToolLifecycleEvent) => {
    const operation = event.operation ?? inputState.operations?.[event.name];
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
      { messages: inputState.messages },
      {
        ...input.runnableConfig,
        signal: input.signal,
        // Normal stopping is controlled by the subagent iteration guard.
        // LangGraph recursionLimit stays intentionally high as a final breaker.
        recursionLimit: SUBAGENT_HARD_RECURSION_LIMIT,
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

    // A guard may have gracefully ended the agent by appending its stop
    // notice as the FINAL message (via Command goto END). That is a clean "limit
    // reached" stop, not natural completion. Check only the last message — a stop
    // marker buried in the input history must not be misread as our stop, and
    // contextPolicy may rewrite the list so an index-based slice is unreliable.
    const lastMessage = latestMessages.at(-1);
    const stoppedByGuard = lastMessage ? isSubagentGuardStopMessage(lastMessage) : false;
    await finishToolEvents('completed');
    return {
      messages: latestMessages,
      artifacts: inputState.artifacts ?? [],
      completionReason: stoppedByGuard ? 'limit_reached' : 'natural',
    };
  } catch (err) {
    // The agent's hard recursion breaker (recursionLimit) fired. The iteration
    // guard is meant to stop before this, but keep it as a graceful last-resort:
    // degrade to limit_reached instead of throwing through the orchestrator.
    if (isGraphRecursionLimitError(err)) {
      await finishToolEvents('failed', err);
      return {
        messages: latestMessages,
        artifacts: inputState.artifacts ?? [],
        completionReason: 'limit_reached',
      };
    }

    await finishToolEvents('failed', err);
    throw err;
  }
}
