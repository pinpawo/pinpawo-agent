import type { RunnableConfig } from '@langchain/core/runnables';
import { createSubagent } from '../../../../subagent/createSubagent';
import type { CapabilityArtifactRef } from '../../../../types/artifact';
import type { SubagentRunInput } from '../../../../types/subagent';
import {
  buildEmptyRunCapabilitySearchState,
  type OrchestratorStateType,
} from '../../state';
import { updateRunDelegationResult } from '../../delegations';
import {
  laneMessages,
  readLatestAnnounce,
  tagNewLaneMessages,
} from '../../messageLanes';
import {
  buildDelegationHandoffInstruction,
  collectCapabilityOperations,
  resolveInstructions,
  resolveToolkitResources,
  selectCapabilityTools,
} from '../../subagentHandoff';
import type {
  MessageLane,
  OrchestratorConfig,
} from '../../types';
import { validateUniqueToolkitNames, validateUniqueToolNames } from '../../validation';
import { createToolAuthorizationRecorder } from '../authorization';
import {
  CAPABILITY_SUBAGENT_MAX_ITERATIONS,
} from '../constants';
import {
  capabilityLaneToolkits,
  getInvokeOptions,
  readThreadId,
  resolveActor,
} from '../config';
import {
  createTaskActiveDelegation,
  readCapabilityNameFromLane,
  resolveDelegationTranscriptRunId,
} from '../decisions/delegationLifecycle';

export function createCapabilityNode(params: {
  config: OrchestratorConfig;
  subagentContextWindowTokens: number | undefined;
}) {
  const { config, subagentContextWindowTokens } = params;

  // Node: capability — reads capabilities, tools, execution from configurable
  return async function capabilityNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const {
      capabilities,
      toolkits,
      execution,
      onToolEvent,
      workdir,
      runtimeEnvironment,
      reviewCapabilities,
      globalReviewPolicy,
    } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const toolkitList = capabilityLaneToolkits(toolkits ?? []);
    validateUniqueToolkitNames(toolkitList);
    const runPendingDelegation = state.runPendingDelegation;
    if (!runPendingDelegation) {
      throw new Error('Capability node cannot run without a pending capability delegation.');
    }
    const capabilityName = readCapabilityNameFromLane(runPendingDelegation.lane);
    if (!capabilityName) {
      throw new Error('Capability node received a non-capability delegation lane.');
    }
    const capability = capabilities?.find((c) => c.name === capabilityName);
    if (!capability) {
      throw new Error(`Capability node cannot resolve capability "${capabilityName}".`);
    }
    const lane: MessageLane = `capability:${capability.name}`;
    const transcriptRunId = resolveDelegationTranscriptRunId(state, runPendingDelegation);
    const scopedMessages = laneMessages(state.messages, lane, transcriptRunId, runPendingDelegation.id);
    const threadId = readThreadId(runnableConfig);

    const availableToolkits = toolkitList.map(({ name, description }) => ({
      name,
      description,
    }));

    const runtime = await capability.createRuntime({
      models: config.models,
      actor,
      messages: scopedMessages,
      execution,
      availableToolkits,
      artifactStore: config.capabilityArtifactStore,
    });

    const authorizationRecorder = createToolAuthorizationRecorder(state.sessionToolAuthorizations);
    const artifactRefs: CapabilityArtifactRef[] = [];
    const toolkitContext = {
      models: config.models,
      actor,
      messages: scopedMessages,
      threadId,
      capabilityId: capability.name,
      resultSchema: capability.resultSchema,
      delegationId: runPendingDelegation.id,
      runId: transcriptRunId,
      execution,
      reviewCapabilities,
      globalReviewPolicy,
      toolAuthorizations: authorizationRecorder.active,
      recordToolAuthorization: authorizationRecorder.recordToolAuthorization,
      recordCapabilityArtifact: (ref: CapabilityArtifactRef) => {
        artifactRefs.push(ref);
      },
      emitRuntimeEvent: onToolEvent,
    };
    const usedToolkitResources = await resolveToolkitResources(toolkitList, runtime.uses ?? [], toolkitContext);
    const runtimeInstructions = await resolveInstructions(runtime, {
      models: config.models,
      actor,
      messages: scopedMessages,
      availableToolkits,
    }, execution);
    const middleware = runtime.middleware;
    const handoffInstruction = buildDelegationHandoffInstruction({
      lane,
      task: runPendingDelegation.task,
      contextSummary: runPendingDelegation.contextSummary,
      workdir: workdir ?? null,
    });

    let subagentInput: SubagentRunInput = {
      model: config.models.subagent ?? config.models.act,
      tools: selectCapabilityTools(runtime, usedToolkitResources.tools),
      instructions: [handoffInstruction, ...usedToolkitResources.instructions, ...(runtimeEnvironment ? [runtimeEnvironment] : []), ...runtimeInstructions],
      operations: collectCapabilityOperations(usedToolkitResources.toolkits, runtime),
      messages: scopedMessages,
      maxIterations: CAPABILITY_SUBAGENT_MAX_ITERATIONS,
      contextWindowTokens: subagentContextWindowTokens,
      contextPolicy: runtime.contextPolicy,
      runnableConfig,
      signal: runnableConfig?.signal,
      artifacts: artifactRefs,
      artifactSink: {
        recordCapabilityArtifact: (ref: CapabilityArtifactRef) => {
          artifactRefs.push(ref);
        },
        threadId,
        delegationId: runPendingDelegation.id,
        runId: transcriptRunId,
      },
    };
    validateUniqueToolNames(subagentInput.tools);

    if (middleware?.beforeRun) {
      subagentInput = await middleware.beforeRun(subagentInput);
      validateUniqueToolNames(subagentInput.tools);
    }

    let result = await createSubagent(subagentInput);

    if (middleware?.afterRun) {
      result = await middleware.afterRun(result, {
        recordCapabilityArtifact: (ref: CapabilityArtifactRef) => {
          artifactRefs.push(ref);
        },
        threadId,
        capabilityId: capability.name,
        delegationId: runPendingDelegation.id,
        runId: transcriptRunId,
      });
    }

    const laneOutputMessages = tagNewLaneMessages(
      result.messages,
      subagentInput.messages.length,
      lane,
      transcriptRunId,
      result.completionReason,
      {
        delegationId: runPendingDelegation.id,
        task: runPendingDelegation.task,
      },
    );
    const delegationAnnounce = readLatestAnnounce(laneOutputMessages, { delegationId: runPendingDelegation.id });
    // The subagent node only records that the delegation ran (status 'progress');
    // whether it is complete is the orchestrator's call at delegationOutcomeDecision,
    // which upgrades the status to 'completed' when it hands off. The raw lane
    // messages are kept in place — handoff (or a later continuation) cleans them up.
    const updatedRunDelegations = updateRunDelegationResult(
      state.runDelegations,
      runPendingDelegation.id,
      {
        status: 'progress',
        resultPreview: delegationAnnounce?.text ?? null,
      },
    );

    return {
      messages: laneOutputMessages,
      sessionCapabilityArtifacts: result.artifacts,
      runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
      runDelegations: updatedRunDelegations,
      runPendingDelegation: null,
      taskActiveDelegation: {
        ...(state.taskActiveDelegation ?? createTaskActiveDelegation(runPendingDelegation, transcriptRunId)),
        status: 'awaiting_decision' as const,
        resultPreview: delegationAnnounce?.text ?? null,
      },
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: authorizationRecorder.recorded,
    };
  };
}
