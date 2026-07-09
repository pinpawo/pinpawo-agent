import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { END } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { evaluateGuard } from '../../../../guards';
import {
  buildEmptyRunCapabilitySearchState,
  type OrchestratorStateType,
} from '../../state';
import type {
  MessageLane,
  OrchestratorConfig,
  RunNextDelegation,
  RunPendingTask,
  RunTaskPlanDraft,
  TaskActiveDelegation,
} from '../../types';
import {
  buildDelegationOutcomeDecisionOutputInstruction,
  buildDelegationOutcomeDecisionSchema,
  buildRouteDecisionSchema,
  buildTaskDecisionSchema,
  buildOrchestrationDecisionStructuredOutputOptions,
  parseRouteLane,
  readDecisionText,
  type DelegationOutcomeDecision,
  type RouteDecision,
  type TaskDecision,
} from '../../schemas';
import { commandTo } from '../../controlPrimitives';
import { readContextCompactionSummaries } from '../../contextCompaction';
import {
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildDelegationOutcomeOtherTasksContext,
  buildPreparedRequestContext,
  buildRouteDecisionInput,
  buildRouteDecisionSystemPrompt,
  buildRouteTargetsContext,
  buildRunDelegationSummaryContext,
  buildSubagentAnnounceContext,
  buildTaskDecisionInput,
  buildTaskPlanDraftContext,
  buildTaskDecisionSystemPrompt,
} from '../../prompts';
import { reuseOrAppendRunDelegationSummary } from '../../delegations';
import {
  ACTIVE_DELEGATION_LIMIT_REACHED,
  delegationOutcomeDecisionGuard,
  ORCHESTRATOR_GUARD_POSITION,
} from '../../guardDefinitions';
import {
  buildHandoffArtifactRefs,
  findLatestHandoffCopyForDelegation,
} from '../../artifacts/handoff';
import {
  buildSubagentHandoff,
  getMessageHandoffSource,
  readLatestAnnounce,
  readLatestAnnounceCompletionReason,
  readLatestHumanRequest,
  readRecentAnnounces,
  stampMessageCreatedAtUtc,
} from '../../messageLanes';
import { resolveToolkitResources } from '../../subagentHandoff';
import {
  validateUniqueCapabilityNames,
  validateUniqueToolkitNames,
  validateUniqueToolNames,
} from '../../validation';
import { readMessageText } from '../../utils';
import { invokeStructuredOutput } from '../../../../utils/structuredOutput';
import {
  mainMessagesWithoutCompaction,
} from './capabilityCandidates';
import {
  createTaskActiveDelegation,
  decisionModeFromRunNextDelegation,
} from './delegationLifecycle';
import {
  generalLaneToolkits,
  getInvokeOptions,
  resolveActor,
} from '../config';
import { guardDecisionEmitter } from '../guards/decisionEvents';

type DecisionKind = 'delegation_outcome';

export function createTaskDecisionRunner(config: OrchestratorConfig) {
  return async function runTaskDecision(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const context = buildTaskDecisionContext({ config, state, runnableConfig });
    const decision = await invokeTaskDecision({ config, context, runnableConfig });
    return buildTaskDecisionResult({ decision });
  };
}

export function createRouteDecisionRunner(config: OrchestratorConfig) {
  return async function runRouteDecision(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const context = await buildRouteDecisionContext({ config, state, runnableConfig });
    if (!context.pendingTask) {
      return buildInlineStopResult('当前没有待路由的 delegated task，无法继续执行。');
    }
    const readyContext: RouteDecisionReadyContext = {
      ...context,
      pendingTask: context.pendingTask,
    };
    if (context.decisionCapabilityCandidates.length === 0) {
      return buildRouteDecisionResult({ state, context: readyContext, routeLane: 'general' });
    }

    const decision = await invokeRouteDecision({ config, context, runnableConfig });
    return buildRouteDecisionResult({ state, context: readyContext, routeLane: decision.lane });
  };
}

export function createOrchestrationDecisionRunner(config: OrchestratorConfig) {
  return async function runOrchestrationDecision(
    kind: DecisionKind,
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const context = buildDecisionContext({ config, kind, state, runnableConfig });
    const decision = await invokeDelegationOutcomeDecision({ config, context, runnableConfig });
    return buildDelegationOutcomeDecisionResult({ state, context, decision });
  };
}

