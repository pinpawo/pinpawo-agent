import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command } from '@langchain/langgraph';
import { evaluateGuard } from '../../../../guards';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorStatePatch } from '../../controlPrimitives';
import type {
  OrchestratorConfig,
  RunNextDelegation,
  TaskActiveDelegation,
} from '../../types';
import {
  buildDelegationOutcomeDecisionOutputInstruction,
  buildDelegationOutcomeDecisionSchema,
  buildEntryDecisionOutputInstruction,
  buildEntryDecisionSchema,
  buildOrchestrationDecisionStructuredOutputOptions,
  readDecisionText,
  type AcceptedDelegationOutcome,
  type DelegationOutcomeDecision,
  type EntryDecision,
} from '../../schemas';
import { readContextCompactionSummaries } from '../../contextCompaction';
import {
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildDelegationOutcomeOtherTasksContext,
  buildDelegationOutcomeRemainingPlanContext,
  buildCompactionSummaryXmlContext,
  buildPreparedRequestContext,
  buildRunDelegationSummaryContext,
  buildRuntimeContext,
  buildSubagentAnnounceContext,
  buildEntryDecisionInput,
  buildEntryDecisionSystemPrompt,
} from '../../prompts';
import {
  appendRunDelegationSummary,
  resumeRunDelegationSummary,
} from '../../delegations';
import { materializeDelegation } from '../../delegationBriefing';
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
  setPinpetMeta,
} from '../../messageLanes';
import { readMessageText } from '../../utils';
import { invokeStructuredOutput } from '../../../../utils/structuredOutput';
import {
  mainMessagesWithoutCompaction,
} from './conversationContext';
import {
  getInvokeOptions,
  resolveActor,
} from '../config';
import { guardDecisionEmitter } from '../guards/decisionEvents';
import { prepareModelRequestMessages } from '../../modelRequestPolicy';

type DecisionKind = 'delegation_outcome';

