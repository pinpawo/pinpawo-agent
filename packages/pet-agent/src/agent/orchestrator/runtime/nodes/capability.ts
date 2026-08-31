import type { RunnableConfig } from '@langchain/core/runnables';
import { createSubagent } from '../../../../subagent/createSubagent';
import type { CapabilityArtifactRef } from '../../../../types/artifact';
import type { SubagentRunInput } from '../../../../types/subagent';
import type { OrchestratorStateType } from '../../state';
import { updateRunDelegationSummaryResult } from '../../delegations';
import {
  observeAgentMessageSelection,
  queryAgentMessages,
} from '../../../messages';
import {
  readLatestAnnounce,
  reconcileDelegationPrivateMessages,
} from '../../delegation';
import { orchestratorModelInvocationMiddleware } from '../../modelInvocation';
import {
  buildSubagentExecutionContext,
  collectToolkitOperations,
  resolveToolkitExecution,
} from '../../subagentDispatch';
import type {
  CapabilityMessageLane,
  OrchestratorConfig,
} from '../../types';
import { emitRuntimeEventToStreamWriter } from '../../../../utils/streamWriterEvents';
import { createToolAuthorizationRecorder } from '../authorization';
import {
  CAPABILITY_SUBAGENT_MAX_ITERATIONS,
} from '../constants';
import {
  getInvokeRegistry,
  getInvokeOptions,
  readThreadId,
  resolveActor,
} from '../config';
import {
  readCapabilityNameFromLane,
  resolveDelegationRunId,
} from '../decisions/delegationLifecycle';
import {
  hasArtifactDiscoveryToolkit,
} from '../../artifacts/discovery';
import type { ToolkitRuntimeExecution } from '../../toolkitRuntime';
import { materializeDelegation } from '../../delegation';
import { snapshotPlannerTaskContinuation } from '../../capabilityPlanner/session';

