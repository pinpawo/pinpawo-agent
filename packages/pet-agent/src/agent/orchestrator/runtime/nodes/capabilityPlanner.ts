import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from '@langchain/langgraph';
import { type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { materializeCapabilityDocumentWorkspace } from '../../capabilityPlanner/documentWorkspace';
import {
  createCapabilityPlannerAgent,
  DEFAULT_CAPABILITY_PLANNER_MAX_SEARCH_ROUNDS,
} from '../../capabilityPlanner/agent';
import { resolveCapabilityDisclosureState } from '../../capabilityPlanner/capabilityDisclosure';
import {
  type CapabilityPlannerDispatch,
  type CapabilityPlannerInput,
  type CapabilityPlannerRuntimeState,
  type CapabilityPlannerRunner,
  isCapabilityPlannerIncompleteResult,
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
import { findLatestHandoffCopyForDelegation } from '../../artifacts/handoff';
import {
  buildSubagentHandoff,
  getMessageHandoffSource,
  readLatestAnnounce,
  readLatestAnnounceCompletionReason,
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
    messages: materializedDelegation.laneMessages as BaseMessage[],
    runNextDelegation,
    runCapabilityPlan: remainingPlan,
    taskActiveDelegation,
    runDelegationSummaries: appendRunDelegationSummary(
      state.runDelegationSummaries,
      runNextDelegation,
    ),
    runLatestDelegationOutcome: null,
    runUserInputRequest: null,
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
    runUserInputRequest: null,
    runRuntimeFailure: null,
  };
}

/**
 * Materialize `continue_current`, which carries no tasks: the active
 * delegation's id, lane and task are reused verbatim and `runCapabilityPlan` is
 * passed through untouched. This is where the "continue_current changes neither
 * the task nor the remaining plan" invariant is enforced — PlannerCommit is a
 * flat shape and cannot express it in the type system.
 */
function buildContinueCurrentUpdate(params: {
  state: OrchestratorStateType;
  activeDelegation: TaskActiveDelegation;
}) {
  const { state, activeDelegation } = params;
  const runNextDelegation: RunNextDelegation = {
    id: activeDelegation.id,
    lane: activeDelegation.lane,
    task: activeDelegation.task,
    contextSummary: null,
  };
  const materialized = materializeDelegation({
    mode: 'continue',
    lane: activeDelegation.lane,
    transcriptRunId: activeDelegation.transcriptRunId,
    delegationId: activeDelegation.id,
    task: activeDelegation.task,
    guidance: null,
  });
  return {
    messages: materialized.laneMessages,
    runNextDelegation,
    runCapabilityPlan: state.runCapabilityPlan,
    taskActiveDelegation: {
      ...activeDelegation,
      contextSummary: null,
      status: 'pending' as const,
      resultPreview: null,
    },
    runDelegationSummaries: resumeRunDelegationSummary(
      state.runDelegationSummaries,
      runNextDelegation,
    ),
    runLatestDelegationOutcome: null,
    runUserInputRequest: null,
    runRuntimeFailure: null,
  };
}

function buildWaitingUpdate(
  state: OrchestratorStateType,
  commit: PlannerCommit,
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
    runLatestDelegationOutcome: commit.action,
    runUserInputRequest: commit.userInputRequest ?? null,
    runRuntimeFailure: null,
  };
}

function createDefaultPlannerRunner(config: OrchestratorConfig): CapabilityPlannerRunner {
  return createCapabilityPlannerAgent({
    model: config.models.act,
    ...(config.defaultCapabilityName !== undefined
      ? { defaultCapabilityName: config.defaultCapabilityName }
      : {}),
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
    runCapabilityDisclosure: state.runCapabilityDisclosure,
  };
}

function buildPlannerInput(params: {
  nodeInput: OrchestratorStateType | CapabilityPlannerDispatch;
  workspace: CapabilityPlannerInput['workspace'];
  capabilityDisclosure: CapabilityPlannerInput['capabilityDisclosure'];
}): { input: CapabilityPlannerInput; state: CapabilityPlannerRuntimeState } {
  const { nodeInput, workspace, capabilityDisclosure } = params;
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
        messages: nodeInput.messages,
        activeDelegation: null,
        latestAnnounce: null,
        remainingPlan: state.runCapabilityPlan,
        workspace,
        capabilityDisclosure,
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
      messages: state.messages,
      activeDelegation: {
        delegationId: activeDelegation.id,
        transcriptRunId: activeDelegation.transcriptRunId,
        capability,
        task: activeDelegation.task,
      },
      latestAnnounce: announce
        ? {
            messageId: announce.messageId,
            completionReason,
          }
        : null,
      remainingPlan: state.runCapabilityPlan,
      workspace,
      capabilityDisclosure,
    },
  };
}

