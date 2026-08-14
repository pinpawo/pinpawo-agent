import path from 'node:path';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  GENERAL_CAPABILITY_NAME,
  type AgentCapability,
  type AgentToolkit,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import {
  createStudio,
  type PetAgentRuntime,
  type Studio,
  type StudioPlugin,
} from '@pinpawo/studio';
import { createKanbanPlugin } from '@pinpawo-toolkit/studio-kanban';

import { buildLocalAgentModels, resolveLlmGenerationReserveTokens } from '../agentModels';
import type { LocalModelProfileRegistry } from '../llmConfig';
import { createExploreCapability } from '../capabilities/explore';
import { loadStudioPlanningCapability } from '../capabilities/studioPlanning';
import { buildLocalAgentRuntimeConfig } from '../runtimeConfig';
import { loadPetLocalConfigs } from './petConfig';
import { loadStudioLocalConfig, resolveStudio, type ResolvedStudio } from './studioConfig';
import { buildPetActorFromLocalConfig } from './petActor';
import { createPetAgentRuntime } from './createPetAgentRuntime';

/**
 * 当前 workdir 下没有 .pinpawo/studio.json 时抛此错。
 */
export class StudioNotConfiguredError extends Error {
  constructor(public readonly configPath: string) {
    super(`No Studio config found at ${configPath}. Create one to enable studio mode.`);
    this.name = 'StudioNotConfiguredError';
  }
}

export type BuildStudioInput = {
  modelProfiles: LocalModelProfileRegistry;
  /** 全局 capability 池(local + user 合并);按 pet config 的 capability 名筛选。 */
  capabilities: AgentCapability[];
  /** 全局 toolkit 池(plugin + local);所有 pet 共享。 */
  toolkits?: AgentToolkit[];
  toolkitRuntimeManager?: ToolkitRuntimeManager;
  /** Host 持有的 checkpointer,由所有 pet 共用(#613)。 */
  checkpoint?: BaseCheckpointSaver;
  ownerUserId: string | null;
  studioConfigPath?: string;
  petsDir?: string;
  workdir?: string;
  /** 覆盖内置插件表;仅供测试注入假插件。 */
  pluginFactories?: Record<string, StudioPluginFactory>;
};

export type BuildStudioResult = {
  studio: Studio;
  resolved: ResolvedStudio;
  /** 已装配的插件,按配置顺序。 */
  plugins: StudioPlugin[];
};

/**
 * 插件工厂。`options` 原样来自 `studio.json`,**由插件自己解释与校验** ——
 * 宿主不认识任何插件的领域概念,只负责把它递过去。
 */
export type StudioPluginFactory = (options?: Record<string, unknown>) => StudioPlugin;

/**
 * 已内置的插件实现。
 *
 * `studio.json` 里显式列出要装哪些 —— studio 不做隐式装配,读一眼配置就
 * 知道这块 studio 由什么驱动。
 */
const PLUGIN_FACTORIES: Record<string, StudioPluginFactory> = {
  kanban: () => createKanbanPlugin(),
};

/**
 * 从 workdir 装配一块 studio。
 *
 * 宿主职责:读配置文件、解析 pet、把插件接上。studio 本身不读文件 ——
 * 文件入口属于宿主(与 #613 的 config loader 分层一致)。
 */
