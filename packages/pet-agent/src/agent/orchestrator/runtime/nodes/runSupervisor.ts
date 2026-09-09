import { randomUUID } from 'node:crypto';
import { Command } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createCapabilityCatalog } from '../../runSupervisor/capabilityCatalog';
import {
  createRunSupervisorAgent,
} from '../../runSupervisor/agent';
import { resolveCapabilityDisclosureState } from '../../runSupervisor/capabilityDisclosure';
import {
  createRunSupervisorSession,
  updateRunSupervisorSession,
  type RunSupervisorSessionState,
} from '../../runSupervisor/session';
import {
  type RunSupervisorDispatch,
  type RunSupervisorRuntimeState,
  type RunSupervisorRunner,
  isRunSupervisorReplyResult,
} from '../../runSupervisor/runner';
import {
  parseSupervisorCommand,
} from '../../runSupervisor/protocol';
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
import {
  observeAgentMessageSelection,
} from '../../../messages';
import {
  buildSubagentHandoff,
} from '../../delegation';
import {
  buildRunSupervisorInput,
  isSupervisorDispatch,
  supervisorRuntimeStateFromRoot,
} from '../../runSupervisor/input';
import {
  getInvokeOptions,
  getInvokeRegistry,
} from '../config';
import {
  createTaskActiveDelegation,
  readCapabilityNameFromLane,
} from '../decisions/delegationLifecycle';

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
      `Run Supervisor selected "${nextTask.capability}" outside the immutable catalog.`,
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
    taskRunContinuation: null,
    runDelegationSummaries: appendRunDelegationSummary(
      state.runDelegationSummaries,
      runNextDelegation,
    ),
    runSupervisorReply: null,
    runRuntimeFailure: null,
  };
}

function buildDelegationHandoffUpdate(
  state: OrchestratorStateType,
  activeDelegation: TaskActiveDelegation,
) {
  const messages = buildSubagentHandoff({
    taskAccepted: true,
    messages: state.messages,
    lane: activeDelegation.lane,
    runId: activeDelegation.runId,
    delegationId: activeDelegation.id,
  });
  if (!messages) {
    throw new Error('Cannot hand off a delegation without result evidence.');
  }
  return {
    messages,
    runNextDelegation: null,
    taskActiveDelegation: null,
    runDelegationSummaries: state.runDelegationSummaries.map((delegation) =>
      delegation.id === activeDelegation.id
        ? { ...delegation, status: 'completed' as const }
        : delegation),
    runSupervisorReply: null,
    runRuntimeFailure: null,
  };
}

function buildContinueCurrentUpdate(params: {
  state: OrchestratorStateType;
  activeDelegation: TaskActiveDelegation;
  feedback?: string;
}) {
  const { state, activeDelegation } = params;
  const runNextDelegation: RunNextDelegation = {
    id: activeDelegation.id,
    lane: activeDelegation.lane,
    mode: 'continue',
    task: activeDelegation.task,
    contextSummary: params.feedback ?? null,
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
    runSupervisorReply: null,
    runRuntimeFailure: null,
  };
}

function createDefaultSupervisorRunner(config: OrchestratorConfig): RunSupervisorRunner {
  return createRunSupervisorAgent({
    model: config.models.act,
    ...(config.defaultCapabilityName !== undefined
      ? { defaultCapabilityName: config.defaultCapabilityName }
      : {}),
  });
}

