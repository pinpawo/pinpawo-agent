import path from 'node:path';
import {
  GENERAL_CAPABILITY_NAME,
  defineCapability,
  type AgentCapability,
  type CapabilityArtifactStore,
  type PetDocument,
} from '@pinpawo/pet-agent';
import { prepareStudio, type PreparedStudio } from '../createStudio';
import type { Studio, StudioPlugin } from '../studioContract';
import type { StudioPetRegistration, StudioPetRuntime } from '../types';
import {
  buildHostRuntimeConfig,
  createResidentPetHost,
  type FileSaver,
  type HostToolkitInventoryStore,
  type HostExecutionConfig,
  type LocalModelProfileRegistry,
  type PetConfig,
  type PetCredentialSource,
  type ResidentPetHost,
  type ResidentPetInteraction,
} from 'pinpawo/host-runtime';
import { loadPetConfigs } from 'pinpawo/host-runtime';
import { loadStudioLocalConfig, resolveStudio, type ResolvedStudio } from './studioConfig';
import type { StudioStorageSettings } from '../configSchema';
import type { StudioStorageConfig } from '../storage/studioStorage';
import { readStudioCredentialsKey } from './credentialsKey';

/**
 * 当前 workdir 下没有 .pinpawo/studio.json 时抛此错。
 */
export class StudioNotConfiguredError extends Error {
  constructor(public readonly configPath: string) {
    super(`No Studio config found at ${configPath}. Create one before starting the Studio Host.`);
    this.name = 'StudioNotConfiguredError';
  }
}

export type BuildStudioInput = HostExecutionConfig & {
  configuration: ResolvedStudioHostConfig;
  modelProfiles: LocalModelProfileRegistry;
  /** Host fallback Capability 池；Studio uses general only without an explicit default. */
  hostCapabilities: readonly AgentCapability[];
  /** 每份 Pet 定义从约定目录严格加载的 Agent Capability 定义,按 definitionId。 */
  petCapabilities: ReadonlyMap<string, readonly AgentCapability[]>;
  /** Optional PET.md root-document snapshot keyed by definition id. */
  petDocuments?: ReadonlyMap<string, PetDocument>;
  toolkitInventory: HostToolkitInventoryStore;
  capabilityArtifactStore: CapabilityArtifactStore;
  checkpoint: FileSaver;
  /** Host composition defers Plugin listeners until Agent Session transport is ready. */
  deferPluginActivation?: boolean;
};

export function selectStudioPetCapabilities(input: {
  defaultCapabilityName?: string;
  generalCapability: AgentCapability;
  petCapabilities: readonly AgentCapability[];
  pluginCapabilities?: readonly AgentCapability[];
}): AgentCapability[] {
  const petNames = new Set(input.petCapabilities.map(({ name }) => name));
  const capabilities = [
    ...input.petCapabilities,
    ...(input.pluginCapabilities ?? []).filter(({ name }) => !petNames.has(name)),
  ];
  const defaultCapabilityName = input.defaultCapabilityName ?? GENERAL_CAPABILITY_NAME;
  return defaultCapabilityName === GENERAL_CAPABILITY_NAME
    ? [input.generalCapability, ...capabilities]
    : capabilities;
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
  /** Decrypts the running Pet's credentials for its commands; the Host's ShellRS uses it. */
  credentialSource: PetCredentialSource;
  resolved: ResolvedStudio;
  /** 已装配的插件,按配置顺序。 */
  plugins: StudioPlugin[];
  /**
   * The live Pets' Host resources by petId, kept current as Pets are created. Studio core receives only their dispatch and session ports.
   */
  residentPets: ReadonlyMap<string, ResidentPetHost>;
  /** The live Pets' Agent Session surfaces by petId, kept current the same way. */
  residentPetInteractions: ReadonlyMap<string, ResidentPetInteraction>;
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
    if (plugin.capabilities !== undefined && !Array.isArray(plugin.capabilities)) {
      throw new Error(`studio "${studioId}": plugin "${plugin.name}" capabilities must be a list`);
    }
    if (typeof plugin.start !== 'function') {
      throw new Error(`studio "${studioId}": plugin "${plugin.name}" must define start()`);
    }
    if (plugin.stop !== undefined && typeof plugin.stop !== 'function') {
      throw new Error(`studio "${studioId}": plugin "${plugin.name}" stop must be a function`);
    }
  }
}

