import { AIMessage, SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  getMessageHandoffSource,
  mainConversationMessages,
  stampMessageCreatedAtUtc,
  type HandoffSource,
} from '../../messageLanes';
import { buildAnswerSystemPrompt } from '../../prompts';
import {
  buildEmptyRunCapabilitySearchState,
  type OrchestratorStateType,
} from '../../state';
import type { OrchestratorConfig } from '../../types';
import { readMessageText } from '../../utils';
import { readLatestAnnounceCompletionReason } from '../../messageLanes';
import {
  getInvokeOptions,
  resolveActor,
} from '../config';
import { DEFAULT_ORCHESTRATOR_MAX_ITERATIONS } from '../constants';

export function createAnswerNode(config: OrchestratorConfig) {
  // Node: answer — the dedicated final-reply node. The decision nodes only route
  // here; this node synthesizes the user-facing reply from the FULL conversation
  // (not the clipped decision digest), so prior subagent results are reproduced
  // faithfully instead of being re-fabricated.
  return async function answerNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const { workdir, runtimeEnvironment, maxRunIterations } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    // The full main conversation queue. Subagent results already live here as
    // handoff copies (first-class, lane-free), so the answer node just reads main
    // — no need to dig announces out of lanes. Context-compaction summaries are
    // kept (mainConversationMessages only drops lane-tagged messages), since after
    // compaction a summary may be the only surviving record of older results.
    const history = mainConversationMessages(state.messages);
    const latestMainMessage = history.at(-1);
    const latestHandoffSource = latestMainMessage
      ? getMessageHandoffSource(latestMainMessage)
      : null;
    const terminalContext = buildTerminalAnswerContext(
      state,
      maxRunIterations ?? config.maxRunIterations ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS,
    );
    const response = await config.models.act.invoke(
      [
        new SystemMessage(buildAnswerSystemPrompt({ actor, workdir, runtimeEnvironment })),
        ...history,
        ...(latestHandoffSource
          ? [new SystemMessage(buildDelegationCompletionAnswerContext(latestHandoffSource))]
          : []),
        ...(terminalContext ? [new SystemMessage(terminalContext)] : []),
      ],
      runnableConfig,
    );
    if (!readMessageText(response).trim()) {
      const fallback = new AIMessage('我这边暂时没有可展示的回复，麻烦你再说一下需要我做什么。');
      return {
        messages: [stampMessageCreatedAtUtc(fallback)],
        ...buildAnswerCleanup(),
      };
    }
    return {
      messages: [stampMessageCreatedAtUtc(response)],
      ...buildAnswerCleanup(),
    };
  };
}

function buildAnswerCleanup() {
  return {
    runNextDelegation: null,
    runPendingTask: null,
    runTaskPlanDraft: null,
    runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
    runIterationCount: 0,
  };
}

function buildTerminalAnswerContext(state: OrchestratorStateType, runIterationLimit: number) {
  const activeDelegation = state.taskActiveDelegation;
  if (activeDelegation && state.runIterationCount >= runIterationLimit) {
    return [
      '当前 task loop 已达到本 run 的迭代上限。',
      `当前 delegated task 仍保留为待续跑状态：${activeDelegation.task}`,
      '请基于已有对话如实说明当前进度与限制，不要声称目标已经完成。',
    ].join('\n');
  }

  if (activeDelegation) {
    const completionReason = readLatestAnnounceCompletionReason(state.messages, {
      runId: activeDelegation.transcriptRunId,
      delegationId: activeDelegation.id,
    });
    if (completionReason === 'limit_reached') {
      return [
        '当前 capability subagent 已达到自身执行限制，尚无可交接的完成结果。',
        `当前 delegated task 仍保留为待续跑状态：${activeDelegation.task}`,
        '请基于已有对话如实说明当前进度与限制，不要声称目标已经完成。',
      ].join('\n');
    }

    return [
      '当前 delegated task 尚无可交接的完成结果，任务边界没有完成切换。',
      `当前 delegated task 仍保留为待续跑状态：${activeDelegation.task}`,
      '请基于已有对话如实说明当前状态，不要声称目标已经完成。',
    ].join('\n');
  }

  if (state.runPendingTask && !state.runNextDelegation) {
    return [
      '当前 task 没有匹配到可执行的 capability subagent。',
      `未执行的 task：${state.runPendingTask.task}`,
      '请如实说明当前无法执行这一步，不要编造执行结果。',
    ].join('\n');
  }

  return null;
}

function buildDelegationCompletionAnswerContext(source: HandoffSource) {
  return [
    '当前最终回复模式：delegation completion acknowledgement。',
    '刚刚跑完了一次 delegation task。请看近期消息记录，简短总结本次 delegation task 的完成情况。',
    '回复重点是 orchestrator/delegation 层面的完成状态：做了哪类交接、是否已经完成、是否需要用户继续指示。',
    '不要把回复写成对任务处理结果正文的二次总结；不要重复列出 handoff 中的完整结论、数据、文件内容或执行细节。',
    `delegation 来源：${source.handoffFrom}`,
    ...(source.runId ? [`delegation run：${source.runId}`] : []),
    ...(source.task ? [`delegated task：${source.task}`] : []),
  ].join('\n');
}
