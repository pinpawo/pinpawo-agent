import { type BaseMessage } from '@langchain/core/messages';
import type {
  SubagentInputState,
  SubagentResult,
  SubagentRunInput,
} from '../types/subagent';
import {
  evaluateGuard,
  type GuardDecisionEmitter,
} from '../guards';
import { createAgent, createMiddleware } from 'langchain';
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
import { Command, END, getWriter } from '@langchain/langgraph';

// Fallback model-call budget when the caller does not pass maxIterations. The
// subagent iteration guard should stop gracefully first; LangGraph recursionLimit
// is a deliberately high last-resort breaker, not a normal control signal.
const DEFAULT_SUBAGENT_MAX_ITERATIONS = 100;
const SUBAGENT_HARD_RECURSION_LIMIT = 10_000;

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
 * from a registry merges this map in so delegation-scoped toolset operations
 * (which are not in any statically known toolkit) still resolve.
 */
export const SUBAGENT_OPERATIONS_EVENT = 'subagent_operations';

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

/**
 * Writes a runtime event through the run's stream writer. Pregel injects the
 * writer with `config.writer ??= ...`, so a subagent invoked with the parent
 * config writes through the PARENT's writer and the event surfaces as a
 * `custom` event on the root protocol stream. Emission is advisory: outside a
 * run context it degrades to a no-op.
 */
function writeSubagentRuntimeEvent(name: string, data: unknown) {
  try {
    getWriter()?.({
      event: 'on_runtime_event',
      name,
      data,
    });
  } catch {
    // Outside a run context; skip.
  }
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
  // Decision records must never fail the run.
  const emitGuardDecision: GuardDecisionEmitter = (record) => {
    writeSubagentRuntimeEvent(SUBAGENT_GUARD_DECISION_EVENT, record);
  };
  const contextPolicyMiddleware = createContextPolicyMiddleware(inputState, emitGuardDecision);
  const iterationGuardMiddleware = createSubagentIterationGuardMiddleware(maxIterations, emitGuardDecision);
  const middleware = [
    contextPolicyMiddleware,
    iterationGuardMiddleware,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  // No checkpointer here: the child inherits the parent's through the runnable
  // config, so its state checkpoints under the parent's namespaced thread and a
  // bare Command({ resume }) against the parent re-enters the child (#322).
  const agent = createAgent({
    model: input.model,
    tools: input.tools,
    systemPrompt,
    ...(middleware.length > 0 ? { middleware } : {}),
  });

  if (inputState.operations && Object.keys(inputState.operations).length > 0) {
    writeSubagentRuntimeEvent(SUBAGENT_OPERATIONS_EVENT, { operations: inputState.operations });
  }

  let latestMessages = inputState.messages;
  try {
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
        signal: input.signal,
        // Normal stopping is controlled by the subagent iteration guard.
        // LangGraph recursionLimit stays intentionally high as a final breaker.
        recursionLimit: SUBAGENT_HARD_RECURSION_LIMIT,
      },
    );
    latestMessages = readResultMessages(result) ?? latestMessages;

    // A guard may have gracefully ended the agent by appending its stop
    // notice as the FINAL message (via Command goto END). That is a clean "limit
    // reached" stop, not natural completion. Check only the last message — a stop
    // marker buried in the input history must not be misread as our stop, and
    // contextPolicy may rewrite the list so an index-based slice is unreliable.
    const lastMessage = latestMessages.at(-1);
    const stoppedByGuard = lastMessage ? isSubagentGuardStopMessage(lastMessage) : false;
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
      return {
        messages: latestMessages,
        artifacts: inputState.artifacts ?? [],
        completionReason: 'limit_reached',
      };
    }
    throw err;
  }
}