export function createCapabilityPlannerNode(config: OrchestratorConfig) {
  const runner = config.capabilityPlannerRunner ?? createDefaultPlannerRunner(config);

  return async function capabilityPlannerNode(
    nodeInput: OrchestratorStateType | CapabilityPlannerDispatch,
    runnableConfig?: RunnableConfig,
  ) {
    if (!isPlannerDispatch(nodeInput) && !nodeInput.runCapabilityDisclosure) {
      return new Command({
        update: {
          runNextDelegation: null,
          runCapabilityPlan: [],
          runLatestDelegationOutcome: null,
          runUserInputRequest: null,
          runRuntimeFailure: 'checkpoint_incompatible' as const,
        },
        goto: 'answer',
      });
    }
    const registry = getInvokeRegistry(runnableConfig);
    const allowedCapabilityNames = getInvokeOptions(runnableConfig).allowedCapabilityNames;
    const workspace = await materializeCapabilityDocumentWorkspace({
      registry,
      cacheRoot: DEFAULT_CAPABILITY_PLANNER_WORKSPACE_ROOT,
      ...(allowedCapabilityNames ? { allowedCapabilityNames } : {}),
    });
    const currentDisclosure = isPlannerDispatch(nodeInput)
      ? nodeInput.plannerState.runCapabilityDisclosure
      : nodeInput.runCapabilityDisclosure;
    const capabilityDisclosure = resolveCapabilityDisclosureState({
      current: currentDisclosure,
      workspace,
      ...(config.defaultCapabilityName !== undefined
        ? { defaultCapabilityName: config.defaultCapabilityName }
        : {}),
      maxEmptySearchRounds: config.capabilityPlannerMaxSearchRounds
        ?? DEFAULT_CAPABILITY_PLANNER_MAX_SEARCH_ROUNDS,
    });
    const { input, state } = buildPlannerInput({
      nodeInput,
      workspace,
      capabilityDisclosure,
    });
    const result = await runner.invoke(input, runnableConfig);
    const plannerMessageUpdates = [...(result.messageUpdates ?? [])];
    const updatedCapabilityDisclosure = result.capabilityDisclosure
      ?? input.capabilityDisclosure;
    // A non-commit is not a model terminal action: do not invent General, do
    // not fabricate a ToolMessage, and do not accept an active delegation.
    // Root owns the truthful fallback route to Answer.
    if (isCapabilityPlannerIncompleteResult(result)) {
      const includeIncompletePlannerMessages = <T extends object>(update: T) => ({
        ...update,
        ...(input.mode === 'entry' ? { runUserRequest: state.runUserRequest } : {}),
        runCapabilityDisclosure: updatedCapabilityDisclosure,
        ...(plannerMessageUpdates.length > 0 ? { messages: plannerMessageUpdates } : {}),
      });
      return new Command({
        update: includeIncompletePlannerMessages({
          runNextDelegation: null,
          runCapabilityPlan: input.mode === 'boundary'
            ? [...state.runCapabilityPlan]
            : [],
          runLatestDelegationOutcome: 'planner_incomplete' as const,
          runUserInputRequest: null,
          runRuntimeFailure: null,
        }),
        goto: 'answer',
      });
    }
    // CapabilityPlannerRunner is an injectable seam: config.capabilityPlannerRunner
    // may be a scripted or third-party implementation that never ran the agent's
    // own validation. This re-parse is the root's trust boundary, not a duplicate
    // of the parse inside createCapabilityPlannerAgent() — do not remove it.
    const commit = parsePlannerCommit(
      {
        action: result.action,
        tasks: result.tasks,
        ...('userInputRequest' in result
          ? { userInputRequest: result.userInputRequest }
          : {}),
      },
      {
        mode: input.mode,
        activeDelegation: input.activeDelegation,
        allowedCapabilityNames: workspace.capabilityNames,
      },
    );
    // On entry the goal reaching this node came from plan_request, resolved by
    // Entry Answer against the whole conversation. Its Command.PARENT update is
    // overwritten when the entryAnswer subgraph writes its own channels back, so
    // this node — the first to run outside that subgraph — is what commits the
    // resolved goal to root state for Capability, Answer and the delegation
    // snapshot to read.
    const includePlannerMessages = <T extends object>(update: T) => {
      const existingMessages = 'messages' in update && Array.isArray(update.messages)
        ? update.messages as BaseMessage[]
        : [];
      return {
        ...update,
        ...(input.mode === 'entry' ? { runUserRequest: state.runUserRequest } : {}),
        runCapabilityDisclosure: updatedCapabilityDisclosure,
        ...(plannerMessageUpdates.length > 0 || existingMessages.length > 0
          ? { messages: [...plannerMessageUpdates, ...existingMessages] }
          : {}),
      };
    };

    if (input.mode === 'entry') {
      if (commit.action === 'execute_plan') {
        const [nextTask, ...remainingPlan] = commit.tasks;
        if (!nextTask) throw new Error('Planner execute_plan requires a task.');
        return new Command({
          update: includePlannerMessages(materializeNextDelegation({
            state,
            nextTask,
            remainingPlan: [...remainingPlan],
            allowedCapabilityNames: workspace.capabilityNames,
          })),
          goto: 'capability',
        });
      }
      return new Command({
        update: includePlannerMessages({
          runNextDelegation: null,
          runCapabilityPlan: [],
          runLatestDelegationOutcome: commit.action,
          runUserInputRequest: commit.userInputRequest ?? null,
          runRuntimeFailure: null,
        }),
        goto: 'answer',
      });
    }

    const rootState = nodeInput as OrchestratorStateType;
    const activeDelegation = rootState.taskActiveDelegation;
    if (!activeDelegation) throw new Error('Boundary Planner lost active delegation.');

    if (commit.action === 'continue_current') {
      return new Command({
        update: includePlannerMessages(buildContinueCurrentUpdate({
          state: rootState,
          activeDelegation,
        })),
        goto: 'capability',
      });
    }
    if (commit.action === 'user_input_required' || commit.action === 'unavailable') {
      return new Command({
        update: includePlannerMessages(buildWaitingUpdate(rootState, commit)),
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
        update: includePlannerMessages({
          runNextDelegation: null,
          runCapabilityPlan: [],
          runUserInputRequest: null,
        }),
        goto: 'answer',
      });
    }
    if (commit.action === 'goal_done') {
      return new Command({ update: includePlannerMessages(accepted), goto: 'answer' });
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
      update: includePlannerMessages({
        ...accepted,
        ...next,
        messages: [...accepted.messages, ...next.messages],
      }),
      goto: 'capability',
    });
  };
}
