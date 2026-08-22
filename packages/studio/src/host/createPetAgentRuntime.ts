/**
 * `PetAgentRuntime` port 的 Studio Host 适配器。
 *
 * 它位于 Studio package 的 Host 层，把 core port 接到具体 LangGraph
 * 执行路径。core 目录本身仍不依赖 Host 或本机服务实现。
 *
 * LangGraph 把 interrupt 与 pending continuation 持久化到 checkpoint；runtime
 * 负责把它投射成公开 PendingInterrupt、校验 typed resume，并构造 Command。
 * Studio core 只搬运这些输入/结果，不解释 review 选项或 checkpoint 内容。
 */
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';

import type { AgentCapability } from '@pinpawo/pet-agent';
import type { AgentActor, AgentExecution, AgentModels } from '@pinpawo/pet-agent';
import {
  filterAvailableToolkits,
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import { ToolkitRuntimeManager } from '@pinpawo/pet-agent';
import type {
  PetAgentCapabilitySummary,
  PetAgentStartupMode,
  PetAgentStatus,
} from '../petAgentTypes';
import {
  buildOrchestratorRunInput,
  createOrchestratorGraph,
  compileAgentRegistry,
  formatExecutorCompilationIssues,
  isHumanReviewBatchInterruptPayload,
  isHumanReviewInterruptPayload,
  projectHumanReviewRequest,
  resolveHumanReviewResponse,
  toInternalReviewResponse,
  type OrchestratorConfig,
  type OrchestratorGraph,
  type ReviewResponse,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
import type {
  PetAgentRuntime,
  PetAgentRuntimeDescriptor,
  PetAgentRuntimeInvokeInput,
  PetAgentRuntimeInvokeResult,
  PetGateState,
} from '../types';
import type { StudioWikiAccess } from '../wikiPort';
import type { PendingInterruptProjection } from '../studioInvocation';

/**
 * Studio runtime 允许 LangGraph 生成可持久化的 review interrupt。当前内建
 * transport 不复用 Chat review 消息；独立交互 Plugin 可以观察 pending
 * invocation event，并通过 Studio dispatch 对同一 Pet thread 提交 typed resume。
 */
const STUDIO_REVIEW_CAPABILITIES = {
  humanReview: true,
  sessionAuthorization: true,
} as const;

export type PetAgentRuntimeConfig = {
  models: AgentModels;
  actor: AgentActor;
  role?: string | null;
  serviceSummary?: string | null;
  startupMode?: PetAgentStartupMode;
  status?: PetAgentStatus;
  capabilities?: AgentCapability[];
  toolkits?: AgentToolkit[];
  execution?: AgentExecution;
  workdir?: string;
  graph?: OrchestratorGraph;
  modelInputModalities?: OrchestratorConfig['modelInputModalities'];
  checkpoint?: OrchestratorConfig['checkpoint'];
  contextWindowTokens?: OrchestratorConfig['contextWindowTokens'];
  generationReserveTokens?: OrchestratorConfig['generationReserveTokens'];
  subagentContextWindowTokens?: OrchestratorConfig['subagentContextWindowTokens'];
  subagentGenerationReserveTokens?: OrchestratorConfig['subagentGenerationReserveTokens'];
  /** Host-owned when a process has a durable Toolkit runtime lifecycle. */
  toolkitRuntimeManager?: ToolkitRuntimeManager;
  /**
   * 注入的 wiki 访问实现。不提供时 pet 不装备 wiki 检索工具,
   * 也不注入知识库 system prompt。
   */
  wikiAccess?: StudioWikiAccess;
};

function buildCapabilitySummaries(config: PetAgentRuntimeConfig): PetAgentCapabilitySummary[] {
  // descriptor() is synchronous and therefore reports static dependency
  // resolution against the configured Toolkit inventory. Runtime availability
  // is evaluated for each async invoke generation below.
  const registry = compileAgentRegistry({
    toolkits: config.toolkits ?? [],
    capabilities: config.capabilities ?? [],
  });
  const availableNames = new Set(
    registry.capabilities.map(({ capability }) => capability.name),
  );
  const unavailableByName = new Map(
    registry.unavailableCapabilities.map(({ capability, issues }) => [
      capability.name,
      formatExecutorCompilationIssues(issues),
    ]),
  );
  return (config.capabilities ?? []).map((capability) => {
    const available = availableNames.has(capability.name);
    return {
      name: capability.name,
      description: capability.description,
      available,
      reason: available ? null : unavailableByName.get(capability.name) ?? null,
    };
  });
}

function initialStatus(config: PetAgentRuntimeConfig): PetAgentStatus {
  if (config.startupMode === 'disabled') return 'disabled';
  if (config.startupMode === 'lazy') return config.status ?? 'unavailable';
  return config.status ?? 'standby';
}

function canInvokeStatus(status: PetAgentStatus): boolean {
  return status === 'standby' || status === 'degraded';
}

/**
 * Wiki middleware:通过注入的 wiki access 读取索引并构造 system prompt 片段。
 * 读不到则降级为只列检索工具,不抛错。
 */
async function buildWikiSystemPrompt(
  wikiRoot: string,
  wikiAccess: StudioWikiAccess,
): Promise<string> {
  const indexContent = (await wikiAccess.readIndex(wikiRoot))
    ?? '(知识库为空,尚未生成 index.md)';
  return [
    '你可以访问一个共享知识库,根目录已通过 wiki_read 工具配置好。',
    '下面是知识库的当前索引:',
    '',
    '----- index.md -----',
    indexContent.trim(),
    '--------------------',
    '',
    '使用 wiki_read_ls / wiki_read_cat / wiki_read_grep / wiki_read_find / wiki_read_head / wiki_read_tail 检索详情。',
  ].join('\n');
}

async function buildRequestMessages(
  brief: string,
  wikiRoot: string | undefined,
  wikiAccess: StudioWikiAccess | undefined,
): Promise<BaseMessage[]> {
  const messages: BaseMessage[] = [];
  if (wikiRoot && wikiAccess) {
    const wikiPrompt = await buildWikiSystemPrompt(wikiRoot, wikiAccess);
    messages.push(new SystemMessage(wikiPrompt));
  }
  messages.push(new HumanMessage(brief));
  return messages;
}

/**
 * checkpoint 上还有没有没跑完的活。
 *
 * pet 撞到人工确认时 `graph.invoke` 会**提前返回**,但 graph 停在中断点上,
 * `next` / `tasks` 非空。这正是"invoke 返回 ≠ 活干完了"的判据。
 */
function hasPendingContinuation(snapshot: unknown): boolean {
  const record = snapshot && typeof snapshot === 'object'
    ? snapshot as { next?: unknown; tasks?: unknown }
    : null;
  const next = Array.isArray(record?.next) ? record.next : [];
  if (next.length > 0) return true;
  const tasks = Array.isArray(record?.tasks) ? record.tasks : [];
  return tasks.length > 0;
}

type PendingHumanReview = {
  projection: PendingInterruptProjection;
  reviews: ReviewSpec[];
};

function readGraphInterrupt(snapshot: unknown): { id: string; value: unknown } | null {
  const tasks = Array.isArray((snapshot as { tasks?: unknown } | null)?.tasks)
    ? (snapshot as { tasks: unknown[] }).tasks
    : [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const interrupts = Array.isArray((task as { interrupts?: unknown }).interrupts)
      ? (task as { interrupts: unknown[] }).interrupts
      : [];
    const first = interrupts[0];
    if (!first || typeof first !== 'object') continue;
    const id = (first as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) continue;
    return { id, value: (first as { value?: unknown }).value };
  }
  return null;
}

function projectPendingHumanReview(snapshot: unknown): PendingHumanReview | null {
  const interrupt = readGraphInterrupt(snapshot);
  if (!interrupt) return null;
  const reviews = isHumanReviewBatchInterruptPayload(interrupt.value)
    ? interrupt.value.reviews.map((item) => item.review)
    : isHumanReviewInterruptPayload(interrupt.value)
      ? [interrupt.value.review]
      : [];
  if (reviews.length === 0) return null;
  return {
    projection: {
      interruptId: interrupt.id,
      payload: {
        kind: 'human_review',
        interactions: reviews.map(projectHumanReviewRequest),
      },
    },
    reviews,
  };
}

function buildHumanReviewResume(
  pending: PendingHumanReview,
  responses: Parameters<typeof toInternalReviewResponse>[0][],
) {
  const decisions = responses.map(toInternalReviewResponse);
  if (decisions.length === 0 || decisions.length > pending.reviews.length) {
    throw new Error(
      `Interrupt "${pending.projection.interruptId}" expects ${pending.reviews.length} review response(s).`,
    );
  }
  for (let index = 0; index < decisions.length; index += 1) {
    const review = pending.reviews[index];
    const decision = decisions[index];
    if (!review || !decision || decision.reviewId !== review.id) {
      throw new Error(
        `Review response at index ${index.toString()} does not match the pending interaction.`,
      );
    }
    const resolution = resolveHumanReviewResponse({ reviewSpec: review }, decision);
    const isFinal = index === decisions.length - 1;
    if (resolution.decision.type !== 'approve' && !isFinal) {
      throw new Error(`Review response "${decision.reviewId}" stops the batch and must be final.`);
    }
    if (
      resolution.decision.type === 'approve'
      && isFinal
      && decisions.length < pending.reviews.length
    ) {
      throw new Error(`Review response batch is incomplete after "${decision.reviewId}".`);
    }
  }
  return { [pending.projection.interruptId]: { decisions: decisions as ReviewResponse[] } };
}

export function createPetAgentRuntime(config: PetAgentRuntimeConfig): PetAgentRuntime {
  let status = initialStatus(config);
  let gateState: PetGateState = 'open';
  const gateListeners = new Set<(state: PetGateState) => void>();

  function setGate(next: PetGateState): void {
    if (gateState === next) return;
    gateState = next;
    for (const listener of gateListeners) {
      try {
        listener(next);
      } catch (error) {
        console.error(
          '[pet-runtime] gate listener failed:',
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
  const startupMode = config.startupMode ?? 'standby';
  // A caller-supplied graph is already responsible for its graph config. Do
  // not create and start an unreachable manager beside it.
  const ownsToolkitRuntimeManager = !config.toolkitRuntimeManager && !config.graph;
  const toolkitRuntimeManager = config.toolkitRuntimeManager
    ?? (config.graph ? null : new ToolkitRuntimeManager());
  const graph = config.graph ?? createOrchestratorGraph({
    models: config.models,
    modelInputModalities: config.modelInputModalities,
    actor: config.actor,
    checkpoint: config.checkpoint,
    contextWindowTokens: config.contextWindowTokens,
    generationReserveTokens: config.generationReserveTokens,
    subagentContextWindowTokens: config.subagentContextWindowTokens,
    subagentGenerationReserveTokens: config.subagentGenerationReserveTokens,
    toolkitRuntimeManager: toolkitRuntimeManager ?? undefined,
  });

  function descriptor(): PetAgentRuntimeDescriptor {
    return {
      ...config.actor,
      role: config.role ?? null,
      serviceSummary: config.serviceSummary ?? null,
      startupMode,
      status,
      capabilities: buildCapabilitySummaries(config),
    };
  }

  async function invoke(input: PetAgentRuntimeInvokeInput): Promise<PetAgentRuntimeInvokeResult> {
    if (startupMode === 'disabled' || !canInvokeStatus(status)) {
      throw new Error(`Pet agent "${config.actor.petId}" is not dispatchable: ${status}`);
    }

    const checkpointConfigurable: Record<string, unknown> = {
      actor: config.actor,
      thread_id: input.threadId,
    };
    const initialSnapshot = config.checkpoint
      ? await graph.getState({ configurable: checkpointConfigurable })
      : null;
    const pending = projectPendingHumanReview(initialSnapshot);
    setGate(pending
      ? 'waiting'
      : hasPendingContinuation(initialSnapshot)
        ? 'blocked'
        : 'open');
    let graphInput: Parameters<OrchestratorGraph['invoke']>[0];
    if (input.input.kind === 'request') {
      if (hasPendingContinuation(initialSnapshot)) {
        setGate(pending ? 'waiting' : 'blocked');
        throw new Error(
          pending
            ? `Pet "${config.actor.petId}" is waiting on interrupt "${pending.projection.interruptId}".`
            : `Pet "${config.actor.petId}" has an unsupported pending continuation.`,
        );
      }
      const messages = await buildRequestMessages(
        input.input.request,
        input.wikiRoot,
        config.wikiAccess,
      );
      graphInput = buildOrchestratorRunInput(
        messages,
        { activeDelegationTransition: input.activeDelegationTransition },
      );
    } else {
      if (!pending) {
        setGate(hasPendingContinuation(initialSnapshot) ? 'blocked' : 'open');
        throw new Error(`Pet "${config.actor.petId}" has no pending human-review interrupt.`);
      }
      if (pending.projection.interruptId !== input.input.interruptId) {
        setGate('waiting');
        throw new Error(
          `Interrupt "${input.input.interruptId}" is stale; `
          + `Pet "${config.actor.petId}" is waiting on "${pending.projection.interruptId}".`,
        );
      }
      if (input.input.payload.kind !== 'human_review_response') {
        setGate('waiting');
        throw new Error(`Interrupt "${input.input.interruptId}" received an unsupported payload.`);
      }
      graphInput = new Command({
        resume: buildHumanReviewResume(pending, input.input.payload.responses),
      });
    }

    const toolkitDefinitions = [
      ...(config.toolkits ?? []),
      ...(input.toolkits ?? []),
      ...(input.wikiRoot && config.wikiAccess
        ? [config.wikiAccess.createReadToolkit(input.wikiRoot)]
        : []),
    ];
    await toolkitRuntimeManager?.start(toolkitDefinitions, { signal: input.signal });
    const toolkits = await filterAvailableToolkits(toolkitDefinitions);
    const configuredCapabilities = [
      ...(config.capabilities ?? []),
      ...(input.extraCapabilities ?? []),
    ];
    const wikiCapability = input.wikiRoot && config.wikiAccess
      && !configuredCapabilities.some((capability) =>
        capability.name === config.wikiAccess!.readCapabilityName
          || capability.uses.includes('wiki_read'))
      ? config.wikiAccess.createReadCapability()
      : null;
    const capabilities = wikiCapability
      ? [...configuredCapabilities, wikiCapability]
      : configuredCapabilities;
    const registry = compileAgentRegistry({
      toolkits,
      capabilities,
    });
    const configurable: Record<string, unknown> = {
      actor: config.actor,
      thread_id: input.threadId,
      registry,
      reviewCapabilities: STUDIO_REVIEW_CAPABILITIES,
      execution: {
        ...(config.execution ?? {}),
        ...(input.execution ?? {}),
        threadId: input.threadId,
      },
      workdir: input.workdir ?? config.workdir,
      runtimeEnvironment: input.runtimeEnvironment,
      allowedCapabilityNames: input.allowedCapabilityNames,
    };

    const previousStatus = status;
    status = 'active';
    setGate('busy');
    try {
      const result = await graph.invoke(graphInput, { signal: input.signal, configurable });
      const finalSnapshot = config.checkpoint
        ? await graph.getState({ configurable })
        : null;
      const finalPending = projectPendingHumanReview(finalSnapshot);
      if (finalPending) {
        setGate('waiting');
        return {
          status: 'pending_interrupt',
          pendingInterrupt: finalPending.projection,
        };
      }
      if (hasPendingContinuation(finalSnapshot)) {
        setGate('blocked');
        throw new Error(
          `Pet "${config.actor.petId}" stopped on an unsupported pending continuation.`,
        );
      }
      setGate('open');
      return { status: 'completed', reply: readReply(result) };
    } catch (error) {
      setGate('blocked');
      throw error;
    } finally {
      status = previousStatus === 'active' ? 'standby' : previousStatus;
    }
  }

  return {
    descriptor,
    invoke,
    gate: () => gateState,
    onGateChange: (listener) => {
      gateListeners.add(listener);
      return () => gateListeners.delete(listener);
    },
    shutdown: async () => {
      if (ownsToolkitRuntimeManager && toolkitRuntimeManager) {
        await toolkitRuntimeManager.stop();
      }
    },
  };
}

function readReply(result: unknown): string {
  const messages = (result as { messages?: BaseMessage[] } | undefined)?.messages ?? [];
  const last = messages.at(-1);
  return typeof last?.content === 'string' ? last.content.trim() : '';
}
