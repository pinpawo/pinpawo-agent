import path from 'node:path';
import {
  GENERAL_CAPABILITY_NAME,
  type AgentCapability,
  type CapabilityArtifactStore,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import { prepareStudio } from '../createStudio';
import type { Studio, StudioPlugin } from '../studioContract';
import type { StudioPetBinding } from '../types';
import {
  buildLocalAgentRuntimeConfig,
  createResidentPetHost,
  type FileSaver,
  type HostToolkitInventoryStore,
  type LocalAgentRuntimeConfig,
  type LocalModelProfileRegistry,
  type ResidentPetHost,
} from 'pinpawo/host-runtime';
import { loadPetLocalConfigs } from './petConfig';
import { loadStudioLocalConfig, resolveStudio, type ResolvedStudio } from './studioConfig';
import { buildPetActorFromLocalConfig } from './petActor';

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
  configuration: ResolvedStudioHostConfig;
  modelProfiles: LocalModelProfileRegistry;
  /** Host fallback Capability 池；Studio uses general only without an explicit default. */
  hostCapabilities: readonly AgentCapability[];
  /** 每个 Pet 从约定目录严格加载的 Agent Capability 定义。 */
  petCapabilities: ReadonlyMap<string, readonly AgentCapability[]>;
  toolkitInventory: HostToolkitInventoryStore;
  toolkitRuntimeManager: ToolkitRuntimeManager;
  capabilityArtifactStore: CapabilityArtifactStore;
  checkpoint: FileSaver;
  runtimeConfig: LocalAgentRuntimeConfig;
  /** Host composition defers Plugin listeners until Agent Session transport is ready. */
  deferPluginActivation?: boolean;
};

export function selectStudioPetCapabilities(input: {
  defaultCapabilityName?: string;
  generalCapability: AgentCapability;
  petCapabilities: readonly AgentCapability[];
}): AgentCapability[] {
  const defaultCapabilityName = input.defaultCapabilityName ?? GENERAL_CAPABILITY_NAME;
  return defaultCapabilityName === GENERAL_CAPABILITY_NAME
    ? [input.generalCapability, ...input.petCapabilities]
    : [...input.petCapabilities];
}

export type ResolveStudioHostConfigInput = {
  studioConfigPath?: string;
  petsDir?: string;
  workdir?: string;
  /** Installed Plugins are selected by config and resolved by the Host caller. */
  resolvePlugin?: StudioPluginResolver;
};

export type BuildStudioResult = {
  studio: Studio;
  resolved: ResolvedStudio;
  /** 已装配的插件,按配置顺序。 */
  plugins: StudioPlugin[];
  /** Host lifecycle resources; Studio core receives only their dispatch ports. */
  residentPets: ReadonlyMap<string, ResidentPetHost>;
  /** Idempotently activate configured Plugin lifecycles. */
  activatePlugins: () => Promise<void>;
};

/** One Studio configuration snapshot resolved once by its Host. */
export type ResolvedStudioHostConfig = {
  workdir: string;
  studioConfigPath: string;
  petsDir: string;
  resolved: ResolvedStudio;
  plugins: StudioPlugin[];
};

export type StudioPluginResolver = (
  id: string,
  options?: Record<string, unknown>,
) => Promise<StudioPlugin> | StudioPlugin;

function validateResolvedPlugins(studioId: string, plugins: readonly StudioPlugin[]): void {
  const names = new Set<string>();
  for (const [index, plugin] of plugins.entries()) {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
      throw new Error(`studio "${studioId}": resolved plugin at index ${index.toString()} must be an object`);
    }
    if (typeof plugin.name !== 'string' || !plugin.name.trim()) {
      throw new Error(`studio "${studioId}": resolved plugin at index ${index.toString()} must have a name`);
    }
    if (names.has(plugin.name)) {
      throw new Error(`studio "${studioId}": duplicate plugin "${plugin.name}"`);
    }
    names.add(plugin.name);
    if (!Array.isArray(plugin.toolkits)) {
      throw new Error(`studio "${studioId}": plugin "${plugin.name}" must define a Toolkit list`);
    }
    if (typeof plugin.start !== 'function') {
      throw new Error(`studio "${studioId}": plugin "${plugin.name}" must define start()`);
    }
    if (plugin.stop !== undefined && typeof plugin.stop !== 'function') {
      throw new Error(`studio "${studioId}": plugin "${plugin.name}" stop must be a function`);
    }
  }
}

