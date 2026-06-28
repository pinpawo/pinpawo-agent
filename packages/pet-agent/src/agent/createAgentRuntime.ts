import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { StateGraph, START, END } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { AgentCapability } from '../types/capability';
import type { AgentActor, AgentExecution, AgentModels } from '../types/agent';
import type { CapabilityArtifactRef } from '../types/artifact';
import type { SubagentInput, SubagentToolEventHandler } from '../types/subagent';
import type { AgentToolkit, ToolkitReviewCapabilities } from '../types/toolkit';
import { randomUUID } from 'node:crypto';
import { createSubagent } from '../subagent/createSubagent';
import {
  buildEmptyRunCapabilitySearchState,
  buildRunStateReset,
  OrchestratorState,
  type OrchestratorStateType,
} from './orchestrator/state';
import {
  asDecisionNode,
  asGuardNode,
  type OrchestratorControlContext,
  type OrchestratorDecision,
} from './orchestrator/controlPrimitives';
import {
  createOrchestratorGuards,
  readLegacyTaskActiveDelegation,
} from './orchestrator/guards';
import {
  compactOrchestratorMessages,
  isContextCompactionMessage,
  readContextCompactionSummaries,
} from './orchestrator/contextCompaction';
import type {
  CapabilityCandidate,
  CapabilityDecisionState,
  RunFinalReplyRoute,
  MessageLane,
  OrchestratorConfig,
  OrchestratorInvokeOptions,
  RunPendingDelegation,
  DecisionMode,
  ToolBindableChatModel,
  OrchestrationDecisionStructuredOutputConfig,
  TaskActiveDelegation,
} from './orchestrator/types';
import {
  buildOrchestrationDecisionSchema,
  buildOrchestrationDecisionOutputInstruction,
  buildOrchestrationDecisionStructuredOutputOptions,
  parseAction,
  readDecisionText,
  type OrchestrationDecision,
} from './orchestrator/schemas';
import {
  CAPABILITY_SEARCH_TOOL_NAME,
  capabilitySearchTool,
  readModelToolCalls,
} from './orchestrator/capabilitySearch';
import { invokeStructuredOutput } from '../utils/structuredOutput';
import {
  buildCapabilityDiscoveryInput,
  buildCapabilityDiscoveryRequestContext,
  buildCapabilityDiscoverySystemPrompt,
  buildDecisionTargetsContext,
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildDelegationOutcomeOtherTasksContext,
  buildAnswerSystemPrompt,
  buildPreparedRequestContext,
  buildSubagentAnnounceContext,
  buildRunDelegationContext,
  buildUserIntentDecisionInput,
  buildUserIntentDecisionSystemPrompt,
} from './orchestrator/prompts';
import {
  mergeToolAuthorizations,
  type ToolAuthorizationRecord,
} from './orchestrator/review/reviewAuthorizations';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  type GlobalReviewPolicy,
  type GlobalReviewPolicyMode,
  type GlobalReviewPolicyResolver,
  type GlobalReviewPolicyStructuredOutputConfig,
} from './orchestrator/review/globalReviewPolicy';
import {
  reuseOrAppendRunDelegation,
  updateRunDelegationResult,
} from './orchestrator/delegations';
import {
  buildHandoffArtifactRefs,
  findLatestHandoffCopyForDelegation,
} from './orchestrator/artifacts/handoff';
import {
  buildSubagentHandoff,
  getMessageHandoffSource,
  getMessageLane,
  getMessageTurnId,
  laneMessages,
  mainConversationMessages,
  readInFlightAnnounceLanes,
  readLatestHumanRequest,
  readLatestAnnounce,
  readLatestAnnounceCompletionReason,
  readRecentAnnounces,
  setPinpetMeta,
  tagNewLaneMessages,
} from './orchestrator/messageLanes';
import {
  buildDelegationHandoffInstruction,
  collectCapabilityOperations,
  collectGeneralOperations,
  collectToolkitOperations,
  resolveInstructions,
  resolveToolkitResources,
  selectCapabilityTools,
} from './orchestrator/subagentHandoff';
import { validateUniqueCapabilityNames, validateUniqueToolkitNames, validateUniqueToolNames } from './orchestrator/validation';
import { readMessageText } from './orchestrator/utils';

