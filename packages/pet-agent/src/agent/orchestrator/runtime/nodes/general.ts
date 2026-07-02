import { AIMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createSubagent } from '../../../../subagent/createSubagent';
import {
  buildEmptyRunCapabilitySearchState,
  type OrchestratorStateType,
} from '../../state';
import { updateRunDelegationResult } from '../../delegations';
import {
  laneMessages,
  readLatestAnnounce,
  stampMessageCreatedAtUtc,
  tagNewLaneMessages,
} from '../../messageLanes';
import {
  buildDelegationHandoffInstruction,
  collectGeneralOperations,
  resolveToolkitResources,
} from '../../subagentHandoff';
import { HUMAN_REVIEW_REJECTED_STOP_MESSAGE } from '../../review/reviewStop';
import type {
  MessageLane,
  OrchestratorConfig,
} from '../../types';
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

export function createGeneralNode(params: {
  config: OrchestratorConfig;
  subagentContextWindowTokens: number | undefined;
}) {
  const { config, subagentContextWindowTokens } = params;

  // Node: general — reads tools from configurable
  return async function generalNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const { toolkits, execution, workdir, runtimeEnvironment, onToolEvent, reviewCapabilities, globalReviewPolicy } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const toolkitList = generalLaneToolkits(toolkits ?? []);
    validateUniqueToolkitNames(toolkitList);
    const authorizationRecorder = createToolAuthorizationRecorder(state.sessionToolAuthorizations);
    const runControl: { humanReviewRejected?: { reason: string } } = {};
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
      emitRuntimeEvent: onToolEvent,
      runControl,
    });
    const toolList = [...toolkitResources.tools];
    validateUniqueToolNames(toolList);

    if (toolList.length === 0) {
      throw new Error('General path selected without any available tools');
    }

    const lane: MessageLane = 'general';
    const runPendingDelegation = state.runPendingDelegation;
    if (!runPendingDelegation || runPendingDelegation.lane !== 'general') {
      throw new Error('General node cannot run without a pending general delegation.');
    }
    const transcriptRunId = resolveDelegationTranscriptRunId(state, runPendingDelegation);
    const scopedMessages = laneMessages(state.messages, lane, transcriptRunId, runPendingDelegation.id);
    const handoffInstruction = buildDelegationHandoffInstruction({
      lane,
      task: runPendingDelegation.task,
      contextSummary: runPendingDelegation.contextSummary,
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

    const subagentMessages = scopedMessages;
    const result = await createSubagent({
      model: config.models.subagent ?? config.models.act,
      tools: toolList,
      instructions: [handoffInstruction, ...toolkitResources.instructions, ...instructions],
      operations: collectGeneralOperations(toolkitResources.toolkits),
      messages: subagentMessages,
      maxIterations: GENERAL_SUBAGENT_MAX_ITERATIONS,
      contextWindowTokens: subagentContextWindowTokens,
      checkpoint: config.checkpoint,
      runnableConfig,
      signal: runnableConfig?.signal,
      onToolEvent,
    });

    const outputMessages = tagNewLaneMessages(
      result.messages,
      subagentMessages.length,
      lane,
      transcriptRunId,
      result.completionReason,
      {
        delegationId: runPendingDelegation.id,
        task: runPendingDelegation.task,
      },
    );
    const delegationAnnounce = readLatestAnnounce(outputMessages, { delegationId: runPendingDelegation.id });
    const stoppedByHumanReviewReject = result.completionReason === 'human_rejected'
      || Boolean(runControl.humanReviewRejected);
    const resultPreview = stoppedByHumanReviewReject
      ? HUMAN_REVIEW_REJECTED_STOP_MESSAGE
      : delegationAnnounce?.text ?? null;

    // See capabilityNode: status is 'progress' until the orchestrator judges it
    // complete at delegationOutcomeDecision; raw lane messages are kept in place.
    const updatedRunDelegations = updateRunDelegationResult(
      state.runDelegations,
      runPendingDelegation.id,
      {
        status: stoppedByHumanReviewReject ? 'cancelled' : 'progress',
        resultPreview,
      },
    );

    if (stoppedByHumanReviewReject) {
      return {
        messages: [
          ...outputMessages,
          stampMessageCreatedAtUtc(new AIMessage(HUMAN_REVIEW_REJECTED_STOP_MESSAGE)),
        ],
        runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
        runDelegations: updatedRunDelegations,
        runPendingDelegation: null,
        runPendingFinalReply: 'inline' as const,
        runStopReason: 'human_review_rejected' as const,
        taskActiveDelegation: null,
        runIterationCount: state.runIterationCount + 1,
        sessionToolAuthorizations: authorizationRecorder.recorded,
      };
    }

    return {
      messages: outputMessages,
      runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
      runDelegations: updatedRunDelegations,
      runPendingDelegation: null,
      taskActiveDelegation: {
        ...(state.taskActiveDelegation ?? createTaskActiveDelegation(runPendingDelegation, transcriptRunId)),
        status: 'awaiting_decision' as const,
        resultPreview,
      },
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: authorizationRecorder.recorded,
    };
  };
}
