import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from '@langchain/langgraph';
import { type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { materializeCapabilityDocumentWorkspace } from '../../capabilityPlanner/documentWorkspace';
import {
  CapabilityPlannerAgentError,
  createCapabilityPlannerAgent,
} from '../../capabilityPlanner/agent';
import {
  CAPABILITY_PLANNER_BOUNDARY_RESULT_MAX_CHARS,
  type CapabilityPlannerDispatch,
  type CapabilityPlannerInput,
  type CapabilityPlannerRuntimeState,
  type CapabilityPlannerRunner,
} from '../../capabilityPlanner/runner';
import {
  parsePlannerCommit,
  type PlannerCommit,
  type PlannerReplyOutcome,
} from '../../capabilityPlanner/protocol';
import { materializeDelegation } from '../../delegationBriefing';
import {
  appendRunDelegationSummary,
  resumeRunDelegationSummary,
} from '../../delegations';
import type { OrchestratorStateType } from '../../state';
import type {
  CapabilityPlanTask,
  MessageLane,
  OrchestratorConfig,
  RunNextDelegation,
  TaskActiveDelegation,
} from '../../types';
import {
  buildHandoffArtifactRefs,
  findLatestHandoffCopyForDelegation,
} from '../../artifacts/handoff';
import {
  buildSubagentHandoff,
  getMessageHandoffSource,
  readLatestAnnounce,
  readLatestAnnounceCompletionReason,
  readLatestHumanRequest,
} from '../../messageLanes';
import {
  getInvokeOptions,
  getInvokeRegistry,
} from '../config';
import {
  createTaskActiveDelegation,
  readCapabilityNameFromLane,
} from '../decisions/delegationLifecycle';

const DEFAULT_CAPABILITY_PLANNER_WORKSPACE_ROOT = join(
  tmpdir(),
  'pinpawo-capability-workspaces',
);

function isPlannerDispatch(
  input: OrchestratorStateType | CapabilityPlannerDispatch,
): input is CapabilityPlannerDispatch {
  return 'plannerState' in input && input.mode === 'entry';
}

function boundPlannerAnnounce(value: string | null): string | null {
  const text = value?.trim() ?? '';
  if (!text) return null;
  if (text.length <= CAPABILITY_PLANNER_BOUNDARY_RESULT_MAX_CHARS) return text;
  const marker = '\n\n[announce truncated for Planner context]\n\n';
  const available = CAPABILITY_PLANNER_BOUNDARY_RESULT_MAX_CHARS - marker.length;
  const tailLength = Math.floor(available / 4);
  return `${text.slice(0, available - tailLength)}${marker}${text.slice(-tailLength)}`;
}

function materializeNextDelegation(params: {
  state: CapabilityPlannerRuntimeState;
  nextTask: CapabilityPlanTask;
  remainingPlan: CapabilityPlanTask[];
  allowedCapabilityNames: readonly string[];
}) {
  const { state, nextTask, remainingPlan, allowedCapabilityNames } = params;
  if (!state.runUserRequest) {
    throw new Error('Capability Planner requires runUserRequest before materializing a delegation.');
  }
  if (!allowedCapabilityNames.includes(nextTask.capability)) {
    throw new Error(
      `Capability Planner selected "${nextTask.capability}" outside the immutable workspace.`,
    );
  }
  const lane: MessageLane = `capability:${nextTask.capability}`;
  const runNextDelegation: RunNextDelegation = {
    id: randomUUID().slice(0, 8),
    lane,
    task: nextTask.task,
    contextSummary: null,
  };
  const taskActiveDelegation = createTaskActiveDelegation(
    runNextDelegation,
    state.runId,
    state.runUserRequest,
    state.traceId,
  );
  const materializedDelegation = materializeDelegation({
    mode: 'initial',
    lane,
    transcriptRunId: taskActiveDelegation.transcriptRunId,
    delegationId: runNextDelegation.id,
    task: runNextDelegation.task,
    essentialContext: null,
  });

  return {
    messages: [
      ...materializedDelegation.mainMessages,
      ...materializedDelegation.laneMessages,
    ] as BaseMessage[],
    runNextDelegation,
    runCapabilityPlan: remainingPlan,
    taskActiveDelegation,
    runDelegationSummaries: appendRunDelegationSummary(
      state.runDelegationSummaries,
      runNextDelegation,
    ),
    runLatestDelegationOutcome: null,
    runRuntimeFailure: null,
  };
}

function buildAcceptedDelegationUpdate(
  state: OrchestratorStateType,
  activeDelegation: TaskActiveDelegation,
  outcome: PlannerReplyOutcome | null,
) {
  const completionReason = readLatestAnnounceCompletionReason(state.messages, {
    transcriptRunId: activeDelegation.transcriptRunId,
    delegationId: activeDelegation.id,
  });
  if (completionReason === 'limit_reached') {
    return null;
  }
  const capabilityId = readCapabilityNameFromLane(activeDelegation.lane);
  const artifactRefs = buildHandoffArtifactRefs(
    state.sessionCapabilityArtifacts,
    {
      delegationId: activeDelegation.id,
      runId: activeDelegation.transcriptRunId,
      capabilityId,
    },
  );
  const existingCopy = findLatestHandoffCopyForDelegation(
    state.messages,
    activeDelegation.id,
    activeDelegation.lane,
    activeDelegation.transcriptRunId,
    getMessageHandoffSource,
  );
  const messages = buildSubagentHandoff({
    messages: state.messages,
    lane: activeDelegation.lane,
    transcriptRunId: activeDelegation.transcriptRunId,
    delegationId: activeDelegation.id,
    artifactRefs,
    clearLane: true,
    includeCopy: !existingCopy,
  });
  if (!messages) {
    return null;
  }
  return {
    messages,
    runNextDelegation: null,
    taskActiveDelegation: null,
    runDelegationSummaries: state.runDelegationSummaries.map((delegation) =>
      delegation.id === activeDelegation.id
        ? { ...delegation, status: 'completed' as const }
        : delegation),
    runLatestDelegationOutcome: outcome,
    runRuntimeFailure: null,
  };
}

function buildContinueCurrentUpdate(params: {
  state: OrchestratorStateType;
  activeDelegation: TaskActiveDelegation;
  commit: Extract<PlannerCommit, { action: 'continue_current' }>;
}) {
  const { state, activeDelegation, commit } = params;
  const [nextTask, ...remainingPlan] = commit.tasks;
  if (!nextTask) {
    throw new Error('Planner continue_current requires a continuation task.');
  }
  const runNextDelegation: RunNextDelegation = {
    id: activeDelegation.id,
    lane: activeDelegation.lane,
    task: nextTask.task,
    contextSummary: null,
  };
  const materialized = materializeDelegation({
    mode: 'continue',
    lane: activeDelegation.lane,
    transcriptRunId: activeDelegation.transcriptRunId,
    delegationId: activeDelegation.id,
    task: nextTask.task,
    gapNote: commit.gapNote,
  });
  return {
    messages: materialized.laneMessages,
    runNextDelegation,
    runCapabilityPlan: remainingPlan,
    taskActiveDelegation: {
      ...activeDelegation,
      task: nextTask.task,
      contextSummary: null,
      status: 'pending' as const,
      resultPreview: null,
    },
    runDelegationSummaries: resumeRunDelegationSummary(
      state.runDelegationSummaries,
      runNextDelegation,
    ),
    runLatestDelegationOutcome: null,
    runRuntimeFailure: null,
  };
}

function buildWaitingUpdate(
  state: OrchestratorStateType,
  outcome: Extract<PlannerReplyOutcome, 'user_input_required' | 'unavailable'>,
) {
  const activeDelegation = state.taskActiveDelegation;
  return {
    runNextDelegation: null,
    runCapabilityPlan: [],
    taskActiveDelegation: activeDelegation,
    runDelegationSummaries: activeDelegation
      ? state.runDelegationSummaries.map((delegation) =>
          delegation.id === activeDelegation.id
            ? { ...delegation, status: 'progress' as const }
            : delegation)
      : state.runDelegationSummaries,
    runLatestDelegationOutcome: outcome,
    runRuntimeFailure: null,
  };
}

function buildPlannerCheckpointMissingUpdate(state: OrchestratorStateType) {
  const activeDelegation = state.taskActiveDelegation;
  return {
    runNextDelegation: null,
    runCapabilityPlan: state.runCapabilityPlan,
    taskActiveDelegation: activeDelegation,
    runDelegationSummaries: activeDelegation
      ? state.runDelegationSummaries.map((delegation) =>
          delegation.id === activeDelegation.id
            ? { ...delegation, status: 'progress' as const }
            : delegation)
      : state.runDelegationSummaries,
    runLatestDelegationOutcome: null,
    runRuntimeFailure: 'planner_checkpoint_missing' as const,
  };
}

function createDefaultPlannerRunner(config: OrchestratorConfig): CapabilityPlannerRunner {
  return createCapabilityPlannerAgent({
    model: config.models.act,
    registryBackend: config.capabilityRegistryBackend ?? 'filesystem',
  });
}

function runtimeStateFromRoot(state: OrchestratorStateType): CapabilityPlannerRuntimeState {
  if (!state.runUserRequest) {
    throw new Error('Capability Planner requires runUserRequest.');
  }
  return {
    runId: state.runId,
    traceId: state.traceId,
    runUserRequest: state.runUserRequest,
    runDelegationSummaries: state.runDelegationSummaries,
    runCapabilityPlan: state.runCapabilityPlan,
  };
}

function buildPlannerInput(params: {
  nodeInput: OrchestratorStateType | CapabilityPlannerDispatch;
  rootState?: OrchestratorStateType;
  workspace: CapabilityPlannerInput['workspace'];
}): { input: CapabilityPlannerInput; state: CapabilityPlannerRuntimeState } {
  const { nodeInput, workspace } = params;
  if (isPlannerDispatch(nodeInput)) {
    const state = nodeInput.plannerState;
    return {
      state,
      input: {
        mode: 'entry',
        inputId: `trace_started:${state.traceId}`,
        traceId: state.traceId,
        runId: state.runId,
        userRequest: state.runUserRequest,
        mainMessages: nodeInput.mainMessages,
        latestUserMessage: null,
        activeDelegation: null,
        latestAnnounce: null,
        remainingPlan: state.runCapabilityPlan,
        workspace,
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
  const announce = readLatestAnnounce(state.messages, {
    transcriptRunId: activeDelegation.transcriptRunId,
    delegationId: activeDelegation.id,
  });
  const completionReason = readLatestAnnounceCompletionReason(state.messages, {
    transcriptRunId: activeDelegation.transcriptRunId,
    delegationId: activeDelegation.id,
  });
  // resume_active is a fresh Planner input only before this run executes a
  // Capability. After execution, runIterationCount advances and the new
  // announce must receive its own collision-free boundary input identity.
  const freshTurn = state.runActiveDelegationTransition === 'resume_active'
    && state.runIterationCount === 0;
  const plannerState = runtimeStateFromRoot(state);
  return {
    state: plannerState,
    input: {
      mode: 'boundary',
      inputId: freshTurn
        ? `human:${state.runId}`
        : `announce:${activeDelegation.id}:${announce?.messageId
          ?? `${activeDelegation.transcriptRunId}:${String(state.runIterationCount)}`}`,
      traceId: state.traceId,
      runId: state.runId,
      userRequest: plannerState.runUserRequest,
      mainMessages: [],
      latestUserMessage: freshTurn ? readLatestHumanRequest(state.messages) : null,
      activeDelegation: {
        delegationId: activeDelegation.id,
        capability,
        task: activeDelegation.task,
      },
      latestAnnounce: announce
        ? {
            messageId: announce.messageId,
            text: boundPlannerAnnounce(announce.text),
            completionReason,
          }
        : null,
      remainingPlan: state.runCapabilityPlan,
      workspace,
    },
  };
}

export function createCapabilityPlannerNode(config: OrchestratorConfig) {
  const runner = config.capabilityPlannerRunner ?? createDefaultPlannerRunner(config);

  return async function capabilityPlannerNode(
    nodeInput: OrchestratorStateType | CapabilityPlannerDispatch,
    runnableConfig?: RunnableConfig,
  ) {
    const registry = getInvokeRegistry(runnableConfig);
    const allowedCapabilityNames = getInvokeOptions(runnableConfig).allowedCapabilityNames;
    const workspace = await materializeCapabilityDocumentWorkspace({
      registry,
      cacheRoot: DEFAULT_CAPABILITY_PLANNER_WORKSPACE_ROOT,
      ...(allowedCapabilityNames ? { allowedCapabilityNames } : {}),
    });
    const { input, state } = buildPlannerInput({ nodeInput, workspace });
    let commit: PlannerCommit;
    try {
      commit = parsePlannerCommit(
        await runner.invoke(input, runnableConfig),
        {
          mode: input.mode,
          activeDelegation: input.activeDelegation,
          allowedCapabilityNames: workspace.capabilityNames,
        },
      );
    } catch (error) {
      if (input.mode === 'boundary'
        && error instanceof CapabilityPlannerAgentError
        && error.code === 'planner_checkpoint_missing') {
        return new Command({
          update: buildPlannerCheckpointMissingUpdate(nodeInput as OrchestratorStateType),
          goto: 'answer',
        });
      }
      throw error;
    }

    if (input.mode === 'entry') {
      if (commit.action === 'execute_plan') {
        const [nextTask, ...remainingPlan] = commit.tasks;
        if (!nextTask) throw new Error('Planner execute_plan requires a task.');
        return new Command({
          update: materializeNextDelegation({
            state,
            nextTask,
            remainingPlan: [...remainingPlan],
            allowedCapabilityNames: workspace.capabilityNames,
          }),
          goto: 'capability',
        });
      }
      if (commit.action === 'answer_directly') {
        return new Command({
          update: {
            runNextDelegation: null,
            runCapabilityPlan: [],
            runLatestDelegationOutcome: null,
            runRuntimeFailure: null,
          },
          goto: 'answer',
        });
      }
      return new Command({
        update: {
          runNextDelegation: null,
          runCapabilityPlan: [],
          runLatestDelegationOutcome: commit.action,
          runRuntimeFailure: null,
        },
        goto: 'answer',
      });
    }

    const rootState = nodeInput as OrchestratorStateType;
    const activeDelegation = rootState.taskActiveDelegation;
    if (!activeDelegation) throw new Error('Boundary Planner lost active delegation.');

    if (commit.action === 'continue_current') {
      return new Command({
        update: buildContinueCurrentUpdate({
          state: rootState,
          activeDelegation,
          commit,
        }),
        goto: 'capability',
      });
    }
    if (commit.action === 'user_input_required' || commit.action === 'unavailable') {
      return new Command({
        update: buildWaitingUpdate(rootState, commit.action),
        goto: 'answer',
      });
    }

    const accepted = buildAcceptedDelegationUpdate(
      rootState,
      activeDelegation,
      commit.action === 'goal_done' ? 'goal_done' : null,
    );
    if (!accepted) {
      return new Command({
        update: {
          runNextDelegation: null,
          runCapabilityPlan: [],
        },
        goto: 'answer',
      });
    }
    if (commit.action === 'goal_done') {
      return new Command({ update: accepted, goto: 'answer' });
    }

    const [nextTask, ...remainingPlan] = commit.tasks;
    if (!nextTask) throw new Error('Planner advance_plan requires a task.');
    const next = materializeNextDelegation({
      state: {
        ...state,
        runDelegationSummaries: accepted.runDelegationSummaries,
      },
      nextTask,
      remainingPlan: [...remainingPlan],
      allowedCapabilityNames: workspace.capabilityNames,
    });
    return new Command({
      update: {
        ...accepted,
        ...next,
        messages: [...accepted.messages, ...next.messages],
      },
      goto: 'capability',
    });
  };
}