export function createCapabilityNode(params: {
  config: OrchestratorConfig;
  subagentContextWindowTokens: number | undefined;
  subagentGenerationReserveTokens: number | undefined;
}) {
  const {
    config,
    subagentContextWindowTokens,
    subagentGenerationReserveTokens,
  } = params;

  // Node: capability — reads capabilities, tools, execution from configurable
  return async function capabilityNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const {
      execution,
      workdir,
      runtimeEnvironment,
      reviewCapabilities,
      globalReviewPolicy,
    } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const registry = getInvokeRegistry(runnableConfig);
    const runNextDelegation = state.runNextDelegation;
    if (!runNextDelegation) {
      throw new Error('Capability node cannot run without a pending capability delegation.');
    }
    if (!state.runUserRequest) {
      throw new Error('Capability execution requires runUserRequest.');
    }
    const activeDelegation = state.taskActiveDelegation;
    if (!activeDelegation || activeDelegation.id !== runNextDelegation.id) {
      throw new Error('Capability execution requires its matching taskActiveDelegation.');
    }
    const capabilityName = readCapabilityNameFromLane(runNextDelegation.lane);
    if (!capabilityName) {
      throw new Error('Capability node received a non-capability delegation lane.');
    }
    const compiledCapability = registry.capabilities
      .find(({ capability }) => capability.name === capabilityName);
    if (!compiledCapability) {
      throw new Error(
        `Capability node cannot resolve an available capability "${capabilityName}".`,
      );
    }
    const { capability } = compiledCapability;
    const toolkitList = [...compiledCapability.toolkits];
    const lane: CapabilityMessageLane = runNextDelegation.lane;
    const runId = resolveDelegationRunId(state, runNextDelegation);
    const delegationScope = {
      lane,
      runId,
      delegationId: runNextDelegation.id,
    };
    const briefingBase = {
      userRequest: state.runUserRequest,
      task: runNextDelegation.task,
    };
    const delegationBriefing = materializeDelegation(
      runNextDelegation.mode === 'initial'
        ? {
            ...briefingBase,
            mode: 'initial',
            essentialContext: runNextDelegation.contextSummary,
          }
        : {
            ...briefingBase,
            mode: 'continue',
            guidance: runNextDelegation.contextSummary,
          },
    );
    const scopedQuery = queryAgentMessages(state.messages)
      .main()
      .delegation(delegationScope);
    const canonicalSelection = scopedQuery.select();
    const scopedSelection = scopedQuery
      .append(delegationBriefing)
      .select();
    observeAgentMessageSelection(
      'capability.private_messages',
      scopedSelection.diagnostics,
      runnableConfig,
    );
    const scopedMessages = scopedSelection.messages;
    const threadId = readThreadId(runnableConfig);

    const authorizationRecorder = createToolAuthorizationRecorder(
      state.sessionToolAuthorizations.generation === registry.authorizationGeneration
        ? state.sessionToolAuthorizations.records
        : [],
    );
    const artifactRefs: CapabilityArtifactRef[] = [];
    const toolkitContext = {
      models: config.models,
      modelInputModalities: config.modelInputModalities,
      actor,
      messages: scopedMessages,
      reviewContext: {
        task: runNextDelegation.task,
        workdir: workdir ?? null,
      },
      reviewCapabilities,
      globalReviewPolicy,
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
    let result: Awaited<ReturnType<typeof createSubagent>>;
    try {
      runtimeExecution = config.toolkitRuntimeManager
        ? await config.toolkitRuntimeManager.resolve({
            toolkits: toolkitList,
            execution: {
              threadId,
              runId,
              delegationId: runNextDelegation.id,
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
        workdir: workdir ?? null,
        artifactDiscovery: canExploreArtifacts,
      });
      subagentInput = {
        model: config.models.subagent ?? config.models.act,
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
          ...(runtimeEnvironment
            ? [{
                id: 'runtime-environment',
                owner: 'host',
                content: runtimeEnvironment,
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
            delegationId: runNextDelegation.id,
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
      result = await createSubagent(subagentInput);
    } finally {
      await runtimeExecution?.release();
    }

    if (
      result.completionReason !== 'interrupted'
      && capability.lifecycle?.finalize
    ) {
      const finalized = await capability.lifecycle.finalize(result, {
        models: config.models,
        actor,
        messages: scopedMessages,
        execution,
        artifactStore: config.capabilityArtifactStore,
        recordCapabilityArtifact: (ref: CapabilityArtifactRef) => {
          artifactRefs.push(ref);
        },
        threadId,
        capabilityId: capability.name,
        delegationId: runNextDelegation.id,
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

    const laneOutputMessages = reconcileDelegationPrivateMessages(
      result.messages,
      subagentInput.messages,
      lane,
      runId,
      result.completionReason,
      {
        delegationId: runNextDelegation.id,
        task: runNextDelegation.task,
        announceMessageId: result.announceMessageId,
      },
      canonicalSelection.messages,
    );
    const delegationAnnounce = readLatestAnnounce(laneOutputMessages, delegationScope);
    const interrupted = result.completionReason === 'interrupted';
    const currentResultPreview = state.taskActiveDelegation?.resultPreview ?? null;
    const resultPreview = interrupted
      ? currentResultPreview
      : delegationAnnounce?.result ?? null;
    // The subagent node only records that the delegation ran (status 'progress');
    // whether it is complete is the Planner's call at the execution boundary,
    // which upgrades the status to 'completed' when it hands off. The raw lane
    // messages are kept in place — handoff (or a later continuation) cleans them up.
    const updatedRunDelegationSummaries = updateRunDelegationSummaryResult(
      state.runDelegationSummaries,
      runNextDelegation.id,
      {
        status: 'progress',
        resultPreview,
      },
    );
    const interruptedContinuation = interrupted
      ? state.taskPlannerContinuation
        ?? snapshotPlannerTaskContinuation({
          activeDelegation,
          plannerSession: state.runPlannerSession,
        })
      : null;
    return {
      messages: laneOutputMessages,
      sessionCapabilityArtifacts: result.artifacts,
      runDelegationSummaries: updatedRunDelegationSummaries,
      runNextDelegation: null,
      taskActiveDelegation: {
        ...activeDelegation,
        status: interrupted ? 'pending' as const : 'awaiting_decision' as const,
        resultPreview,
      },
      runIterationCount: state.runIterationCount + 1,
      ...(interrupted ? {
        runPlannerSession: null,
        taskPlannerContinuation: interruptedContinuation,
      } : {}),
      sessionToolAuthorizations: {
        generation: registry.authorizationGeneration,
        records: authorizationRecorder.active,
      },
    };
  };
}
