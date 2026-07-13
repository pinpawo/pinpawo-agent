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
import { createAgent, createMiddleware, type AnyAgentMiddleware } from 'langchain';
import {
  buildContextManagementStateUpdate,
  resolveSubagentContextManagement,
  rewriteMessagesForContextManagement,
} from './contextManagement';
import { isGraphRecursionLimitError } from '../utils/graphErrors';
import {
  contextMaintenanceGuard,
  SUBAGENT_GUARD_POSITION,
  subagentIterationLimitGuard,
} from './guardDefinitions';
import {
  buildSubagentIterationLimitStopNotice,
  isSubagentGuardStopMessage,
} from './guardStop';
import { Command, END } from '@langchain/langgraph';
import { emitRuntimeEventToStreamWriter } from '../utils/streamWriterEvents';
import { CONTEXT_MANAGEMENT_GOVERNING_PROMPT } from './prompts/templates/contextManagement.prompt';
import { SUBAGENT_GOVERNING_PROMPT } from './prompts/templates/governing.prompt';

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

function buildContextManagementContext(
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

function createContextManagementMiddleware(
  inputState: SubagentInputState,
  emitGuardDecision?: GuardDecisionEmitter,
) {
  let iterationCount = 0;

  return createMiddleware({
    name: 'SubagentContextManagement',
    beforeModel: async (state) => {
      iterationCount += 1;
      const management = inputState.contextManagement;
      if (!management) {
        return undefined;
      }
      const messages = state.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return undefined;
      }
      const baseMessages = messages as BaseMessage[];
      const outcome = evaluateGuard(contextMaintenanceGuard, {
        state: { messages: baseMessages, contextManagement: management },
        config: { contextWindowTokens: inputState.contextWindowTokens },
        position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_MANAGEMENT,
      }, { emit: emitGuardDecision, iteration: iterationCount });
      if (outcome.kind !== 'maintain') {
        return undefined;
      }
      const context = buildContextManagementContext(inputState, iterationCount);
      const rewritten = management.rewriteAsync
        ? await management.rewriteAsync(baseMessages, context)
        : rewriteMessagesForContextManagement(baseMessages, management, context);
      return buildContextManagementStateUpdate(baseMessages, rewritten) ?? undefined;
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

function writeSubagentRuntimeEvent(name: string, data: unknown) {
  emitRuntimeEventToStreamWriter({ event: 'on_runtime_event', name, data });
}

export async function createSubagent(input: SubagentRunInput): Promise<SubagentResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_SUBAGENT_MAX_ITERATIONS;
  const contextManagement = resolveSubagentContextManagement(
    input.contextManagement ?? input.contextPolicy,
  );
  const inputState: SubagentInputState = {
    instructions: input.instructions,
    operations: input.operations,
    messages: input.messages,
    maxIterations: input.maxIterations,
    contextWindowTokens: input.contextWindowTokens,
    contextManagement,
    artifacts: input.artifacts,
    artifactSink: input.artifactSink,
  };
  const systemPrompt = [
    SUBAGENT_GOVERNING_PROMPT,
    inputState.contextManagement ? CONTEXT_MANAGEMENT_GOVERNING_PROMPT : null,
    ...inputState.instructions,
  ].filter((item): item is string => Boolean(item)).join('\n\n');
  // Decision records must never fail the run.
  const emitGuardDecision: GuardDecisionEmitter = (record) => {
    writeSubagentRuntimeEvent(SUBAGENT_GUARD_DECISION_EVENT, record);
  };
  const contextManagementMiddleware = createContextManagementMiddleware(inputState, emitGuardDecision);
  const iterationGuardMiddleware = createSubagentIterationGuardMiddleware(maxIterations, emitGuardDecision);
  const middleware: AnyAgentMiddleware[] = [
    contextManagementMiddleware,
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
    // Context management may rewrite the list so an index-based slice is unreliable.
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
