import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from '@langchain/langgraph';
import { type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { materializeCapabilityDocumentWorkspace } from '../../capabilityPlanner/documentWorkspace';
import { createCapabilityPlannerAgent } from '../../capabilityPlanner/agent';
import type {
  CapabilityPlannerDispatch,
  CapabilityPlannerInput,
  CapabilityPlannerResult,
  CapabilityPlannerRuntimeState,
  CapabilityPlannerRunner,
} from '../../capabilityPlanner/runner';
import { materializeDelegation } from '../../delegationBriefing';
import { appendRunDelegationSummary } from '../../delegations';
import type { OrchestratorStateType } from '../../state';
import type {
  CapabilityPlanTask,
  MessageLane,
  OrchestratorConfig,
  PlannerAnswerDisposition,
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
function isPlannerDispatch(
  input: OrchestratorStateType | CapabilityPlannerDispatch,
): input is CapabilityPlannerDispatch {
  return 'plannerState' in input
    && (input.mode === 'entry' || input.mode === 'boundary');
}

function normalizePlannerTask(task: CapabilityPlanTask): CapabilityPlanTask {
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

function normalizePlannerAnswer(
  answer: PlannerAnswerDisposition,
): PlannerAnswerDisposition {
  const reason = answer.reason.trim();
  const context = answer.context.trim();
  const question = answer.question?.trim() || null;
  if (!reason || !context) {
    throw new Error('Capability Planner returned Answer facts with empty text.');
  }
  return { reason, context, question };
}

function materializeNextDelegation(params: {
  state: CapabilityPlannerRuntimeState;
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
    state.runUserGoal,
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
    runPlannerReturn: null,
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
  state: CapabilityPlannerRuntimeState;
  input: CapabilityPlannerInput;
  result: CapabilityPlannerResult;
}) {
  const { state, input, result } = params;
  if (!('tasks' in result)) {
    const answer = normalizePlannerAnswer(result.answer);
    return {
      goto: 'answer' as const,
      update: {
        runNextDelegation: null,
        runPlannerReturn: answer,
        runCapabilityPlan: [],
      },
    };
  }

  const [rawNextTask, ...remainingTasks] = result.tasks;
  if (!rawNextTask) {
    throw new Error('Capability Planner submitted an empty task list.');
  }
  const nextTask = normalizePlannerTask(rawNextTask);
  const remainingPlan = remainingTasks.map(normalizePlannerTask);
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
    registryBackend: config.capabilityRegistryBackend ?? 'filesystem',
  });
}

export function createCapabilityPlannerNode(config: OrchestratorConfig) {
  const runner = config.capabilityPlannerRunner
    ?? createDefaultPlannerRunner(config);

  return async function capabilityPlannerNode(
    nodeInput: OrchestratorStateType | CapabilityPlannerDispatch,
    runnableConfig?: RunnableConfig,
  ) {
    const registry = getInvokeRegistry(runnableConfig);
    const allowedCapabilityNames =
      getInvokeOptions(runnableConfig).allowedCapabilityNames;
    const workspace = await materializeCapabilityDocumentWorkspace({
      registry,
      cacheRoot: DEFAULT_CAPABILITY_PLANNER_WORKSPACE_ROOT,
      ...(allowedCapabilityNames ? { allowedCapabilityNames } : {}),
    });
    if (!isPlannerDispatch(nodeInput)) {
      throw new Error('Capability Planner requires an explicit entry or boundary dispatch.');
    }
    const state = nodeInput.plannerState;
    const input: CapabilityPlannerInput = nodeInput.mode === 'entry'
      ? {
          mode: 'entry',
          userGoal: state.runUserGoal,
          completedTask: null,
          completedTaskResult: null,
          remainingPlan: state.runCapabilityPlan,
          workspace,
        }
      : {
          mode: 'boundary',
          userGoal: state.runUserGoal,
          completedTask: nodeInput.completedTask,
          completedTaskResult: nodeInput.completedTaskResult,
          remainingPlan: state.runCapabilityPlan,
          workspace,
        };
    const result = await runner.invoke(input, runnableConfig);
    const transition = buildPlannerTransition({ state, input, result });
    return new Command({
      update: transition.update,
      goto: transition.goto,
    });
  };
}
