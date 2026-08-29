import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  buildHandoffArtifactRefs,
  type HandOffArtifactRef,
} from '../../artifacts/handoff';
import { getDelegationAnnounce } from '../../delegationAnnounce';
import {
  getMessageHandoffSource,
  mainConversationMessages,
  readLatestAnnounce,
  stampMessageCreatedAtUtc,
} from '../../messageLanes';
import {
  buildResultSynthesisInvocationMessages,
  type ResultSynthesisAcceptedResult,
} from '../../prompts';
import { snapshotPlannerTaskContinuation } from '../../capabilityPlanner/session';
import type { OrchestratorStateType } from '../../state';
import type { RunTerminalOutcome } from '../../terminalOutcome';
import type { OrchestratorConfig } from '../../types';
import { readMessageText } from '../../utils';
import { resolveActor } from '../config';
import { readCapabilityNameFromLane } from '../decisions/delegationLifecycle';

export function collectAcceptedRunResults(params: {
  state: OrchestratorStateType;
  history: BaseMessage[];
}): ResultSynthesisAcceptedResult[] {
  const results: ResultSynthesisAcceptedResult[] = [];

  for (const delegation of params.state.runDelegationSummaries) {
    if (delegation.status !== 'completed') continue;
    const matchingHandoffs = params.history.filter((message) => {
      const source = getMessageHandoffSource(message);
      return source?.delegationId === delegation.id
        && source.handoffFrom === delegation.lane;
    });
    const handoffMessage = matchingHandoffs.at(-1);
    if (!handoffMessage) continue;
    const source = getMessageHandoffSource(handoffMessage);
    if (!source) continue;
    const announce = getDelegationAnnounce(handoffMessage);
    const result = announce?.result ?? readMessageText(handoffMessage);
    if (!result) continue;
    results.push({
      task: source.task ?? delegation.task,
      result,
      artifactRefs: buildHandoffArtifactRefs(
        params.state.sessionCapabilityArtifacts,
        {
          delegationId: delegation.id,
          runId: source.runId,
          capabilityId: readCapabilityNameFromLane(delegation.lane),
        },
      ),
    });
  }

  return results;
}

export const CHECKPOINT_INCOMPATIBLE_MESSAGE =
  '这个任务由旧版本创建，当前版本无法继续。请重新发起或重述任务。';

function renderArtifactLinks(refs: readonly HandOffArtifactRef[]): string {
  if (refs.length === 0) return '';
  return [
    '',
    '',
    '产物：',
    ...refs.map((ref) => `- ${ref.title ?? ref.kind}: ${ref.uri}`),
  ].join('\n');
}

function renderSingleAcceptedResult(result: ResultSynthesisAcceptedResult): string {
  return `${result.result}${renderArtifactLinks(result.artifactRefs)}`;
}

function currentTask(state: OrchestratorStateType): string | null {
  return state.taskActiveDelegation?.task ?? state.runUserRequest ?? null;
}

function renderTerminalOutcome(
  state: OrchestratorStateType,
  outcome: Exclude<RunTerminalOutcome, { kind: 'goal_done' }>,
): string {
  if (outcome.kind === 'direct_response') return outcome.content;
  if (outcome.kind === 'checkpoint_incompatible') {
    return CHECKPOINT_INCOMPATIBLE_MESSAGE;
  }
  if (outcome.kind === 'user_input_required') {
    const active = state.taskActiveDelegation;
    const announce = active
      ? readLatestAnnounce(state.messages, {
          transcriptRunId: active.transcriptRunId,
          delegationId: active.id,
        })
      : null;
    const context = announce?.text?.trim() ?? '';
    const artifacts = active
      ? renderArtifactLinks(buildHandoffArtifactRefs(
          state.sessionCapabilityArtifacts,
          {
            runId: active.transcriptRunId,
            delegationId: active.id,
            capabilityId: readCapabilityNameFromLane(active.lane),
          },
        ))
      : '';
    const progress = `${context}${artifacts}`.trim();
    return progress ? `${progress}\n\n${outcome.question}` : outcome.question;
  }
  const task = currentTask(state);
  const taskSuffix = task ? `\n\n未完成任务：${task}` : '';
  if (outcome.kind === 'unavailable') {
    return `当前没有可用于继续执行这项任务的能力。${taskSuffix}`;
  }
  if (outcome.kind === 'iteration_limit') {
    return `本次运行已达到主流程迭代上限，当前任务仍可在后续运行中继续。${taskSuffix}`;
  }
  if (outcome.kind === 'execution_limit') {
    return `执行器已达到本次执行上限，当前任务尚未完成。${taskSuffix}`;
  }
  if (outcome.kind === 'planner_incomplete') {
    return `Planner 没有形成终态决策，当前任务未被标记为完成。${taskSuffix}`;
  }
  return `当前工作没有形成可交付结果。${taskSuffix}`;
}

function buildFinalizeRunCleanup(
  state: OrchestratorStateType,
  outcome: RunTerminalOutcome,
) {
  const continuation = outcome.kind === 'checkpoint_incompatible'
    ? null
    : snapshotPlannerTaskContinuation({
        activeDelegation: state.taskActiveDelegation,
        plannerSession: state.runPlannerSession,
      });
  return {
    runNextDelegation: null,
    runPlannerSession: null,
    taskPlannerContinuation: continuation,
    runIterationCount: 0,
    runTerminalOutcome: null,
    runTerminalError: null,
  };
}

export function createFinalizeRunNode(config: OrchestratorConfig) {
  return async function finalizeRunNode(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const outcome = state.runTerminalOutcome;
    if (!outcome) {
      throw new Error('finalizeRun requires a terminal outcome.');
    }
    const cleanup = buildFinalizeRunCleanup(state, outcome);

    if (outcome.kind !== 'goal_done') {
      return {
        messages: [stampMessageCreatedAtUtc(new AIMessage(
          renderTerminalOutcome(state, outcome),
        ))],
        ...(outcome.kind === 'checkpoint_incompatible'
          ? { taskActiveDelegation: null }
          : {}),
        ...cleanup,
      };
    }

    const acceptedResults = collectAcceptedRunResults({
      state,
      history: mainConversationMessages(state.messages),
    });
    if (acceptedResults.length === 0) {
      return {
        messages: [stampMessageCreatedAtUtc(new AIMessage('任务已完成。'))],
        ...cleanup,
      };
    }
    if (acceptedResults.length === 1) {
      return {
        messages: [stampMessageCreatedAtUtc(new AIMessage(
          renderSingleAcceptedResult(acceptedResults[0]!),
        ))],
        ...cleanup,
      };
    }

    const response = await (config.models.answer ?? config.models.act).invoke(
      buildResultSynthesisInvocationMessages({
        actor: resolveActor(config, runnableConfig),
        userRequest: state.runUserRequest,
        acceptedResults,
      }),
      runnableConfig,
    );
    const content = readMessageText(response).trim()
      ? response
      : new AIMessage(acceptedResults.map(renderSingleAcceptedResult).join('\n\n'));
    return {
      messages: [stampMessageCreatedAtUtc(content)],
      ...cleanup,
    };
  };
}