/** Read one Studio config snapshot and resolve its selected Plugins. */
export async function resolveStudioHostConfig(
  input: ResolveStudioHostConfigInput,
): Promise<ResolvedStudioHostConfig> {
  const workdir = input.workdir ?? buildLocalAgentRuntimeConfig().workdir;
  const workdirStateRoot = path.join(workdir, '.pinpawo');
  const studioConfigPath = input.studioConfigPath
    ?? path.join(workdirStateRoot, 'studio.json');

  const studioConfig = await loadStudioLocalConfig(studioConfigPath);
  if (!studioConfig) {
    throw new StudioNotConfiguredError(studioConfigPath);
  }

  const petsDir = input.petsDir ?? path.join(path.dirname(studioConfigPath), 'pets');
  const resolved = resolveStudio(studioConfig, await loadPetLocalConfigs(petsDir));
  const plugins: StudioPlugin[] = [];
  for (const { id, options } of studioConfig.plugins ?? []) {
    if (!input.resolvePlugin) {
      throw new Error(
        `studio "${studioConfig.studioId}": plugin "${id}" is configured `
        + 'but no plugin resolver is installed.',
      );
    }
    plugins.push(await input.resolvePlugin(id, options));
  }
  validateResolvedPlugins(studioConfig.studioId, plugins);
  return { workdir, studioConfigPath, petsDir, resolved, plugins };
}

/** Build one resident Studio from an already-resolved Host snapshot. */
export async function buildStudio(input: BuildStudioInput): Promise<BuildStudioResult> {
  const { resolved, plugins } = input.configuration;
  const { studio: studioConfig } = resolved;

  const hostCapabilitiesByName = new Map<string, AgentCapability>();
  for (const capability of input.hostCapabilities) {
    if (hostCapabilitiesByName.has(capability.name)) {
      throw new Error(
        `studio "${studioConfig.studioId}": duplicate Host baseline Capability "${capability.name}"`,
      );
    }
    hostCapabilitiesByName.set(capability.name, capability);
  }
  const generalCapability = hostCapabilitiesByName.get(GENERAL_CAPABILITY_NAME);
  if (!generalCapability) {
    throw new Error(`Studio requires the host baseline Capability "${GENERAL_CAPABILITY_NAME}".`);
  }

  const residentPets = new Map<string, ResidentPetHost>();
  const pets: StudioPetBinding[] = [];
  try {
    for (const petConfig of resolved.pets) {
      const petCapabilities = [...(input.petCapabilities.get(petConfig.petId) ?? [])];
      const petCapabilityNames = new Set<string>();
      for (const capability of petCapabilities) {
        if (capability.name === GENERAL_CAPABILITY_NAME) {
          throw new Error(
            `pet "${petConfig.petId}" cannot replace the Host baseline Capability "${GENERAL_CAPABILITY_NAME}"`,
          );
        }
        if (petCapabilityNames.has(capability.name)) {
          throw new Error(`pet "${petConfig.petId}" has duplicate Capability "${capability.name}"`);
        }
        petCapabilityNames.add(capability.name);
      }
      if (petConfig.defaultCapabilityName
        && petConfig.defaultCapabilityName !== GENERAL_CAPABILITY_NAME
        && !petCapabilityNames.has(petConfig.defaultCapabilityName)) {
        throw new Error(
          `pet "${petConfig.petId}" default Capability "${petConfig.defaultCapabilityName}" is not available`,
        );
      }

      const resident = await createResidentPetHost({
        actor: buildPetActorFromLocalConfig(petConfig, null),
        modelProfiles: input.modelProfiles,
        ...(petConfig.modelProfileId ? { modelProfileId: petConfig.modelProfileId } : {}),
        ...(petConfig.defaultCapabilityName
          ? { defaultCapabilityName: petConfig.defaultCapabilityName }
          : {}),
        capabilities: selectStudioPetCapabilities({
          ...(petConfig.defaultCapabilityName
            ? { defaultCapabilityName: petConfig.defaultCapabilityName }
            : {}),
          generalCapability,
          petCapabilities,
        }),
        toolkitInventory: input.toolkitInventory,
        toolkitRuntimeManager: input.toolkitRuntimeManager,
        capabilityArtifactStore: input.capabilityArtifactStore,
        checkpointer: input.checkpoint,
        runtimeConfig: input.runtimeConfig,
        sessionStatePath: path.join(
          input.runtimeConfig.stateRoot,
          'resident-sessions',
          `${encodeURIComponent(petConfig.petId)}.json`,
        ),
        adoptThreadId: `studio:${encodeURIComponent(studioConfig.studioId)}:pet:${encodeURIComponent(petConfig.petId)}`,
      });
      residentPets.set(petConfig.petId, resident);
      pets.push({
        registration: {
          petId: petConfig.petId,
          name: petConfig.name,
          role: petConfig.role ?? null,
          serviceSummary: petConfig.serviceSummary ?? null,
        },
        dispatch: resident.resident.dispatch,
      });
    }
  } catch (error) {
    await Promise.allSettled([...residentPets.values()].map((resident) => resident.close()));
    throw error;
  }

  let studio: Studio;
  let activatePlugins: () => Promise<void>;
  try {
    const studioInput = {
      studioId: studioConfig.studioId,
      entryPetId: studioConfig.entryPetId,
      pets,
      plugins,
    };
    const prepared = prepareStudio(studioInput);
    studio = prepared.studio;
    activatePlugins = prepared.activatePlugins;
    if (!input.deferPluginActivation) await activatePlugins();
  } catch (error) {
    await Promise.allSettled([...residentPets.values()].map((resident) => resident.close()));
    throw error;
  }

  return { studio, resolved, plugins, residentPets, activatePlugins };
}
