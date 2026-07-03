import { type BaseMessage } from '@langchain/core/messages';
import type {
  SubagentInputState,
  SubagentResult,
  SubagentRunInput,
  SubagentToolLifecycleEvent,
} from '../types/subagent';
import {
  evaluateGuard,
  type GuardDecisionEmitter,
} from '../guards';
import { createAgent, createMiddleware } from 'langchain';
import type { RunnableConfig } from '@langchain/core/runnables';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { SubagentToolEventTracker } from './toolEventTracker';
import {
  buildContextPolicyStateUpdate,
  rewriteMessagesForContextPolicy,
} from './contextPolicy';
import { isGraphRecursionLimitError } from '../utils/graphErrors';
import {
  contextRewriteWatermarkGuard,
  SUBAGENT_GUARD_POSITION,
  subagentIterationLimitGuard,
} from './guardDefinitions';
import {
  buildSubagentIterationLimitStopNotice,
  isSubagentGuardStopMessage,
} from './guardStop';
import { Command, END } from '@langchain/langgraph';
import { SubagentProtocolToolEventReader } from './protocolToolEvents';

// Fallback model-call budget when the caller does not pass maxIterations. The
// subagent iteration guard should stop gracefully first; LangGraph recursionLimit
// is a deliberately high last-resort breaker, not a normal control signal.
const DEFAULT_SUBAGENT_MAX_ITERATIONS = 100;
const SUBAGENT_HARD_RECURSION_LIMIT = 10_000;

/**
 * Runtime-event name carrying subagent guard decision records through the
 * subagent's own event channel (`onToolEvent`); consumers filter by this name.
 */
export const SUBAGENT_GUARD_DECISION_EVENT = 'subagent_guard_decision';

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

export function buildNestedSubagentStreamConfig(config: RunnableConfig | undefined): RunnableConfig {
  const {
    callbacks: _callbacks,
    runId: _runId,
    ...streamConfig
  } = config ?? {};
  return streamConfig;
}

function buildContextPolicyContext(
  inputState: SubagentInputState,
  iterationCount: number,
) {
  return {
    iterationCount,
    operations: inputState.operations ?? {},
    ...(inputState.contextWindowTokens ? { contextWindowTokens: inputState.contextWindowTokens } : {}),
    ...(inputState.artifactSink ? { artifactSink: inputState.artifactSink } : {}),
  };
}

function createContextPolicyMiddleware(
  inputState: SubagentInputState,
  emitGuardDecision?: GuardDecisionEmitter,
) {
  let iterationCount = 0;

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
      const outcome = evaluateGuard(contextRewriteWatermarkGuard, {
        state: { messages: baseMessages, contextPolicy: policy },
        config: { contextWindowTokens: inputState.contextWindowTokens },
        position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY,
      }, { emit: emitGuardDecision, iteration: iterationCount });
      if (outcome.kind !== 'maintain') {
        return undefined;
      }
      const context = buildContextPolicyContext(inputState, iterationCount);
      const rewritten = policy.rewriteAsync
        ? await policy.rewriteAsync(baseMessages, context)
        : rewriteMessagesForContextPolicy(baseMessages, policy, context);
      return buildContextPolicyStateUpdate(baseMessages, rewritten) ?? undefined;
    },
  });
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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function',
  );
}

type ToolCallProjection = {
  toolCalls?: AsyncIterable<{
    output?: unknown;
    status?: unknown;
    error?: unknown;
  }>;
};

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
  // Decision records ride the subagent's own event channel; emission is
  // advisory and must never fail the run.
  const emitGuardDecision: GuardDecisionEmitter = (record) => {
    try {
      void Promise.resolve(input.onToolEvent?.({
        event: 'on_runtime_event',
        name: SUBAGENT_GUARD_DECISION_EVENT,
        data: record,
      })).catch(() => {});
    } catch {
      // Ignore emission failures.
    }
  };
  const contextPolicyMiddleware = createContextPolicyMiddleware(inputState, emitGuardDecision);
  const iterationGuardMiddleware = createSubagentIterationGuardMiddleware(maxIterations, emitGuardDecision);
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
  const emitSubagentMessageDelta = async (token: string) => {
    if (!token) {
      return;
    }
    await input.onToolEvent?.({
      event: 'on_runtime_event',
      name: 'subagent_message_delta',
      data: { text: token },
    });
  };
  const throwIfRejected = (results: PromiseSettledResult<unknown>[]) => {
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) {
      throw rejected.reason;
    }
  };

  try {
    const streamConfig = buildNestedSubagentStreamConfig(input.runnableConfig);
    // Stripping callbacks from the explicit config is not enough: the parent
    // graph's callback manager also flows in implicitly through
    // AsyncLocalStorage, and the nested pregel run can hold duplicate tracer
    // copies that share one run map. Run the whole nested stream in a cleared
    // ALS scope so the subagent traces as its own root run instead.
    await AsyncLocalStorageProviderSingleton.runWithConfig({}, async () => {
      const run = await agent.streamEvents(
        { messages: inputState.messages },
        {
          ...streamConfig,
          version: 'v3',
          signal: input.signal,
          // Normal stopping is controlled by the subagent iteration guard.
          // LangGraph recursionLimit stays intentionally high as a final breaker.
          recursionLimit: SUBAGENT_HARD_RECURSION_LIMIT,
        },
      );

      const consumeValues = async () => {
        for await (const value of run.values) {
          latestMessages = readMessagesFromValuesChunk(value) ?? latestMessages;
        }
      };
      const consumeMessages = async () => {
        for await (const message of run.messages) {
          for await (const token of message.text) {
            await emitSubagentMessageDelta(token);
          }
        }
      };
      const consumeToolEvents = async () => {
        const toolEventReader = new SubagentProtocolToolEventReader();
        for await (const event of run) {
          // Nested parent-graph resumes can namespace this agent's values, while
          // `run.values` only projects root values. Read protocol values too.
          if (event.method === 'values') {
            latestMessages = readMessagesFromValuesChunk(event.params.data) ?? latestMessages;
          }
          const toolEvent = toolEventReader.read(event);
          if (toolEvent) {
            await emitToolEvent(toolEvent);
          }
        }
      };
      const consumeToolCallProjection = async () => {
        const toolCalls = (run as ToolCallProjection).toolCalls;
        if (!toolCalls) {
          return;
        }
        // The native projection owns per-call output/status promises. Draining it
        // keeps interrupt/tool-error paths settled even though raw events drive UI.
        for await (const toolCall of toolCalls) {
          const pending = [toolCall.output, toolCall.status, toolCall.error]
            .filter(isPromiseLike);
          await Promise.allSettled(pending);
        }
      };

      throwIfRejected(await Promise.allSettled([
        consumeValues(),
        consumeMessages(),
        consumeToolEvents(),
        consumeToolCallProjection(),
      ]));
      latestMessages = readMessagesFromValuesChunk(await run.output) ?? latestMessages;
    }, true);

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
