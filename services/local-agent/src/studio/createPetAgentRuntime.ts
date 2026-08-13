/**
 * `PetAgentRuntime` port 的 local host 适配器。
 *
 * 它住在 local-agent 而不是 `@pinpawo/studio`,因为它把 port 接到具体的
 * LangGraph 执行路径上 —— 直接 `createOrchestratorGraph()`、组装消息、
 * 消化 HITL。编排核心不该背这些:那会让 `@pinpawo/studio` 依赖
 * `@langchain/langgraph`,而它本身根本不跑 graph。
 *
 * 未来若出现第二个 host,再单独抽 `studio-pet-agent-adapter`。
 *
 * HITL 对 Studio 透明:pet 撞到 review 时 invoke 直接返回,不在内部等待。
 * review 是 pet 与人之间的事 —— 人已经在跟 pet 打交道了,再让 Studio 知道
 * 一遍是多余的一层。答复走 pet-agent 既有的 resume 路径,与 chat 一致。
 */
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

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
} from '@pinpawo/studio';
import {
  buildOrchestratorRunInput,
  createOrchestratorGraph,
  compileAgentRegistry,
  formatExecutorCompilationIssues,
  type OrchestratorConfig,
  type OrchestratorGraph,
} from '@pinpawo/pet-agent';
import type {
  PetAgentRuntime,
  PetAgentRuntimeDescriptor,
  PetAgentRuntimeInvokeInput,
  PetAgentRuntimeInvokeResult,
} from '@pinpawo/studio';
import type { StudioWikiAccess } from '@pinpawo/studio';

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

async function buildInvokeMessages(
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

export function createPetAgentRuntime(config: PetAgentRuntimeConfig): PetAgentRuntime {
  let status = initialStatus(config);
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

    const messages = await buildInvokeMessages(input.brief, input.wikiRoot, config.wikiAccess);
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
      execution: input.execution ?? config.execution,
      workdir: input.workdir ?? config.workdir,
      runtimeEnvironment: input.runtimeEnvironment,
      allowedCapabilityNames: input.allowedCapabilityNames,
    };

    const previousStatus = status;
    status = 'active';
    try {
      const graphInput: Parameters<OrchestratorGraph['invoke']>[0] = buildOrchestratorRunInput(
        messages,
        { activeDelegationTransition: input.activeDelegationTransition },
      );
      // 撞到 review 就返回 —— 进度已落在 checkpoint 上(#613),答复由客户端
      // 经 pet-agent 的 resume 路径送回。Studio 不参与,也不需要知道。
      const result = await graph.invoke(graphInput, { signal: input.signal, configurable });
      return { reply: readReply(result) };
    } finally {
      status = previousStatus === 'active' ? 'standby' : previousStatus;
    }
  }

  return {
    descriptor,
    invoke,
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

