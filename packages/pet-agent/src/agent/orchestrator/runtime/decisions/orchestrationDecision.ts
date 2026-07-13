import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { evaluateGuard } from '../../../../guards';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorStatePatch } from '../../controlPrimitives';
import type {
  MessageLane,
  OrchestratorConfig,
  RunNextDelegation,
  RunPendingTask,
  TaskActiveDelegation,
} from '../../types';
import {
  buildDelegationOutcomeDecisionOutputInstruction,
  buildDelegationOutcomeDecisionSchema,
  buildCapabilityPlanningDecisionOutputInstruction,
  buildCapabilityPlanningDecisionSchema,
  buildRouteDecisionOutputInstruction,
  buildRouteDecisionSchema,
  buildTaskDecisionOutputInstruction,
  buildTaskDecisionSchema,
  buildOrchestrationDecisionStructuredOutputOptions,
  parseRouteLane,
  readDecisionText,
  type DelegationOutcomeDecision,
  type RouteDecision,
  type TaskDecision,
  type CapabilityPlanningDecision,
} from '../../schemas';
import { readContextCompactionSummaries } from '../../contextCompaction';
import {
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildDelegationOutcomeOtherTasksContext,
  buildCapabilityPlanningDecisionInput,
  buildCapabilityPlanningDecisionSystemPrompt,
  buildCompactionSummaryXmlContext,
  buildPreparedRequestContext,
  buildRouteDecisionInput,
  buildRouteDecisionSystemPrompt,
  buildRouteTargetsContext,
  buildRunDelegationSummaryContext,
  buildRuntimeContext,
  buildSubagentAnnounceContext,
  buildTaskDecisionInput,
  buildTaskDecisionSystemPrompt,
} from '../../prompts';
import {
  appendRunDelegationSummary,
  resumeRunDelegationSummary,
} from '../../delegations';
import {
  buildContinuationBriefingMessage,
  buildDelegationBriefingMessage,
} from '../../delegationBriefing';
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
} from '../../messageLanes';
import { resolveToolkitResources } from '../../subagentDispatch';
import {
  validateUniqueCapabilityNames,
  validateUniqueToolkitNames,
  validateUniqueToolNames,
} from '../../validation';
import { readMessageText } from '../../utils';
import { searchCapabilities } from '../../capabilitySearch';
import { invokeStructuredOutput } from '../../../../utils/structuredOutput';
import {
  mainMessagesWithoutCompaction,
} from './capabilityCandidates';
import {
  createTaskActiveDelegation,
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
    const transition = buildTaskDecisionResult({ state, decision });
    return new Command({ update: transition.update, goto: transition.goto });
  };
}

export function createCapabilityPlanningDecisionRunner(config: OrchestratorConfig) {
  return async function runCapabilityPlanningDecision(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const context = buildCapabilityPlanningContext({ config, state, runnableConfig });
    const decision = await invokeCapabilityPlanningDecision({ config, context, runnableConfig });
    const transition = buildCapabilityPlanningResult(decision);
    return new Command({ update: transition.update, goto: transition.goto });
  };
}

