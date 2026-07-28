import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { GENERAL_CAPABILITY_NAME } from '../../../../types/capability';
import { materializeCapabilityDocumentWorkspace } from '../../capabilityDocumentWorkspace';
import { createCapabilityPlannerAgent } from '../../capabilityPlannerAgent';
import type {
  CapabilityPlannerInput,
  CapabilityPlannerNextTask,
  CapabilityPlannerResult,
  CapabilityPlannerRunner,
} from '../../capabilityPlannerRunner';
import { readContextCompactionSummaries } from '../../contextCompaction';
import { materializeDelegation } from '../../delegationBriefing';
import { appendRunDelegationSummary } from '../../delegations';
import {
  buildPreparedRequestContext,
} from '../../prompts';
import {
  getMessageHandoffSource,
  readLatestHumanRequest,
} from '../../messageLanes';
import type { OrchestratorStateType } from '../../state';
import type {
  CapabilityPlanTask,
  MessageLane,
  OrchestratorConfig,
  RunNextDelegation,
} from '../../types';
import { readMessageText } from '../../utils';
import {
  getInvokeOptions,
  getInvokeRegistry,
} from '../config';
import { mainMessagesWithoutCompaction } from '../decisions/conversationContext';
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
  const latestHumanRequest = readLatestHumanRequest(state.messages);
  const latestCompletedDelegation = [...state.runDelegationSummaries]
    .reverse()
    .find((item) => item.status === 'completed');
  const latestHandoff = latestCompletedDelegation
    ? [...state.messages]
        .reverse()
        .find((message) => {
          const source = getMessageHandoffSource(message);
          return source?.delegationId === latestCompletedDelegation.id
            && source.handoffFrom === latestCompletedDelegation.lane;
        })
    : null;

  return {
    userIntentContext: buildPreparedRequestContext({
      latestUserRequest: latestHumanRequest,
      recentMessages: mainMessagesWithoutCompaction(state.messages),
      contextSummaries: readContextCompactionSummaries(state.messages),
    }),
    completedTasks: state.runDelegationSummaries
      .filter((item) => item.status === 'completed')
      .map((item) => ({
        objective: item.task,
        result: item.resultPreview,
      })),
    latestHandoff: latestHandoff ? readMessageText(latestHandoff) : null,
  };
}

function normalizeRemainingPlan(
  result: Extract<CapabilityPlannerResult, { result: 'next_task' }>,
): CapabilityPlanTask[] {
  return result.remaining_plan.map((item) => ({
    objective: item.objective.trim(),
    capabilityIntent: item.capability_intent.trim(),
  }));
}

function materializeNextDelegation(params: {
  state: OrchestratorStateType;
  nextTask: CapabilityPlannerNextTask;
  remainingPlan: CapabilityPlanTask[];
  allowedCapabilityNames: readonly string[];
}) {
  const {
    state,
    nextTask,
    remainingPlan,
    allowedCapabilityNames,
  } = params;
  if (!allowedCapabilityNames.includes(nextTask.capability_name)) {
    throw new Error(
      `Capability Planner selected "${nextTask.capability_name}" outside the immutable workspace.`,
    );
  }
  if (
    remainingPlan.some((item) =>
      item.objective === nextTask.objective
      && item.capabilityIntent === nextTask.capability_intent)
  ) {
    throw new Error('Capability Planner remaining plan repeats the current task.');
  }

  const lane: MessageLane = `capability:${nextTask.capability_name}`;
  const runNextDelegation: RunNextDelegation = {
    id: randomUUID().slice(0, 8),
    lane,
    task: nextTask.objective,
    contextSummary: nextTask.context_summary,
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
    essentialContext: nextTask.context_summary,
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
  if (result.result === 'unavailable') {
    if (input.workspace.capabilityNames.includes(GENERAL_CAPABILITY_NAME)) {
      throw new Error(
        'Capability Planner returned unavailable while the general Capability is registered.',
      );
    }
    return {
      goto: 'answer' as const,
      update: {
        runNextDelegation: null,
        runPendingTask: {
          task: result.task,
          contextSummary: result.reason,
        },
        runCapabilityPlan: [],
      },
    };
  }

  const remainingPlan = normalizeRemainingPlan(result);
  return {
    goto: 'capability' as const,
    update: materializeNextDelegation({
      state,
      nextTask: result.next_task,
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
