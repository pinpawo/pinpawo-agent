import path from 'node:path';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  GENERAL_CAPABILITY_NAME,
  type AgentCapability,
  type AgentToolkit,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import { createStudio } from '../createStudio';
import type { Studio, StudioPlugin } from '../studioContract';
import type { PetAgentRuntime } from '../types';
import {
  buildLocalAgentModels,
  buildLocalAgentRuntimeConfig,
  createExploreCapability,
  resolveLlmGenerationReserveTokens,
  type LocalModelProfileRegistry,
} from 'pinpawo/host-runtime';
import { loadPetLocalConfigs } from './petConfig';
import { loadStudioLocalConfig, resolveStudio, type ResolvedStudio } from './studioConfig';
import { buildPetActorFromLocalConfig } from './petActor';
import { createPetAgentRuntime } from './createPetAgentRuntime';

/**
 * 当前 workdir 下没有 .pinpawo/studio.json 时抛此错。
 */
export class StudioNotConfiguredError extends Error {
  constructor(public readonly configPath: string) {
    super(`No Studio config found at ${configPath}. Create one before starting the Studio Host.`);
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
  /** Installed optional modules are resolved by the application composition root. */
  resolveModule?: StudioModuleResolver;
};

export type BuildStudioResult = {
  studio: Studio;
  resolved: ResolvedStudio;
  /** 已装配的插件,按配置顺序。 */
  plugins: StudioPlugin[];
};

/**
 * Optional module contribution. A module may provide the Studio lifecycle /
 * Toolkit face and capabilities that refer to that Toolkit. Studio never
 * imports a concrete module implementation.
 */
export type ResolvedStudioModule = {
  plugin: StudioPlugin;
  capabilities?: readonly AgentCapability[];
};

export type StudioModuleResolver = (
  id: string,
  options?: Record<string, unknown>,
) => Promise<ResolvedStudioModule> | ResolvedStudioModule;

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

  const modules: ResolvedStudioModule[] = [];
  for (const { id, options } of studioConfig.plugins ?? []) {
    if (!input.resolveModule) {
      throw new Error(
        `studio "${studioConfig.studioId}": optional module "${id}" is configured `
        + 'but no module resolver is installed.',
      );
    }
    modules.push(await input.resolveModule(id, options));
  }
  const plugins = modules.map(({ plugin }) => plugin);

  const globalLlmConfig = input.modelProfiles.resolve();
  const globalModels = buildLocalAgentModels(globalLlmConfig);
  const capabilitiesByName = new Map<string, AgentCapability>();
  const registerCapability = (capability: AgentCapability, source: string) => {
    if (capabilitiesByName.has(capability.name)) {
      throw new Error(
        `studio "${studioConfig.studioId}": duplicate capability "${capability.name}" `
        + `contributed by ${source}`,
      );
    }
    capabilitiesByName.set(capability.name, capability);
  };
  for (const capability of input.capabilities) {
    registerCapability(capability, 'Host capability assembly');
  }
  modules.forEach(({ capabilities = [] }, moduleIndex) => {
    const moduleId = studioConfig.plugins?.[moduleIndex]?.id ?? `module[${moduleIndex}]`;
    for (const capability of capabilities) {
      registerCapability(capability, `optional module "${moduleId}"`);
    }
  });
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
          `pet "${petConfig.petId}" references capability "${name}" which is not registered by the Host or an installed module`,
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
