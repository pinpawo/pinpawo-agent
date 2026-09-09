import { Command } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { createCapabilityExecutor } from '../../capabilityExecution';
import { updateRunDelegationSummaryResult } from '../../delegations';
import { snapshotRunTaskContinuation } from '../../runSupervisor/session';
import { pauseTaskInterrupt } from '../../interrupt';
import type { createRunTerminationHandlers } from '../runTermination';
import { getInvokeRegistry, getInvokeOptions } from '../config';
import { readCapabilityNameFromLane, resolveDelegationRunId } from '../decisions/delegationLifecycle';

export function createCapabilityNode(params: {
  config: OrchestratorConfig;
  onNodeError: ReturnType<typeof createRunTerminationHandlers>['onNodeError'];
  subagentContextWindowTokens: number | undefined;
  subagentGenerationReserveTokens: number | undefined;
}) {
  const {
    config,
    subagentContextWindowTokens,
    subagentGenerationReserveTokens,
  } = params;

  const executeCapability = createCapabilityExecutor({
    models: config.models,
    modelInputModalities: config.modelInputModalities,
    capabilityArtifactStore: config.capabilityArtifactStore,
    toolkitRuntimeManager: config.toolkitRuntimeManager,
    subagentContextWindowTokens,
    subagentGenerationReserveTokens,
  });

  // Resolve invocation metadata and the Host's structured execution directory.
  return async function capabilityNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const {
      reviewCapabilities,
      globalReviewPolicy,
    } = getInvokeOptions(runnableConfig);
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
    const runId = resolveDelegationRunId(state, runNextDelegation);
    const delegation = {
      id: runNextDelegation.id,
      runId,
      traceId: state.traceId,
      userRequest: state.runUserRequest,
      task: runNextDelegation.task,
    };
    const execution = await executeCapability({
      capability: compiledCapability,
      delegation: runNextDelegation.mode === 'initial'
        ? {
            ...delegation,
            mode: 'initial',
            essentialContext: runNextDelegation.contextSummary,
          }
        : {
            ...delegation,
            mode: 'continue',
            guidance: runNextDelegation.contextSummary,
          },
      history: state.messages,
    }, {
      review: {
        authorizations: state.sessionToolAuthorizations.generation === registry.authorizationGeneration
          ? state.sessionToolAuthorizations.records
          : [],
        hostCapabilities: reviewCapabilities,
        policy: globalReviewPolicy,
      },
      runnableConfig,
    });
    const { messages: laneOutputMessages, announce: delegationAnnounce } = execution.handoff;
    const resultArtifacts = execution.artifacts;
    const paused = execution.status === 'paused';
    const missingDeliverable = execution.status === 'missing_deliverable';
    const currentResultPreview = state.taskActiveDelegation?.resultPreview ?? null;
    const resultPreview = paused
      ? currentResultPreview
      : delegationAnnounce?.result ?? null;
    // The subagent node only records that the delegation ran (status 'progress');
    // whether it is complete is the Supervisor's call at the execution boundary,
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
    const pauseContinuation = paused
      ? state.taskRunContinuation
        ?? snapshotRunTaskContinuation({
          traceId: state.traceId,
          userRequest: state.runUserRequest,
          activeDelegation,
          supervisorSession: state.runSupervisorSession,
        })
      : null;
    const update = {
      messages: laneOutputMessages,
      sessionCapabilityArtifacts: resultArtifacts,
      runDelegationSummaries: updatedRunDelegationSummaries,
      runNextDelegation: null,
      taskActiveDelegation: {
        ...activeDelegation,
        status: paused || missingDeliverable ? 'pending' as const : 'awaiting_decision' as const,
        resultPreview,
      },
      runIterationCount: state.runIterationCount + 1,
      ...(paused ? {
        runSupervisorSession: null,
        taskRunContinuation: pauseContinuation,
        taskPauseInterrupt: pauseTaskInterrupt.interaction(),
      } : {}),
      sessionToolAuthorizations: {
        generation: registry.authorizationGeneration,
        records: execution.toolAuthorizations,
      },
    };
    if (missingDeliverable) {
      const failure = params.onNodeError({ ...state, ...update }, {
        node: 'capability',
        error: new Error('Capability execution produced no new deliverable. Resume the task to continue execution.'),
      });
      return new Command({
        update: { ...update, ...failure.update as Partial<OrchestratorStateType> },
        goto: 'throwRunFailure',
      });
    }
    return update;
  };
}
