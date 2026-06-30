import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { StateGraph, START, END } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { randomUUID } from 'node:crypto';
import {
  buildEmptyRunCapabilitySearchState,
  OrchestratorState,
  type OrchestratorStateType,
} from '../state';
import {
  asDecisionNode,
  type OrchestratorDecision,
} from '../controlPrimitives';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
} from '../guardDefinitions';
import { readContextCompactionSummaries } from '../contextCompaction';
import type {
  RunFinalReplyRoute,
  MessageLane,
  OrchestratorConfig,
  RunPendingDelegation,
  DecisionMode,
  TaskActiveDelegation,
} from '../types';
import {
  buildOrchestrationDecisionSchema,
  buildOrchestrationDecisionOutputInstruction,
  buildOrchestrationDecisionStructuredOutputOptions,
  parseAction,
  readDecisionText,
  type OrchestrationDecision,
} from '../schemas';
import {
  capabilitySearchTool,
} from '../capabilitySearch';
import { invokeStructuredOutput } from '../../../utils/structuredOutput';
import {
  buildDecisionTargetsContext,
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildDelegationOutcomeOtherTasksContext,
  buildPreparedRequestContext,
  buildSubagentAnnounceContext,
  buildRunDelegationContext,
  buildUserIntentDecisionInput,
  buildUserIntentDecisionSystemPrompt,
} from '../prompts';
import {
  reuseOrAppendRunDelegation,
} from '../delegations';
import {
  buildHandoffArtifactRefs,
  findLatestHandoffCopyForDelegation,
} from '../artifacts/handoff';
import {
  buildSubagentHandoff,
  getMessageHandoffSource,
  readInFlightAnnounceLanes,
  readLatestHumanRequest,
  readLatestAnnounce,
  readLatestAnnounceCompletionReason,
  readRecentAnnounces,
} from '../messageLanes';
import {
  resolveToolkitResources,
} from '../subagentHandoff';
import { validateUniqueCapabilityNames, validateUniqueToolkitNames, validateUniqueToolNames } from '../validation';
import { readMessageText } from '../utils';
import {
  canSearchCapabilities,
  buildCapabilityCandidatesFromLanes,
  mainMessagesWithoutCompaction,
  mergeCapabilityCandidates,
  resolveCapabilityDecisionState,
} from './decisions/capabilityCandidates';
import {
  createTaskActiveDelegation,
} from './decisions/delegationLifecycle';
import {
  DEFAULT_ORCHESTRATOR_MAX_ITERATIONS,
} from './constants';
import {
  generalLaneToolkits,
  getInvokeOptions,
  readRunIterationLimit,
  readSubagentContextWindowTokens,
  resolveActor,
} from './config';
import {
  createCompactContextNode,
  createDelegationOutcomeDecisionGuardNode,
  createDelegationOutcomeIterationGuardNode,
  createPrepareNode,
  prepareUserIntentDecision,
} from './guards/nodes';
import { createAnswerNode } from './nodes/answer';
import { createCapabilityNode } from './nodes/capability';
import { createCapabilityDiscoveryNode } from './nodes/capabilityDiscovery';
import { createGeneralNode } from './nodes/general';
import {
  createControlContextBuilder,
  createOrchestratorGuardRegistry,
  createOrchestratorGuardRunner,
} from './guards/runner';
import { afterCapabilityDiscovery } from './routes/afterCapabilityDiscovery';
import { afterContextPrep } from './routes/afterContextPrep';
import { afterDecision } from './routes/afterDecision';
import { afterDelegationOutcomeIterationGuard } from './routes/afterDelegationOutcomeIterationGuard';

// --- Graph builder ---