export function createRunSupervisorNode(config: OrchestratorConfig) {
  const runner = config.runSupervisorRunner ?? createDefaultSupervisorRunner(config);

  return async function runSupervisorNode(
    nodeInput: OrchestratorStateType | RunSupervisorDispatch,
    runnableConfig?: RunnableConfig,
  ) {
    const registry = getInvokeRegistry(runnableConfig);
    const allowedCapabilityNames = getInvokeOptions(runnableConfig).allowedCapabilityNames;
    const catalog = createCapabilityCatalog({
      registry,
      ...(allowedCapabilityNames ? { allowedCapabilityNames } : {}),
    });
    const state = isSupervisorDispatch(nodeInput)
      ? nodeInput.supervisorState
      : supervisorRuntimeStateFromRoot(nodeInput);
    const existingSession = state.runSupervisorSession?.runId === state.runId
      ? state.runSupervisorSession
      : null;
    const continuation = !isSupervisorDispatch(nodeInput)
      && nodeInput.taskRunContinuation?.activeDelegationId === (nodeInput.taskActiveDelegation?.id ?? null)
      ? nodeInput.taskRunContinuation : null;
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
          runSupervisorReply: null,
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
      catalog,
      ...(resumedCapabilityNames.length > 0
        ? { seedCapabilityNames: resumedCapabilityNames }
        : {}),
    });
    const supervisorSession: RunSupervisorSessionState = existingSession
      ? {
          ...existingSession,
          capabilityDisclosure,
        }
      : createRunSupervisorSession({
          runId: state.runId,
          plan: continuation?.remainingPlan ?? [],
          capabilityDisclosure,
        });
    const { input, messageSelections } = buildRunSupervisorInput({
      nodeInput,
      catalog,
      supervisorSession,
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
    const includeSupervisorSession = <T extends object>(
      update: T,
      plan: readonly CapabilityPlanTask[],
    ) => ({
      ...update,
      ...(input.mode === 'entry' ? { runUserRequest: state.runUserRequest } : {}),
      taskRunContinuation: null,
      runSupervisorUserMessageId: null,
      runSupervisorSession: updateRunSupervisorSession({
        current: supervisorSession,
        plan,
        capabilityDisclosure: updatedCapabilityDisclosure,
      }),
    });
    if (isRunSupervisorReplyResult(result)) {
      if (typeof result.reply !== 'string' || !result.reply.trim()) {
        throw new Error('Supervisor returned an empty final reply.');
      }
      return new Command({
        update: includeSupervisorSession({ runNextDelegation: null, runSupervisorReply: result.reply }, supervisorSession.plan),
        goto: 'answer',
      });
    }
    // Injectable runners cross the same root trust boundary as the production adapter.
    const { capabilityDisclosure: _disclosure, ...proposal } = result;
    const command = parseSupervisorCommand(proposal, {
      mode: input.mode,
      hasNewUserInput: input.inputId.startsWith('human:'),
      activeDelegation: input.activeDelegation,
      allowedCapabilityNames: catalog.capabilityNames,
    });
    const rootState = nodeInput as OrchestratorStateType;
    if (command.action === 'adjust_plan') {
      const [first, ...remainingPlan] = command.tasks;
      const activeDelegation = rootState.taskActiveDelegation!;
      const adjustedState = { ...state, runUserRequest: command.goal };
      const update = command.currentDelegation === 'continue'
        ? buildContinueCurrentUpdate({
            state: { ...rootState, runUserRequest: command.goal },
            activeDelegation: { ...activeDelegation, task: first.task, userRequest: command.goal },
            feedback: command.reason,
          })
        : materializeNextDelegation({
            state: { ...adjustedState, runDelegationSummaries: state.runDelegationSummaries.map((delegation) =>
              delegation.id === activeDelegation.id ? { ...delegation, status: 'superseded' as const } : delegation) },
            nextTask: first,
            allowedCapabilityNames: catalog.capabilityNames,
          });
      return new Command({
        update: { ...includeSupervisorSession(update, remainingPlan), runUserRequest: command.goal },
        goto: 'capability',
      });
    }

    const proposedPlan = command.action === 'execute_plan' ? command.tasks
      : supervisorSession.plan;
    const canChangePlan = (input.mode === 'entry' && supervisorSession.plan.length === 0)
      || input.inputId.startsWith('human:');
    if (command.action === 'execute_plan' && !canChangePlan && JSON.stringify(proposedPlan) !== JSON.stringify(supervisorSession.plan)) {
      throw new Error('Execution plan changes require fresh user confirmation.');
    }
    if (command.action === 'review_current' && !command.completed) {
      return new Command({
        update: includeSupervisorSession(buildContinueCurrentUpdate({
          state: rootState,
          activeDelegation: rootState.taskActiveDelegation!,
          feedback: command.reason,
        }), proposedPlan),
        goto: 'capability',
      });
    }
    const handoff = command.action === 'review_current'
      ? buildDelegationHandoffUpdate(rootState, rootState.taskActiveDelegation!) : null;
    if (command.action === 'review_current' && command.reply) {
      return new Command({
        update: includeSupervisorSession({ ...handoff, runSupervisorReply: command.reply }, proposedPlan),
        goto: 'answer',
      });
    }
    const [nextTask, ...remainingPlan] = proposedPlan;
    if (!nextTask) throw new Error('A completed review requires a final reply when no planned work remains.');
    const next = materializeNextDelegation({
      state: { ...state, ...(handoff ? { runDelegationSummaries: handoff.runDelegationSummaries } : {}) },
      nextTask,
      allowedCapabilityNames: catalog.capabilityNames,
    });
    return new Command({
      update: includeSupervisorSession({ ...handoff, ...next }, remainingPlan),
      goto: 'capability',
    });
  };
}
