import type { RunnableConfig } from '@langchain/core/runnables';
import { createSubagent } from '../../../../subagent/createSubagent';
import type { OrchestratorStateType } from '../../state';
import { updateRunDelegationSummaryResult } from '../../delegations';
import {
  laneMessages,
  readLatestAnnounce,
  tagNewLaneMessages,
} from '../../messageLanes';
import {
  buildSubagentExecutionInstruction,
  collectGeneralOperations,
  resolveToolkitResources,
} from '../../subagentDispatch';
import type {
  MessageLane,
  OrchestratorConfig,
} from '../../types';
import { emitRuntimeEventToStreamWriter } from '../../../../utils/streamWriterEvents';
import { validateUniqueToolkitNames, validateUniqueToolNames } from '../../validation';
import { createToolAuthorizationRecorder } from '../authorization';
import {
  GENERAL_SUBAGENT_MAX_ITERATIONS,
} from '../constants';
import {
  generalLaneToolkits,
  getInvokeOptions,
  readThreadId,
  resolveActor,
} from '../config';
import {
  createTaskActiveDelegation,
  resolveDelegationTranscriptRunId,
} from '../decisions/delegationLifecycle';
import { withArtifactDiscoveryContext } from '../../artifacts/discovery';

export function createGeneralNode(params: {
  config: OrchestratorConfig;
  subagentContextWindowTokens: number | undefined;
}) {
  const { config, subagentContextWindowTokens } = params;

  // Node: general — reads tools from configurable
  return async function generalNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const {
      toolkits,
      execution,
      workdir,
      artifactDiscoveryRoot,
      runtimeEnvironment,
      reviewCapabilities,
      globalReviewPolicy,
    } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const toolkitList = generalLaneToolkits(toolkits ?? []);
    validateUniqueToolkitNames(toolkitList);
    const authorizationRecorder = createToolAuthorizationRecorder(state.sessionToolAuthorizations);
    const toolkitResources = await resolveToolkitResources(toolkitList, undefined, {
      models: config.models,
      actor,
      messages: state.messages,
      threadId: readThreadId(runnableConfig),
      execution,
      reviewCapabilities,
      globalReviewPolicy,
      toolAuthorizations: authorizationRecorder.active,
      recordToolAuthorization: authorizationRecorder.recordToolAuthorization,
      // Runtime events (authorization notices) surface as `custom` protocol
      // events on the root stream (#322); review emits from afterModel
      // middleware, where the writer is reachable at call time.
      emitRuntimeEvent: emitRuntimeEventToStreamWriter,
    });
    const toolList = [...toolkitResources.tools];
    validateUniqueToolNames(toolList);

    if (toolList.length === 0) {
      throw new Error('General path selected without any available tools');
    }

    const lane: MessageLane = 'general';
    const runNextDelegation = state.runNextDelegation;
    if (!runNextDelegation || runNextDelegation.lane !== 'general') {
      throw new Error('General node cannot run without a pending general delegation.');
    }
    const transcriptRunId = resolveDelegationTranscriptRunId(state, runNextDelegation);
    const scopedMessages = laneMessages(state.messages, lane, transcriptRunId, runNextDelegation.id);
    const executionInstruction = buildSubagentExecutionInstruction({
      lane,
      workdir: workdir ?? null,
    });
    const instructions = [
      '[配置]',
      `角色：「${actor.name}」`,
      workdir ? `工作目录：${workdir}` : null,
      workdir ? '相对路径默认相对于工作目录；只有在工具显式指定其他目录时，才偏离这个目录。' : null,
      runtimeEnvironment ? runtimeEnvironment : null,
      '',
      '使用可用工具完成任务，优先调用工具获取准确信息，再给出结果。',
    ].filter((line) => line !== null) as string[];

    const subagentMessages = withArtifactDiscoveryContext(scopedMessages, artifactDiscoveryRoot);
    const result = await createSubagent({
      model: config.models.subagent ?? config.models.act,
      tools: toolList,
      instructions: [executionInstruction, ...toolkitResources.instructions, ...instructions],
      operations: collectGeneralOperations(toolkitResources.toolkits),
      messages: subagentMessages,
      maxIterations: GENERAL_SUBAGENT_MAX_ITERATIONS,
      contextWindowTokens: subagentContextWindowTokens,
      middleware: toolkitResources.middleware,
      runnableConfig,
      signal: runnableConfig?.signal,
    });

    const outputMessages = tagNewLaneMessages(
      result.messages,
      subagentMessages,
      lane,
      transcriptRunId,
      result.completionReason,
      {
        delegationId: runNextDelegation.id,
        task: runNextDelegation.task,
      },
    );
    const delegationAnnounce = readLatestAnnounce(outputMessages, { delegationId: runNextDelegation.id });

    // See capabilityNode: status is 'progress' until the orchestrator judges it
    // complete at delegationOutcomeDecision; raw lane messages are kept in place.
    const updatedRunDelegationSummaries = updateRunDelegationSummaryResult(
      state.runDelegationSummaries,
      runNextDelegation.id,
      {
        status: 'progress',
        resultPreview: delegationAnnounce?.text ?? null,
      },
    );

    return {
      messages: outputMessages,
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