export type {
  OrchestratorConfig,
  OrchestratorInvokeOptions,
  OrchestratorStateType,
  OrchestrationDecisionStructuredOutputConfig,
};
export { buildOrchestratorRunInput, buildOrchestratorTurnInput } from './orchestrator/state';
export { validateUniqueCapabilityNames, validateUniqueToolkitNames, validateUniqueToolNames } from './orchestrator/validation';

// Subagent iteration budget = the inner ReAct agent's LangGraph recursionLimit
// (counted in graph super-steps; one model→tool iteration is ~2 steps). With the
// loop guards (#280) the expected stop point is a guard's graceful stop
// (repeated input), so this budget is a generous last-resort breaker
// for genuine runaway loops rather than the normal stopping condition. Unified
// across lanes (P4 / #281). See docs/SUBAGENT_LIMIT_FRAMEWORK_DESIGN.md.
const SUBAGENT_MAX_ITERATIONS = 100;
const GENERAL_SUBAGENT_MAX_ITERATIONS = SUBAGENT_MAX_ITERATIONS;
const CAPABILITY_SUBAGENT_MAX_ITERATIONS = SUBAGENT_MAX_ITERATIONS;
const DEFAULT_ORCHESTRATOR_MAX_ITERATIONS = 25;

function generalLaneToolkits(toolkits: AgentToolkit[]) {
  return toolkits.filter((toolkitItem) => toolkitItem.exposure?.general !== false);
}

function capabilityLaneToolkits(toolkits: AgentToolkit[]) {
  return toolkits.filter((toolkitItem) => toolkitItem.exposure?.capability !== false);
}

const ORCHESTRATOR_INTERNAL_AI_STREAM_NODE_NAMES = [
  'capabilityDiscovery',
  'userIntentDecision',
  'delegationOutcomeDecision',
] as const;

const ORCHESTRATOR_INTERNAL_AI_STREAM_NODE_SET = new Set<string>(
  ORCHESTRATOR_INTERNAL_AI_STREAM_NODE_NAMES,
);

export function isOrchestratorInternalAiStreamNode(node: string) {
  return ORCHESTRATOR_INTERNAL_AI_STREAM_NODE_SET.has(node);
}

// --- Configurable helpers ---

function getInvokeOptions(runnableConfig?: RunnableConfig): OrchestratorInvokeOptions {
  const cfg = runnableConfig?.configurable ?? {};
  return {
    actor: cfg.actor as AgentActor | undefined,
    capabilities: (cfg.capabilities ?? []) as AgentCapability[],
    toolkits: (cfg.toolkits ?? []) as AgentToolkit[],
    execution: cfg.execution as AgentExecution | undefined,
    workdir: cfg.workdir as string | undefined,
    runtimeEnvironment: cfg.runtimeEnvironment as string | undefined,
    onToolEvent: cfg.onToolEvent as SubagentToolEventHandler | undefined,
    reviewCapabilities: readToolkitReviewCapabilities(cfg.reviewCapabilities),
    globalReviewPolicy: readGlobalReviewPolicy(cfg.globalReviewPolicy),
    maxRunIterations: readRunIterationLimit(cfg.maxRunIterations),
    forcedCapabilityNames: Array.isArray((cfg as { forcedCapabilityNames?: unknown }).forcedCapabilityNames)
      ? (cfg as { forcedCapabilityNames: unknown[] }).forcedCapabilityNames.filter(
          (name): name is string => typeof name === 'string' && name.length > 0,
      )
      : undefined,
  };
}

function readGlobalReviewPolicyMode(value: unknown): GlobalReviewPolicyMode | null {
  if (
    value === GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION
    || value === GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
    || value === GLOBAL_REVIEW_POLICY_MODE.FULL_ACCESS
    || value === GLOBAL_REVIEW_POLICY_MODE.CUSTOM
  ) {
    return value;
  }
  if (value === 'ask') {
    return GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION;
  }
  if (value === 'auto') {
    return GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION;
  }
  return null;
}

function warnBareCustomGlobalReviewPolicy() {
  console.warn(
    '[pet-agent] custom global review policy requires a resolver; falling back to require_authorization.',
  );
}