export function createCapabilityDecisionRunner(config: OrchestratorConfig) {
  return async function runCapabilityDecision(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const context = await buildCapabilityDecisionContext({ config, state, runnableConfig });
    if (!context.pendingTask) {
      throw new Error('capabilityDecision requires runPendingTask');
    }
    const readyContext: CapabilityDecisionReadyContext = {
      ...context,
      pendingTask: context.pendingTask,
    };
    if (context.decisionCapabilityCandidates.length === 0) {
      return buildCapabilityDecisionResult({ state, context: readyContext, routeLane: 'general' });
    }

    const decision = await invokeCapabilityDecision({ config, context, runnableConfig });
    return buildCapabilityDecisionResult({ state, context: readyContext, routeLane: decision.lane });
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
    const transition = buildDelegationOutcomeDecisionResult({ state, context, decision });
    return new Command({
      update: transition.update,
      goto: transition.goto,
    });
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
  const contextSummaries = readContextCompactionSummaries(state.messages);
  const compactionContext = buildCompactionSummaryXmlContext(contextSummaries);
  const conversationMessages = [
    ...(compactionContext ? [new AIMessage(compactionContext)] : []),
    ...mainMessagesWithoutCompaction(state.messages)
      .filter((message) => message._getType() === 'human' || message._getType() === 'ai'),
  ];
  const systemPrompt = buildTaskDecisionSystemPrompt({
    actor,
    outputInstruction: buildTaskDecisionOutputInstruction(
      config.decisionStructuredOutput?.method,
    ),
  });
  const decisionContextMessage = new SystemMessage(buildTaskDecisionInput({
    capabilityArtifacts: state.sessionCapabilityArtifacts,
    runDelegationContext: buildRunDelegationSummaryContext(state.runDelegationSummaries),
    runtimeContext: buildRuntimeContext(workdir, runtimeEnvironment),
  }));

  return {
    conversationMessages,
    decisionContextMessage,
    systemPrompt,
  };
}

type TaskDecisionContext = ReturnType<typeof buildTaskDecisionContext>;

async function buildCapabilityDecisionContext(params: {
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
  const query = [state.runPendingTask?.task, state.runPendingTask?.contextSummary]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
    .join(' | ');
  const forcedCapabilityNames = getInvokeOptions(runnableConfig).forcedCapabilityNames ?? [];
  const forcedNames = new Set(forcedCapabilityNames);
  const decisionCapabilityCandidates = forcedNames.size > 0
    ? capabilityList
        .filter((capability) => forcedNames.has(capability.name))
        .map((capability) => ({ name: capability.name, description: capability.description, score: 1, matchedTerms: ['forced'] }))
    : query ? searchCapabilities(query, capabilityList) : [];
  const targetsContext = buildRouteTargetsContext({
    generalTools,
    capabilityCandidates: decisionCapabilityCandidates,
    capabilitySearchAttempted: true,
    capabilitySearchQuery: query || null,
    capabilityRegistryAvailable: capabilityList.length > 0,
  });
  const systemPrompt = buildRouteDecisionSystemPrompt({
    actor,
    outputInstruction: buildRouteDecisionOutputInstruction(
      { capabilityCandidates: decisionCapabilityCandidates },
      config.decisionStructuredOutput?.method,
    ),
  });
  const decisionInputMessage = new HumanMessage(buildRouteDecisionInput({
    pendingTask: state.runPendingTask,
    targetsContext,
    runtimeContext: buildRuntimeContext(workdir, runtimeEnvironment),
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

function buildCapabilityPlanningContext(params: {
  config: OrchestratorConfig;
  state: OrchestratorStateType;
  runnableConfig?: RunnableConfig;
}) {
  const { config, state, runnableConfig } = params;
  const actor = resolveActor(config, runnableConfig);
  const latestHumanRequest = readLatestHumanRequest(state.messages);
  const userIntentContext = buildPreparedRequestContext({
    latestUserRequest: latestHumanRequest,
    recentMessages: mainMessagesWithoutCompaction(state.messages),
    recentAnnounces: [],
    contextSummaries: readContextCompactionSummaries(state.messages),
  });
  const capabilityList = getInvokeOptions(runnableConfig).capabilities ?? [];
  validateUniqueCapabilityNames(capabilityList);
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
  const mode = state.runDelegationSummaries.length === 0 && state.runCapabilityPlan.length === 0
    ? 'entry' as const
    : 'boundary' as const;
  return {
    mode,
    decisionInputMessage: new HumanMessage(buildCapabilityPlanningDecisionInput({
      mode,
      userIntentContext,
      remainingPlan: state.runCapabilityPlan,
      latestHandoff: latestHandoff ? readMessageText(latestHandoff) : null,
      capabilityRegistryContext: capabilityList.length > 0
        ? capabilityList.map((item) => `${item.name}: ${item.description}`).join('\n')
        : 'No custom capabilities registered; general capability remains available.',
    })),
    systemPrompt: buildCapabilityPlanningDecisionSystemPrompt({
      actor,
      outputInstruction: buildCapabilityPlanningDecisionOutputInstruction(config.decisionStructuredOutput?.method),
    }),
  };
}

type CapabilityPlanningContext = ReturnType<typeof buildCapabilityPlanningContext>;

type CapabilityDecisionContext = Awaited<ReturnType<typeof buildCapabilityDecisionContext>>;
type CapabilityDecisionReadyContext = Omit<CapabilityDecisionContext, 'pendingTask'> & {
  pendingTask: RunPendingTask;
};

function buildDecisionContext(params: {
  config: OrchestratorConfig;
  kind: DecisionKind;
  state: OrchestratorStateType;
  runnableConfig?: RunnableConfig;
}) {
  const { config, state, runnableConfig } = params;
  const actor = resolveActor(config, runnableConfig);
  const latestHumanRequest = readLatestHumanRequest(state.messages);
  const userIntentContext = buildPreparedRequestContext({
    latestUserRequest: latestHumanRequest,
    recentMessages: mainMessagesWithoutCompaction(state.messages),
    recentAnnounces: [],
    contextSummaries: readContextCompactionSummaries(state.messages),
  });
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
    outputInstruction: buildDelegationOutcomeDecisionOutputInstruction(
      config.decisionStructuredOutput?.method,
    ),
  });
  const decisionInputMessage = new HumanMessage(buildDelegationOutcomeDecisionInput({
    userIntentContext,
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
        context.decisionContextMessage,
        ...context.conversationMessages,
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

async function invokeCapabilityDecision(params: {
  config: OrchestratorConfig;
  context: CapabilityDecisionContext;
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

async function invokeCapabilityPlanningDecision(params: {
  config: OrchestratorConfig;
  context: CapabilityPlanningContext;
  runnableConfig?: RunnableConfig;
}) {
  const { config, context, runnableConfig } = params;
  return await invokeStructuredOutput({
    model: config.models.act,
    schema: buildCapabilityPlanningDecisionSchema(),
    options: buildOrchestrationDecisionStructuredOutputOptions(config.decisionStructuredOutput),
    messages: [new SystemMessage(context.systemPrompt), context.decisionInputMessage],
    runnableConfig,
  }) as CapabilityPlanningDecision;
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
  state: OrchestratorStateType;
  decision: TaskDecision;
}) {
  const { state, decision } = params;
  const task = readDecisionText(decision.task);
  if (decision.action === 'answer') {
    return {
      goto: 'answer' as const,
      update: {
        runNextDelegation: null,
        runPendingTask: null,
        runCapabilityPlan: [],
      },
    };
  }
  if (decision.action === 'needs_plan') {
    return {
      goto: 'capabilityPlanner' as const,
      update: {
        runNextDelegation: null,
        runPendingTask: null,
        runCapabilityPlan: [],
      },
    };
  }
  if (!task) {
    throw new Error('entryDecision returned direct_task without a task');
  }

  const pendingTask: RunPendingTask = {
    task,
    contextSummary: readDecisionText(decision.context_summary),
    searchKeywords: null,
  };
  return {
    goto: 'capabilityDecision' as const,
    update: {
      runNextDelegation: null,
      runPendingTask: pendingTask,
      runCapabilityPlan: [],
    },
  };
}

function buildCapabilityPlanningResult(decision: CapabilityPlanningDecision) {
  const remainingPlan = decision.remaining_plan.map((item) => ({
    objective: item.objective.trim(),
    capabilityIntent: item.capability_intent.trim(),
    status: item.status,
  }));
  if (decision.result === 'answer' || !decision.next_task) {
    return {
      goto: 'answer' as const,
      update: {
        runCapabilityPlan: remainingPlan,
        runPendingTask: null,
        runNextDelegation: null,
      },
    };
  }
  return {
    goto: 'capabilityDecision' as const,
    update: {
      runCapabilityPlan: remainingPlan,
      runPendingTask: {
        task: decision.next_task.objective.trim(),
        contextSummary: `Capability intent: ${decision.next_task.capability_intent.trim()}`,
        searchKeywords: null,
      },
      runNextDelegation: null,
    },
  };
}

function buildCapabilityDecisionResult(params: {
  state: OrchestratorStateType;
  context: CapabilityDecisionReadyContext;
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
    throw new Error(`capabilityDecision selected unavailable capability: ${parsedLane.capabilityName ?? ''}`);
  }
  if (delegationLane === 'general' && context.generalTools.length === 0) {
    return {
      runNextDelegation: null,
      runPendingTask: pendingTask,
    };
  }

  const runNextDelegation: RunNextDelegation = {
    id: randomUUID().slice(0, 8),
    lane: delegationLane,
    task: pendingTask.task,
    contextSummary: pendingTask.contextSummary ?? '继续完成用户当前请求。',
  };
  const runDelegationSummaries = appendRunDelegationSummary(
    state.runDelegationSummaries,
    runNextDelegation,
  );
  const nextTaskActiveDelegation = createTaskActiveDelegation(runNextDelegation, state.runId);

  // Delegation briefing: the deterministic projection of the materialized
  // delegation into main messages. Written here — and only here — because this
  // is the single point where both entry direct_task and planner next_task
  // become a real delegation; bail-out paths above never leave a stale
  // "当前执行 X" briefing behind. See issue #362.
  const briefingMessage = buildDelegationBriefingMessage({
    lane: runNextDelegation.lane,
    runId: nextTaskActiveDelegation.transcriptRunId,
    delegationId: runNextDelegation.id,
    task: runNextDelegation.task,
    // Pre-fallback value: the '继续完成用户当前请求。' placeholder that pads
    // runNextDelegation.contextSummary carries no execution guidance, so the
    // briefing omits its context line rather than rendering filler.
    contextSummary: pendingTask.contextSummary,
    runDelegationSummaries,
    remainingPlan: state.runCapabilityPlan,
  });

  return {
    messages: [briefingMessage],
    runNextDelegation,
    runPendingTask: null,
    taskActiveDelegation: nextTaskActiveDelegation,
    runDelegationSummaries,
  };
}

function buildDelegationOutcomeDecisionResult(params: {
  state: OrchestratorStateType;
  context: OrchestrationDecisionContext;
  decision: DelegationOutcomeDecision;
}): DelegationOutcomeTransition {
  const { state, context, decision } = params;
  const activeDelegation = context.activeDelegation;

  if (!activeDelegation) {
    throw new Error('outcomeDecision requires taskActiveDelegation');
  }

  if (decision.outcome === 'continue') {
    return {
      goto: activeDelegation.lane === 'general' ? 'general' as const : 'capability' as const,
      update: buildContinueDelegationResult({
        state,
        activeDelegation,
        gapNote: readDecisionText(decision.gap_note),
      }),
    };
  }

  if (!context.canHandoffActiveDelegation) {
    return {
      goto: 'answer' as const,
      update: {
        runNextDelegation: null,
        runPendingTask: null,
      },
    };
  }

  const completedTaskUpdate = buildCompletedTaskResult({ state, context });
  if (!completedTaskUpdate) {
    return {
      goto: 'answer',
      update: {
        runNextDelegation: null,
        runPendingTask: null,
      },
    };
  }

  return {
    goto: decision.outcome === 'goal_done' ? 'answer' : 'capabilityPlanner',
    update: completedTaskUpdate,
  };
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
  const runDelegationSummaries = resumeRunDelegationSummary(
    state.runDelegationSummaries,
    runNextDelegation,
  );
  const nextTaskActiveDelegation: TaskActiveDelegation = {
    ...activeDelegation,
    contextSummary: runNextDelegation.contextSummary,
    status: 'pending',
    resultPreview: null,
  };
  // Continuation briefing: same task, same delegation transcript, plus the
  // reviewer's gap note — a rejected announce without a reason would leave the
  // subagent re-announcing the same conclusion. gapNote may be null (e.g.
  // limit_reached), where continuing is self-evident from the transcript.
  const briefingMessage = buildContinuationBriefingMessage({
    runId: activeDelegation.transcriptRunId,
    delegationId: runNextDelegation.id,
    task: runNextDelegation.task,
    gapNote,
  });
  return {
    messages: [briefingMessage],
    runNextDelegation,
    runPendingTask: null,
    taskActiveDelegation: nextTaskActiveDelegation,
    runDelegationSummaries,
  };
}

function buildCompletedTaskResult(params: {
  state: OrchestratorStateType;
  context: OrchestrationDecisionContext;
}) {
  const { state, context } = params;
  const {
    activeDelegation,
    canHandoffActiveDelegation,
    preDecisionHandoffMessages,
  } = context;
  if (!activeDelegation) {
    throw new Error('completed outcome requires taskActiveDelegation');
  }
  if (!canHandoffActiveDelegation) {
    throw new Error('completed outcome requires a handoff-ready active delegation');
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
    return null;
  }
  handoffMessages.push(...clearLaneMessages);

  const runDelegationSummaries = state.runDelegationSummaries.map((delegation) =>
    delegation.id === activeDelegation.id
      ? { ...delegation, status: 'completed' as const }
      : delegation);

  return {
    messages: handoffMessages,
    runNextDelegation: null,
    runPendingTask: null,
    taskActiveDelegation: null,
    runDelegationSummaries,
  };
}

type DelegationOutcomeDestination = 'capability' | 'general' | 'capabilityPlanner' | 'answer';

type DelegationOutcomeTransition = {
  goto: DelegationOutcomeDestination;
  update: OrchestratorStatePatch;
};
