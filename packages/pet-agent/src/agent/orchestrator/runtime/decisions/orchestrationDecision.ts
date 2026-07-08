import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { randomUUID } from 'node:crypto';
import { evaluateGuard } from '../../../../guards';
import {
  buildEmptyRunCapabilitySearchState,
  type OrchestratorStateType,
} from '../../state';
import type {
  DecisionMode,
  MessageLane,
  OrchestratorConfig,
  RunFinalReplyRoute,
  RunNextDelegation,
  RunPendingTask,
  TaskActiveDelegation,
} from '../../types';
import {
  buildRouteDecisionSchema,
  buildTaskDecisionSchema,
  buildOrchestrationDecisionOutputInstruction,
  buildOrchestrationDecisionSchema,
  buildOrchestrationDecisionStructuredOutputOptions,
  parseAction,
  parseRouteLane,
  readDecisionText,
  type RouteDecision,
  type TaskDecision,
  type OrchestrationDecision,
} from '../../schemas';
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
  buildCapabilityCandidatesFromLanes,
  mainMessagesWithoutCompaction,
} from './capabilityCandidates';
import { createTaskActiveDelegation } from './delegationLifecycle';
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
    return buildTaskDecisionResult({ state, decision });
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
    const context = await buildDecisionContext({ config, kind, state, runnableConfig });
    const decision = await invokeDecision({ config, context, runnableConfig });
    return buildDecisionResult({ kind, state, context, decision });
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

