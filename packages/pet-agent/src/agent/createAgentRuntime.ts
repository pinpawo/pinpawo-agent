import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { AgentCapability } from '../types/capability';
import type { AgentActor, AgentExecution, AgentModels } from '../types/agent';
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
  buildIterationLimitHumanReviewRequest,
  readFirstHumanReviewDecision,
} from './orchestrator/humanReview';
import {
  reuseOrAppendTurnDelegation,
  updateTurnDelegationResult,
} from './orchestrator/delegations';
import {
  getMessageLane,
  getMessageTurnId,
  laneMessages,
  mainConversationMessages,
  readLatestHumanRequest,
  readLatestAnnounce,
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
    tools: (cfg.tools ?? []) as StructuredTool[],
    toolOperations: cfg.toolOperations as OrchestratorInvokeOptions['toolOperations'] | undefined,
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
      tools: globalTools,
      toolkits,
      execution,
      workdir,
      runtimeEnvironment,
      forcedCapabilityNames,
    } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const toolkitList = toolkits ?? [];
    validateUniqueToolkitNames(toolkitList);
    const generalToolkitResources = await resolveToolkitResources(toolkitList, undefined, {
      models: config.models,
      actor,
      messages: state.messages,
      execution,
    }, { includeInstructions: false });
    const generalTools = [...(globalTools ?? []), ...generalToolkitResources.tools];
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
    const requestContext = buildCapabilityDiscoveryRequestContext({
      latestUserRequest: latestHumanRequest,
      recentMessages: mainMessagesWithoutCompaction(state.messages),
      recentAnnounces: readRecentAnnounces(state.messages),
      contextSummaries: readContextCompactionSummaries(state.messages),
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
      capabilityResult: null,
    };
  }

  async function runOrchestrationDecision(
    kind: 'user_intent' | 'delegation_outcome',
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const { capabilities, tools: globalTools, toolkits, execution, maxIterations, workdir, runtimeEnvironment } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const maxIter = maxIterations ?? 5;

    if (state.iterationCount >= maxIter) {
      const delegationSummary = state.turnDelegations
        .map((d) => `[${d.id}] ${d.lane} — ${formatDelegationStatus(d.status)}: ${clipForPrompt(d.task, 80)}`)
        .join('\n') || '无委派记录';
      const reviewRequest = buildIterationLimitHumanReviewRequest({
        iterationCount: state.iterationCount,
        maxIterations: maxIter,
        delegationSummary,
      });
      let decision = readFirstHumanReviewDecision(interrupt(reviewRequest));
      while (!decision) {
        decision = readFirstHumanReviewDecision(interrupt({
          ...reviewRequest,
          error: 'invalid_decision',
          prompt: `${reviewRequest.prompt}\n\n请选择批准继续，或拒绝停止。`,
        }));
      }
      if (decision.type !== 'approve') {
        return {
          messages: [new AIMessage(`已停止，共执行 ${state.iterationCount} 轮。如需继续请告诉我。`)],
          pendingDelegation: null,
        };
      }
      return {
        iterationCount: 0,
        pendingDelegation: null,
      };
    }

    const toolkitList = toolkits ?? [];
    validateUniqueToolkitNames(toolkitList);
    const generalToolkitResources = await resolveToolkitResources(toolkitList, undefined, {
      models: config.models,
      actor,
      messages: state.messages,
      execution,
    }, { includeInstructions: false });
    const generalTools = [...(globalTools ?? []), ...generalToolkitResources.tools];
    validateUniqueToolNames(generalTools);

    const capabilityList = capabilities ?? [];
    validateUniqueCapabilityNames(capabilityList);
    const latestHumanRequest = readLatestHumanRequest(state.messages);
    const recentMainMessages = mainMessagesWithoutCompaction(state.messages);
    const contextSummaries = readContextCompactionSummaries(state.messages);
    const requestContext = buildPreparedRequestContext({
      latestUserRequest: latestHumanRequest,
      recentMessages: recentMainMessages,
      recentAnnounces: readRecentAnnounces(state.messages),
      contextSummaries,
    });
    const isUserIntentDecision = kind === 'user_intent';
    const decisionCapabilityCandidates = isUserIntentDecision ? state.capabilitySearchState.candidates : [];
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
          capabilityCandidates: [],
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
          readLatestAnnounce(state.messages, { turnId: state.turnId }),
        ),
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
      messages: decisionMode === 'finish' && finalReply
        ? [new AIMessage(finalReply)]
        : [],
      pendingDelegation: nextDelegationState.pendingDelegation,
      capabilityResult: decisionMode === 'capability' ? null : state.capabilityResult,
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
    const toolkitList = toolkits ?? [];
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
    const scopedMessages = laneMessages(state.messages, lane, state.turnId);

    const runtime = await capability.createRuntime({
      models: config.models,
      actor,
      messages: scopedMessages,
      execution,
    });

    const toolkitContext = {
      models: config.models,
      actor,
      messages: scopedMessages,
      execution,
    };
    const usedToolkitResources = await resolveToolkitResources(toolkitList, runtime.uses ?? [], toolkitContext);
    const runtimeInstructions = await resolveInstructions(runtime, { models: config.models, actor }, execution);
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
      signal: runnableConfig?.signal,
      onToolEvent,
    };
    validateUniqueToolNames(subagentInput.tools);

    if (middleware?.beforeRun) {
      subagentInput = await middleware.beforeRun(subagentInput);
      validateUniqueToolNames(subagentInput.tools);
    }

    let result = await createSubagent(subagentInput);

    if (middleware?.afterRun) {
      result = await middleware.afterRun(result);
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
    const rawCapabilityResult = runtime.readResult
      ? runtime.readResult(laneOutputMessages)
      : null;
    const parsedCapabilityResult = rawCapabilityResult && capability.resultSchema
      ? capability.resultSchema.safeParse(rawCapabilityResult)
      : null;
    const capabilityResult = parsedCapabilityResult?.success
      ? parsedCapabilityResult.data as Record<string, unknown>
      : null;
    const updatedTurnDelegations = updateTurnDelegationResult(
      state.turnDelegations,
      pendingDelegation.id,
      {
        status: delegationAnnounce?.announce ?? (result.completionReason === 'natural' ? 'completed' : 'progress'),
        resultPreview: delegationAnnounce?.text ?? null,
      },
    );

    return {
      messages: laneOutputMessages,
      capabilityResult,
      capabilitySearchState: buildEmptyCapabilitySearchState(),
      turnDelegations: updatedTurnDelegations,
      pendingDelegation: null,
      iterationCount: state.iterationCount + 1,
    };
  }

  // Node: general — reads tools from configurable
  async function generalNode(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const { tools: globalTools, toolOperations, toolkits, execution, workdir, runtimeEnvironment, onToolEvent } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(config, runnableConfig);
    const toolkitList = toolkits ?? [];
    validateUniqueToolkitNames(toolkitList);
    const toolkitResources = await resolveToolkitResources(toolkitList, undefined, {
      models: config.models,
      actor,
      messages: state.messages,
      execution,
    });
    const toolList = [...(globalTools ?? []), ...toolkitResources.tools];
    validateUniqueToolNames(toolList);

    if (toolList.length === 0) {
      throw new Error('General path selected without any available tools');
    }

    const lane: MessageLane = 'general';
    const scopedMessages = laneMessages(state.messages, lane, state.turnId);
    const pendingDelegation = state.pendingDelegation;
    if (!pendingDelegation || pendingDelegation.lane !== 'general') {
      return {};
    }
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
      operations: collectGeneralOperations(toolkitResources.toolkits, toolOperations),
      messages: subagentMessages,
      maxIterations: GENERAL_SUBAGENT_MAX_ITERATIONS,
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
      messages: outputMessages,
      capabilitySearchState: buildEmptyCapabilitySearchState(),
      turnDelegations: updatedTurnDelegations,
      pendingDelegation: null,
      iterationCount: state.iterationCount + 1,
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
