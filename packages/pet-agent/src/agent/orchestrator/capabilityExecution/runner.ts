import { createSubagent } from '../../../subagent/createSubagent';
import { getAgentRuntimeContext } from '../../../runtime/context';
import type { CapabilityArtifactRef } from '../../../types/artifact';
import type { SubagentRunInput } from '../../../types/subagent';
import { observeAgentMessageSelection, queryAgentMessages } from '../../messages';
import { materializeDelegation, reconcileDelegationPrivateMessages } from '../delegation';
import { readMessageText } from '../utils';
import { orchestratorModelInvocationMiddleware } from '../modelInvocation';
import { buildSubagentExecutionContext, collectToolkitOperations, resolveToolkitExecution } from '../subagentDispatch';
import { emitRuntimeEventToStreamWriter } from '../../../utils/streamWriterEvents';
import { createToolAuthorizationRecorder } from '../runtime/authorization';
import { CAPABILITY_SUBAGENT_MAX_ITERATIONS } from '../runtime/constants';
import { readThreadId } from '../runtime/config';
import { hasArtifactDiscoveryToolkit } from '../artifacts/discovery';
import type { ToolkitRuntimeExecution } from '../toolkitRuntime';
import { readPauseTaskInterruptSignal, type PausedSubagentState } from '../interrupt';
import type {
  CapabilityExecutionContext,
  CapabilityExecutionInput,
  CapabilityExecutionOptions,
  CapabilityExecutionResult,
} from './types';

/**
 * One Capability attempt: briefing -> isolated execution -> evidence handoff.
 * The caller owns scheduling, state application, acceptance and pause policy.
 * No mutable execution state is retained between calls.
 */
