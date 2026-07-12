import type { RunnableConfig } from '@langchain/core/runnables';
import { createSubagent } from '../../../../subagent/createSubagent';
import type { CapabilityArtifactRef } from '../../../../types/artifact';
import type { SubagentRunInput } from '../../../../types/subagent';
import type { OrchestratorStateType } from '../../state';
import { updateRunDelegationSummaryResult } from '../../delegations';
import {
  laneMessages,
  readLatestAnnounce,
  tagNewLaneMessages,
} from '../../messageLanes';
import {
  buildSubagentExecutionInstruction,
  collectCapabilityOperations,
  resolveInstructions,
  resolveToolkitResources,
  selectCapabilityTools,
} from '../../subagentDispatch';
import type {
  MessageLane,
  OrchestratorConfig,
} from '../../types';
import { emitRuntimeEventToStreamWriter } from '../../../../utils/streamWriterEvents';
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
      workdir,
      runtimeEnvironment,
      reviewCapabilities,
      globalReviewPolicy,
    } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const toolkitList = capabilityLaneToolkits(toolkits ?? []);
    validateUniqueToolkitNames(toolkitList);
    const runNextDelegation = state.runNextDelegation;
    if (!runNextDelegation) {
      throw new Error('Capability node cannot run without a pending capability delegation.');
    }
    const capabilityName = readCapabilityNameFromLane(runNextDelegation.lane);
    if (!capabilityName) {
      throw new Error('Capability node received a non-capability delegation lane.');
    }
    const capability = capabilities?.find((c) => c.name === capabilityName);
    if (!capability) {
      throw new Error(`Capability node cannot resolve capability "${capabilityName}".`);
    }
    const lane: MessageLane = `capability:${capability.name}`;
    const transcriptRunId = resolveDelegationTranscriptRunId(state, runNextDelegation);
    const scopedMessages = laneMessages(state.messages, lane, transcriptRunId, runNextDelegation.id);
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
      delegationId: runNextDelegation.id,
      runId: transcriptRunId,
      execution,
      reviewCapabilities,
      globalReviewPolicy,
      toolAuthorizations: authorizationRecorder.active,
      recordToolAuthorization: authorizationRecorder.recordToolAuthorization,
      recordCapabilityArtifact: (ref: CapabilityArtifactRef) => {
        artifactRefs.push(ref);
      },
      // Runtime events (authorization notices) surface as `custom` protocol
      // events on the root stream (#322); review emits from afterModel
      // middleware, where the writer is reachable at call time.
      emitRuntimeEvent: emitRuntimeEventToStreamWriter,
    };
    const usedToolkitResources = await resolveToolkitResources(toolkitList, runtime.uses ?? [], toolkitContext);
    const runtimeInstructions = await resolveInstructions(runtime, {
      models: config.models,
      actor,
      messages: scopedMessages,
      availableToolkits,
    }, execution);
    const middleware = runtime.middleware;
    const executionInstruction = buildSubagentExecutionInstruction({
      lane,
      workdir: workdir ?? null,
    });

    let subagentInput: SubagentRunInput = {
      model: config.models.subagent ?? config.models.act,
      tools: selectCapabilityTools(runtime, usedToolkitResources.tools),
      instructions: [executionInstruction, ...usedToolkitResources.instructions, ...(runtimeEnvironment ? [runtimeEnvironment] : []), ...runtimeInstructions],
      operations: collectCapabilityOperations(usedToolkitResources.toolkits, runtime),
      messages: scopedMessages,
      maxIterations: CAPABILITY_SUBAGENT_MAX_ITERATIONS,
      contextWindowTokens: subagentContextWindowTokens,
      contextPolicy: runtime.contextPolicy,
      middleware: usedToolkitResources.middleware,
      runnableConfig,
      signal: runnableConfig?.signal,
      artifacts: artifactRefs,
      artifactSink: {
        recordCapabilityArtifact: (ref: CapabilityArtifactRef) => {
          artifactRefs.push(ref);
        },
        threadId,
        delegationId: runNextDelegation.id,
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
        delegationId: runNextDelegation.id,
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
        delegationId: runNextDelegation.id,
        task: runNextDelegation.task,
      },
    );
    const delegationAnnounce = readLatestAnnounce(laneOutputMessages, { delegationId: runNextDelegation.id });
    // The subagent node only records that the delegation ran (status 'progress');
    // whether it is complete is the orchestrator's call at delegationOutcomeDecision,
    // which upgrades the status to 'completed' when it hands off. The raw lane
    // messages are kept in place — handoff (or a later continuation) cleans them up.
    const updatedRunDelegationSummaries = updateRunDelegationSummaryResult(
      state.runDelegationSummaries,
      runNextDelegation.id,
      {
        status: 'progress',
        resultPreview: delegationAnnounce?.text ?? null,
      },
    );

    return {
      messages: laneOutputMessages,
      sessionCapabilityArtifacts: result.artifacts,
      runDelegationSummaries: updatedRunDelegationSummaries,
      runNextDelegation: null,
      taskActiveDelegation: {
        ...(state.taskActiveDelegation ?? createTaskActiveDelegation(runNextDelegation, transcriptRunId)),
        status: 'awaiting_decision' as const,
        resultPreview: delegationAnnounce?.text ?? null,
      },
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: authorizationRecorder.recorded,
    };
  };
}