export function createEntryDecisionRunner(config: OrchestratorConfig) {
  return async function runEntryDecision(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const context = buildEntryDecisionContext({ config, state, runnableConfig });
    const decision = await invokeEntryDecision({ config, context, runnableConfig });
    const transition = buildEntryDecisionResult({ decision });
    return new Command({ update: transition.update, goto: transition.goto });
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

function buildEntryDecisionContext(params: {
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
  const systemPrompt = buildEntryDecisionSystemPrompt({
    actor,
    outputInstruction: buildEntryDecisionOutputInstruction(
      config.decisionStructuredOutput?.method,
    ),
  });
  const decisionContextMessage = new HumanMessage(buildEntryDecisionInput({
    runDelegationContext: buildRunDelegationSummaryContext(state.runDelegationSummaries),
    runtimeContext: buildRuntimeContext(workdir, runtimeEnvironment),
  }));
  setPinpetMeta(decisionContextMessage, {
    source: 'entry_decision_context',
    synthetic: true,
  });

  return {
    conversationMessages,
    decisionContextMessage,
    systemPrompt,
  };
}

type EntryDecisionContext = ReturnType<typeof buildEntryDecisionContext>;

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

          const latestSource = getMessageHandoffSource(latestCopy);
          const proposedSource = getMessageHandoffSource(proposedCopy);
          return latestSource?.announceMessageId
            && latestSource.announceMessageId === proposedSource?.announceMessageId
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
    remainingPlanContext: buildDelegationOutcomeRemainingPlanContext(
      state.runCapabilityPlan,
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

async function invokeEntryDecision(params: {
  config: OrchestratorConfig;
  context: EntryDecisionContext;
  runnableConfig?: RunnableConfig;
}) {
  const { config, context, runnableConfig } = params;
  try {
    return await invokeStructuredOutput({
      model: config.models.decision ?? config.models.act,
      schema: buildEntryDecisionSchema(),
      options: buildOrchestrationDecisionStructuredOutputOptions(
        config.decisionStructuredOutput,
      ),
      messages: await prepareModelRequestMessages(config.modelRequestPolicy, [
        new SystemMessage(context.systemPrompt),
        context.decisionContextMessage,
        ...context.conversationMessages,
      ]),
      runnableConfig,
    }) as EntryDecision;
  } catch (error) {
    console.warn('[pet-agent] invalid entry decision structured output:', {
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
      model: config.models.decision ?? config.models.act,
      schema: buildDelegationOutcomeDecisionSchema(),
      options: buildOrchestrationDecisionStructuredOutputOptions(
        config.decisionStructuredOutput,
      ),
      messages: await prepareModelRequestMessages(config.modelRequestPolicy, [
        new SystemMessage(context.systemPrompt),
        context.decisionInputMessage,
      ]),
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

function buildEntryDecisionResult(params: {
  decision: EntryDecision;
}) {
  const { decision } = params;
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
  return {
    goto: 'capabilityPlanner' as const,
    update: {
      runNextDelegation: null,
      runPendingTask: null,
      runCapabilityPlan: [],
    },
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
      goto: 'capability' as const,
      update: buildContinueDelegationResult({
        state,
        activeDelegation,
        gapNote: readDecisionText(decision.gap_note),
      }),
    };
  }

  if (decision.outcome === 'user_input_required') {
    return {
      goto: 'answer' as const,
      update: buildUserInputRequiredDelegationResult({
        state,
        activeDelegation,
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

  const acceptedDelegationUpdate = buildAcceptedDelegationResult({
    state,
    context,
    outcome: decision.outcome,
  });
  if (!acceptedDelegationUpdate) {
    return {
      goto: 'answer',
      update: {
        runNextDelegation: null,
        runPendingTask: null,
      },
    };
  }

  return {
    goto: decision.outcome === 'task_done' ? 'capabilityPlanner' : 'answer',
    update: acceptedDelegationUpdate,
  };
}

function buildUserInputRequiredDelegationResult(params: {
  state: OrchestratorStateType;
  activeDelegation: TaskActiveDelegation;
}) {
  const { state, activeDelegation } = params;
  const runDelegationSummaries = state.runDelegationSummaries.map((delegation) =>
    delegation.id === activeDelegation.id
      ? {
          ...delegation,
          status: 'progress' as const,
        }
      : delegation);

  return {
    runNextDelegation: null,
    runPendingTask: null,
    taskActiveDelegation: activeDelegation,
    runDelegationSummaries,
    runLatestDelegationOutcome: 'user_input_required' as const,
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
  const materializedDelegation = materializeDelegation({
    mode: 'continue',
    lane: activeDelegation.lane,
    runId: activeDelegation.transcriptRunId,
    delegationId: runNextDelegation.id,
    task: runNextDelegation.task,
    gapNote,
  });
  return {
    messages: materializedDelegation.laneMessages,
    runNextDelegation,
    runPendingTask: null,
    taskActiveDelegation: nextTaskActiveDelegation,
    runDelegationSummaries,
    runLatestDelegationOutcome: null,
  };
}

type CompletedDelegationOutcome = Exclude<AcceptedDelegationOutcome, 'user_input_required'>;

function buildAcceptedDelegationResult(params: {
  state: OrchestratorStateType;
  context: OrchestrationDecisionContext;
  outcome: CompletedDelegationOutcome;
}) {
  const { state, context, outcome } = params;
  const {
    activeDelegation,
    canHandoffActiveDelegation,
    preDecisionHandoffMessages,
  } = context;
  if (!activeDelegation) {
    throw new Error('accepted outcome requires taskActiveDelegation');
  }
  if (!canHandoffActiveDelegation) {
    throw new Error('accepted outcome requires a handoff-ready active delegation');
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
      ? {
          ...delegation,
          status: 'completed' as const,
        }
      : delegation);

  return {
    messages: handoffMessages,
    runNextDelegation: null,
    runPendingTask: null,
    taskActiveDelegation: null,
    runDelegationSummaries,
    runLatestDelegationOutcome: outcome,
  };
}

type DelegationOutcomeDestination = 'capability' | 'capabilityPlanner' | 'answer';

type DelegationOutcomeTransition = {
  goto: DelegationOutcomeDestination;
  update: OrchestratorStatePatch;
};
