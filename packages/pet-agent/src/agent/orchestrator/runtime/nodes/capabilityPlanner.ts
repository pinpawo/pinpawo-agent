import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from '@langchain/langgraph';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { materializeCapabilityDocumentWorkspace } from '../../capabilityPlanner/documentWorkspace';
import { createCapabilityPlannerAgent } from '../../capabilityPlanner/agent';
import type {
  CapabilityPlannerInput,
  CapabilityPlannerResult,
  CapabilityPlannerRunner,
} from '../../capabilityPlanner/runner';
import { materializeDelegation } from '../../delegationBriefing';
import { appendRunDelegationSummary } from '../../delegations';
import { isContextCompactionMessage } from '../../contextCompaction';
import { mainConversationMessages } from '../../messageLanes';
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
function buildPlannerMode(state: OrchestratorStateType): CapabilityPlannerInput['mode'] {
  return state.runDelegationSummaries.length === 0
    ? 'entry'
    : 'boundary';
}

function buildPlannerContext(state: OrchestratorStateType) {
  const messages = mainConversationMessages(state.messages).flatMap((message) => {
    const type = message._getType();
    if (type === 'human' || type === 'ai') return [message];
    return isContextCompactionMessage(message) ? [new AIMessage(message.content)] : [];
  });
  const latestCompletedDelegation = [...state.runDelegationSummaries]
    .reverse()
    .find((item) => item.status === 'completed');
  return {
    messages,
    completedTask: latestCompletedDelegation?.task ?? null,
    completedTaskResult: latestCompletedDelegation?.resultPreview ?? null,
  };
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
  state: OrchestratorStateType;
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
    state: OrchestratorStateType,
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
