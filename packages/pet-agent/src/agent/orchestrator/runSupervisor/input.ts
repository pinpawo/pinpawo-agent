import { hasRunHumanMessage } from '../conversationMessages';
import {
  queryAgentMessages,
  getAgentMessageMetadata,
  type AgentMessageSelectionDiagnostics,
} from '../../messages';
import {
  getDelegationAnnounce,
} from '../delegation';
import type { OrchestratorStateType } from '../state';
import { readCapabilityNameFromLane } from '../runtime/decisions/delegationLifecycle';
import type {
  RunSupervisorDispatch,
  RunSupervisorInput,
  RunSupervisorRuntimeState,
} from './runner';
import type { RunSupervisorSessionState } from './session';

export function isSupervisorDispatch(
  input: OrchestratorStateType | RunSupervisorDispatch,
): input is RunSupervisorDispatch {
  return 'supervisorState' in input && input.mode === 'entry';
}

export function supervisorRuntimeStateFromRoot(
  state: OrchestratorStateType,
): RunSupervisorRuntimeState {
  if (!state.runUserRequest) {
    throw new Error('Run Supervisor requires runUserRequest.');
  }
  return {
    runId: state.runId,
    traceId: state.traceId,
    runUserRequest: state.runUserRequest,
    runDelegationSummaries: state.runDelegationSummaries,
    runSupervisorSession: state.runSupervisorSession,
  };
}

export function buildRunSupervisorInput(params: {
  nodeInput: OrchestratorStateType | RunSupervisorDispatch;
  catalog: RunSupervisorInput['catalog'];
  supervisorSession: RunSupervisorSessionState;
}): {
  input: RunSupervisorInput;
  state: RunSupervisorRuntimeState;
  messageSelections: Array<{
    location: string;
    diagnostics: AgentMessageSelectionDiagnostics;
  }>;
} {
  const { nodeInput, catalog, supervisorSession } = params;
  if (isSupervisorDispatch(nodeInput) || !nodeInput.taskActiveDelegation) {
    const state = isSupervisorDispatch(nodeInput) ? nodeInput.supervisorState : supervisorRuntimeStateFromRoot(nodeInput);
    const mainSelection = queryAgentMessages(nodeInput.messages).main().select();
    return {
      state,
      messageSelections: [{
        location: 'run_supervisor.entry',
        diagnostics: mainSelection.diagnostics,
      }],
      input: {
        mode: 'entry',
        inputId: hasRunHumanMessage(mainSelection.messages, state.runId)
          ? `human:${state.runId}` : `run_started:${state.runId}`,
        traceId: state.traceId,
        runId: state.runId,
        userRequest: state.runUserRequest,
        messages: mainSelection.messages,
        deliveries: isSupervisorDispatch(nodeInput) ? [] : (nodeInput.sessionDelegationResults ?? [])
          .filter((delivery) => delivery.scope.traceId === state.traceId),
        activeDelegation: null,
        remainingPlan: supervisorSession.plan,
        catalog,
        capabilityDisclosure: supervisorSession.capabilityDisclosure,
        supervisorSession,
      },
    };
  }

  const state = nodeInput;
  const activeDelegation = state.taskActiveDelegation;
  if (!activeDelegation) {
    throw new Error('Boundary Supervisor requires taskActiveDelegation.');
  }
  const capability = readCapabilityNameFromLane(activeDelegation.lane);
  if (!capability) {
    throw new Error('Boundary Supervisor active delegation has an invalid lane.');
  }
  const activeScope = {
    lane: activeDelegation.lane,
    runId: activeDelegation.runId,
    delegationId: activeDelegation.id,
  };
  const deliveries = (state.sessionDelegationResults ?? []).filter((delivery) =>
    delivery.scope.traceId === state.traceId);
  const currentDeliveries = deliveries.filter((delivery) =>
    delivery.scope.delegationId === activeScope.delegationId
    && delivery.scope.runId === activeScope.runId
    && delivery.scope.lane === activeScope.lane);
  const mainSelection = queryAgentMessages(state.messages.filter((message) =>
    getAgentMessageMetadata(message).traceId === state.traceId)).main().select();
  const latestAnnounce = mainSelection.messages.flatMap((message) => {
    const announce = getDelegationAnnounce(message);
    return announce && announce.sourceLane === activeScope.lane
      && announce.runId === activeScope.runId && announce.delegationId === activeScope.delegationId
      ? [announce] : [];
  }).at(-1);
  // A new run or an explicitly queued pause-resume message is user input.
  // Execution evidence alone must not reopen plan adjustment.
  const resumedUserMessage = state.runSupervisorUserMessageId
    ? mainSelection.messages.find((message) => message.id === state.runSupervisorUserMessageId
      && message._getType() === 'human') : undefined;
  const userInputId = `human:${resumedUserMessage?.id ?? state.runId}`;
  const freshTurn = resumedUserMessage
    ? supervisorSession.handledUserInputId !== userInputId
    : !supervisorSession.handledUserInputId
      && state.runActiveDelegationTransition === 'resume_active'
      && state.runIterationCount === 0
      && hasRunHumanMessage(mainSelection.messages, state.runId);
  const pendingDelegation = state.runNextDelegation && !freshTurn
    ? { delegationId: activeDelegation.id, runId: activeDelegation.runId, capability, task: state.runNextDelegation.task }
    : null;
  if (!currentDeliveries.length && !latestAnnounce && !freshTurn && !pendingDelegation) {
    throw new Error('Boundary Supervisor requires typed result evidence or fresh user input.');
  }
  const supervisorState = supervisorRuntimeStateFromRoot(state);
  return {
    state: supervisorState,
    messageSelections: [
      {
        location: 'run_supervisor.boundary.main',
        diagnostics: mainSelection.diagnostics,
      },

    ],
    input: {
      mode: 'boundary',
      pendingDelegation,
      deliveries,
      inputId: pendingDelegation ? `dispatch:${activeDelegation.id}:${state.runIterationCount}` : freshTurn
        ? `human:${resumedUserMessage?.id ?? state.runId}`
        : `result:${activeDelegation.id}:${currentDeliveries.at(-1)?.id ?? latestAnnounce!.announceMessageId}`,
      traceId: state.traceId,
      runId: state.runId,
      userRequest: supervisorState.runUserRequest,
      messages: mainSelection.messages,
      activeDelegation: {
        delegationId: activeDelegation.id,
        runId: activeDelegation.runId,
        capability,
        task: activeDelegation.task,
      },
      remainingPlan: supervisorSession.plan,
      catalog,
      capabilityDisclosure: supervisorSession.capabilityDisclosure,
      supervisorSession,
    },
  };
}