async function buildDecisionContext(params: {
  config: OrchestratorConfig;
  kind: DecisionKind;
  state: OrchestratorStateType;
  runnableConfig?: RunnableConfig;
}) {
  const { config, kind, state, runnableConfig } = params;
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
  // Unfinished delegation lifecycle is explicit task state. Lane announces are
  // transcript storage and context, not normal control-flow authority.
  const decisionCapabilityCandidates = buildCapabilityCandidatesFromLanes(
    capabilityList,
    [activeDelegationAnnounce?.lane ?? activeDelegation?.lane],
  );
  const outputInstruction = buildOrchestrationDecisionOutputInstruction({
    capabilityCandidates: decisionCapabilityCandidates,
  });
  const systemPrompt = buildDelegationOutcomeDecisionSystemPrompt({
      actor,
      outputInstruction,
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
    capabilityList,
    decisionCapabilityCandidates,
    decisionInputMessage,
    generalTools,
    latestHumanRequest,
    preDecisionHandoffMessages,
    systemPrompt,
  };
}

type OrchestrationDecisionContext = Awaited<ReturnType<typeof buildDecisionContext>>;

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

async function invokeDecision(params: {
  config: OrchestratorConfig;
  context: OrchestrationDecisionContext;
  runnableConfig?: RunnableConfig;
}) {
  const { config, context, runnableConfig } = params;
  const decisionSchema = buildOrchestrationDecisionSchema({
    capabilityCandidates: context.decisionCapabilityCandidates,
  });
  let decision: OrchestrationDecision;
  try {
    decision = await invokeStructuredOutput({
      model: config.models.act,
      schema: decisionSchema,
      options: buildOrchestrationDecisionStructuredOutputOptions(
        config.decisionStructuredOutput,
      ),
      messages: [
        new SystemMessage(context.systemPrompt),
        context.decisionInputMessage,
      ],
      runnableConfig,
    }) as OrchestrationDecision;
  } catch (error) {
    console.warn('[pet-agent] invalid orchestration decision structured output:', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return decision;
}

function buildTaskDecisionResult(params: {
  state: OrchestratorStateType;
  decision: TaskDecision;
}) {
  const { decision } = params;
  const task = readDecisionText(decision.task);
  if (decision.action === 'answer') {
    return {
      runNextDelegation: null,
      runPendingTask: null,
      runPendingFinalReply: 'answer' as const,
      runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
    };
  }
  if (!task) {
    return buildInlineStopResult('当前 task decision 选择继续执行，但没有提供明确任务。');
  }

  const pendingTask: RunPendingTask = {
    task,
    contextSummary: readDecisionText(decision.context_summary),
    searchKeywords: readDecisionText(decision.search_keywords),
  };
  return {
    runNextDelegation: null,
    runPendingTask: pendingTask,
    runPendingFinalReply: null,
    runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
  };
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

  return {
    runNextDelegation: nextDelegationState.runNextDelegation,
    runPendingTask: null,
    runPendingFinalReply: null,
    runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
    taskActiveDelegation: nextTaskActiveDelegation,
    runDelegationSummaries: nextDelegationState.runDelegationSummaries,
  };
}

function buildInlineStopResult(message: string) {
  return {
    messages: [stampMessageCreatedAtUtc(new AIMessage(message))],
    runNextDelegation: null,
    runPendingTask: null,
    runPendingFinalReply: 'inline' as const,
    runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
  };
}

function buildDecisionResult(params: {
  kind: DecisionKind;
  state: OrchestratorStateType;
  context: OrchestrationDecisionContext;
  decision: OrchestrationDecision;
}) {
  const { kind, state, context, decision } = params;
  const {
    activeDelegation,
    canHandoffActiveDelegation,
    capabilityList,
    generalTools,
    latestHumanRequest,
    preDecisionHandoffMessages,
  } = context;
  const { kind: actionKind, capabilityName: requestedCapability } = parseAction(decision.action);
  const activeCapability = requestedCapability
    && capabilityList.some((item) => item.name === requestedCapability)
    ? requestedCapability
    : null;
  const decisionTask = readDecisionText(decision.task);
  const decisionContextSummary = readDecisionText(decision.context_summary);

  const decisionMode: DecisionMode =
    actionKind === 'delegate_general' && generalTools.length > 0 && decisionTask
      ? 'general'
      : actionKind === 'delegate_capability' && activeCapability && decisionTask
        ? 'capability'
        : 'answer';

  // Decision nodes only route. An `answer` decision routes to the dedicated answer
  // node; degenerate delegate fallbacks still emit fixed inline errors because
  // there is no valid next node to run.
  const inlineReply = decisionMode === 'answer'
    ? actionKind === 'answer'
      ? null
      : actionKind === 'delegate_general' && generalTools.length === 0
        ? '我现在没有可用的通用工具执行器，无法继续完成这一步。'
        : actionKind === 'delegate_capability' && !activeCapability
          ? `当前没有可用的 capability「${requestedCapability ?? ''}」，无法继续完成这一步。`
          : !decisionTask
            ? '当前决策选择继续 delegate，但没有提供明确任务。'
            : '当前决策已结束，但没有生成可展示的回复。'
    : null;

  const runPendingFinalReply: RunFinalReplyRoute =
    decisionMode !== 'answer'
      ? null
      : inlineReply
        ? 'inline'
        : 'answer';

  const delegationLane: MessageLane | null = decisionMode === 'general'
    ? 'general'
    : activeCapability
      ? `capability:${activeCapability}`
      : null;
  const delegationTask = decisionMode !== 'answer'
    ? decisionTask ?? latestHumanRequest ?? '继续完成用户当前请求'
    : null;
  const delegationContextSummary = decisionMode !== 'answer'
    ? decisionContextSummary ?? '继续完成用户当前请求。'
    : null;
  const runNextDelegation: RunNextDelegation | null = delegationLane && delegationTask
    ? {
        id: activeDelegation && activeDelegation.lane === delegationLane
          ? activeDelegation.id
          : randomUUID().slice(0, 8),
        lane: delegationLane,
        task: delegationTask,
        contextSummary: delegationContextSummary,
      }
    : null;
  const nextDelegationState = reuseOrAppendRunDelegationSummary(state.runDelegationSummaries, runNextDelegation);

  // Handoff (D1): copy the active subagent announce into the main queue before
  // the next decision branch runs.
  // - answer decision: announce is final for this delegation (old lane transcript
  //   can be cleared).
  // - continue decision: preserve lane transcript and do not write a main
  //   handoff copy yet; a non-terminal announce is only decision context.
  //
  // Single-line delegation handoff is driven by taskActiveDelegation. run
  // summaries are not the source of truth for unfinished task lifecycle.
  const replacingActiveDelegation = kind === 'delegation_outcome'
    && Boolean(activeDelegation && runNextDelegation && activeDelegation.id !== runNextDelegation.id);
  const handoffMessages: BaseMessage[] = [];
  const handedOffDelegationIds = new Set<string>();
  const shouldClearLaneForHandoff = kind === 'delegation_outcome'
    && actionKind === 'answer'
    && canHandoffActiveDelegation
    && Boolean(activeDelegation);
  if ((shouldClearLaneForHandoff || replacingActiveDelegation) && preDecisionHandoffMessages) {
    handoffMessages.push(...preDecisionHandoffMessages);
  }
  if ((shouldClearLaneForHandoff || replacingActiveDelegation) && activeDelegation) {
    const messages = buildSubagentHandoff({
      messages: state.messages,
      lane: activeDelegation.lane,
      runId: activeDelegation.transcriptRunId,
      delegationId: activeDelegation.id,
      clearLane: shouldClearLaneForHandoff || replacingActiveDelegation,
      includeCopy: false,
    });
    if (messages) {
      handoffMessages.push(...messages);
      handedOffDelegationIds.add(activeDelegation.id);
    }
  }
  const replacementBlocked = replacingActiveDelegation
    && activeDelegation !== null
    && !handedOffDelegationIds.has(activeDelegation.id);
  const replacementBlockedText = '当前 delegated task 还没有可交接的结果，暂不能切换到新的执行器。请先继续当前 delegated task，或明确说明要放弃它。';
  const blockedReplacementMessage = replacementBlocked
    ? stampMessageCreatedAtUtc(new AIMessage(replacementBlockedText))
    : null;

  // A handed-off delegation is, by the orchestrator's judgment, complete.
  const shouldMarkDelegationComplete = actionKind === 'answer' || replacingActiveDelegation;
  const finalRunDelegationSummaries = handedOffDelegationIds.size > 0 && shouldMarkDelegationComplete
    ? nextDelegationState.runDelegationSummaries.map((delegation) =>
        handedOffDelegationIds.has(delegation.id)
          ? { ...delegation, status: 'completed' as const }
          : delegation)
    : nextDelegationState.runDelegationSummaries;

  let nextTaskActiveDelegation: TaskActiveDelegation | null;
  const shouldClearTaskActiveDelegation = shouldClearLaneForHandoff;
  if (replacementBlocked) {
    nextTaskActiveDelegation = activeDelegation;
  } else if (shouldClearTaskActiveDelegation) {
    nextTaskActiveDelegation = null;
  } else if (runNextDelegation) {
    nextTaskActiveDelegation = activeDelegation && activeDelegation.id === runNextDelegation.id
      ? {
          ...activeDelegation,
          task: runNextDelegation.task,
          contextSummary: runNextDelegation.contextSummary,
          status: 'pending' as const,
          resultPreview: null,
        }
      : createTaskActiveDelegation(runNextDelegation, state.runId);
  } else {
    nextTaskActiveDelegation = activeDelegation;
  }

  return {
    messages: [
      ...handoffMessages,
      ...(blockedReplacementMessage ? [blockedReplacementMessage] : []),
      ...(inlineReply ? [stampMessageCreatedAtUtc(new AIMessage(inlineReply))] : []),
    ],
    runNextDelegation: replacementBlocked ? null : nextDelegationState.runNextDelegation,
    runPendingFinalReply: replacementBlocked ? 'inline' : runPendingFinalReply,
    taskActiveDelegation: nextTaskActiveDelegation,
    ...(kind === 'delegation_outcome'
      ? {
          runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
        }
      : {}),
    runDelegationSummaries: replacementBlocked ? state.runDelegationSummaries : finalRunDelegationSummaries,
  };
}
