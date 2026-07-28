import { AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  buildHandoffArtifactRefs,
  formatHandoffArtifactRefsForMessage,
} from '../../artifacts/handoff';
import {
  getMessageHandoffSource,
  mainConversationMessages,
  readLatestAnnounce,
  readLatestAnnounceCompletionReason,
  readLatestHumanRequest,
  stampMessageCreatedAtUtc,
  type HandoffSource,
} from '../../messageLanes';
import { buildAnswerSystemPrompt } from '../../prompts';
import type { AcceptedDelegationOutcome } from '../../schemas';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { readMessageText } from '../../utils';
import {
  getInvokeOptions,
  readRunIterationLimit,
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
    // The full main conversation queue. Completed subagent results live here as
    // handoff copies (first-class, lane-free). A user-input-required result is
    // different: its lane remains resumable, so its announce and artifact refs
    // are appended only to this model invocation and never copied into main state.
    const history = mainConversationMessages(state.messages);
    const latestMainMessage = history.at(-1);
    const handoffSource = latestMainMessage
      ? getMessageHandoffSource(latestMainMessage)
      : null;
    const acceptedOutcome = state.runLatestDelegationOutcome;
    const acceptedHandoff = handoffSource
      && acceptedOutcome
      && acceptedOutcome !== 'user_input_required'
      ? {
          source: handoffSource,
          outcome: acceptedOutcome,
        }
      : null;
    const userInputRequiredDelegation = acceptedOutcome === 'user_input_required'
      ? state.taskActiveDelegation
      : null;
    const userInputRequiredAnnounce = userInputRequiredDelegation
      ? readLatestAnnounce(state.messages, {
          runId: userInputRequiredDelegation.transcriptRunId,
          delegationId: userInputRequiredDelegation.id,
        })
      : null;
    const userInputRequiredArtifactContext = userInputRequiredDelegation
      ? formatHandoffArtifactRefsForMessage(buildHandoffArtifactRefs(
          state.sessionCapabilityArtifacts,
          {
            runId: userInputRequiredDelegation.transcriptRunId,
            delegationId: userInputRequiredDelegation.id,
          },
        ))
      : '';
    const awaitingUserInput = acceptedOutcome === 'user_input_required';
    const userInputRequiredContext = [
      userInputRequiredAnnounce?.text ?? '',
      userInputRequiredArtifactContext,
    ].join('').trim();
    const answerHistory = userInputRequiredContext
      ? [...history, new AIMessage(userInputRequiredContext)]
      : history;
    const terminalContext = awaitingUserInput
      ? null
      : buildTerminalAnswerContext(
          state,
          maxRunIterations
            ?? readRunIterationLimit(config.maxRunIterations)
            ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS,
        );
    const answerMessages = buildAnswerInvocationMessages({
      actor,
      history: answerHistory,
      workdir,
      runtimeEnvironment,
      acceptedHandoff,
      awaitingUserInput,
      terminalContext,
    });
    const response = await config.models.act.invoke(answerMessages, runnableConfig);
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

export function buildAnswerInvocationMessages(params: {
  actor: NonNullable<OrchestratorConfig['actor']>;
  history: BaseMessage[];
  workdir?: string;
  runtimeEnvironment?: string;
  acceptedHandoff?: {
    source: HandoffSource;
    outcome: Exclude<AcceptedDelegationOutcome, 'user_input_required'>;
  } | null;
  awaitingUserInput?: boolean;
  terminalContext?: string | null;
}): BaseMessage[] {
  const hasUserGoal = Boolean(readLatestHumanRequest(params.history));
  const replyContext = params.awaitingUserInput
    ? buildUserInputRequiredAnswerContext(hasUserGoal)
    : params.acceptedHandoff?.outcome === 'goal_done'
      ? buildDelegationCompletionAnswerContext(params.acceptedHandoff.source, hasUserGoal)
      : params.acceptedHandoff?.outcome === 'task_done'
        ? buildTaskResultAnswerContext(hasUserGoal)
        : hasUserGoal ? buildAnswerReplyContext() : null;
  const systemContext = [
    buildAnswerSystemPrompt({
      actor: params.actor,
      workdir: params.workdir,
      runtimeEnvironment: params.runtimeEnvironment,
    }),
    replyContext,
    params.terminalContext,
  ].filter((value): value is string => Boolean(value)).join('\n\n');
  return [
    new SystemMessage(systemContext),
    ...params.history,
  ];
}

function buildAnswerReplyContext() {
  return [
    '本次用户目标：',
    '主对话中最近一条用户消息所表达的目标。',
    '',
    '本次回复目标：',
    '根据主对话已有信息完成该用户目标。',
  ].join('\n');
}

function buildTaskResultAnswerContext(hasUserGoal: boolean) {
  return [
    ...(hasUserGoal ? [
      '本次用户目标：',
      '主对话中最近一条用户消息所表达的目标。',
      '',
    ] : []),
    '当前状态：',
    '上一条消息是本轮执行得到的结果。',
    '',
    '本次回复目标：',
    '向用户呈现上一条结果中的具体发现，并结合本次用户目标说明结论。',
  ].join('\n');
}

function buildAnswerCleanup() {
  return {
    runNextDelegation: null,
    runPendingTask: null,
    runCapabilityPlan: [],
    runIterationCount: 0,
    runLatestDelegationOutcome: null,
  };
}

function buildUserInputRequiredAnswerContext(hasUserGoal: boolean) {
  return [
    ...(hasUserGoal ? [
      '本次用户目标（尚未完成）：',
      '主对话中最近一条用户消息所表达的目标。',
      '',
    ] : []),
    '当前状态：',
    '上一条消息呈现了目前已经取得的结果；继续完成目标需要用户补充、澄清或确认。',
    '',
    '本次回复目标：',
    '根据上一条结果说明已经取得的进展和尚未完成的部分，并询问继续所需的信息。',
  ].join('\n');
}

function buildTerminalAnswerContext(state: OrchestratorStateType, runIterationLimit: number) {
  const activeDelegation = state.taskActiveDelegation;
  if (activeDelegation && state.runIterationCount >= runIterationLimit) {
    return [
      '当前状态：',
      '本次处理已达到执行上限，目标尚未完成。',
      `尚未完成的工作：${activeDelegation.task}`,
      '',
      '本次回复目标：',
      '根据已有信息说明当前进度、执行限制和待继续的工作。',
    ].join('\n');
  }

  if (activeDelegation) {
    const completionReason = readLatestAnnounceCompletionReason(state.messages, {
      runId: activeDelegation.transcriptRunId,
      delegationId: activeDelegation.id,
    });
    if (completionReason === 'limit_reached') {
      return [
        '当前状态：',
        '当前执行已达到限制，目标尚未完成，暂时没有可交付结果。',
        `尚未完成的工作：${activeDelegation.task}`,
        '',
        '本次回复目标：',
        '根据已有信息说明当前进度、执行限制和待继续的工作。',
      ].join('\n');
    }

    return [
      '当前状态：',
      '当前工作尚未完成，暂时没有可交付结果。',
      `尚未完成的工作：${activeDelegation.task}`,
      '',
      '本次回复目标：',
      '根据已有信息说明当前状态和待继续的工作。',
    ].join('\n');
  }

  if (state.runPendingTask && !state.runNextDelegation) {
    const unavailableReason = state.runPendingTask.contextSummary?.trim();
    return [
      '当前状态：',
      '当前没有可用于执行这项工作的能力，目标尚未完成。',
      `尚未执行的工作：${state.runPendingTask.task}`,
      ...(unavailableReason
        ? [`不可执行的原因：${unavailableReason}`]
        : []),
      '',
      '本次回复目标：',
      '说明当前无法执行的工作、具体原因以及仍需完成的内容。',
    ].join('\n');
  }

  return null;
}

function buildDelegationCompletionAnswerContext(
  source: HandoffSource,
  hasUserGoal = false,
) {
  const completedWork = source.task?.trim() || '本次工作';
  return [
    ...(hasUserGoal ? [
      '本次用户目标（已完成）：',
      '主对话中最近一条用户消息所表达的目标。',
      '',
    ] : []),
    '当前状态：',
    '上一条消息已经完整呈现工作结果。',
    '',
    '本次回复目标：',
    '逐字输出以下一行：',
    `${JSON.stringify(completedWork)}已完成。如需继续，请告诉我。`,
  ].join('\n');
}
