import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { materializeCapabilityDocumentWorkspace } from '../../runSupervisor/documentWorkspace';
import {
  createRunSupervisorAgent,
  DEFAULT_RUN_SUPERVISOR_MAX_SEARCH_ROUNDS,
} from '../../runSupervisor/agent';
import { resolveCapabilityDisclosureState } from '../../runSupervisor/capabilityDisclosure';
import {
  createRunSupervisorSession,
  updateRunSupervisorSession,
  type RunSupervisorSessionState,
} from '../../runSupervisor/session';
import {
  type RunSupervisorDispatch,
  type RunSupervisorInput,
  type RunSupervisorRuntimeState,
  type RunSupervisorRunner,
  isRunSupervisorNoCommandResult,
} from '../../runSupervisor/runner';
import {
  parseSupervisorCommand,
  type SupervisorCommand,
  type SupervisorReplyOutcome,
} from '../../runSupervisor/protocol';
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

const DEFAULT_RUN_SUPERVISOR_WORKSPACE_ROOT = join(
  tmpdir(),
  'pinpawo-capability-workspaces',
);

function isSupervisorDispatch(
  input: OrchestratorStateType | RunSupervisorDispatch,
): input is RunSupervisorDispatch {
  return 'supervisorState' in input && input.mode === 'entry';
}

