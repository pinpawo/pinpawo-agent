import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { AgentCapability } from '../types/capability';
import type { AgentActor, AgentExecution, AgentModels } from '../types/agent';
import type { CapabilityArtifactRef } from '../types/artifact';
import type { SubagentInput, SubagentToolEventHandler } from '../types/subagent';
import type { AgentToolkit } from '../types/toolkit';
import { randomUUID } from 'node:crypto';
import { createSubagent } from '../subagent/createSubagent';
import {
  buildEmptyCapabilitySearchState,
  buildTurnStateReset,
  OrchestratorState,
  type OrchestratorStateType,
} from './orchestrator/state';
import {
  compactOrchestratorMessages,
  isContextCompactionMessage,
  readContextCompactionSummaries,
} from './orchestrator/contextCompaction';
import type {
  CapabilityCandidate,
  CapabilityDecisionState,
  MessageLane,
  OrchestratorConfig,
  OrchestratorInvokeOptions,
  PendingDelegation,
  DecisionMode,
  StructuredOrchestrationDecisionModel,
  ToolBindableChatModel,
  OrchestrationDecisionStructuredOutputConfig,
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
import {
  buildCapabilityDiscoveryInput,
  buildCapabilityDiscoveryRequestContext,
  buildCapabilityDiscoverySystemPrompt,
  buildDecisionTargetsContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildPreparedRequestContext,
  buildSubagentAnnounceContext,
  buildTurnDelegationContext,
  buildUserIntentDecisionInput,
  buildUserIntentDecisionSystemPrompt,
} from './orchestrator/prompts';
import {
  resolveHumanReviewResume,
  ReviewResponseResolutionError,
} from './orchestrator/review/reviewResponseResolver';
import { buildReviewSpec, type HumanReviewInterruptPayload } from './orchestrator/review/reviewSpec';
import {
  mergeToolAuthorizations,
  type ToolAuthorizationRecord,
} from './orchestrator/review/reviewAuthorizations';
import {
  reuseOrAppendTurnDelegation,
  updateTurnDelegationResult,
} from './orchestrator/delegations';
import {
  getMessageLane,
  getMessageTurnId,
  laneMessages,
  laneMessagesForStateUpdate,
  mainConversationMessages,
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
import { clipForPrompt, formatDelegationStatus } from './orchestrator/utils';

export type {
  OrchestratorConfig,
  OrchestratorInvokeOptions,
  OrchestratorStateType,
  OrchestrationDecisionStructuredOutputConfig,
};
export { buildOrchestratorTurnInput } from './orchestrator/state';
export { validateUniqueCapabilityNames, validateUniqueToolkitNames, validateUniqueToolNames } from './orchestrator/validation';

const GENERAL_SUBAGENT_MAX_ITERATIONS = 16;
const CAPABILITY_SUBAGENT_MAX_ITERATIONS = 8;

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
    maxIterations: cfg.maxIterations as number | undefined,
    workdir: cfg.workdir as string | undefined,
    runtimeEnvironment: cfg.runtimeEnvironment as string | undefined,
    onToolEvent: cfg.onToolEvent as SubagentToolEventHandler | undefined,
    forcedCapabilityNames: Array.isArray((cfg as { forcedCapabilityNames?: unknown }).forcedCapabilityNames)
      ? (cfg as { forcedCapabilityNames: unknown[] }).forcedCapabilityNames.filter(
          (name): name is string => typeof name === 'string' && name.length > 0,
        )
      : undefined,
  };
}

function readThreadId(runnableConfig?: RunnableConfig): string | null {
  const value = runnableConfig?.configurable?.thread_id;
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * 把 `forcedCapabilityNames` 映射成 synthetic capabilitySearch candidates。
 *
 * 命中:在 `prepare` 阶段把同名 capability 直接登记为已发现候选(高分 +
 * matchedTerms=['forced']),并把 `attempted` 置为 true。下游
 * `canSearchCapabilities` 会因为 candidates 非空 / attempted=true 而短路,
 * 整段 capability discovery + search 不再触发。
 *
 * 未传或为空数组 → 返回 null,prepare 走默认 turn reset 路径(0 行为变化)。
 */
function buildForcedCapabilitySearchState(
  forcedNames: string[] | undefined,
  capabilityList: AgentCapability[],
): { capabilitySearchState: CapabilitySearchStateForReset } | null {
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
    capabilitySearchState: {
      query: null,
      attempted: true,
      candidates,
    },
  };
}

