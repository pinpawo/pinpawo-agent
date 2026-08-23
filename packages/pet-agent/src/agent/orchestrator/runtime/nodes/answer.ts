import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  buildHandoffArtifactRefs,
  formatHandoffArtifactRefsForMessage,
} from '../../artifacts/handoff';
import {
  getPinpetMeta,
  getMessageHandoffSource,
  mainConversationMessages,
  readLatestAnnounce,
  readLatestAnnounceCompletionReason,
  readLatestHumanRequest,
  stampMessageCreatedAtUtc,
} from '../../messageLanes';
import { CAPABILITY_PLANNER_MESSAGE_SOURCE } from '../../capabilityPlanner/messageContext';
import { getDelegationAnnounce } from '../../delegationAnnounce';
import {
  buildAnswerInvocationMessages,
  type AnswerAcceptedResult,
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
import { readCapabilityNameFromLane } from '../decisions/delegationLifecycle';

type AcceptedRunResultsProjection = {
  history: BaseMessage[];
  results: AnswerAcceptedResult[];
};

export function projectAcceptedRunResults(params: {
  state: OrchestratorStateType;
  history: BaseMessage[];
}): AcceptedRunResultsProjection {
  const selectedMessages = new Set<BaseMessage>();
  const results: AnswerAcceptedResult[] = [];

  for (const delegation of params.state.runDelegationSummaries) {
    if (delegation.status !== 'completed') continue;
    const matchingHandoffs = params.history.filter((message) => {
      const source = getMessageHandoffSource(message);
      return source?.delegationId === delegation.id
        && source.handoffFrom === delegation.lane;
    });
    const handoffMessage = matchingHandoffs.at(-1);
    if (!handoffMessage) continue;
    const source = getMessageHandoffSource(handoffMessage);
    if (!source) continue;
    const announce = getDelegationAnnounce(handoffMessage);
    const artifactRefs = buildHandoffArtifactRefs(
      params.state.sessionCapabilityArtifacts,
      {
        delegationId: delegation.id,
        runId: source.runId,
        capabilityId: readCapabilityNameFromLane(delegation.lane),
      },
    );
    const result = announce?.result ?? readMessageText(handoffMessage);
    if (!result) continue;
    for (const matchingHandoff of matchingHandoffs) {
      selectedMessages.add(matchingHandoff);
    }
    results.push({
      task: source.task ?? delegation.task,
      result,
      artifactRefs,
    });
  }

  return {
    history: params.history.filter((message) => !selectedMessages.has(message)),
    results,
  };
}

export const CHECKPOINT_INCOMPATIBLE_MESSAGE =
  '这个任务由旧版本创建，当前版本无法继续。请重新发起或重述任务。';

function readLatestPlannerIncompleteOutput(state: OrchestratorStateType) {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    const meta = getPinpetMeta(message);
    if (meta.source !== CAPABILITY_PLANNER_MESSAGE_SOURCE
      || meta.traceId !== state.traceId
      || !AIMessage.isInstance(message)
      || message.tool_calls?.length) {
      continue;
    }
    const content = readMessageText(message).trim();
    if (content) return content;
  }
  return null;
}

export function createAnswerNode(config: OrchestratorConfig) {
  // Node: answer — the dedicated final-reply node. The decision nodes only route
  // here; this node synthesizes the user-facing reply from the FULL conversation
  // (not the clipped decision digest), so prior subagent results remain available
  // as faithful evidence instead of being re-fabricated.
  return async function answerNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    if (state.runRuntimeFailure === 'checkpoint_incompatible') {
      return {
        messages: [stampMessageCreatedAtUtc(
          new AIMessage(CHECKPOINT_INCOMPATIBLE_MESSAGE),
        )],
        taskActiveDelegation: null,
        ...buildAnswerCleanup(state),
      };
    }
    const { maxRunIterations } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    // The full main conversation queue. Completed subagent results live here as
    // handoff copies (first-class, lane-free). A user-input-required result is
    // different: its lane remains resumable, so its announce and artifact refs
    // are appended only to this model invocation and never copied into main state.
    const canonicalHistory = mainConversationMessages(state.messages);
    const acceptedResultsProjection = projectAcceptedRunResults({
      state,
      history: canonicalHistory,
    });
    const history = acceptedResultsProjection.history;
    const acceptedOutcome = state.runLatestDelegationOutcome;
    const acceptedHandoffOutcome = acceptedResultsProjection.results.length > 0
      && acceptedOutcome === 'goal_done'
      ? acceptedOutcome
      : null;
    const userInputRequiredDelegation = acceptedOutcome === 'user_input_required'
      ? state.taskActiveDelegation
      : null;
    const userInputRequiredAnnounce = userInputRequiredDelegation
      ? readLatestAnnounce(state.messages, {
          transcriptRunId: userInputRequiredDelegation.transcriptRunId,
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
      acceptedResults: acceptedResultsProjection.results,
      awaitingUserInput,
      userInputQuestion: state.runUserInputRequest?.question ?? null,
      userInputRequiredContext,
      runIterationLimit: maxRunIterations
        ?? readRunIterationLimit(config.maxRunIterations)
        ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS,
    });
    const answerMessages = buildAnswerInvocationMessages({
      actor,
      userRequest: state.runUserRequest,
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
        ...buildAnswerCleanup(state),
      };
    }
    return {
      messages: [stampMessageCreatedAtUtc(response)],
      ...buildAnswerCleanup(state),
    };
  };
}

