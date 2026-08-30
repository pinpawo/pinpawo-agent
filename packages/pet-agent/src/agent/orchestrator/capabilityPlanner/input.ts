import {
  queryAgentMessages,
  type AgentMessageSelectionDiagnostics,
} from '../../messages';
import {
  getMessageCompletionReason,
  getMessageIsAnnounce,
} from '../delegation';
import type { OrchestratorStateType } from '../state';
import { readCapabilityNameFromLane } from '../runtime/decisions/delegationLifecycle';
import type {
  CapabilityPlannerDispatch,
  CapabilityPlannerInput,
  CapabilityPlannerRuntimeState,
} from './runner';
import type { PlannerSessionState } from './session';

export function isPlannerDispatch(
  input: OrchestratorStateType | CapabilityPlannerDispatch,
): input is CapabilityPlannerDispatch {
  return 'plannerState' in input && input.mode === 'entry';
}

export function plannerRuntimeStateFromRoot(
  state: OrchestratorStateType,
): CapabilityPlannerRuntimeState {
  if (!state.runUserRequest) {
    throw new Error('Capability Planner requires runUserRequest.');
  }
  return {
    runId: state.runId,
    traceId: state.traceId,
    runUserRequest: state.runUserRequest,
    runDelegationSummaries: state.runDelegationSummaries,
    runPlannerSession: state.runPlannerSession,
  };
}

export function buildCapabilityPlannerInput(params: {
  nodeInput: OrchestratorStateType | CapabilityPlannerDispatch;
  workspace: CapabilityPlannerInput['workspace'];
  plannerSession: PlannerSessionState;
}): {
  input: CapabilityPlannerInput;
  state: CapabilityPlannerRuntimeState;
  messageSelections: Array<{
    location: string;
    diagnostics: AgentMessageSelectionDiagnostics;
  }>;
} {
  const { nodeInput, workspace, plannerSession } = params;
  if (isPlannerDispatch(nodeInput)) {
    const state = nodeInput.plannerState;
    const mainSelection = queryAgentMessages(nodeInput.messages).main().select();
    return {
      state,
      messageSelections: [{
        location: 'capability_planner.entry',
        diagnostics: mainSelection.diagnostics,
      }],
      input: {
        mode: 'entry',
        inputId: `run_started:${state.runId}`,
        traceId: state.traceId,
        runId: state.runId,
        userRequest: state.runUserRequest,
        messages: mainSelection.messages,
        activeDelegation: null,
        latestAnnounce: null,
        announceAttempts: [],
        remainingPlan: plannerSession.plan,
        workspace,
        capabilityDisclosure: plannerSession.capabilityDisclosure,
        plannerSession,
      },
    };
  }

  const state = nodeInput;
  const activeDelegation = state.taskActiveDelegation;
  if (!activeDelegation) {
    throw new Error('Boundary Planner requires taskActiveDelegation.');
  }
  const capability = readCapabilityNameFromLane(activeDelegation.lane);
  if (!capability) {
    throw new Error('Boundary Planner active delegation has an invalid lane.');
  }
  const activeScope = {
    lane: activeDelegation.lane,
    transcriptRunId: activeDelegation.transcriptRunId,
    delegationId: activeDelegation.id,
  };
  const mainSelection = queryAgentMessages(state.messages).main().select();
  const delegationSelection = queryAgentMessages(state.messages)
    .delegation(activeScope)
    .select();
  const announceAttempts = delegationSelection.messages
    .filter(getMessageIsAnnounce)
    .flatMap((message) => {
      if (!message.id) return [];
      const reason = getMessageCompletionReason(message);
      if (!reason) return [];
      return [{
        messageId: message.id,
        completionReason: reason,
        result: message.text,
      }];
    });
  const latestAnnounce = announceAttempts.at(-1) ?? null;
  // resume_active is a fresh Planner input only before this run executes a
  // Capability. Later iterations use the identity of their latest Announce.
  const freshTurn = state.runActiveDelegationTransition === 'resume_active'
    && state.runIterationCount === 0;
  const plannerState = plannerRuntimeStateFromRoot(state);
  return {
    state: plannerState,
    messageSelections: [
      {
        location: 'capability_planner.boundary.main',
        diagnostics: mainSelection.diagnostics,
      },
      {
        location: 'capability_planner.boundary.delegation',
        diagnostics: delegationSelection.diagnostics,
      },
    ],
    input: {
      mode: 'boundary',
      inputId: freshTurn
        ? `human:${state.runId}`
        : `announce:${activeDelegation.id}:${latestAnnounce?.messageId
          ?? `${activeDelegation.transcriptRunId}:${String(state.runIterationCount)}`}`,
      traceId: state.traceId,
      runId: state.runId,
      userRequest: plannerState.runUserRequest,
      messages: mainSelection.messages,
      activeDelegation: {
        delegationId: activeDelegation.id,
        transcriptRunId: activeDelegation.transcriptRunId,
        capability,
        task: activeDelegation.task,
      },
      latestAnnounce,
      announceAttempts,
      remainingPlan: plannerSession.plan,
      workspace,
      capabilityDisclosure: plannerSession.capabilityDisclosure,
      plannerSession,
    },
  };
}
