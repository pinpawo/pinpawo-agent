import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from '@langchain/langgraph';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { materializeCapabilityDocumentWorkspace } from '../../capabilityDocumentWorkspace';
import { createCapabilityPlannerAgent } from '../../capabilityPlannerAgent';
import type {
  CapabilityPlannerInput,
  CapabilityPlannerResult,
  CapabilityPlannerRunner,
  CapabilityPlannerTask,
} from '../../capabilityPlannerRunner';
import { materializeDelegation } from '../../delegationBriefing';
import { appendRunDelegationSummary } from '../../delegations';
import { isContextCompactionMessage } from '../../contextCompaction';
import {
  mainConversationMessages,
  toolProtocolSafeMessages,
} from '../../messageLanes';
import type { OrchestratorStateType } from '../../state';
import type {
  CapabilityPlanTask,
  MessageLane,
  OrchestratorConfig,
  RunNextDelegation,
} from '../../types';
import {
  getInvokeOptions,
  getInvokeRegistry,
} from '../config';
import { createTaskActiveDelegation } from '../decisions/delegationLifecycle';

const DEFAULT_CAPABILITY_PLANNER_WORKSPACE_ROOT = join(
  tmpdir(),
  'pinpawo-capability-workspaces',
);

function buildPlannerMode(state: OrchestratorStateType): CapabilityPlannerInput['mode'] {
  return state.runDelegationSummaries.length === 0
    ? 'entry'
    : 'boundary';
}

function buildPlannerMessages(messages: BaseMessage[]) {
  // Planner policy comes only from its own system prompt. Main Human/AI turns
  // remain verbatim; framework compaction is retained as lower-authority evidence.
  const projectedMessages = mainConversationMessages(messages).flatMap((message) => {
    const type = message._getType();
    if (type === 'human' || type === 'ai') return [message];
    if (isContextCompactionMessage(message)) {
      return [new AIMessage(message.content)];
    }
    return [];
  });
  return toolProtocolSafeMessages(projectedMessages);
}

function buildPlannerContext(state: OrchestratorStateType) {
  const latestCompletedDelegation = [...state.runDelegationSummaries]
    .reverse()
    .find((item) => item.status === 'completed');
  return {
    messages: buildPlannerMessages(state.messages),
    completedTask: latestCompletedDelegation?.task ?? null,
  };
}

function normalizeRemainingPlan(
  tasks: readonly CapabilityPlannerTask[],
): CapabilityPlanTask[] {
  return tasks.map(normalizePlannerTask);
}

function normalizePlannerTask(task: CapabilityPlannerTask): CapabilityPlanTask {
  const capability = task.capability.trim();
  const description = task.task.trim();
  if (!capability || !description) {
    throw new Error('Capability Planner submitted a task with an empty capability or description.');
  }
  return {
    capability,
    task: description,
  };
}

function samePlannerTask(left: CapabilityPlanTask, right: CapabilityPlanTask) {
  return left.capability === right.capability && left.task === right.task;
}

function normalizeUnavailableResult(result: Extract<CapabilityPlannerResult, { task: string }>) {
  const task = result.task.trim();
  const reason = result.reason.trim();
  if (!task || !reason) {
    throw new Error('Capability Planner submitted an unavailable result with empty text.');
  }
  return { task, reason };
}

/**
 * Boundary planning starts from an already accepted future plan. Keep that
 * plan stable unless its Capability disappeared from the current workspace;
 * completed items can be removed by returning a later plan item as the new
 * first task.
 */