function buildTaskDecisionContext(params: {
  config: OrchestratorConfig;
  state: OrchestratorStateType;
  runnableConfig?: RunnableConfig;
}) {
  const { config, state, runnableConfig } = params;
  const {
    workdir,
    runtimeEnvironment,
  } = getInvokeOptions(runnableConfig);
  const actor = resolveActor(config, runnableConfig);
  const latestHumanRequest = readLatestHumanRequest(state.messages);
  const contextSummaries = readContextCompactionSummaries(state.messages);
  const recentMainMessages = mainMessagesWithoutCompaction(state.messages);
  const recentAnnounces = readRecentAnnounces(state.messages);
  const requestContext = buildPreparedRequestContext({
    latestUserRequest: latestHumanRequest,
    recentMessages: recentMainMessages,
    recentAnnounces,
    contextSummaries,
    capabilityArtifacts: state.sessionCapabilityArtifacts,
  });
  const systemPrompt = buildTaskDecisionSystemPrompt({
    actor,
    runDelegationContext: buildRunDelegationSummaryContext(state.runDelegationSummaries),
    workdir,
    runtimeEnvironment,
  });
  const decisionInputMessage = new HumanMessage(buildTaskDecisionInput({
    latestUserRequest: latestHumanRequest,
    recentMessages: recentMainMessages,
    requestContext,
    taskPlanDraftContext: buildTaskPlanDraftContext(state.runTaskPlanDraft),
  }));

  return {
    decisionInputMessage,
    systemPrompt,
  };
}

type TaskDecisionContext = ReturnType<typeof buildTaskDecisionContext>;

async function buildRouteDecisionContext(params: {
  config: OrchestratorConfig;
  state: OrchestratorStateType;
  runnableConfig?: RunnableConfig;
}) {
  const { config, state, runnableConfig } = params;
  const {
    capabilities,
    toolkits,
    execution,
    workdir,
    runtimeEnvironment,
    reviewCapabilities,
    globalReviewPolicy,
  } = getInvokeOptions(runnableConfig);
  const actor = resolveActor(config, runnableConfig);
  const toolkitList = generalLaneToolkits(toolkits ?? []);
  validateUniqueToolkitNames(toolkitList);
  const generalToolkitResources = await resolveToolkitResources(toolkitList, undefined, {
    models: config.models,
    actor,
    messages: state.messages,
    execution,
    reviewCapabilities,
    globalReviewPolicy,
    toolAuthorizations: state.sessionToolAuthorizations,
  }, { includeInstructions: false });
  const generalTools = generalToolkitResources.tools;
  validateUniqueToolNames(generalTools);

  const capabilityList = capabilities ?? [];
  validateUniqueCapabilityNames(capabilityList);
  const decisionCapabilityCandidates = state.runCapabilitySearchState.candidates;
  const targetsContext = buildRouteTargetsContext({
    generalTools,
    capabilityCandidates: decisionCapabilityCandidates,
    capabilitySearchAttempted: state.runCapabilitySearchState.attempted,
    capabilitySearchQuery: state.runCapabilitySearchState.query,
    capabilityRegistryAvailable: capabilityList.length > 0,
  });
  const systemPrompt = buildRouteDecisionSystemPrompt({
    actor,
    targetsContext,
    workdir,
    runtimeEnvironment,
  });
  const decisionInputMessage = new HumanMessage(buildRouteDecisionInput({
    pendingTask: state.runPendingTask,
  }));

  return {
    capabilityList,
    decisionCapabilityCandidates,
    decisionInputMessage,
    generalTools,
    pendingTask: state.runPendingTask,
    systemPrompt,
  };
}

type RouteDecisionContext = Awaited<ReturnType<typeof buildRouteDecisionContext>>;
type RouteDecisionReadyContext = Omit<RouteDecisionContext, 'pendingTask'> & {
  pendingTask: RunPendingTask;
};