/** Where this workdir's Studio keeps Plugin data. */
export function resolveStudioStorage(
  settings: StudioStorageSettings | undefined,
  workdir: string,
  env: NodeJS.ProcessEnv = process.env,
): StudioStorageConfig {
  if (!settings || settings.kind === 'sqlite') {
    return { kind: 'sqlite', path: path.resolve(workdir, settings?.path ?? '.pinpawo/studio/studio.sqlite') };
  }
  if ('url' in settings) return { kind: 'postgres', url: settings.url };
  const url = env[settings.urlEnv]?.trim();
  if (!url) throw new Error(`Studio storage: environment variable ${settings.urlEnv} is not set.`);
  return { kind: 'postgres', url };
}

/** Read one Studio config snapshot and resolve its selected Plugins. */
export async function resolveStudioHostConfig(
  input: ResolveStudioHostConfigInput,
): Promise<ResolvedStudioHostConfig> {
  const workdir = input.workdir ?? buildHostRuntimeConfig().workdir;
  const workdirStateRoot = path.join(workdir, '.pinpawo');
  const studioConfigPath = input.studioConfigPath
    ?? path.join(workdirStateRoot, 'studio.json');

  const studioConfig = await loadStudioLocalConfig(studioConfigPath);
  if (!studioConfig) {
    throw new StudioNotConfiguredError(studioConfigPath);
  }

  const petsDir = input.petsDir ?? path.join(path.dirname(studioConfigPath), 'pets');
  const resolved = resolveStudio(studioConfig, await loadPetConfigs(petsDir));
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

  const pluginCapabilities = new Map<string, AgentCapability>();
  for (const plugin of plugins) {
    for (const definition of plugin.capabilities ?? []) {
      const capability = defineCapability(definition);
      if (capability.name === GENERAL_CAPABILITY_NAME) {
        throw new Error(`Plugin "${plugin.name}" cannot replace the Host baseline Capability "${GENERAL_CAPABILITY_NAME}"`);
      }
      if (pluginCapabilities.has(capability.name)) {
        throw new Error(`Duplicate Plugin Capability "${capability.name}"`);
      }
      pluginCapabilities.set(capability.name, capability);
    }
  }

  // Check every definition up front, so a bad one fails Host start rather
  // than the first create that uses it.
  const definitions = new Map<string, { config: PetConfig; capabilities: AgentCapability[] }>();
  for (const definition of resolved.definitions) {
    const { definitionId } = definition;
    const petCapabilities = [...(input.petCapabilities.get(definitionId) ?? [])];
    const petCapabilityNames = new Set<string>();
    for (const capability of petCapabilities) {
      if (capability.name === GENERAL_CAPABILITY_NAME) {
        throw new Error(
          `definition "${definitionId}" cannot replace the Host baseline Capability "${GENERAL_CAPABILITY_NAME}"`,
        );
      }
      if (petCapabilityNames.has(capability.name)) {
        throw new Error(`definition "${definitionId}" has duplicate Capability "${capability.name}"`);
      }
      petCapabilityNames.add(capability.name);
    }
    if (definition.defaultCapabilityName
      && definition.defaultCapabilityName !== GENERAL_CAPABILITY_NAME
      && !petCapabilityNames.has(definition.defaultCapabilityName)
      && !pluginCapabilities.has(definition.defaultCapabilityName)) {
      throw new Error(
        `definition "${definitionId}" default Capability "${definition.defaultCapabilityName}" is not available`,
      );
    }
    definitions.set(definitionId, {
      config: definition,
      capabilities: selectStudioPetCapabilities({
        ...(definition.defaultCapabilityName
          ? { defaultCapabilityName: definition.defaultCapabilityName }
          : {}),
        generalCapability,
        petCapabilities,
        pluginCapabilities: [...pluginCapabilities.values()],
      }),
    });
  }

  const residentPets = new Map<string, ResidentPetHost>();
  const residentPetInteractions = new Map<string, ResidentPetInteraction>();
  // Pets are restored only after prepareStudio returns; this late-bound bridge
  // keeps Plugin context owned by Studio without extending the dispatch port.
  let prepared: PreparedStudio;
  const assemblePet = async (pet: StudioPetRegistration): Promise<StudioPetRuntime> => {
    const definition = definitions.get(pet.definitionId);
    if (!definition) throw new Error(`Pet "${pet.petId}" uses unknown definition "${pet.definitionId}"`);
    const { config } = definition;
    const document = input.petDocuments?.get(pet.definitionId);
    const resident = await createResidentPetHost({
      petId: pet.petId,
      petName: pet.name,
      modelProfiles: input.modelProfiles,
      ...(config.modelProfileId ? { modelProfileId: config.modelProfileId } : {}),
      ...(config.defaultCapabilityName ? { defaultCapabilityName: config.defaultCapabilityName } : {}),
      ...(document ? { petDocument: document } : {}),
      resolveInvocationContext: async (target) => prepared.resolveInvocationContext(target),
      capabilities: definition.capabilities,
      toolkitInventory: input.toolkitInventory,
      capabilityArtifactStore: input.capabilityArtifactStore,
      checkpointer: input.checkpoint,
      runtimeConfig: input.runtimeConfig,
      toolAuthorizationMode: input.toolAuthorizationMode,
      autoAuthorizationSafetyLevel: input.autoAuthorizationSafetyLevel,
      sessionStatePath: path.join(
        input.runtimeConfig.sessionRoot,
        'resident-sessions',
        `${encodeURIComponent(pet.petId)}.json`,
      ),
      adoptThreadId: `studio:${encodeURIComponent(studioConfig.studioId)}:pet:${encodeURIComponent(pet.petId)}`,
    });
    residentPets.set(pet.petId, resident);
    residentPetInteractions.set(pet.petId, resident.interaction);
    return {
      dispatch: resident.resident.dispatch,
      sessions: resident.sessions,
      close: async () => {
        residentPetInteractions.delete(pet.petId);
        residentPets.delete(pet.petId);
        await resident.close();
      },
    };
  };

  prepared = prepareStudio({
    studioId: studioConfig.studioId,
    definitions: resolved.definitions.map(({ definitionId, name }) => ({ definitionId, name })),
    assemblePet,
    plugins,
    storage: resolveStudioStorage(studioConfig.storage, input.configuration.workdir),
    ...(studioConfig.credentials
      ? { credentialsKey: await readStudioCredentialsKey(studioConfig.credentials.keyFile) }
      : {}),
    models: {
      resolve: (profileId?: string) => {
        const config = input.modelProfiles.resolve(profileId);
        return {
          profileId: config.modelProfileId ?? profileId ?? input.modelProfiles.defaultProfileId,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          ...(config.structuredOutputMethod ? { structuredOutputMethod: config.structuredOutputMethod } : {}),
        };
      },
    },
  });
  try {
    // Before any transport listens: a TUI may connect to any active Pet.
    await prepared.restorePets();
    if (!input.deferPluginActivation) await prepared.activatePlugins();
  } catch (error) {
    await prepared.studio.shutdown();
    throw error;
  }

  return {
    studio: prepared.studio,
    credentialSource: prepared.credentialSource,
    resolved,
    plugins,
    residentPets,
    residentPetInteractions,
    activatePlugins: prepared.activatePlugins,
  };
}