function materializeNextDelegation(params: {
  state: RunSupervisorRuntimeState;
  nextTask: CapabilityPlanTask;
  allowedCapabilityNames: readonly string[];
}) {
  const { state, nextTask, allowedCapabilityNames } = params;
  if (!state.runUserRequest) {
    throw new Error('Run Supervisor requires runUserRequest before materializing a delegation.');
  }
  if (!allowedCapabilityNames.includes(nextTask.capability)) {
    throw new Error(
      `Run Supervisor selected "${nextTask.capability}" outside the immutable workspace.`,
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
    taskRunContinuation: null,
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
  outcome: SupervisorReplyOutcome | null,
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
 * the task nor the remaining plan" invariant is enforced — SupervisorCommand is a
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
  command: SupervisorCommand,
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
    runLatestDelegationOutcome: command.action,
    runUserInputRequest: command.userInputRequest ?? null,
    runRuntimeFailure: null,
  };
}

function createDefaultSupervisorRunner(config: OrchestratorConfig): RunSupervisorRunner {
  return createRunSupervisorAgent({
    model: config.models.act,
    ...(config.defaultCapabilityName !== undefined
      ? { defaultCapabilityName: config.defaultCapabilityName }
      : {}),
    registryBackend: config.capabilityRegistryBackend ?? 'filesystem',
  });
}

function runtimeStateFromRoot(state: OrchestratorStateType): RunSupervisorRuntimeState {
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

function buildSupervisorInput(params: {
  nodeInput: OrchestratorStateType | RunSupervisorDispatch;
  workspace: RunSupervisorInput['workspace'];
  supervisorSession: RunSupervisorSessionState;
}): { input: RunSupervisorInput; state: RunSupervisorRuntimeState } {
  const { nodeInput, workspace, supervisorSession } = params;
  if (isSupervisorDispatch(nodeInput)) {
    const state = nodeInput.supervisorState;
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
        remainingPlan: supervisorSession.plan,
        workspace,
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
  // resume_active is a fresh Supervisor input only before this run executes a
  // Capability. After execution, runIterationCount advances and the new
  // announce must receive its own collision-free boundary input identity.
  const freshTurn = state.runActiveDelegationTransition === 'resume_active'
    && state.runIterationCount === 0;
  const supervisorState = runtimeStateFromRoot(state);
  return {
    state: supervisorState,
    input: {
      mode: 'boundary',
      inputId: freshTurn
        ? `human:${state.runId}`
        : `announce:${activeDelegation.id}:${latestAnnounce?.messageId
          ?? `${activeDelegation.transcriptRunId}:${String(state.runIterationCount)}`}`,
      traceId: state.traceId,
      runId: state.runId,
      userRequest: supervisorState.runUserRequest,
      messages: mainConversationMessages([...state.messages]),
      activeDelegation: {
        delegationId: activeDelegation.id,
        transcriptRunId: activeDelegation.transcriptRunId,
        capability,
        task: activeDelegation.task,
      },
      latestAnnounce,
      announceAttempts,
      remainingPlan: supervisorSession.plan,
      workspace,
      capabilityDisclosure: supervisorSession.capabilityDisclosure,
      supervisorSession,
    },
  };
}

export function createRunSupervisorNode(config: OrchestratorConfig) {
  const runner = config.runSupervisorRunner ?? createDefaultSupervisorRunner(config);

  return async function runSupervisorNode(
    nodeInput: OrchestratorStateType | RunSupervisorDispatch,
    runnableConfig?: RunnableConfig,
  ) {
    const registry = getInvokeRegistry(runnableConfig);
    const allowedCapabilityNames = getInvokeOptions(runnableConfig).allowedCapabilityNames;
    const workspace = await materializeCapabilityDocumentWorkspace({
      registry,
      cacheRoot: DEFAULT_RUN_SUPERVISOR_WORKSPACE_ROOT,
      ...(allowedCapabilityNames ? { allowedCapabilityNames } : {}),
    });
    const state = isSupervisorDispatch(nodeInput)
      ? nodeInput.supervisorState
      : runtimeStateFromRoot(nodeInput);
    const existingSession = state.runSupervisorSession?.runId === state.runId
      ? state.runSupervisorSession
      : null;
    const continuation = !isSupervisorDispatch(nodeInput)
      && nodeInput.taskActiveDelegation
      && nodeInput.taskRunContinuation?.activeDelegationId
        === nodeInput.taskActiveDelegation.id
      ? nodeInput.taskRunContinuation
      : null;
    const isExplicitResume = !isSupervisorDispatch(nodeInput)
      && nodeInput.runActiveDelegationTransition === 'resume_active';
    if (!isSupervisorDispatch(nodeInput)
      && !existingSession
      && !continuation
      && !isExplicitResume) {
      return new Command({
        update: {
          runNextDelegation: null,
          runSupervisorSession: null,
          runLatestDelegationOutcome: null,
          runUserInputRequest: null,
          runRuntimeFailure: 'checkpoint_incompatible' as const,
        },
        goto: 'answer',
      });
    }
    const resumedCapabilityNames = !existingSession && !isSupervisorDispatch(nodeInput)
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
      maxEmptySearchRounds: config.runSupervisorMaxSearchRounds
        ?? DEFAULT_RUN_SUPERVISOR_MAX_SEARCH_ROUNDS,
    });
    const supervisorSession: RunSupervisorSessionState = existingSession
      ? {
          ...existingSession,
          capabilityDisclosure,
          ...(existingSession.capabilityDisclosure.registryDigest
            !== capabilityDisclosure.registryDigest
            ? { lastCommand: null }
            : {}),
        }
      : createRunSupervisorSession({
          runId: state.runId,
          plan: continuation?.remainingPlan ?? [],
          capabilityDisclosure,
        });
    const { input } = buildSupervisorInput({
      nodeInput,
      workspace,
      supervisorSession,
    });
    const result = await runner.invoke(input, runnableConfig);
    const updatedCapabilityDisclosure = result.capabilityDisclosure
      ?? input.capabilityDisclosure;
    // A missing command is not a state-changing action: do not invent General, do
    // not fabricate a ToolMessage, and do not accept an active delegation.
    // Both modes report an explicit typed failure to Answer. Ordinary Supervisor
    // text remains private to invocation tracing and never becomes a root reply.
    if (isRunSupervisorNoCommandResult(result)) {
      const incompletePlan = input.mode === 'boundary' ? supervisorSession.plan : [];
      return new Command({
        update: {
          runNextDelegation: null,
          ...(input.mode === 'entry' ? { runUserRequest: state.runUserRequest } : {}),
          taskRunContinuation: null,
          runSupervisorSession: updateRunSupervisorSession({
            current: supervisorSession,
            plan: incompletePlan,
            capabilityDisclosure: updatedCapabilityDisclosure,
            inputId: input.inputId,
            registryDigest: workspace.registryDigest,
            command: null,
          }),
          runLatestDelegationOutcome: 'supervisor_command_missing' as const,
          runUserInputRequest: null,
          runRuntimeFailure: null,
        },
        goto: 'answer',
      });
    }
    // RunSupervisorRunner is an injectable seam: config.runSupervisorRunner
    // may be a scripted or third-party implementation that never ran the agent's
    // own validation. This re-parse is the root's trust boundary, not a duplicate
    // of the parse inside createRunSupervisorAgent() — do not remove it.
    const command = parseSupervisorCommand(
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
    const includeSupervisorSession = <T extends object>(
      update: T,
      plan: readonly CapabilityPlanTask[],
    ) => ({
        ...update,
        ...(input.mode === 'entry' ? { runUserRequest: state.runUserRequest } : {}),
        taskRunContinuation: null,
        runSupervisorSession: updateRunSupervisorSession({
          current: supervisorSession,
          plan,
          capabilityDisclosure: updatedCapabilityDisclosure,
          inputId: input.inputId,
          registryDigest: workspace.registryDigest,
          command,
        }),
      });

    if (input.mode === 'entry') {
      if (command.action === 'execute_plan') {
        const [nextTask, ...remainingPlan] = command.tasks;
        if (!nextTask) throw new Error('Supervisor execute_plan requires a task.');
        return new Command({
          update: includeSupervisorSession(materializeNextDelegation({
            state,
            nextTask,
            allowedCapabilityNames: workspace.capabilityNames,
          }), remainingPlan),
          goto: 'capability',
        });
      }
      return new Command({
        update: includeSupervisorSession({
          runNextDelegation: null,
          runLatestDelegationOutcome: command.action,
          runUserInputRequest: command.userInputRequest ?? null,
          runRuntimeFailure: null,
        }, []),
        goto: 'answer',
      });
    }

    const rootState = nodeInput as OrchestratorStateType;
    const activeDelegation = rootState.taskActiveDelegation;
    if (!activeDelegation) throw new Error('Boundary Supervisor lost active delegation.');

    if (command.action === 'continue_current') {
      return new Command({
        update: includeSupervisorSession(buildContinueCurrentUpdate({
          state: rootState,
          activeDelegation,
        }), supervisorSession.plan),
        goto: 'capability',
      });
    }
    if (command.action === 'user_input_required' || command.action === 'unavailable') {
      return new Command({
        update: includeSupervisorSession(
          buildWaitingUpdate(rootState, command),
          supervisorSession.plan,
        ),
        goto: 'answer',
      });
    }

    const accepted = buildAcceptedDelegationUpdate(
      rootState,
      activeDelegation,
      command.action === 'goal_done' ? 'goal_done' : null,
    );
    if (!accepted) {
      return new Command({
        update: includeSupervisorSession({
          runNextDelegation: null,
          runUserInputRequest: null,
        }, supervisorSession.plan),
        goto: 'answer',
      });
    }
    if (command.action === 'goal_done') {
      return new Command({
        update: includeSupervisorSession(accepted, []),
        goto: 'answer',
      });
    }

    const [nextTask, ...remainingPlan] = command.tasks;
    if (!nextTask) throw new Error('Supervisor advance_plan requires a task.');
    const next = materializeNextDelegation({
      state: {
        ...state,
        runDelegationSummaries: accepted.runDelegationSummaries,
      },
      nextTask,
      allowedCapabilityNames: workspace.capabilityNames,
    });
    return new Command({
      update: includeSupervisorSession({
        ...accepted,
        ...next,
        messages: accepted.messages,
      }, remainingPlan),
      goto: 'capability',
    });
  };
}
