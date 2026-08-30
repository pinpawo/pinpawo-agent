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
  CapabilityMessageLane,
  OrchestratorConfig,
  RunNextDelegation,
  TaskActiveDelegation,
} from '../../types';
import { findLatestHandoffCopyForDelegation } from '../../artifacts/handoff';
import {
  observeAgentMessageSelection,
} from '../../../messages';
import {
  buildSubagentHandoff,
  getMessageHandoffSource,
  readLatestAnnounceCompletionReason,
} from '../../delegation';
import {
  buildCapabilityPlannerInput,
  isPlannerDispatch,
  plannerRuntimeStateFromRoot,
} from '../../capabilityPlanner/input';
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
  const lane: CapabilityMessageLane = `capability:${nextTask.capability}`;
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
    lane: activeDelegation.lane,
    runId: activeDelegation.runId,
    delegationId: activeDelegation.id,
  });
  if (completionReason === 'limit_reached') {
    return null;
  }
  const existingCopy = findLatestHandoffCopyForDelegation(
    state.messages,
    activeDelegation.id,
    activeDelegation.lane,
    activeDelegation.runId,
    getMessageHandoffSource,
  );
  const messages = buildSubagentHandoff({
    messages: state.messages,
    lane: activeDelegation.lane,
    runId: activeDelegation.runId,
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
      : plannerRuntimeStateFromRoot(nodeInput);
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
    const { input, messageSelections } = buildCapabilityPlannerInput({
      nodeInput,
      workspace,
      plannerSession,
    });
    for (const selection of messageSelections) {
      observeAgentMessageSelection(
        selection.location,
        selection.diagnostics,
        runnableConfig,
      );
    }
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