function readGlobalReviewPolicy(value: unknown): GlobalReviewPolicy | undefined {
  const directMode = readGlobalReviewPolicyMode(value);
  if (directMode) {
    if (directMode === GLOBAL_REVIEW_POLICY_MODE.CUSTOM) {
      warnBareCustomGlobalReviewPolicy();
      return undefined;
    }
    return { mode: directMode };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const mode = readGlobalReviewPolicyMode(record.mode);
  if (!mode) {
    return undefined;
  }
  if (mode === GLOBAL_REVIEW_POLICY_MODE.CUSTOM) {
    if (typeof record.resolve !== 'function') {
      warnBareCustomGlobalReviewPolicy();
      return undefined;
    }
    return {
      mode,
      resolve: record.resolve as GlobalReviewPolicyResolver,
    };
  }
  const structuredOutput = record.structuredOutput
    && typeof record.structuredOutput === 'object'
    && !Array.isArray(record.structuredOutput)
    ? record.structuredOutput as GlobalReviewPolicyStructuredOutputConfig
    : undefined;
  return {
    mode,
    ...(structuredOutput ? { structuredOutput } : {}),
  };
}

function readThreadId(runnableConfig?: RunnableConfig): string | null {
  const value = runnableConfig?.configurable?.thread_id;
  return typeof value === 'string' && value.trim() ? value : null;
}

function readToolkitReviewCapabilities(value: unknown): ToolkitReviewCapabilities | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.humanReview !== 'boolean' || typeof record.sessionAuthorization !== 'boolean') {
    return undefined;
  }
  return {
    humanReview: record.humanReview,
    sessionAuthorization: record.sessionAuthorization,
  };
}

/**
 * 把 `forcedCapabilityNames` 映射成 synthetic capabilitySearch candidates。
 *
 * 命中:在 `prepare` 阶段把同名 capability 直接登记为已发现候选(高分 +
 * matchedTerms=['forced']),并把 `attempted` 置为 true。下游
 * `canSearchCapabilities` 会因为 candidates 非空 / attempted=true 而短路,
 * 整段 capability discovery + search 不再触发。
 *
 * 未传或为空数组 → 返回 null,prepare 走默认 run reset 路径(0 行为变化)。
 */
function buildForcedRunCapabilitySearchState(
  forcedNames: string[] | undefined,
  capabilityList: AgentCapability[],
): { runCapabilitySearchState: RunCapabilitySearchStateForReset } | null {
  if (!forcedNames || forcedNames.length === 0) return null;
  const candidates: CapabilityCandidate[] = [];
  const seen = new Set<string>();
  for (const name of forcedNames) {
    if (seen.has(name)) continue;
    const capability = capabilityList.find((item) => item.name === name);
    if (!capability) continue;
    seen.add(name);
    candidates.push({
      name: capability.name,
      description: capability.description,
      score: Number.POSITIVE_INFINITY,
      matchedTerms: ['forced'],
    });
  }
  if (candidates.length === 0) return null;
  return {
    runCapabilitySearchState: {
      query: null,
      attempted: true,
      candidates,
    },
  };
}

type RunCapabilitySearchStateForReset = ReturnType<typeof buildEmptyRunCapabilitySearchState>;

function canSearchCapabilities(
  model: AgentModels['act'],
  state: OrchestratorStateType,
  capabilities: AgentCapability[],
): model is ToolBindableChatModel {
  return capabilities.length > 0
    && !state.runCapabilitySearchState.attempted
    && state.runCapabilitySearchState.candidates.length === 0
    && typeof (model as ToolBindableChatModel).bindTools === 'function';
}

function resolveCapabilityDecisionState(params: {
  canSearch: boolean;
  capabilityCandidates: CapabilityCandidate[];
  capabilitySearchAttempted: boolean;
}): CapabilityDecisionState {
  if (params.capabilityCandidates.length > 0) return 'candidates_available';
  if (params.canSearch) return 'search_available';
  if (params.capabilitySearchAttempted) return 'search_exhausted';
  return 'unavailable';
}

function decisionModeFromRunPendingDelegation(pending: RunPendingDelegation | null): DecisionMode {
  if (!pending) return 'answer';
  return pending.lane === 'general' ? 'general' : 'capability';
}

function createTaskActiveDelegation(
  delegation: RunPendingDelegation,
  runId: string,
): TaskActiveDelegation {
  return {
    id: delegation.id,
    lane: delegation.lane,
    task: delegation.task,
    contextSummary: delegation.contextSummary,
    transcriptRunId: runId,
    status: 'pending',
    resultPreview: null,
  };
}

function readRunIterationLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function resolveDelegationTranscriptRunId(
  state: OrchestratorStateType,
  delegation: RunPendingDelegation,
) {
  return state.taskActiveDelegation?.id === delegation.id
    ? state.taskActiveDelegation.transcriptRunId
    : state.runId;
}

function readCapabilityNameFromLane(lane: MessageLane): string | null {
  return lane.startsWith('capability:') ? lane.slice('capability:'.length) : null;
}

function mainMessagesWithoutCompaction(messages: BaseMessage[]): BaseMessage[] {
  return mainConversationMessages(messages).filter((message) => !isContextCompactionMessage(message));
}

function buildCapabilityCandidatesFromLanes(
  capabilityList: AgentCapability[],
  lanes: Array<MessageLane | null | undefined>,
): CapabilityCandidate[] {
  const candidates: CapabilityCandidate[] = [];
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (!lane) continue;
    const capabilityName = readCapabilityNameFromLane(lane);
    if (!capabilityName || seen.has(capabilityName)) continue;
    const capability = capabilityList.find((item) => item.name === capabilityName);
    if (!capability) continue;
    seen.add(capabilityName);
    candidates.push({
      name: capability.name,
      description: capability.description,
      score: Number.POSITIVE_INFINITY,
      matchedTerms: ['in_progress'],
    });
  }
  return candidates;
}

function mergeCapabilityCandidates(...groups: CapabilityCandidate[][]): CapabilityCandidate[] {
  const candidates: CapabilityCandidate[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const candidate of group) {
      if (seen.has(candidate.name)) continue;
      seen.add(candidate.name);
      candidates.push(candidate);
    }
  }
  return candidates;
}

function resolveActor(config: OrchestratorConfig, runnableConfig?: RunnableConfig): AgentActor {
  const invokeActor = getInvokeOptions(runnableConfig).actor;
  if (invokeActor) {
    return invokeActor;
  }
  if (config.actor) {
    return config.actor;
  }
  throw new Error('Missing actor in orchestrator config and invoke options');
}

function createToolAuthorizationRecorder(current: ToolAuthorizationRecord[]) {
  const active = mergeToolAuthorizations([], current);
  const recorded: ToolAuthorizationRecord[] = [];

  return {
    active,
    recorded,
    recordToolAuthorization: (authorization: ToolAuthorizationRecord) => {
      const merged = mergeToolAuthorizations(active, [authorization]);
      if (merged.length > active.length) {
        recorded.push(authorization);
      }
      active.splice(0, active.length, ...merged);
    },
  };
}

// --- Graph builder ---

