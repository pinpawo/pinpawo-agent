import { AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  buildHandoffArtifactRefs,
  formatHandoffArtifactRefsForMessage,
} from '../../artifacts/handoff';
import {
  observeAgentMessageSelection,
  queryAgentMessages,
  stampAgentMessageCreatedAt,
} from '../../../messages';
import {
  getMessageHandoffSource,
  readLatestAnnounce,
  readLatestAnnounceCompletionReason,
} from '../../delegation';
import { readLatestHumanRequest } from '../../conversationMessages';
import { getDelegationAnnounce } from '../../delegation';
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
} from '../config';
import { DEFAULT_ORCHESTRATOR_MAX_ITERATIONS } from '../constants';
import { invokeOrchestratorModel } from '../../modelInvocation';
import { readCapabilityNameFromLane } from '../decisions/delegationLifecycle';
import { snapshotRunTaskContinuation } from '../../runSupervisor/session';

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

export function createAnswerNode(config: OrchestratorConfig) {
  // Node: answer — the dedicated final-reply node. The decision nodes only route
  // here; this node synthesizes the user-facing reply from the FULL conversation
  // (not the clipped decision digest), so prior subagent results remain available
  // as faithful evidence instead of being re-fabricated.
  return async function answerNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    if (state.runRuntimeFailure === 'checkpoint_incompatible') {
      return {
        messages: [stampAgentMessageCreatedAt(
          new AIMessage(CHECKPOINT_INCOMPATIBLE_MESSAGE),
        )],
        taskActiveDelegation: null,
        ...buildAnswerCleanup(state),
      };
    }
    const { maxRunIterations } = getInvokeOptions(runnableConfig);
    // The full main conversation queue. Completed subagent results live here as
    // handoff copies (first-class, lane-free). A user-input-required result is
    // different: its lane remains resumable, so its announce and artifact refs
    // are appended only to this model invocation and never copied into main state.
    const mainSelection = queryAgentMessages(state.messages).main().select();
    observeAgentMessageSelection(
      'answer.main',
      mainSelection.diagnostics,
      runnableConfig,
    );
    const canonicalHistory = mainSelection.messages;
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
          lane: userInputRequiredDelegation.lane,
          runId: userInputRequiredDelegation.runId,
          delegationId: userInputRequiredDelegation.id,
        })
      : null;
    const userInputRequiredArtifactContext = userInputRequiredDelegation
      ? formatHandoffArtifactRefsForMessage(buildHandoffArtifactRefs(
          state.sessionCapabilityArtifacts,
          {
            runId: userInputRequiredDelegation.runId,
            delegationId: userInputRequiredDelegation.id,
          },
        ))
      : '';
    const awaitingUserInput = acceptedOutcome === 'user_input_required';
    const userInputRequiredContext = [
      userInputRequiredAnnounce?.result ?? '',
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
      userRequest: state.runUserRequest,
      contextFacts: answerContextFacts,
    });
    const [systemMessage, ...messages] = answerMessages;
    if (!SystemMessage.isInstance(systemMessage)) {
      throw new Error('Answer invocation requires a system message.');
    }
    const response = await invokeOrchestratorModel(
      config.models.answer ?? config.models.act,
      {
        systemMessage,
        messages,
      },
      runnableConfig,
    );
    if (!readMessageText(response).trim()) {
      const fallback = new AIMessage('我这边暂时没有可展示的回复，麻烦你再说一下需要我做什么。');
      return {
        messages: [stampAgentMessageCreatedAt(fallback)],
        ...buildAnswerCleanup(state),
      };
    }
    return {
      messages: [stampAgentMessageCreatedAt(response)],
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
  if (params.state.runLatestDelegationOutcome === 'supervisor_command_missing') {
    return {
      mode: 'blocked',
      hasUserRequest,
      acceptedResults: params.acceptedResults,
      reason: 'supervisor_command_missing',
      unfinishedTask: params.state.taskActiveDelegation?.task
        ?? params.state.runUserRequest
        ?? null,
      detail: null,
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
      lane: activeDelegation.lane,
      runId: activeDelegation.runId,
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

  return {
    mode: 'direct',
    hasUserRequest,
    acceptedResults: params.acceptedResults,
  };
}

function buildAnswerCleanup(state: OrchestratorStateType) {
  const continuation = state.runRuntimeFailure === null
    ? snapshotRunTaskContinuation({
        activeDelegation: state.taskActiveDelegation,
        supervisorSession: state.runSupervisorSession,
      })
    : null;
  return {
    runNextDelegation: null,
    runSupervisorSession: null,
    taskRunContinuation: continuation,
    runIterationCount: 0,
    runLatestDelegationOutcome: null,
    runUserInputRequest: null,
    runRuntimeFailure: null,
    runTerminalError: null,
  };
}