export function assertBoundaryPlanContinuity(
  input: CapabilityPlannerInput,
  result: CapabilityPlannerResult,
) {
  if (input.mode !== 'boundary' || input.remainingPlan.length === 0 || !('tasks' in result)) {
    return;
  }
  const firstPlannedCapability = input.remainingPlan[0]?.capability;
  if (!firstPlannedCapability
    || !input.workspace.capabilityNames.includes(firstPlannedCapability)) {
    return;
  }

  const plannedTasks = input.remainingPlan.map(normalizePlannerTask);
  const returnedTasks = result.tasks.map(normalizePlannerTask);
  let plannedIndex = 0;
  for (const task of returnedTasks) {
    const matchIndex = plannedTasks.findIndex((plannedTask, index) =>
      index >= plannedIndex && samePlannerTask(plannedTask, task));
    if (matchIndex < 0) {
      throw new Error(
        'Capability Planner changed boundary remaining_plan without an invalidated first task.',
      );
    }
    plannedIndex = matchIndex + 1;
  }
}

function materializeNextDelegation(params: {
  state: OrchestratorStateType;
  nextTask: CapabilityPlanTask;
  remainingPlan: CapabilityPlanTask[];
  allowedCapabilityNames: readonly string[];
}) {
  const {
    state,
    nextTask,
    remainingPlan,
    allowedCapabilityNames,
  } = params;
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
  );
  const materializedDelegation = materializeDelegation({
    mode: 'initial',
    lane,
    runId: taskActiveDelegation.transcriptRunId,
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
    runPendingTask: null,
    runCapabilityPlan: remainingPlan,
    taskActiveDelegation,
    runDelegationSummaries: appendRunDelegationSummary(
      state.runDelegationSummaries,
      runNextDelegation,
    ),
    runLatestDelegationOutcome: null,
  };
}

function buildPlannerTransition(params: {
  state: OrchestratorStateType;
  input: CapabilityPlannerInput;
  result: CapabilityPlannerResult;
}) {
  const { state, input, result } = params;
  assertBoundaryPlanContinuity(input, result);
  if (!('tasks' in result)) {
    const unavailable = normalizeUnavailableResult(result);
    return {
      goto: 'answer' as const,
      update: {
        runNextDelegation: null,
        runPendingTask: {
          task: unavailable.task,
          contextSummary: unavailable.reason,
        },
        runCapabilityPlan: [],
      },
    };
  }

  const [rawNextTask, ...remainingTasks] = result.tasks;
  if (!rawNextTask) {
    throw new Error('Capability Planner submitted an empty task list.');
  }
  const nextTask = normalizePlannerTask(rawNextTask);
  const remainingPlan = normalizeRemainingPlan(remainingTasks);
  return {
    goto: 'capability' as const,
    update: materializeNextDelegation({
      state,
      nextTask,
      remainingPlan,
      allowedCapabilityNames: input.workspace.capabilityNames,
    }),
  };
}

function createDefaultPlannerRunner(config: OrchestratorConfig): CapabilityPlannerRunner {
  return createCapabilityPlannerAgent({
    model: config.models.act,
  });
}

export function createCapabilityPlannerNode(config: OrchestratorConfig) {
  const runner = config.capabilityPlannerRunner
    ?? createDefaultPlannerRunner(config);
  const workspaceRoot = config.capabilityPlannerWorkspaceRoot
    ?? DEFAULT_CAPABILITY_PLANNER_WORKSPACE_ROOT;

  return async function capabilityPlannerNode(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const registry = getInvokeRegistry(runnableConfig);
    const allowedCapabilityNames =
      getInvokeOptions(runnableConfig).allowedCapabilityNames;
    const workspace = await materializeCapabilityDocumentWorkspace({
      registry,
      cacheRoot: workspaceRoot,
      ...(allowedCapabilityNames ? { allowedCapabilityNames } : {}),
    });
    const mode = buildPlannerMode(state);
    const context = buildPlannerContext(state);
    const input: CapabilityPlannerInput = {
      mode,
      remainingPlan: state.runCapabilityPlan,
      workspace,
      ...context,
    };
    const result = await runner.invoke(input, runnableConfig);
    const transition = buildPlannerTransition({ state, input, result });
    return new Command({
      update: transition.update,
      goto: transition.goto,
    });
  };
}