export function createOrchestratorGraph(config: OrchestratorConfig) {
  const orchestratorMaxIterations = readRunIterationLimit(config.maxRunIterations)
    ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS;

  // Shared control context handed to every Guard/Decision via the node adapters.
  function buildControlContext(runnableConfig?: RunnableConfig): OrchestratorControlContext {
    return { runnableConfig, orchestratorMaxIterations };
  }

  async function prepare(state: OrchestratorStateType) {
    if (state.runId) {
      return {};
    }
    return buildRunStateReset();
  }

  async function compactContext(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const result = await compactOrchestratorMessages({
      messages: state.messages,
      model: config.models.observe ?? config.models.act,
      options: {
        contextWindowTokens: config.contextWindowTokens,
      },
      runnableConfig,
    });
    if (!result.compacted) {
      return {};
    }
    return {
      messages: result.messages,
    };
  }

  // Orchestrator Guards live in ./orchestrator/guards.ts as concrete
  // OrchestratorGuard implementations; getInvokeOptions is injected (it is
  // broadly used invoke-config parsing that stays in this module).
  const {
    userIntentDecisionGuard,
    delegationOutcomeDecisionGuard,
    runIterationLimitGuard,
  } = createOrchestratorGuards({ getInvokeOptions });

  function afterIterationLimitGuard(state: OrchestratorStateType) {
    return state.runPendingFinalReply === 'inline' ? 'end' : 'delegationOutcomeDecisionGuard';
  }

  async function capabilityDiscovery(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const {
      capabilities,
      toolkits,
      execution,
      workdir,
      runtimeEnvironment,
      reviewCapabilities,
      globalReviewPolicy,
      forcedCapabilityNames,
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

    // 强制候选注入:命中时直接把 forced capability 登记为已发现候选并短路
    // 后续 LLM 发现 + 工具搜索流程。仅当 runCapabilitySearchState 还未填充时生效,
    // 保证同一 run 内只在 run 开始时注入一次。未传 forcedCapabilityNames 走老路径。
    if (
      !state.runCapabilitySearchState.attempted
      && state.runCapabilitySearchState.candidates.length === 0
    ) {
      const forcedSeed = buildForcedRunCapabilitySearchState(forcedCapabilityNames, capabilityList);
      if (forcedSeed) {
        return forcedSeed;
      }
    }

    const decisionBaseModel = config.models.act;
    const latestHumanRequest = readLatestHumanRequest(state.messages);
    const recentAnnounces = readRecentAnnounces(state.messages);
    const requestContext = buildCapabilityDiscoveryRequestContext({
      latestUserRequest: latestHumanRequest,
      recentMessages: mainMessagesWithoutCompaction(state.messages),
      recentAnnounces,
      contextSummaries: readContextCompactionSummaries(state.messages),
      capabilityArtifacts: state.sessionCapabilityArtifacts,
    });
    const searchAvailable = canSearchCapabilities(decisionBaseModel, state, capabilityList);

    if (!searchAvailable) {
      return {};
    }

    const discoveryModel = (decisionBaseModel as ToolBindableChatModel).bindTools!([capabilitySearchTool], { parallel_tool_calls: false });
    const response = await discoveryModel.invoke(
      [
        new SystemMessage(buildCapabilityDiscoverySystemPrompt({
          actor,
          runDelegationContext: buildRunDelegationContext(state.runDelegations),
          generalTools,
          workdir,
          runtimeEnvironment,
        })),
        new HumanMessage(buildCapabilityDiscoveryInput({
          latestUserRequest: latestHumanRequest,
          requestContext,
        })),
      ],
      runnableConfig,
    );

    const capabilitySearchCalls = readModelToolCalls(response).filter((call) => call.name === CAPABILITY_SEARCH_TOOL_NAME);
    if (capabilitySearchCalls.length === 0) {
      return {};
    }
    if (capabilitySearchCalls.length > 1) {
      throw new Error('capability discovery emitted multiple capability_search tool calls');
    }
    setPinpetMeta(response, { lane: 'orchestrator', runId: state.runId });

    return {
      messages: [response],
      runPendingDelegation: null,
    };
  }

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
    const activeDelegation = state.taskActiveDelegation
      ?? (kind === 'delegation_outcome' ? readLegacyTaskActiveDelegation(state) : null);
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
    const outputInstruction = buildOrchestrationDecisionOutputInstruction();
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
              ? '当前决策选择继续委派，但没有提供明确任务。'
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
      ? new AIMessage('当前委派任务还没有可交接的结果，暂不能切换到新的执行器。请先继续当前委派，或明确说明要放弃它。')
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

  // Node: answer — the dedicated final-reply node. The decision nodes only route
  // here; this node synthesizes the user-facing reply from the FULL conversation
  // (not the clipped decision digest), so prior subagent results are reproduced
  // faithfully instead of being re-fabricated.
  async function answerNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const { workdir, runtimeEnvironment } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    // The full main conversation queue. Subagent results already live here as
    // handoff copies (first-class, lane-free), so the answer node just reads main
    // — no need to dig announces out of lanes. Context-compaction summaries are
    // kept (mainConversationMessages only drops lane-tagged messages), since after
    // compaction a summary may be the only surviving record of older results.
    const history = mainConversationMessages(state.messages);
    const response = await config.models.act.invoke(
      [
        new SystemMessage(buildAnswerSystemPrompt({ actor, workdir, runtimeEnvironment })),
        ...history,
      ],
      runnableConfig,
    );
    if (!readMessageText(response).trim()) {
      return { messages: [new AIMessage('我这边暂时没有可展示的回复，麻烦你再说一下需要我做什么。')] };
    }
    return { messages: [response] };
  }

  // Node: capability — reads capabilities, tools, execution from configurable
  async function capabilityNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const {
      capabilities,
      toolkits,
      execution,
      onToolEvent,
      workdir,
      runtimeEnvironment,
      reviewCapabilities,
      globalReviewPolicy,
    } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const toolkitList = capabilityLaneToolkits(toolkits ?? []);
    validateUniqueToolkitNames(toolkitList);
    const runPendingDelegation = state.runPendingDelegation;
    if (!runPendingDelegation) {
      return {};
    }
    const capabilityName = readCapabilityNameFromLane(runPendingDelegation.lane);
    const capability = capabilities?.find((c) => c.name === capabilityName);
    if (!capability) {
      return {};
    }
    const lane: MessageLane = `capability:${capability.name}`;
    const transcriptRunId = resolveDelegationTranscriptRunId(state, runPendingDelegation);
    const scopedMessages = laneMessages(state.messages, lane, transcriptRunId, runPendingDelegation.id);
    const threadId = readThreadId(runnableConfig);

    const availableToolkits = toolkitList.map(({ name, description }) => ({
      name,
      description,
    }));

    const runtime = await capability.createRuntime({
      models: config.models,
      actor,
      messages: scopedMessages,
      execution,
      availableToolkits,
      artifactStore: config.capabilityArtifactStore,
    });

    const authorizationRecorder = createToolAuthorizationRecorder(state.sessionToolAuthorizations);
    const artifactRefs: CapabilityArtifactRef[] = [];
    const toolkitContext = {
      models: config.models,
      actor,
      messages: scopedMessages,
      threadId,
      capabilityId: capability.name,
      resultSchema: capability.resultSchema,
      delegationId: runPendingDelegation.id,
      runId: transcriptRunId,
      execution,
      reviewCapabilities,
      globalReviewPolicy,
      toolAuthorizations: authorizationRecorder.active,
      recordToolAuthorization: authorizationRecorder.recordToolAuthorization,
      recordCapabilityArtifact: (ref: CapabilityArtifactRef) => {
        artifactRefs.push(ref);
      },
      emitRuntimeEvent: onToolEvent,
    };
    const usedToolkitResources = await resolveToolkitResources(toolkitList, runtime.uses ?? [], toolkitContext);
    const runtimeInstructions = await resolveInstructions(runtime, {
      models: config.models,
      actor,
      messages: scopedMessages,
      availableToolkits,
    }, execution);
    const middleware = runtime.middleware;
    const handoffInstruction = buildDelegationHandoffInstruction({
      lane,
      task: runPendingDelegation.task,
      contextSummary: runPendingDelegation.contextSummary,
      workdir: workdir ?? null,
    });

    let subagentInput: SubagentInput = {
      model: config.models.subagent ?? config.models.act,
      tools: selectCapabilityTools(runtime, usedToolkitResources.tools),
      instructions: [handoffInstruction, ...usedToolkitResources.instructions, ...(runtimeEnvironment ? [runtimeEnvironment] : []), ...runtimeInstructions],
      operations: collectCapabilityOperations(usedToolkitResources.toolkits, runtime),
      messages: scopedMessages,
      maxIterations: CAPABILITY_SUBAGENT_MAX_ITERATIONS,
      contextWindowTokens: config.contextWindowTokens,
      contextPolicy: runtime.contextPolicy,
      checkpoint: config.checkpoint,
      runnableConfig,
      signal: runnableConfig?.signal,
      artifacts: artifactRefs,
      artifactSink: {
        recordCapabilityArtifact: (ref: CapabilityArtifactRef) => {
          artifactRefs.push(ref);
        },
        threadId,
        delegationId: runPendingDelegation.id,
        runId: transcriptRunId,
      },
      onToolEvent,
    };
    validateUniqueToolNames(subagentInput.tools);

    if (middleware?.beforeRun) {
      subagentInput = await middleware.beforeRun(subagentInput);
      validateUniqueToolNames(subagentInput.tools);
    }

    let result = await createSubagent(subagentInput);

    if (middleware?.afterRun) {
      result = await middleware.afterRun(result, {
        recordCapabilityArtifact: (ref: CapabilityArtifactRef) => {
          artifactRefs.push(ref);
        },
        threadId,
        capabilityId: capability.name,
        delegationId: runPendingDelegation.id,
        runId: transcriptRunId,
      });
    }

    const laneOutputMessages = tagNewLaneMessages(
      result.messages,
      subagentInput.messages.length,
      lane,
      transcriptRunId,
      result.completionReason,
      {
        delegationId: runPendingDelegation.id,
        task: runPendingDelegation.task,
      },
    );
    const delegationAnnounce = readLatestAnnounce(laneOutputMessages, { delegationId: runPendingDelegation.id });
    // The subagent node only records that the delegation ran (status 'progress');
    // whether it is complete is the orchestrator's call at delegationOutcomeDecision,
    // which upgrades the status to 'completed' when it hands off. The raw lane
    // messages are kept in place — handoff (or a later continuation) cleans them up.
    const updatedRunDelegations = updateRunDelegationResult(
      state.runDelegations,
      runPendingDelegation.id,
      {
        status: 'progress',
        resultPreview: delegationAnnounce?.text ?? null,
      },
    );

    return {
      messages: laneOutputMessages,
      sessionCapabilityArtifacts: result.artifacts,
      runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
      runDelegations: updatedRunDelegations,
      runPendingDelegation: null,
      taskActiveDelegation: {
        ...(state.taskActiveDelegation ?? createTaskActiveDelegation(runPendingDelegation, transcriptRunId)),
        status: 'awaiting_decision' as const,
        resultPreview: delegationAnnounce?.text ?? null,
      },
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: authorizationRecorder.recorded,
    };
  }

  // Node: general — reads tools from configurable
  async function generalNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const { toolkits, execution, workdir, runtimeEnvironment, onToolEvent, reviewCapabilities, globalReviewPolicy } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const toolkitList = generalLaneToolkits(toolkits ?? []);
    validateUniqueToolkitNames(toolkitList);
    const authorizationRecorder = createToolAuthorizationRecorder(state.sessionToolAuthorizations);
    const toolkitResources = await resolveToolkitResources(toolkitList, undefined, {
      models: config.models,
      actor,
      messages: state.messages,
      threadId: readThreadId(runnableConfig),
      execution,
      reviewCapabilities,
      globalReviewPolicy,
      toolAuthorizations: authorizationRecorder.active,
      recordToolAuthorization: authorizationRecorder.recordToolAuthorization,
      emitRuntimeEvent: onToolEvent,
    });
    const toolList = [...toolkitResources.tools];
    validateUniqueToolNames(toolList);

    if (toolList.length === 0) {
      throw new Error('General path selected without any available tools');
    }

    const lane: MessageLane = 'general';
    const runPendingDelegation = state.runPendingDelegation;
    if (!runPendingDelegation || runPendingDelegation.lane !== 'general') {
      return {};
    }
    const transcriptRunId = resolveDelegationTranscriptRunId(state, runPendingDelegation);
    const scopedMessages = laneMessages(state.messages, lane, transcriptRunId, runPendingDelegation.id);
    const handoffInstruction = buildDelegationHandoffInstruction({
      lane,
      task: runPendingDelegation.task,
      contextSummary: runPendingDelegation.contextSummary,
      workdir: workdir ?? null,
    });
    const instructions = [
      '[配置]',
      `角色：「${actor.name}」`,
      workdir ? `工作目录：${workdir}` : null,
      workdir ? '相对路径默认相对于工作目录；只有在工具显式指定其他目录时，才偏离这个目录。' : null,
      runtimeEnvironment ? runtimeEnvironment : null,
      '',
      '使用可用工具完成任务，优先调用工具获取准确信息，再给出结果。',
    ].filter((line) => line !== null) as string[];

    const subagentMessages = scopedMessages;
    const result = await createSubagent({
      model: config.models.subagent ?? config.models.act,
      tools: toolList,
      instructions: [handoffInstruction, ...toolkitResources.instructions, ...instructions],
      operations: collectGeneralOperations(toolkitResources.toolkits),
      messages: subagentMessages,
      maxIterations: GENERAL_SUBAGENT_MAX_ITERATIONS,
      contextWindowTokens: config.contextWindowTokens,
      checkpoint: config.checkpoint,
      runnableConfig,
      signal: runnableConfig?.signal,
      onToolEvent,
    });

    const outputMessages = tagNewLaneMessages(
      result.messages,
      subagentMessages.length,
      lane,
      transcriptRunId,
      result.completionReason,
      {
        delegationId: runPendingDelegation.id,
        task: runPendingDelegation.task,
      },
    );
    const delegationAnnounce = readLatestAnnounce(outputMessages, { delegationId: runPendingDelegation.id });

    // See capabilityNode: status is 'progress' until the orchestrator judges it
    // complete at delegationOutcomeDecision; raw lane messages are kept in place.
    const updatedRunDelegations = updateRunDelegationResult(
      state.runDelegations,
      runPendingDelegation.id,
      {
        status: 'progress',
        resultPreview: delegationAnnounce?.text ?? null,
      },
    );

    return {
      messages: outputMessages,
      runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
      runDelegations: updatedRunDelegations,
      runPendingDelegation: null,
      taskActiveDelegation: {
        ...(state.taskActiveDelegation ?? createTaskActiveDelegation(runPendingDelegation, transcriptRunId)),
        status: 'awaiting_decision' as const,
        resultPreview: delegationAnnounce?.text ?? null,
      },
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: authorizationRecorder.recorded,
    };
  }

  function afterCapabilityDiscovery(state: OrchestratorStateType) {
    const latestMessage = state.messages[state.messages.length - 1];
    if (
      latestMessage?._getType() === 'ai'
      && getMessageLane(latestMessage) === 'orchestrator'
      && getMessageTurnId(latestMessage) === state.runId
      && readModelToolCalls(latestMessage as AIMessage).some((call) => call.name === CAPABILITY_SEARCH_TOOL_NAME)
    ) {
      return 'capabilitySearch';
    }
    return 'userIntentDecisionGuard';
  }

  function afterContextPrep(state: OrchestratorStateType) {
    if (state.taskActiveDelegation?.status === 'awaiting_decision') {
      return 'delegationOutcomeIterationGuard';
    }
    if (!state.taskActiveDelegation && readLegacyTaskActiveDelegation(state)) {
      return 'delegationOutcomeIterationGuard';
    }
    return 'capabilityDiscovery';
  }

  function afterDecision(state: OrchestratorStateType) {
    const decisionMode = decisionModeFromRunPendingDelegation(state.runPendingDelegation);
    if (decisionMode === 'capability') return 'capability';
    if (decisionMode === 'general') return 'general';
    // answer bucket: route a real answer decision to the answer node; inline fallback
    // errors already emitted their message.
    return state.runPendingFinalReply === 'answer' ? 'answer' : 'end';
  }

  const graph = new StateGraph(OrchestratorState)
    .addNode('prepare', prepare)
    .addNode('compactContext', compactContext)
    .addNode('capabilityDiscovery', capabilityDiscovery)
    .addNode('capabilitySearch', new ToolNode([capabilitySearchTool]))
    .addNode('userIntentDecisionGuard', asGuardNode(userIntentDecisionGuard, buildControlContext))
    .addNode('delegationOutcomeDecisionGuard', asGuardNode(delegationOutcomeDecisionGuard, buildControlContext))
    .addNode('userIntentDecision', asDecisionNode(userIntentDecision, buildControlContext))
    .addNode('delegationOutcomeIterationGuard', asGuardNode(runIterationLimitGuard, buildControlContext))
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
      userIntentDecisionGuard: 'userIntentDecisionGuard',
    })
    .addEdge('userIntentDecisionGuard', 'userIntentDecision')
    .addConditionalEdges('delegationOutcomeIterationGuard', afterIterationLimitGuard, {
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
    .addEdge('capabilitySearch', 'userIntentDecisionGuard')
    .addEdge('capability', 'delegationOutcomeIterationGuard')
    .addEdge('general', 'delegationOutcomeIterationGuard');

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;

export type OrchestratorGraphStream = AsyncIterable<unknown>;
/** @deprecated Use OrchestratorGraphStream. */
export type OrchestratorTokenUsageStream = OrchestratorGraphStream;

export function streamOrchestratorGraph(
  graph: OrchestratorGraph,
  input: Parameters<OrchestratorGraph['stream']>[0],
  options?: Parameters<OrchestratorGraph['stream']>[1],
): OrchestratorGraphStream {
  return (async function* streamOrchestratorGraphChunks() {
    const innerStream = await graph.stream(input, options);
    for await (const chunk of innerStream as AsyncIterable<unknown>) {
      yield chunk;
    }
  })();
}

/** @deprecated Use streamOrchestratorGraph. */
export const streamOrchestratorGraphWithTokenUsage = streamOrchestratorGraph;
