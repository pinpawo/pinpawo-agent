import { AIMessage, type BaseMessage } from '@langchain/core/messages';
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
} from '../../messageLanes';
import {
  buildAnswerInvocationMessages,
  type AnswerContextFacts,
} from '../../prompts';
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
    const { maxRunIterations } = getInvokeOptions(runnableConfig);
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
    const acceptedHandoffOutcome = handoffSource
      && acceptedOutcome === 'goal_done'
      ? acceptedOutcome
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
    const answerContextFacts = selectAnswerContextFacts({
      state,
      history,
      acceptedHandoffOutcome,
      awaitingUserInput,
      userInputRequiredContext,
      runIterationLimit: maxRunIterations
        ?? readRunIterationLimit(config.maxRunIterations)
        ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS,
    });
    const answerMessages = buildAnswerInvocationMessages({
      actor,
      history,
      userGoal: state.runUserGoal,
      contextFacts: answerContextFacts,
    });
    const response = await (config.models.answer ?? config.models.act).invoke(
      answerMessages,
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

export function selectAnswerContextFacts(params: {
  state: OrchestratorStateType;
  history: BaseMessage[];
  acceptedHandoffOutcome: 'goal_done' | null;
  awaitingUserInput: boolean;
  userInputRequiredContext?: string | null;
  runIterationLimit: number;
}): AnswerContextFacts {
  const hasUserGoal = Boolean(
    params.state.runUserGoal
    ?? readLatestHumanRequest(params.history),
  );
  if (params.awaitingUserInput) {
    return {
      mode: 'user_input_required',
      hasUserGoal,
      context: params.userInputRequiredContext?.trim() || null,
    };
  }
  if (params.acceptedHandoffOutcome === 'goal_done') {
    return { mode: 'goal_done', hasUserGoal };
  }
  if (params.state.runLatestDelegationOutcome === 'unavailable') {
    return {
      mode: 'blocked',
      hasUserGoal,
      reason: 'capability_unavailable',
      unfinishedTask: params.state.taskActiveDelegation?.task
        ?? params.state.runUserGoal?.objective
        ?? null,
      detail: null,
    };
  }

  const activeDelegation = params.state.taskActiveDelegation;
  if (activeDelegation && params.state.runIterationCount >= params.runIterationLimit) {
    return {
      mode: 'blocked',
      hasUserGoal,
      reason: 'iteration_limit',
      unfinishedTask: activeDelegation.task,
      detail: null,
    };
  }

  if (activeDelegation) {
    const completionReason = readLatestAnnounceCompletionReason(params.state.messages, {
      runId: activeDelegation.transcriptRunId,
      delegationId: activeDelegation.id,
    });
    return {
      mode: 'blocked',
      hasUserGoal,
      reason: completionReason === 'limit_reached' ? 'execution_limit' : 'incomplete',
      unfinishedTask: activeDelegation.task,
      detail: null,
    };
  }

  return { mode: 'direct', hasUserGoal };
}

function buildAnswerCleanup() {
  return {
    runNextDelegation: null,
    runCapabilityPlan: [],
    runIterationCount: 0,
    runLatestDelegationOutcome: null,
  };
}
