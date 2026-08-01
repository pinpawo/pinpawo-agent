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
  collectToolkitOperations,
  resolveToolkitExecution,
} from '../../subagentDispatch';
import type {
  MessageLane,
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
  createTaskActiveDelegation,
  readCapabilityNameFromLane,
  resolveDelegationTranscriptRunId,
} from '../decisions/delegationLifecycle';
import {
  hasArtifactDiscoveryToolkit,
  withArtifactDiscoveryContext,
} from '../../artifacts/discovery';

function buildCapabilityActorContext(actor: ReturnType<typeof resolveActor>): string {
  return [
    '[角色]',
    `角色：「${actor.name}」`,
    actor.species ? `物种：${actor.species}` : null,
    actor.stage ? `阶段：${actor.stage}` : null,
    actor.personality ? `性格：${actor.personality}` : null,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

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
    const lane: MessageLane = runNextDelegation.lane;
    const transcriptRunId = resolveDelegationTranscriptRunId(state, runNextDelegation);
    const scopedMessages = laneMessages(state.messages, lane, transcriptRunId, runNextDelegation.id);
    const threadId = readThreadId(runnableConfig);

    const authorizationRecorder = createToolAuthorizationRecorder(
      state.sessionToolAuthorizations.generation === registry.authorizationGeneration
        ? state.sessionToolAuthorizations.records
        : [],
    );
    const artifactRefs: CapabilityArtifactRef[] = [];
    const toolkitContext = {
      models: config.models,
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
    const usedResolvedToolkitExecution = await resolveToolkitExecution(
      toolkitList,
      undefined,
      toolkitContext,
    );
    const selectedTools = usedResolvedToolkitExecution.tools;
    const canExploreArtifacts = hasArtifactDiscoveryToolkit(
      usedResolvedToolkitExecution.toolkits,
    );
    const executionInstruction = buildSubagentExecutionInstruction({
      lane,
      workdir: workdir ?? null,
    });

    const subagentMessages = withArtifactDiscoveryContext(
      scopedMessages,
      canExploreArtifacts,
    );
    const subagentInput: SubagentRunInput = {
      model: config.models.subagent ?? config.models.act,
      tools: selectedTools,
      promptSections: [
        {
          id: 'delegation-context',
          owner: 'framework',
          content: executionInstruction,
        },
        {
          id: 'actor-context',
          owner: 'framework',
          content: buildCapabilityActorContext(actor),
        },
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
        ...(runtimeEnvironment
          ? [{
              id: 'runtime-environment',
              owner: 'host',
              content: runtimeEnvironment,
            }]
          : []),
      ],
      operations: collectToolkitOperations(usedResolvedToolkitExecution.toolkits),
      messages: subagentMessages,
      maxIterations: CAPABILITY_SUBAGENT_MAX_ITERATIONS,
      contextWindowTokens: subagentContextWindowTokens,
      generationReserveTokens: subagentGenerationReserveTokens,
      middleware: usedResolvedToolkitExecution.middleware,
      runtimeContext: {
        executionScope: {
          threadId,
          runId: transcriptRunId,
          delegationId: runNextDelegation.id,
        },
      },
      runnableConfig,
      signal: runnableConfig?.signal,
      artifacts: artifactRefs,
    };
    let result = await createSubagent(subagentInput);

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
        runId: transcriptRunId,
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

    const laneOutputMessages = tagNewLaneMessages(
      result.messages,
      subagentInput.messages,
      lane,
      transcriptRunId,
      result.completionReason,
      {
        delegationId: runNextDelegation.id,
        task: runNextDelegation.task,
        announceMessageId: result.announceMessageId,
      },
    );
    const delegationAnnounce = readLatestAnnounce(laneOutputMessages, { delegationId: runNextDelegation.id });
    const interrupted = result.completionReason === 'interrupted';
    const currentResultPreview = state.taskActiveDelegation?.resultPreview ?? null;
    const resultPreview = interrupted
      ? currentResultPreview
      : delegationAnnounce?.text ?? null;
    // The subagent node only records that the delegation ran (status 'progress');
    // whether it is complete is the orchestrator's call at delegationOutcomeDecision,
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

    return {
      messages: laneOutputMessages,
      sessionCapabilityArtifacts: result.artifacts,
      runDelegationSummaries: updatedRunDelegationSummaries,
      runNextDelegation: null,
      taskActiveDelegation: {
        ...(state.taskActiveDelegation ?? createTaskActiveDelegation(runNextDelegation, transcriptRunId)),
        status: interrupted ? 'pending' as const : 'awaiting_decision' as const,
        resultPreview,
      },
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: {
        generation: registry.authorizationGeneration,
        records: authorizationRecorder.active,
      },
    };
  };
}