export async function buildStudio(input: BuildStudioInput): Promise<BuildStudioResult> {
  const effectiveWorkdir = input.workdir ?? buildLocalAgentRuntimeConfig().workdir;
  const workdirStateRoot = path.join(effectiveWorkdir, '.pinpawo');
  const studioConfigPath = input.studioConfigPath
    ?? path.join(workdirStateRoot, 'studio.json');

  const studioConfig = await loadStudioLocalConfig(studioConfigPath);
  if (!studioConfig) {
    throw new StudioNotConfiguredError(studioConfigPath);
  }

  const petsDir = input.petsDir ?? path.join(path.dirname(studioConfigPath), 'pets');
  const resolved = resolveStudio(studioConfig, await loadPetLocalConfigs(petsDir));

  const pluginFactories = input.pluginFactories ?? PLUGIN_FACTORIES;
  const plugins = (studioConfig.plugins ?? []).map(({ id, options }) => {
    const factory = pluginFactories[id];
    if (!factory) {
      throw new Error(
        `studio "${studioConfig.studioId}": unknown plugin "${id}". `
        + `Known plugins: ${Object.keys(pluginFactories).join(', ')}.`,
      );
    }
    return factory(options);
  });

  const globalLlmConfig = input.modelProfiles.resolve();
  const globalModels = buildLocalAgentModels(globalLlmConfig);
  // studio 专用的内置 Capability 只在这里加入,**不进默认 registry** ——
  // 它声明 uses: ['kanban'],而 kanban 只在 studio 装配时作为插件注入。放进
  // 全局 registry 会让每个普通 chat 会话都打一条 "unavailable" 警告。
  //
  // 仍由 pet 配置决定谁用得上:这里只是让 studio 侧能解析到这个名字。
  const studioPlanning = loadStudioPlanningCapability();
  const capabilitiesByName = new Map([
    ...(studioPlanning ? [[studioPlanning.name, studioPlanning] as const] : []),
    ...input.capabilities.map((item) => [item.name, item] as const),
  ]);
  const generalCapability = capabilitiesByName.get(GENERAL_CAPABILITY_NAME);
  if (!generalCapability) {
    throw new Error(`Studio requires the host baseline Capability "${GENERAL_CAPABILITY_NAME}".`);
  }

  // 插件的 toolkit 与普通 toolkit 在 pet 眼里没有区别 —— pet 不需要知道
  // 某个 toolkit 背后还插在 studio 上。
  const availableToolkits = [...(input.toolkits ?? []), ...plugins];

  const pets: PetAgentRuntime[] = resolved.pets.map((petConfig) => {
    const petLlmConfig = petConfig.modelProfileId
      ? input.modelProfiles.resolve(petConfig.modelProfileId)
      : globalLlmConfig;
    const petModels = petConfig.modelProfileId
      ? buildLocalAgentModels(petLlmConfig)
      : globalModels;
    const generationReserveTokens = resolveLlmGenerationReserveTokens(petLlmConfig);

    const petCapabilities = petConfig.capabilities.map((name) => {
      if (name === 'explore') return createExploreCapability();
      const capability = capabilitiesByName.get(name);
      if (!capability) {
        throw new Error(
          `pet "${petConfig.petId}" references capability "${name}" which is not registered in this local-agent`,
        );
      }
      return capability;
    });

    return createPetAgentRuntime({
      models: petModels,
      modelInputModalities: petLlmConfig.inputModalities ?? ['text'],
      actor: buildPetActorFromLocalConfig(petConfig, input.ownerUserId),
      role: petConfig.role ?? null,
      serviceSummary: petConfig.serviceSummary ?? null,
      capabilities: [
        generalCapability,
        ...petCapabilities.filter(({ name }) => name !== GENERAL_CAPABILITY_NAME),
      ],
      toolkits: availableToolkits,
      toolkitRuntimeManager: input.toolkitRuntimeManager,
      checkpoint: input.checkpoint,
      contextWindowTokens: petLlmConfig.contextWindowTokens,
      subagentContextWindowTokens: petLlmConfig.subagentContextWindowTokens
        ?? petLlmConfig.contextWindowTokens,
      generationReserveTokens,
      subagentGenerationReserveTokens: generationReserveTokens,
      workdir: effectiveWorkdir,
    });
  });

  const studio = await createStudio({
    studioId: studioConfig.studioId,
    entryPetId: studioConfig.entryPetId,
    pets,
    plugins,
  });

  return { studio, resolved, plugins };
}