export function createOrchestratorGraph(config: OrchestratorConfig) {
  const orchestratorMaxIterations = readRunIterationLimit(config.maxRunIterations)
    ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS;
  const subagentContextWindowTokens = readSubagentContextWindowTokens(config);
  const orchestratorGuardRegistry = createOrchestratorGuardRegistry();
  const runOrchestratorGuard = createOrchestratorGuardRunner({
    config,
    orchestratorMaxIterations,
    guardRegistry: orchestratorGuardRegistry,
  });
  const buildControlContext = createControlContextBuilder(orchestratorMaxIterations);
  const prepare = createPrepareNode(runOrchestratorGuard);
  const compactContext = createCompactContextNode({ config, runOrchestratorGuard });
  const delegationOutcomeDecisionGuardNode =
    createDelegationOutcomeDecisionGuardNode(runOrchestratorGuard);
  const delegationOutcomeIterationGuardNode =
    createDelegationOutcomeIterationGuardNode(runOrchestratorGuard);
  const capabilityDiscovery = createCapabilityDiscoveryNode({ config, runOrchestratorGuard });

  async function runOrchestrationDecision(
    kind: 'user_intent' | 'delegation_outcome',
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
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
    const contextSummaries = readContextCompactionSummaries(state.messages);
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
    const canHandoffActiveDelegation = kind === 'delegation_outcome'
      ? state.canHandoffActiveDelegation
      : true;
    const preDecisionHandoffMessages =
      kind === 'delegation_outcome'
      && canHandoffActiveDelegation
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
              getMessageHandoffSource,
            );
            if (!latestCopy) return proposedMessages;

            return readMessageText(latestCopy) === readMessageText(proposedCopy)
              ? null
              : proposedMessages;
          })()
        : null;
    const decisionContextMessages = preDecisionHandoffMessages
      ? [...state.messages, ...preDecisionHandoffMessages]
      : state.messages;
    const recentMainMessages = mainMessagesWithoutCompaction(decisionContextMessages);
    const recentAnnounces = readRecentAnnounces(decisionContextMessages);
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
    const requestContext = buildPreparedRequestContext({
      latestUserRequest: latestHumanRequest,
      recentMessages: recentMainMessages,
      recentAnnounces,
      contextSummaries,
      capabilityArtifacts: state.sessionCapabilityArtifacts,
    });
    const isUserIntentDecision = kind === 'user_intent';
    // Unfinished delegation lifecycle is explicit task state. Lane announces are
    // transcript storage and context, not normal control-flow authority.
    const inProgressCapabilityCandidates = buildCapabilityCandidatesFromLanes(
      capabilityList,
      isUserIntentDecision
        ? [
            activeDelegation?.lane,
            ...(state.taskActiveDelegation ? [] : readInFlightAnnounceLanes(state.messages)),
          ]
        : [activeDelegationAnnounce?.lane ?? activeDelegation?.lane],
    );
    const decisionCapabilityCandidates = isUserIntentDecision
      ? mergeCapabilityCandidates(state.runCapabilitySearchState.candidates, inProgressCapabilityCandidates)
      : inProgressCapabilityCandidates;
    const decisionCapabilitySearchAttempted = isUserIntentDecision && state.runCapabilitySearchState.attempted;
    const decisionCapabilitySearchQuery = isUserIntentDecision ? state.runCapabilitySearchState.query : null;
    const searchAvailable = isUserIntentDecision
      && canSearchCapabilities(config.models.act, state, capabilityList);
    const capabilityDecisionState = resolveCapabilityDecisionState({
      canSearch: searchAvailable,
      capabilityCandidates: decisionCapabilityCandidates,
      capabilitySearchAttempted: decisionCapabilitySearchAttempted,
    });
    const runDelegationContext = buildRunDelegationContext(state.runDelegations);
    const decisionTargetsContext = buildDecisionTargetsContext({
      generalTools,
      capabilityCandidates: decisionCapabilityCandidates,
      capabilitySearchAttempted: decisionCapabilitySearchAttempted,
      capabilitySearchAvailable: false,
      capabilitySearchQuery: decisionCapabilitySearchQuery,
      capabilityRegistryAvailable: capabilityList.length > 0,
    });
    const outputInstruction = buildOrchestrationDecisionOutputInstruction({
      capabilityCandidates: decisionCapabilityCandidates,
    });
    const systemPrompt = isUserIntentDecision
      ? buildUserIntentDecisionSystemPrompt({
        actor,
        runDelegationContext: runDelegationContext,
        targetsContext: decisionTargetsContext,
        capabilityDecisionState,
        outputInstruction,
        workdir,
        runtimeEnvironment,
      })
      : buildDelegationOutcomeDecisionSystemPrompt({
        actor,
        outputInstruction,
        workdir,
        runtimeEnvironment,
      });
    const decisionInputMessage = isUserIntentDecision
      ? new HumanMessage(buildUserIntentDecisionInput({
        latestUserRequest: latestHumanRequest,
        recentMessages: recentMainMessages,
        requestContext,
      }))
      : new HumanMessage(buildDelegationOutcomeDecisionInput({
        latestUserRequest: latestHumanRequest,
        currentTaskContext: buildDelegationOutcomeCurrentTaskContext(activeDelegation),
        subagentAnnounceContext: buildSubagentAnnounceContext(
          activeDelegationAnnounceForDecision,
          activeDelegationCompletionReason,
        ),
        otherTasksContext: buildDelegationOutcomeOtherTasksContext(
          state.runDelegations,
          activeDelegation?.id ?? null,
        ),
        capabilityArtifacts: state.sessionCapabilityArtifacts,
      }));

    const decisionSchema = buildOrchestrationDecisionSchema({
      capabilityCandidates: decisionCapabilityCandidates,
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
          new SystemMessage(systemPrompt),
          decisionInputMessage,
        ],
        runnableConfig,
      }) as OrchestrationDecision;
    } catch (error) {
      console.warn('[pet-agent] invalid orchestration decision structured output:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

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
      ? decisionTask ?? readLatestHumanRequest(state.messages) ?? '继续完成用户当前请求'
      : null;
    const delegationContextSummary = decisionMode !== 'answer'
      ? decisionContextSummary ?? '继续完成用户当前请求。'
      : null;
    const runPendingDelegation: RunPendingDelegation | null = delegationLane && delegationTask
      ? {
          id: activeDelegation && activeDelegation.lane === delegationLane
            ? activeDelegation.id
            : randomUUID().slice(0, 8),
          lane: delegationLane,
          task: delegationTask,
          contextSummary: delegationContextSummary,
        }
      : null;
    const nextDelegationState = reuseOrAppendRunDelegation(state.runDelegations, runPendingDelegation);

    // Handoff (D1): copy the active subagent announce into the main queue before
    // the next decision branch runs.
    // - answer decision: announce is final for this delegation (old lane transcript
    //   can be cleared).
    // - continue decision: preserve lane transcript for continuation while still
    //   keeping the latest announce in main for better downstream judgment.
    //
    // Single-line delegation handoff is driven by taskActiveDelegation. run
    // summaries are not the source of truth for unfinished task lifecycle.
    const replacingActiveDelegation = kind === 'delegation_outcome'
      && Boolean(activeDelegation && runPendingDelegation && activeDelegation.id !== runPendingDelegation.id);
    const handoffMessages: BaseMessage[] = [];
    const handedOffDelegationIds = new Set<string>();
    if (preDecisionHandoffMessages) {
      handoffMessages.push(...preDecisionHandoffMessages);
    }
    const shouldClearLaneForHandoff = kind === 'delegation_outcome'
      && actionKind === 'answer'
      && canHandoffActiveDelegation
      && Boolean(activeDelegation);
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
    const blockedReplacementMessage = replacementBlocked
      ? new AIMessage('当前 delegated task 还没有可交接的结果，暂不能切换到新的执行器。请先继续当前 delegated task，或明确说明要放弃它。')
      : null;

    // A handed-off delegation is, by the orchestrator's judgment, complete.
    const shouldMarkDelegationComplete = actionKind === 'answer' || replacingActiveDelegation;
    const finalRunDelegations = handedOffDelegationIds.size > 0 && shouldMarkDelegationComplete
      ? nextDelegationState.runDelegations.map((delegation) =>
          handedOffDelegationIds.has(delegation.id)
            ? { ...delegation, status: 'completed' as const }
            : delegation)
      : nextDelegationState.runDelegations;

    let nextTaskActiveDelegation: TaskActiveDelegation | null;
    const shouldClearTaskActiveDelegation = shouldClearLaneForHandoff;
    if (replacementBlocked) {
      nextTaskActiveDelegation = activeDelegation;
    } else if (shouldClearTaskActiveDelegation) {
      nextTaskActiveDelegation = null;
    } else if (runPendingDelegation) {
      nextTaskActiveDelegation = activeDelegation && activeDelegation.id === runPendingDelegation.id
        ? {
            ...activeDelegation,
            task: runPendingDelegation.task,
            contextSummary: runPendingDelegation.contextSummary,
            status: 'pending' as const,
            resultPreview: null,
          }
        : createTaskActiveDelegation(runPendingDelegation, state.runId);
    } else {
      nextTaskActiveDelegation = activeDelegation;
    }

    return {
      messages: [
        ...handoffMessages,
        ...(blockedReplacementMessage ? [blockedReplacementMessage] : []),
        ...(inlineReply ? [new AIMessage(inlineReply)] : []),
      ],
      runPendingDelegation: replacementBlocked ? null : nextDelegationState.runPendingDelegation,
      runPendingFinalReply: replacementBlocked ? 'inline' : runPendingFinalReply,
      taskActiveDelegation: nextTaskActiveDelegation,
      ...(kind === 'delegation_outcome'
        ? {
            runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
          }
        : {}),
      runDelegations: replacementBlocked ? state.runDelegations : finalRunDelegations,
    };
  }

  // The two Decision nodes. runOrchestrationDecision holds the (large, closure-
  // bound) body; these thin wrappers bind it to a decision kind and conform to the
  // OrchestratorDecision contract (state, ctx) -> patch.
  const userIntentDecision: OrchestratorDecision = (state, ctx) => {
    return runOrchestrationDecision('user_intent', state, ctx.runnableConfig);
  };

  const delegationOutcomeDecision: OrchestratorDecision = (state, ctx) => {
    return runOrchestrationDecision('delegation_outcome', state, ctx.runnableConfig);
  };

  const answerNode = createAnswerNode(config);
  const capabilityNode = createCapabilityNode({ config, subagentContextWindowTokens });
  const generalNode = createGeneralNode({ config, subagentContextWindowTokens });

  const graph = new StateGraph(OrchestratorState)
    .addNode('prepare', prepare)
    .addNode('compactContext', compactContext)
    .addNode('capabilityDiscovery', capabilityDiscovery)
    .addNode('capabilitySearch', new ToolNode([capabilitySearchTool]))
    .addNode('prepareUserIntentDecision', prepareUserIntentDecision)
    .addNode('delegationOutcomeDecisionGuard', delegationOutcomeDecisionGuardNode)
    .addNode('userIntentDecision', asDecisionNode(userIntentDecision, buildControlContext))
    .addNode('delegationOutcomeIterationGuard', delegationOutcomeIterationGuardNode)
    .addNode('delegationOutcomeDecision', asDecisionNode(delegationOutcomeDecision, buildControlContext))
    .addNode('answer', answerNode)
    .addNode('capability', capabilityNode)
    .addNode('general', generalNode)
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'compactContext')
    // Run entry uses explicit task lifecycle state. Lane announces remain
    // transcript/context storage and are not the normal control-flow signal.
    .addConditionalEdges('compactContext', afterContextPrep, {
      delegationOutcomeIterationGuard: 'delegationOutcomeIterationGuard',
      capabilityDiscovery: 'capabilityDiscovery',
    })
    .addConditionalEdges('capabilityDiscovery', afterCapabilityDiscovery, {
      capabilitySearch: 'capabilitySearch',
      prepareUserIntentDecision: 'prepareUserIntentDecision',
    })
    .addEdge('prepareUserIntentDecision', 'userIntentDecision')
    .addConditionalEdges('delegationOutcomeIterationGuard', afterDelegationOutcomeIterationGuard, {
      end: END,
      delegationOutcomeDecisionGuard: 'delegationOutcomeDecisionGuard',
    })
    .addEdge('delegationOutcomeDecisionGuard', 'delegationOutcomeDecision')
    .addConditionalEdges('userIntentDecision', afterDecision, {
      end: END,
      answer: 'answer',
      capability: 'capability',
      general: 'general',
    })
    .addConditionalEdges('delegationOutcomeDecision', afterDecision, {
      end: END,
      answer: 'answer',
      capability: 'capability',
      general: 'general',
    })
    .addEdge('answer', END)
    .addEdge('capabilitySearch', 'prepareUserIntentDecision')
    .addEdge('capability', 'delegationOutcomeIterationGuard')
    .addEdge('general', 'delegationOutcomeIterationGuard');

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