function buildDecisionContext(params: {
  config: OrchestratorConfig;
  kind: DecisionKind;
  state: OrchestratorStateType;
  runnableConfig?: RunnableConfig;
}) {
  const { config, state, runnableConfig } = params;
  const {
    workdir,
    runtimeEnvironment,
  } = getInvokeOptions(runnableConfig);
  const actor = resolveActor(config, runnableConfig);
  const latestHumanRequest = readLatestHumanRequest(state.messages);
  const activeDelegation = state.taskActiveDelegation;
  const activeDelegationCapabilityId = activeDelegation
    && activeDelegation.lane.startsWith('capability:')
    ? activeDelegation.lane.slice('capability:'.length)
    : null;
  const activeDelegationArtifactRefs = activeDelegation
    ? buildHandoffArtifactRefs(
        state.sessionCapabilityArtifacts,
        {
          delegationId: activeDelegation.id,
          runId: activeDelegation.transcriptRunId,
          capabilityId: activeDelegationCapabilityId,
        },
      )
    : [];
  const handoffGuardOutcome = evaluateGuard(delegationOutcomeDecisionGuard, {
    state,
    config: {},
    position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_DECISION,
  }, { emit: guardDecisionEmitter(runnableConfig), runId: state.runId });
  const canHandoffActiveDelegation = !(
    handoffGuardOutcome?.kind === 'derive'
    && handoffGuardOutcome.reason === ACTIVE_DELEGATION_LIMIT_REACHED
  );
  const preDecisionHandoffMessages =
    canHandoffActiveDelegation
    && activeDelegation
      ? (() => {
          const proposedMessages = buildSubagentHandoff({
            messages: state.messages,
            lane: activeDelegation.lane,
            runId: activeDelegation.transcriptRunId,
            delegationId: activeDelegation.id,
            artifactRefs: activeDelegationArtifactRefs,
            clearLane: false,
          });
          if (!proposedMessages) return null;
          const proposedCopy = proposedMessages.find(
            (message): message is AIMessage => message._getType() === 'ai',
          );
          if (!proposedCopy) return proposedMessages;

          const latestCopy = findLatestHandoffCopyForDelegation(
            state.messages,
            activeDelegation.id,
            activeDelegation.lane,
            activeDelegation.transcriptRunId,
            getMessageHandoffSource,
          );
          if (!latestCopy) return proposedMessages;

          return readMessageText(latestCopy) === readMessageText(proposedCopy)
            ? null
            : proposedMessages;
        })()
      : null;
  const activeDelegationAnnounce = activeDelegation
    ? readLatestAnnounce(state.messages, {
        runId: activeDelegation.transcriptRunId,
        delegationId: activeDelegation.id,
      })
    : null;
  const activeDelegationCompletionReason = activeDelegation
    ? readLatestAnnounceCompletionReason(state.messages, {
        runId: activeDelegation.transcriptRunId,
        delegationId: activeDelegation.id,
      })
    : null;
  const activeDelegationAnnounceForDecision = activeDelegationAnnounce
    ? { ...activeDelegationAnnounce, artifactRefs: activeDelegationArtifactRefs }
    : null;
  const systemPrompt = buildDelegationOutcomeDecisionSystemPrompt({
      actor,
      outputInstruction: buildDelegationOutcomeDecisionOutputInstruction(),
      workdir,
      runtimeEnvironment,
    });
  const decisionInputMessage = new HumanMessage(buildDelegationOutcomeDecisionInput({
      latestUserRequest: latestHumanRequest,
      currentTaskContext: buildDelegationOutcomeCurrentTaskContext(activeDelegation),
      subagentAnnounceContext: buildSubagentAnnounceContext(
        activeDelegationAnnounceForDecision,
        activeDelegationCompletionReason,
      ),
      otherTasksContext: buildDelegationOutcomeOtherTasksContext(
        state.runDelegationSummaries,
        activeDelegation?.id ?? null,
      ),
      capabilityArtifacts: state.sessionCapabilityArtifacts,
    }));

  return {
    activeDelegation,
    canHandoffActiveDelegation,
    decisionInputMessage,
    preDecisionHandoffMessages,
    systemPrompt,
  };
}

type OrchestrationDecisionContext = ReturnType<typeof buildDecisionContext>;