type CapabilitySearchStateForReset = ReturnType<typeof buildEmptyCapabilitySearchState>;

function canSearchCapabilities(
  model: AgentModels['act'],
  state: OrchestratorStateType,
  capabilities: AgentCapability[],
): model is ToolBindableChatModel {
  return capabilities.length > 0
    && !state.capabilitySearchState.attempted
    && state.capabilitySearchState.candidates.length === 0
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

function decisionModeFromPendingDelegation(pending: PendingDelegation | null): DecisionMode {
  if (!pending) return 'finish';
  return pending.lane === 'general' ? 'general' : 'capability';
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

function buildIterationLimitReviewPayload(params: {
  turnId: string;
  iterationCount: number;
  maxIterations: number;
  delegationSummary: string;
}): HumanReviewInterruptPayload {
  const body = `已执行 ${params.iterationCount} 轮循环（上限 ${params.maxIterations}），当前任务状态：\n${params.delegationSummary}\n\n是否批准继续执行？`;
  return {
    kind: 'review',
    review: buildReviewSpec({
      id: `iteration-limit:${params.turnId}:${params.iterationCount}:${params.maxIterations}`,
      view: {
        kind: 'plain',
        title: 'Iteration limit reached',
        body,
      },
      options: [
        {
          id: 'approve',
          label: 'Approve',
          variant: 'primary',
          decision: { type: 'approve' },
        },
        {
          id: 'reject',
          label: 'Reject',
          variant: 'danger',
          decision: { type: 'reject' },
        },
        {
          id: 'respond',
          label: 'Respond',
          input: {
            kind: 'text',
            key: 'message',
            required: true,
            multiline: true,
            placeholder: 'Tell the agent how to continue',
          },
          decision: { type: 'respond', messageInputKey: 'message' },
        },
      ],
    }),
  };
}

function buildInvalidIterationLimitReviewPayload(
  payload: HumanReviewInterruptPayload,
): HumanReviewInterruptPayload {
  const message = '请选择批准继续、拒绝停止，或提供新的处理方向。';
  return {
    ...payload,
    error: 'invalid_decision',
    review: {
      ...payload.review,
      view: {
        ...payload.review.view,
        body: `${payload.review.view.body}\n\n${message}`,
      },
    },
  };
}

function resolveIterationLimitReviewDecision(payload: HumanReviewInterruptPayload, resume: unknown) {
  try {
    return resolveHumanReviewResume({
      reviewSpec: payload.review,
    }, resume).decision;
  } catch (error) {
    if (!(error instanceof ReviewResponseResolutionError)) {
      throw error;
    }
  }
  return null;
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
  async function prepare(state: OrchestratorStateType) {
    if (state.turnId) {
      return {};
    }
    return buildTurnStateReset();
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

  async function capabilityDiscovery(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const {
      capabilities,
      toolkits,
      execution,
      workdir,
      runtimeEnvironment,
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
      toolAuthorizations: state.toolAuthorizations,
    }, { includeInstructions: false });
    const generalTools = generalToolkitResources.tools;
    validateUniqueToolNames(generalTools);
    const capabilityList = capabilities ?? [];
    validateUniqueCapabilityNames(capabilityList);

    // 强制候选注入:命中时直接把 forced capability 登记为已发现候选并短路
    // 后续 LLM 发现 + 工具搜索流程。仅当 capabilitySearchState 还未填充时生效,
    // 保证多 turn 内只在 turn 开始时注入一次。未传 forcedCapabilityNames 走老路径。
    if (
      !state.capabilitySearchState.attempted
      && state.capabilitySearchState.candidates.length === 0
    ) {
      const forcedSeed = buildForcedCapabilitySearchState(forcedCapabilityNames, capabilityList);
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
      capabilityArtifacts: state.capabilityArtifacts,
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
          turnDelegationContext: buildTurnDelegationContext(state.turnDelegations),
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
    setPinpetMeta(response, { lane: 'orchestrator', turnId: state.turnId });

    return {
      messages: [response],
      pendingDelegation: null,
    };
  }

  async function runOrchestrationDecision(
    kind: 'user_intent' | 'delegation_outcome',
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const { capabilities, toolkits, execution, maxIterations, workdir, runtimeEnvironment } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const maxIter = maxIterations ?? 5;
    let iterationLimitMessages: BaseMessage[] = [];
    let resetIterationCount = false;

    if (state.iterationCount >= maxIter) {
      const delegationSummary = state.turnDelegations
        .map((d) => `[${d.id}] ${d.lane} — ${formatDelegationStatus(d.status)}: ${clipForPrompt(d.task, 80)}`)
        .join('\n') || '无委派记录';
      const reviewPayload = buildIterationLimitReviewPayload({
        turnId: state.turnId,
        iterationCount: state.iterationCount,
        maxIterations: maxIter,
        delegationSummary,
      });
      let decision = resolveIterationLimitReviewDecision(reviewPayload, interrupt(reviewPayload));
      while (!decision) {
        decision = resolveIterationLimitReviewDecision(
          reviewPayload,
          interrupt(buildInvalidIterationLimitReviewPayload(reviewPayload)),
        );
      }
      if (decision.type === 'respond') {
        iterationLimitMessages = [new HumanMessage(decision.message)];
        state = {
          ...state,
          messages: [...state.messages, ...iterationLimitMessages],
          iterationCount: 0,
          pendingDelegation: null,
        };
        resetIterationCount = true;
      } else if (decision.type !== 'approve') {
        return {
          messages: [new AIMessage(`已停止，共执行 ${state.iterationCount} 轮。如需继续请告诉我。`)],
          pendingDelegation: null,
        };
      } else {
        state = {
          ...state,
          iterationCount: 0,
          pendingDelegation: null,
        };
        resetIterationCount = true;
      }
    }

    const toolkitList = generalLaneToolkits(toolkits ?? []);
    validateUniqueToolkitNames(toolkitList);
    const generalToolkitResources = await resolveToolkitResources(toolkitList, undefined, {
      models: config.models,
      actor,
      messages: state.messages,
      execution,
      toolAuthorizations: state.toolAuthorizations,
    }, { includeInstructions: false });
    const generalTools = generalToolkitResources.tools;
    validateUniqueToolNames(generalTools);

    const capabilityList = capabilities ?? [];
    validateUniqueCapabilityNames(capabilityList);
    const latestHumanRequest = readLatestHumanRequest(state.messages);
    const recentMainMessages = mainMessagesWithoutCompaction(state.messages);
    const contextSummaries = readContextCompactionSummaries(state.messages);
    const recentAnnounces = readRecentAnnounces(state.messages);
    const latestTurnAnnounce = readLatestAnnounce(state.messages, { turnId: state.turnId });
    const requestContext = buildPreparedRequestContext({
      latestUserRequest: latestHumanRequest,
      recentMessages: recentMainMessages,
      recentAnnounces,
      contextSummaries,
      capabilityArtifacts: state.capabilityArtifacts,
    });
    const isUserIntentDecision = kind === 'user_intent';
    const inProgressCapabilityCandidates = buildCapabilityCandidatesFromLanes(
      capabilityList,
      isUserIntentDecision
        ? recentAnnounces
          .filter((announce) => announce.announce === 'progress')
          .map((announce) => announce.lane)
        : [latestTurnAnnounce?.lane],
    );
    const decisionCapabilityCandidates = isUserIntentDecision
      ? mergeCapabilityCandidates(state.capabilitySearchState.candidates, inProgressCapabilityCandidates)
      : inProgressCapabilityCandidates;
    const decisionCapabilitySearchAttempted = isUserIntentDecision && state.capabilitySearchState.attempted;
    const decisionCapabilitySearchQuery = isUserIntentDecision ? state.capabilitySearchState.query : null;
    const searchAvailable = isUserIntentDecision
      && canSearchCapabilities(config.models.act, state, capabilityList);
    const capabilityDecisionState = resolveCapabilityDecisionState({
      canSearch: searchAvailable,
      capabilityCandidates: decisionCapabilityCandidates,
      capabilitySearchAttempted: decisionCapabilitySearchAttempted,
    });
    const turnDelegationContext = buildTurnDelegationContext(state.turnDelegations);
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
        turnDelegationContext,
        targetsContext: decisionTargetsContext,
        capabilityDecisionState,
        outputInstruction,
        workdir,
        runtimeEnvironment,
      })
      : buildDelegationOutcomeDecisionSystemPrompt({
        actor,
        targetsContext: buildDecisionTargetsContext({
          generalTools,
          capabilityCandidates: decisionCapabilityCandidates,
          capabilitySearchAttempted: false,
          capabilitySearchAvailable: false,
          capabilitySearchQuery: null,
          capabilityRegistryAvailable: capabilityList.length > 0,
        }),
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
        turnDelegationContext,
        subagentAnnounceContext: buildSubagentAnnounceContext(
          latestTurnAnnounce,
          readLatestAnnounceCompletionReason(state.messages, { turnId: state.turnId }),
        ),
        capabilityArtifacts: state.capabilityArtifacts,
      }));

    const decisionSchema = buildOrchestrationDecisionSchema({
      capabilityCandidates: decisionCapabilityCandidates,
    });
    let decision: OrchestrationDecision;
    try {
      const decisionModel = config.models.act.withStructuredOutput(
        decisionSchema,
        buildOrchestrationDecisionStructuredOutputOptions(
          config.decisionStructuredOutput,
        ),
      ) as StructuredOrchestrationDecisionModel;
      const rawDecision = await decisionModel.invoke(
        [
          new SystemMessage(systemPrompt),
          decisionInputMessage,
        ],
        runnableConfig,
      );
      const parsedDecision = decisionSchema.safeParse(rawDecision);
      if (!parsedDecision.success) {
        throw new Error(`Invalid orchestration decision structured output: ${parsedDecision.error.message}`);
      }
      decision = parsedDecision.data as OrchestrationDecision;
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
          : 'finish';

    const finalReply = decisionMode === 'finish'
      ? actionKind === 'finish'
        ? readDecisionText(decision.answer) ?? '当前决策选择直接回复，但没有生成可展示的回复内容。'
        : actionKind === 'ask_user'
          ? readDecisionText(decision.question) ?? '我需要你再补充一点信息，才能继续推进。'
          : actionKind === 'delegate_general' && generalTools.length === 0
            ? '我现在没有可用的通用工具执行器，无法继续完成这一步。'
            : actionKind === 'delegate_capability' && !activeCapability
              ? `当前没有可用的 capability「${requestedCapability ?? ''}」，无法继续完成这一步。`
              : !decisionTask
                ? '当前决策选择继续委派，但没有提供明确任务。'
                : '当前决策已结束，但没有生成可展示的回复。'
      : null;

    const delegationLane: MessageLane | null = decisionMode === 'general'
      ? 'general'
      : activeCapability
        ? `capability:${activeCapability}`
        : null;
    const delegationTask = decisionMode !== 'finish'
      ? decisionTask ?? readLatestHumanRequest(state.messages) ?? '继续完成用户当前请求'
      : null;
    const delegationContextSummary = decisionMode !== 'finish'
      ? decisionContextSummary ?? '继续完成用户当前请求。'
      : null;
    const pendingDelegation: PendingDelegation | null = delegationLane && delegationTask
      ? {
          id: randomUUID().slice(0, 8),
          lane: delegationLane,
          task: delegationTask,
          contextSummary: delegationContextSummary,
        }
      : null;
    const nextDelegationState = reuseOrAppendTurnDelegation(state.turnDelegations, pendingDelegation);

    return {
      messages: [
        ...iterationLimitMessages,
        ...(decisionMode === 'finish' && finalReply ? [new AIMessage(finalReply)] : []),
      ],
      pendingDelegation: nextDelegationState.pendingDelegation,
      ...(resetIterationCount ? { iterationCount: 0 } : {}),
      ...(kind === 'delegation_outcome'
        ? {
            capabilitySearchState: buildEmptyCapabilitySearchState(),
          }
        : {}),
      turnDelegations: nextDelegationState.turnDelegations,
    };
  }

  async function userIntentDecision(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    return runOrchestrationDecision('user_intent', state, runnableConfig);
  }

  async function delegationOutcomeDecision(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    return runOrchestrationDecision('delegation_outcome', state, runnableConfig);
  }

  // Node: capability — reads capabilities, tools, execution from configurable
  async function capabilityNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const { capabilities, toolkits, execution, onToolEvent, workdir, runtimeEnvironment } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const toolkitList = capabilityLaneToolkits(toolkits ?? []);
    validateUniqueToolkitNames(toolkitList);
    const pendingDelegation = state.pendingDelegation;
    if (!pendingDelegation) {
      return {};
    }
    const capabilityName = readCapabilityNameFromLane(pendingDelegation.lane);
    const capability = capabilities?.find((c) => c.name === capabilityName);
    if (!capability) {
      return {};
    }
    const lane: MessageLane = `capability:${capability.name}`;
    const scopedMessages = laneMessages(state.messages, lane, state.turnId, pendingDelegation.id);
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
    });

    const authorizationRecorder = createToolAuthorizationRecorder(state.toolAuthorizations);
    const artifactRefs: CapabilityArtifactRef[] = [];
    const toolkitContext = {
      models: config.models,
      actor,
      messages: scopedMessages,
      threadId,
      capabilityId: capability.name,
      resultSchema: capability.resultSchema,
      delegationId: pendingDelegation.id,
      turnId: state.turnId,
      execution,
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
      task: pendingDelegation.task,
      contextSummary: pendingDelegation.contextSummary,
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
        delegationId: pendingDelegation.id,
        turnId: state.turnId,
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
        delegationId: pendingDelegation.id,
        turnId: state.turnId,
      });
    }

    const laneOutputMessages = tagNewLaneMessages(
      result.messages,
      subagentInput.messages.length,
      lane,
      state.turnId,
      result.completionReason,
      {
        delegationId: pendingDelegation.id,
        task: pendingDelegation.task,
      },
    );
    const delegationAnnounce = readLatestAnnounce(laneOutputMessages, { delegationId: pendingDelegation.id });
    const updatedTurnDelegations = updateTurnDelegationResult(
      state.turnDelegations,
      pendingDelegation.id,
      {
        status: delegationAnnounce?.announce ?? (result.completionReason === 'natural' ? 'completed' : 'progress'),
        resultPreview: delegationAnnounce?.text ?? null,
      },
    );

    return {
      messages: laneMessagesForStateUpdate({
        existingMessages: state.messages,
        outputMessages: laneOutputMessages,
        lane,
        turnId: state.turnId,
        delegationId: pendingDelegation.id,
      }),
      capabilityArtifacts: result.artifacts,
      capabilitySearchState: buildEmptyCapabilitySearchState(),
      turnDelegations: updatedTurnDelegations,
      pendingDelegation: null,
      iterationCount: state.iterationCount + 1,
      toolAuthorizations: authorizationRecorder.recorded,
    };
  }

  // Node: general — reads tools from configurable
  async function generalNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const { toolkits, execution, workdir, runtimeEnvironment, onToolEvent } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const toolkitList = generalLaneToolkits(toolkits ?? []);
    validateUniqueToolkitNames(toolkitList);
    const authorizationRecorder = createToolAuthorizationRecorder(state.toolAuthorizations);
    const toolkitResources = await resolveToolkitResources(toolkitList, undefined, {
      models: config.models,
      actor,
      messages: state.messages,
      threadId: readThreadId(runnableConfig),
      execution,
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
    const pendingDelegation = state.pendingDelegation;
    if (!pendingDelegation || pendingDelegation.lane !== 'general') {
      return {};
    }
    const scopedMessages = laneMessages(state.messages, lane, state.turnId, pendingDelegation.id);
    const handoffInstruction = buildDelegationHandoffInstruction({
      lane,
      task: pendingDelegation.task,
      contextSummary: pendingDelegation.contextSummary,
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
      state.turnId,
      result.completionReason,
      {
        delegationId: pendingDelegation.id,
        task: pendingDelegation.task,
      },
    );
    const delegationAnnounce = readLatestAnnounce(outputMessages, { delegationId: pendingDelegation.id });

    const updatedTurnDelegations = updateTurnDelegationResult(
      state.turnDelegations,
      pendingDelegation.id,
      {
        status: delegationAnnounce?.announce ?? (result.completionReason === 'natural' ? 'completed' : 'progress'),
        resultPreview: delegationAnnounce?.text ?? null,
      },
    );

    return {
      messages: laneMessagesForStateUpdate({
        existingMessages: state.messages,
        outputMessages,
        lane,
        turnId: state.turnId,
        delegationId: pendingDelegation.id,
      }),
      capabilitySearchState: buildEmptyCapabilitySearchState(),
      turnDelegations: updatedTurnDelegations,
      pendingDelegation: null,
      iterationCount: state.iterationCount + 1,
      toolAuthorizations: authorizationRecorder.recorded,
    };
  }

  // Conditional edge
  function afterPrepare(state: OrchestratorStateType) {
    return readLatestAnnounce(state.messages, { turnId: state.turnId })
      ? 'delegationOutcomeDecision'
      : 'capabilityDiscovery';
  }

  function afterCapabilityDiscovery(state: OrchestratorStateType) {
    const latestMessage = state.messages[state.messages.length - 1];
    if (
      latestMessage?._getType() === 'ai'
      && getMessageLane(latestMessage) === 'orchestrator'
      && getMessageTurnId(latestMessage) === state.turnId
      && readModelToolCalls(latestMessage as AIMessage).some((call) => call.name === CAPABILITY_SEARCH_TOOL_NAME)
    ) {
      return 'capabilitySearch';
    }
    return 'userIntentDecision';
  }

  function afterDecision(state: OrchestratorStateType) {
    const decisionMode = decisionModeFromPendingDelegation(state.pendingDelegation);
    if (decisionMode === 'capability') return 'capability';
    if (decisionMode === 'general') return 'general';
    return 'end';
  }

  const graph = new StateGraph(OrchestratorState)
    .addNode('prepare', prepare)
    .addNode('compactContext', compactContext)
    .addNode('capabilityDiscovery', capabilityDiscovery)
    .addNode('capabilitySearch', new ToolNode([capabilitySearchTool]))
    .addNode('userIntentDecision', userIntentDecision)
    .addNode('delegationOutcomeDecision', delegationOutcomeDecision)
    .addNode('capability', capabilityNode)
    .addNode('general', generalNode)
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'compactContext')
    .addConditionalEdges('compactContext', afterPrepare, {
      capabilityDiscovery: 'capabilityDiscovery',
      delegationOutcomeDecision: 'delegationOutcomeDecision',
    })
    .addConditionalEdges('capabilityDiscovery', afterCapabilityDiscovery, {
      capabilitySearch: 'capabilitySearch',
      userIntentDecision: 'userIntentDecision',
    })
    .addConditionalEdges('userIntentDecision', afterDecision, {
      end: END,
      capability: 'capability',
      general: 'general',
    })
    .addConditionalEdges('delegationOutcomeDecision', afterDecision, {
      end: END,
      capability: 'capability',
      general: 'general',
    })
    .addEdge('capabilitySearch', 'userIntentDecision')
    .addEdge('capability', 'delegationOutcomeDecision')
    .addEdge('general', 'delegationOutcomeDecision');

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
