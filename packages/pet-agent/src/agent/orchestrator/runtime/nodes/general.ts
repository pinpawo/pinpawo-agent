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
  resolveToolkitExecution,
  selectCapabilityTools,
} from '../../subagentDispatch';
import type {
  MessageLane,
  OrchestratorConfig,
} from '../../types';
import { emitRuntimeEventToStreamWriter } from '../../../../utils/streamWriterEvents';
import { validateUniqueToolNames } from '../../validation';
import { createToolAuthorizationRecorder } from '../authorization';
import {
  GENERAL_SUBAGENT_MAX_ITERATIONS,
} from '../constants';
import {
  getInvokeRegistry,
  getInvokeOptions,
  resolveActor,
} from '../config';
import {
  createTaskActiveDelegation,
  resolveDelegationTranscriptRunId,
} from '../decisions/delegationLifecycle';
import {
  hasArtifactDiscoveryTools,
  withArtifactDiscoveryContext,
} from '../../artifacts/discovery';

export function createGeneralNode(params: {
  config: OrchestratorConfig;
  subagentContextWindowTokens: number | undefined;
}) {
  const { config, subagentContextWindowTokens } = params;

  // Node: general — reads tools from configurable
  return async function generalNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const {
      workdir,
      artifactDiscoveryRoot,
      artifactDiscoveryToolkit,
      runtimeEnvironment,
      reviewCapabilities,
      globalReviewPolicy,
    } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const registry = getInvokeRegistry(runnableConfig);
    const toolkitList = [...registry.general.toolkits];
    const runNextDelegation = state.runNextDelegation;
    if (!runNextDelegation || runNextDelegation.lane !== 'general') {
      throw new Error('General node cannot run without a pending general delegation.');
    }
    const authorizationRecorder = createToolAuthorizationRecorder(state.sessionToolAuthorizations);
    const toolkitExecution = await resolveToolkitExecution(
      toolkitList,
      toolkitList.map(({ name }) => name),
      {
        models: config.models,
        actor,
        messages: state.messages,
        reviewContext: {
          task: runNextDelegation.task,
          workdir: workdir ?? null,
        },
        reviewCapabilities,
        globalReviewPolicy,
        toolAuthorizations: authorizationRecorder.active,
        recordToolAuthorization: authorizationRecorder.recordToolAuthorization,
        // Runtime events (authorization notices) surface as `custom` protocol
        // events on the root stream (#322); review emits from afterModel
        // middleware, where the writer is reachable at call time.
        emitRuntimeEvent: emitRuntimeEventToStreamWriter,
      },
    );
    const toolList = selectCapabilityTools(toolkitExecution.tools);
    validateUniqueToolNames(toolList);

    if (toolList.length === 0) {
      throw new Error('General path selected without any available tools');
    }

    const lane: MessageLane = 'general';
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

    const canExploreArtifacts = Boolean(
      artifactDiscoveryRoot
      && artifactDiscoveryToolkit
      && hasArtifactDiscoveryTools(
        toolList,
        artifactDiscoveryToolkit.tools.map((definition) => definition.tool),
      ),
    );
    const subagentMessages = withArtifactDiscoveryContext(
      scopedMessages,
      canExploreArtifacts ? artifactDiscoveryRoot : null,
    );
    const result = await createSubagent({
      model: config.models.subagent ?? config.models.act,
      tools: toolList,
      promptSections: [
        {
          id: 'delegation-context',
          owner: 'framework',
          content: executionInstruction,
        },
        ...toolkitExecution.toolkits
          .filter((toolkit) => Boolean(toolkit.instructions?.trim()))
          .map((toolkit) => ({
            id: `toolkit:${toolkit.name}`,
            owner: toolkit.name,
            content: toolkit.instructions as string,
          })),
        {
          id: 'general-executor',
          owner: 'framework',
          content: instructions.join('\n'),
        },
      ],
      operations: collectGeneralOperations(toolkitExecution.toolkits),
      messages: subagentMessages,
      maxIterations: GENERAL_SUBAGENT_MAX_ITERATIONS,
      contextWindowTokens: subagentContextWindowTokens,
      middleware: toolkitExecution.middleware,
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
        announceMessageId: result.announceMessageId,
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
