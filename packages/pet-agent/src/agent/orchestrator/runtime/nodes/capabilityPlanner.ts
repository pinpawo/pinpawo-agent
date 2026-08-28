import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { materializeCapabilityDocumentWorkspace } from '../../capabilityPlanner/documentWorkspace';
import {
  createCapabilityPlannerAgent,
  DEFAULT_CAPABILITY_PLANNER_MAX_SEARCH_ROUNDS,
} from '../../capabilityPlanner/agent';
import { resolveCapabilityDisclosureState } from '../../capabilityPlanner/capabilityDisclosure';
import {
  createPlannerSession,
  updatePlannerSession,
  type PlannerSessionState,
} from '../../capabilityPlanner/session';
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
  getMessageCompletionReason,
  mainConversationMessages,
  readLatestAnnounceCompletionReason,
  selectDelegationLaneAnnounceMessages,
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
  allowedCapabilityNames: readonly string[];
}) {
  const { state, nextTask, allowedCapabilityNames } = params;
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
    mode: 'initial',
    task: nextTask.task,
    contextSummary: null,
  };
  const taskActiveDelegation = createTaskActiveDelegation(
    runNextDelegation,
    state.runId,
    state.runUserRequest,
    state.traceId,
  );
  return {
    runNextDelegation,
    taskActiveDelegation,
    taskPlannerContinuation: null,
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
 * delegation's id, lane and task are reused verbatim and the session plan is
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
    mode: 'continue',
    task: activeDelegation.task,
    contextSummary: null,
  };
  return {
    runNextDelegation,
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
    runPlannerSession: state.runPlannerSession,
  };
}