export function selectAnswerContextFacts(params: {
  state: OrchestratorStateType;
  history: BaseMessage[];
  acceptedHandoffOutcome: 'goal_done' | null;
  acceptedResults: readonly AnswerAcceptedResult[];
  awaitingUserInput: boolean;
  userInputQuestion?: string | null;
  userInputRequiredContext?: string | null;
  runIterationLimit: number;
}): AnswerContextFacts {
  const hasUserRequest = Boolean(
    params.state.runUserRequest
    ?? readLatestHumanRequest(params.history),
  );
  if (params.awaitingUserInput) {
    return {
      mode: 'user_input_required',
      hasUserRequest,
      acceptedResults: params.acceptedResults,
      question: params.userInputQuestion?.trim() || null,
      context: params.userInputRequiredContext?.trim() || null,
    };
  }
  if (params.acceptedHandoffOutcome === 'goal_done') {
    return {
      mode: 'goal_done',
      hasUserRequest,
      acceptedResults: params.acceptedResults,
    };
  }
  if (params.state.runLatestDelegationOutcome === 'unavailable') {
    return {
      mode: 'blocked',
      hasUserRequest,
      acceptedResults: params.acceptedResults,
      reason: 'capability_unavailable',
      unfinishedTask: params.state.taskActiveDelegation?.task
        ?? params.state.runUserRequest
        ?? null,
      detail: null,
    };
  }
  if (params.state.runLatestDelegationOutcome === 'planner_incomplete') {
    return {
      mode: 'blocked',
      hasUserRequest,
      acceptedResults: params.acceptedResults,
      reason: 'planner_incomplete',
      unfinishedTask: params.state.taskActiveDelegation?.task
        ?? params.state.runUserRequest
        ?? null,
      // Ordinary Planner text is not a control action, but it is still useful
      // evidence for Answer to explain why planning stopped.
      detail: readLatestPlannerIncompleteOutput(params.state),
    };
  }

  const activeDelegation = params.state.taskActiveDelegation;
  if (activeDelegation && params.state.runIterationCount >= params.runIterationLimit) {
    return {
      mode: 'blocked',
      hasUserRequest,
      acceptedResults: params.acceptedResults,
      reason: 'iteration_limit',
      unfinishedTask: activeDelegation.task,
      detail: null,
    };
  }

  if (activeDelegation) {
    const completionReason = readLatestAnnounceCompletionReason(params.state.messages, {
      transcriptRunId: activeDelegation.transcriptRunId,
      delegationId: activeDelegation.id,
    });
    return {
      mode: 'blocked',
      hasUserRequest,
      acceptedResults: params.acceptedResults,
      reason: completionReason === 'limit_reached' ? 'execution_limit' : 'incomplete',
      unfinishedTask: activeDelegation.task,
      detail: null,
    };
  }

  return { mode: 'direct', hasUserRequest, acceptedResults: params.acceptedResults };
}

function buildAnswerCleanup(state: OrchestratorStateType) {
  const preserveBoundaryPlan = state.runLatestDelegationOutcome === 'planner_incomplete'
    && state.runRuntimeFailure === null
    && state.taskActiveDelegation !== null;
  return {
    runNextDelegation: null,
    runCapabilityPlan: preserveBoundaryPlan ? [...state.runCapabilityPlan] : [],
    runIterationCount: 0,
    runLatestDelegationOutcome: null,
    runUserInputRequest: null,
    runRuntimeFailure: null,
  };
}