async function invokeTaskDecision(params: {
  config: OrchestratorConfig;
  context: TaskDecisionContext;
  runnableConfig?: RunnableConfig;
}) {
  const { config, context, runnableConfig } = params;
  try {
    return await invokeStructuredOutput({
      model: config.models.act,
      schema: buildTaskDecisionSchema(),
      options: buildOrchestrationDecisionStructuredOutputOptions(
        config.decisionStructuredOutput,
      ),
      messages: [
        new SystemMessage(context.systemPrompt),
        context.decisionInputMessage,
      ],
      runnableConfig,
    }) as TaskDecision;
  } catch (error) {
    console.warn('[pet-agent] invalid task decision structured output:', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function invokeRouteDecision(params: {
  config: OrchestratorConfig;
  context: RouteDecisionContext;
  runnableConfig?: RunnableConfig;
}) {
  const { config, context, runnableConfig } = params;
  try {
    return await invokeStructuredOutput({
      model: config.models.act,
      schema: buildRouteDecisionSchema({
        capabilityCandidates: context.decisionCapabilityCandidates,
      }),
      options: buildOrchestrationDecisionStructuredOutputOptions(
        config.decisionStructuredOutput,
      ),
      messages: [
        new SystemMessage(context.systemPrompt),
        context.decisionInputMessage,
      ],
      runnableConfig,
    }) as RouteDecision;
  } catch (error) {
    console.warn('[pet-agent] invalid route decision structured output:', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function invokeDelegationOutcomeDecision(params: {
  config: OrchestratorConfig;
  context: OrchestrationDecisionContext;
  runnableConfig?: RunnableConfig;
}) {
  const { config, context, runnableConfig } = params;
  let decision: DelegationOutcomeDecision;
  try {
    decision = await invokeStructuredOutput({
      model: config.models.act,
      schema: buildDelegationOutcomeDecisionSchema(),
      options: buildOrchestrationDecisionStructuredOutputOptions(
        config.decisionStructuredOutput,
      ),
      messages: [
        new SystemMessage(context.systemPrompt),
        context.decisionInputMessage,
      ],
      runnableConfig,
    }) as DelegationOutcomeDecision;
  } catch (error) {
    console.warn('[pet-agent] invalid delegation outcome decision structured output:', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return decision;
}

function buildTaskDecisionResult(params: {
  decision: TaskDecision;
}) {
  const { decision } = params;
  const task = readDecisionText(decision.task);
  const planDraft = normalizePlanDraft(decision.plan_draft);
  if (decision.action === 'answer') {
    return commandTo('answer', {
      runNextDelegation: null,
      runPendingTask: null,
      runTaskPlanDraft: null,
      runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
    });
  }
  if (!task) {
    return buildInlineStopResult('当前 task decision 选择继续执行，但没有提供明确任务。');
  }

  const pendingTask: RunPendingTask = {
    task,
    contextSummary: readDecisionText(decision.context_summary),
    searchKeywords: readDecisionText(decision.search_keywords),
  };
  return commandTo('capabilitySearch', {
    runNextDelegation: null,
    runPendingTask: pendingTask,
    runTaskPlanDraft: planDraft,
    runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
  });
}

function buildRouteDecisionResult(params: {
  state: OrchestratorStateType;
  context: RouteDecisionReadyContext;
  routeLane: RouteDecision['lane'];
}) {
  const { state, context, routeLane } = params;
  const pendingTask = context.pendingTask;

  const parsedLane = parseRouteLane(routeLane);
  const activeCapability = parsedLane.kind === 'capability'
    && parsedLane.capabilityName
    && context.capabilityList.some((item) => item.name === parsedLane.capabilityName)
    ? parsedLane.capabilityName
    : null;
  const delegationLane: MessageLane | null = activeCapability
    ? `capability:${activeCapability}`
    : parsedLane.kind === 'general'
      ? 'general'
      : null;
  if (!delegationLane) {
    return buildInlineStopResult(`当前没有可用的 capability「${parsedLane.capabilityName ?? ''}」，无法继续完成这一步。`);
  }
  if (delegationLane === 'general' && context.generalTools.length === 0) {
    return buildInlineStopResult('我现在没有可用的通用工具执行器，无法继续完成这一步。');
  }

  const runNextDelegation: RunNextDelegation = {
    id: state.taskActiveDelegation && state.taskActiveDelegation.lane === delegationLane
      ? state.taskActiveDelegation.id
      : randomUUID().slice(0, 8),
    lane: delegationLane,
    task: pendingTask.task,
    contextSummary: pendingTask.contextSummary ?? '继续完成用户当前请求。',
  };
  const nextDelegationState = reuseOrAppendRunDelegationSummary(state.runDelegationSummaries, runNextDelegation);
  const nextTaskActiveDelegation = state.taskActiveDelegation
    && state.taskActiveDelegation.id === runNextDelegation.id
    ? {
        ...state.taskActiveDelegation,
        task: runNextDelegation.task,
        contextSummary: runNextDelegation.contextSummary,
        status: 'pending' as const,
        resultPreview: null,
      }
    : createTaskActiveDelegation(runNextDelegation, state.runId);

  const decisionMode = decisionModeFromRunNextDelegation(nextDelegationState.runNextDelegation);
  return commandTo(decisionMode, {
    runNextDelegation: nextDelegationState.runNextDelegation,
    runPendingTask: null,
    runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
    taskActiveDelegation: nextTaskActiveDelegation,
    runDelegationSummaries: nextDelegationState.runDelegationSummaries,
  });
}

function buildInlineStopResult(message: string) {
  return commandTo(END, {
    messages: [stampMessageCreatedAtUtc(new AIMessage(message))],
    runNextDelegation: null,
    runPendingTask: null,
    runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
  });
}

function buildDelegationOutcomeDecisionResult(params: {
  state: OrchestratorStateType;
  context: OrchestrationDecisionContext;
  decision: DelegationOutcomeDecision;
}) {
  const { state, context, decision } = params;
  const activeDelegation = context.activeDelegation;

  if (!activeDelegation) {
    return buildInlineStopResult('当前没有 active delegated task，无法判断执行结果。');
  }

  if (decision.outcome === 'continue') {
    return buildContinueDelegationResult({
      state,
      activeDelegation,
      gapNote: readDecisionText(decision.gap_note),
    });
  }

  return buildCompletedTaskResult({
    state,
    context,
    goto: decision.outcome === 'task_done' ? 'taskDecision' : 'answer',
    clearPlanDraft: decision.outcome === 'goal_done',
  });
}

function normalizePlanDraft(value: TaskDecision['plan_draft']): RunTaskPlanDraft {
  const steps = (value ?? [])
    .map((step) => readDecisionText(step))
    .filter((step): step is string => Boolean(step))
    .slice(0, 5);
  return steps.length > 0 ? steps : null;
}

function buildContinueDelegationResult(params: {
  state: OrchestratorStateType;
  activeDelegation: TaskActiveDelegation;
  gapNote: string | null;
}) {
  const { state, activeDelegation, gapNote } = params;
  const runNextDelegation: RunNextDelegation = {
    id: activeDelegation.id,
    lane: activeDelegation.lane,
    task: activeDelegation.task,
    contextSummary: gapNote ?? activeDelegation.contextSummary ?? '继续完成当前 delegated task。',
  };
  const nextDelegationState = reuseOrAppendRunDelegationSummary(state.runDelegationSummaries, runNextDelegation);
  const nextTaskActiveDelegation: TaskActiveDelegation = {
    ...activeDelegation,
    contextSummary: runNextDelegation.contextSummary,
    status: 'pending',
    resultPreview: null,
  };
  const decisionMode = decisionModeFromRunNextDelegation(nextDelegationState.runNextDelegation);
  return commandTo(decisionMode, {
    runNextDelegation: nextDelegationState.runNextDelegation,
    runPendingTask: null,
    taskActiveDelegation: nextTaskActiveDelegation,
    runDelegationSummaries: nextDelegationState.runDelegationSummaries,
  });
}

function buildCompletedTaskResult(params: {
  state: OrchestratorStateType;
  context: OrchestrationDecisionContext;
  goto: 'taskDecision' | 'answer';
  clearPlanDraft: boolean;
}) {
  const { state, context, goto, clearPlanDraft } = params;
  const {
    activeDelegation,
    canHandoffActiveDelegation,
    preDecisionHandoffMessages,
  } = context;
  if (!activeDelegation) {
    return buildInlineStopResult('当前没有 active delegated task，无法完成任务交接。');
  }
  if (!canHandoffActiveDelegation) {
    return buildInlineStopResult('当前 delegated task 还没有可交接的结果，暂不能完成任务边界切换。请先继续当前 delegated task，或明确说明要放弃它。');
  }

  const handoffMessages: BaseMessage[] = [];
  if (preDecisionHandoffMessages) {
    handoffMessages.push(...preDecisionHandoffMessages);
  }
  const clearLaneMessages = buildSubagentHandoff({
    messages: state.messages,
    lane: activeDelegation.lane,
    runId: activeDelegation.transcriptRunId,
    delegationId: activeDelegation.id,
    clearLane: true,
    includeCopy: false,
  });
  if (!clearLaneMessages) {
    return buildInlineStopResult('当前 delegated task 还没有可交接的结果，暂不能完成任务边界切换。');
  }
  handoffMessages.push(...clearLaneMessages);

  const runDelegationSummaries = state.runDelegationSummaries.map((delegation) =>
    delegation.id === activeDelegation.id
      ? { ...delegation, status: 'completed' as const }
      : delegation);

  return commandTo(goto, {
    messages: handoffMessages,
    runNextDelegation: null,
    runPendingTask: null,
    ...(clearPlanDraft ? { runTaskPlanDraft: null } : {}),
    taskActiveDelegation: null,
    runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
    runDelegationSummaries,
  });
}