export function createCapabilityExecutor(options: CapabilityExecutionOptions) {
  const runSubagent = options.runSubagent ?? createSubagent;
  const {
    subagentContextWindowTokens,
    subagentGenerationReserveTokens,
  } = options;

  return async function executeCapability(
    input: CapabilityExecutionInput,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecutionResult> {
    const { runnableConfig, review } = context;
    const { workdir } = getAgentRuntimeContext(runnableConfig);
    const threadId = readThreadId(runnableConfig);
    const { delegation } = input;
    const { capability } = input.capability;
    const scope: CapabilityExecutionResult['scope'] = {
      lane: `capability:${capability.name}`,
      delegationId: delegation.id,
      runId: delegation.runId,
      traceId: delegation.traceId,
    };
    if (!scope.delegationId || !scope.runId) {
      throw new Error('Capability execution requires a complete delegation identity.');
    }
    const toolkitList = [...input.capability.toolkits];
    const { runId } = scope;
    const delegationBriefing = materializeDelegation(delegation);
    const scopedQuery = queryAgentMessages(input.history)
      .main()
      .delegation(scope);
    const canonicalSelection = scopedQuery.select();
    if (canonicalSelection.messages.some((message) => !message.id?.trim())) {
      throw new Error('Capability history messages must have stable IDs before execution.');
    }
    const scopedSelection = scopedQuery
      .append(delegationBriefing)
      .select();
    observeAgentMessageSelection(
      'capability.private_messages',
      scopedSelection.diagnostics,
      runnableConfig,
    );
    const scopedMessages = scopedSelection.messages;
    const authorizationRecorder = createToolAuthorizationRecorder(
      [...review.authorizations],
    );
    const artifactRefs: CapabilityArtifactRef[] = [];
    const toolkitContext = {
      models: options.models,
      modelInputModalities: options.modelInputModalities,
      messages: scopedMessages,
      reviewContext: {
        task: delegation.task,
        workdir: workdir ?? null,
      },
      reviewCapabilities: review.hostCapabilities,
      globalReviewPolicy: review.policy,
      toolAuthorizations: authorizationRecorder.active,
      recordToolAuthorizations: authorizationRecorder.recordToolAuthorizations,
      // Runtime events (authorization notices) surface as `custom` protocol
      // events on the root stream (#322); review emits from afterModel
      // middleware, where the writer is reachable at call time.
      emitRuntimeEvent: emitRuntimeEventToStreamWriter,
    };
    let runtimeExecution: ToolkitRuntimeExecution | null = null;
    let usedResolvedToolkitExecution: Awaited<ReturnType<typeof resolveToolkitExecution>>;
    let subagentInput: SubagentRunInput;
    let result: Awaited<ReturnType<typeof createSubagent>> | null = null;
    let pausedSubagentState: PausedSubagentState | null = null;
    try {
      runtimeExecution = options.toolkitRuntimeManager
        ? await options.toolkitRuntimeManager.resolve({
            toolkits: toolkitList,
            execution: {
              threadId,
              runId,
              delegationId: scope.delegationId,
              workdir: workdir ?? null,
              signal: runnableConfig?.signal,
            },
          })
        : null;
      const executionToolkits = runtimeExecution
        ? [...runtimeExecution.toolkits]
        : toolkitList;
      usedResolvedToolkitExecution = await resolveToolkitExecution(
        executionToolkits,
        undefined,
        toolkitContext,
      );
      const canExploreArtifacts = hasArtifactDiscoveryToolkit(
        usedResolvedToolkitExecution.toolkits,
      );
      const executionContext = buildSubagentExecutionContext({
        artifactDiscovery: canExploreArtifacts,
      });
      subagentInput = {
        model: options.models.subagent ?? options.models.act,
        tools: usedResolvedToolkitExecution.tools,
        promptSections: [
          ...usedResolvedToolkitExecution.toolkits
            .filter((toolkit) => Boolean(toolkit.instructions?.trim()))
            .map((toolkit) => ({
              id: `toolkit:${toolkit.name}`,
              owner: toolkit.name,
              content: toolkit.instructions as string,
            })),
          {
            id: `capability:${capability.name}`,
            owner: capability.name,
            content: capability.instructions.content,
          },
          ...(executionContext
            ? [{
                id: 'execution-context',
                owner: 'framework',
                content: executionContext,
              }]
            : []),
        ],
        operations: collectToolkitOperations(usedResolvedToolkitExecution.toolkits),
        messages: scopedMessages,
        maxIterations: CAPABILITY_SUBAGENT_MAX_ITERATIONS,
        contextWindowTokens: subagentContextWindowTokens,
        generationReserveTokens: subagentGenerationReserveTokens,
        middleware: [
          ...usedResolvedToolkitExecution.middleware,
          orchestratorModelInvocationMiddleware,
        ],
        runtimeContext: {
          executionScope: {
            threadId,
            runId,
            delegationId: scope.delegationId,
            workdir: workdir ?? null,
          },
          ...(runtimeExecution
            ? { toolkitRuntimes: runtimeExecution.runtimes }
            : {}),
        },
        runnableConfig,
        signal: runnableConfig?.signal,
        artifacts: artifactRefs,
      };
      try {
        result = await runSubagent(subagentInput);
      } catch (error) {
        const pauseSignal = readPauseTaskInterruptSignal(error);
        if (!pauseSignal) {
          throw error;
        }
        pausedSubagentState = pauseSignal.state;
      }
    } finally {
      await runtimeExecution?.release();
    }

    if (result && capability.lifecycle?.finalize) {
      const finalized = await capability.lifecycle.finalize(result, {
        models: options.models,
        messages: scopedMessages,
        artifactStore: options.capabilityArtifactStore,
        recordCapabilityArtifact: (ref: CapabilityArtifactRef) => {
          artifactRefs.push(ref);
        },
        threadId,
        capabilityId: capability.name,
        delegationId: scope.delegationId,
        runId,
      });
      const artifactsById = new Map(
        [...result.artifacts, ...artifactRefs, ...(finalized?.artifactRefs ?? [])]
          .map((ref) => [ref.id, ref]),
      );
      result = {
        ...result,
        ...(finalized?.messages ? { messages: finalized.messages } : {}),
        ...(finalized?.announceMessageId !== undefined
          ? { announceMessageId: finalized.announceMessageId }
          : {}),
        artifacts: [...artifactsById.values()],
      };
    }

    if (!result && !pausedSubagentState) {
      throw new Error('Capability subagent produced neither a result nor a pause signal.');
    }
    const resultMessages = pausedSubagentState?.messages ?? result!.messages;
    const resultArtifacts = pausedSubagentState?.artifacts ?? result!.artifacts;
    const announceMessageId = result?.announceMessageId ?? null;
    const laneOutputMessages = reconcileDelegationPrivateMessages(
      resultMessages,
      subagentInput.messages,
      scope.lane,
      scope.runId,
      {
        traceId: scope.traceId,
        delegationId: scope.delegationId,
        task: delegation.task,
        announceMessageId,
        publishAnnounce: false,
      },
      canonicalSelection.messages,
    );
    const deliveredMessage = announceMessageId
      ? laneOutputMessages.find((message) => message.id === announceMessageId)
      : null;
    const delivery = deliveredMessage ? {
      id: `delivery:${scope.runId}:${scope.delegationId}:${announceMessageId}`,
      scope,
      task: delegation.task,
      text: readMessageText(deliveredMessage),
    } : null;
    return {
      status: pausedSubagentState ? 'paused' : delivery ? 'returned' : 'missing_deliverable',
      scope,
      delivery,
      privateMessages: laneOutputMessages,
      artifacts: resultArtifacts,
      toolAuthorizations: [...authorizationRecorder.active],
    };
  };
}