function buildPlannerInput(params: {
  nodeInput: OrchestratorStateType | CapabilityPlannerDispatch;
  workspace: CapabilityPlannerInput['workspace'];
  plannerSession: PlannerSessionState;
}): { input: CapabilityPlannerInput; state: CapabilityPlannerRuntimeState } {
  const { nodeInput, workspace, plannerSession } = params;
  if (isPlannerDispatch(nodeInput)) {
    const state = nodeInput.plannerState;
    return {
      state,
      input: {
        mode: 'entry',
        inputId: `run_started:${state.runId}`,
        traceId: state.traceId,
        runId: state.runId,
        userRequest: state.runUserRequest,
        messages: mainConversationMessages([...nodeInput.messages]),
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
  const announceAttempts = selectDelegationLaneAnnounceMessages(state.messages, {
    lane: activeDelegation.lane,
    transcriptRunId: activeDelegation.transcriptRunId,
    delegationId: activeDelegation.id,
  }).flatMap((message) => {
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
        : `announce:${activeDelegation.id}:${latestAnnounce?.messageId
          ?? `${activeDelegation.transcriptRunId}:${String(state.runIterationCount)}`}`,
      traceId: state.traceId,
      runId: state.runId,
      userRequest: plannerState.runUserRequest,
      messages: mainConversationMessages([...state.messages]),
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
    const state = isPlannerDispatch(nodeInput)
      ? nodeInput.plannerState
      : runtimeStateFromRoot(nodeInput);
    const existingSession = state.runPlannerSession?.runId === state.runId
      ? state.runPlannerSession
      : null;
    const continuation = !isPlannerDispatch(nodeInput)
      && nodeInput.taskActiveDelegation
      && nodeInput.taskPlannerContinuation?.activeDelegationId
        === nodeInput.taskActiveDelegation.id
      ? nodeInput.taskPlannerContinuation
      : null;
    const isExplicitResume = !isPlannerDispatch(nodeInput)
      && nodeInput.runActiveDelegationTransition === 'resume_active';
    if (!isPlannerDispatch(nodeInput)
      && !existingSession
      && !continuation
      && !isExplicitResume) {
      return new Command({
        update: {
          runNextDelegation: null,
          runPlannerSession: null,
          runLatestDelegationOutcome: null,
          runUserInputRequest: null,
          runRuntimeFailure: 'checkpoint_incompatible' as const,
        },
        goto: 'answer',
      });
    }
    const resumedCapabilityNames = !existingSession && !isPlannerDispatch(nodeInput)
      ? [
          ...(nodeInput.taskActiveDelegation
            ? [readCapabilityNameFromLane(nodeInput.taskActiveDelegation.lane) ?? '']
            : []),
          ...(continuation?.remainingPlan.map((task) => task.capability) ?? []),
        ].filter(Boolean)
      : [];
    const capabilityDisclosure = resolveCapabilityDisclosureState({
      current: existingSession?.capabilityDisclosure ?? null,
      workspace,
      ...(resumedCapabilityNames.length > 0
        ? { seedCapabilityNames: resumedCapabilityNames }
        : {}),
      ...(config.defaultCapabilityName !== undefined
        ? { defaultCapabilityName: config.defaultCapabilityName }
        : {}),
      maxEmptySearchRounds: config.capabilityPlannerMaxSearchRounds
        ?? DEFAULT_CAPABILITY_PLANNER_MAX_SEARCH_ROUNDS,
    });
    const plannerSession: PlannerSessionState = existingSession
      ? {
          ...existingSession,
          capabilityDisclosure,
          ...(existingSession.capabilityDisclosure.registryDigest
            !== capabilityDisclosure.registryDigest
            ? { lastCommit: null }
            : {}),
        }
      : createPlannerSession({
          runId: state.runId,
          plan: continuation?.remainingPlan ?? [],
          capabilityDisclosure,
        });
    const { input } = buildPlannerInput({
      nodeInput,
      workspace,
      plannerSession,
    });
    const result = await runner.invoke(input, runnableConfig);
    const updatedCapabilityDisclosure = result.capabilityDisclosure
      ?? input.capabilityDisclosure;
    // A non-commit is not a model terminal action: do not invent General, do
    // not fabricate a ToolMessage, and do not accept an active delegation.
    // Both modes report an explicit typed failure to Answer. Ordinary Planner
    // text remains private to invocation tracing and never becomes a root reply.
    if (isCapabilityPlannerIncompleteResult(result)) {
      const incompletePlan = input.mode === 'boundary' ? plannerSession.plan : [];
      return new Command({
        update: {
          runNextDelegation: null,
          ...(input.mode === 'entry' ? { runUserRequest: state.runUserRequest } : {}),
          taskPlannerContinuation: null,
          runPlannerSession: updatePlannerSession({
            current: plannerSession,
            plan: incompletePlan,
            capabilityDisclosure: updatedCapabilityDisclosure,
            inputId: input.inputId,
            registryDigest: workspace.registryDigest,
            decision: null,
          }),
          runLatestDelegationOutcome: 'planner_incomplete' as const,
          runUserInputRequest: null,
          runRuntimeFailure: null,
        },
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
    const includePlannerSession = <T extends object>(
      update: T,
      plan: readonly CapabilityPlanTask[],
    ) => ({
        ...update,
        ...(input.mode === 'entry' ? { runUserRequest: state.runUserRequest } : {}),
        taskPlannerContinuation: null,
        runPlannerSession: updatePlannerSession({
          current: plannerSession,
          plan,
          capabilityDisclosure: updatedCapabilityDisclosure,
          inputId: input.inputId,
          registryDigest: workspace.registryDigest,
          decision: commit,
        }),
      });

    if (input.mode === 'entry') {
      if (commit.action === 'execute_plan') {
        const [nextTask, ...remainingPlan] = commit.tasks;
        if (!nextTask) throw new Error('Planner execute_plan requires a task.');
        return new Command({
          update: includePlannerSession(materializeNextDelegation({
            state,
            nextTask,
            allowedCapabilityNames: workspace.capabilityNames,
          }), remainingPlan),
          goto: 'capability',
        });
      }
      return new Command({
        update: includePlannerSession({
          runNextDelegation: null,
          runLatestDelegationOutcome: commit.action,
          runUserInputRequest: commit.userInputRequest ?? null,
          runRuntimeFailure: null,
        }, []),
        goto: 'answer',
      });
    }

    const rootState = nodeInput as OrchestratorStateType;
    const activeDelegation = rootState.taskActiveDelegation;
    if (!activeDelegation) throw new Error('Boundary Planner lost active delegation.');

    if (commit.action === 'continue_current') {
      return new Command({
        update: includePlannerSession(buildContinueCurrentUpdate({
          state: rootState,
          activeDelegation,
        }), plannerSession.plan),
        goto: 'capability',
      });
    }
    if (commit.action === 'user_input_required' || commit.action === 'unavailable') {
      return new Command({
        update: includePlannerSession(
          buildWaitingUpdate(rootState, commit),
          plannerSession.plan,
        ),
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
        update: includePlannerSession({
          runNextDelegation: null,
          runUserInputRequest: null,
        }, plannerSession.plan),
        goto: 'answer',
      });
    }
    if (commit.action === 'goal_done') {
      return new Command({
        update: includePlannerSession(accepted, []),
        goto: 'answer',
      });
    }

    const [nextTask, ...remainingPlan] = commit.tasks;
    if (!nextTask) throw new Error('Planner advance_plan requires a task.');
    const next = materializeNextDelegation({
      state: {
        ...state,
        runDelegationSummaries: accepted.runDelegationSummaries,
      },
      nextTask,
      allowedCapabilityNames: workspace.capabilityNames,
    });
    return new Command({
      update: includePlannerSession({
        ...accepted,
        ...next,
        messages: accepted.messages,
      }, remainingPlan),
      goto: 'capability',
    });
  };
}
