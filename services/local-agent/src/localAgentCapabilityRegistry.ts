import type { StructuredTool } from '@langchain/core/tools';
import {
  type AgentCapability,
  type AgentToolkit,
  compileAgentRegistry,
  validateToolkitDefinition,
} from '@pinpawo/pet-agent';
import { loadUserCapabilities, type LoadedUserCapability } from './capabilityLoader';
import {
  resolveAvailableCapabilities,
  resolveAvailableToolkits,
  resolveCapabilityAvailability,
} from './capabilities/capabilityAvailability';
import { createBrowserCapability } from './capabilities/browserCapability';
import { createExploreCapability } from './capabilities/explore';
import { createBrowserToolkit } from './toolkits/browser';
import { FileCapabilityArtifactStore } from './capabilityArtifactStore';
import { createBashToolkit, createGitToolkit, loadCoreLocalTools } from './toolkits/local';

type ResolveCapabilityAvailability = typeof resolveCapabilityAvailability;

type LocalAgentCapabilityRegistryDeps = {
  loadLocalTools: () => Promise<StructuredTool[]>;
  loadUserCapabilities: () => Promise<LoadedUserCapability[]>;
  createLocalToolkits: (
    localTools: StructuredTool[],
  ) => AgentToolkit[];
  createLocalCapabilities: () => AgentCapability[];
  resolveAvailableToolkits: typeof resolveAvailableToolkits;
  resolveAvailableCapabilities: typeof resolveAvailableCapabilities;
  resolveCapabilityAvailability: ResolveCapabilityAvailability;
};

type LocalAgentCapabilityRegistryOptions = Partial<LocalAgentCapabilityRegistryDeps> & {
  capabilityArtifactRoot?: string;
};

const defaultDeps: LocalAgentCapabilityRegistryDeps = {
  loadLocalTools: loadCoreLocalTools,
  loadUserCapabilities,
  createLocalToolkits: () => [
    createBashToolkit(),
    createGitToolkit(),
    createBrowserToolkit(),
  ],
  createLocalCapabilities: () => [
    createExploreCapability(),
    createBrowserCapability(),
  ],
  resolveAvailableToolkits,
  resolveAvailableCapabilities,
  resolveCapabilityAvailability,
};

async function filterAvailableUserCapabilities(
  loaded: LoadedUserCapability[],
  resolveAvailability: ResolveCapabilityAvailability,
  options: { force?: boolean } = {},
): Promise<LoadedUserCapability[]> {
  const records = await Promise.all(
    loaded.map(async (item) => ({
      item,
      availability: await resolveAvailability(item.capability, options),
    })),
  );
  return records
    .filter((record) => record.availability.availability.available)
    .map((record) => record.item);
}

export class LocalAgentCapabilityRegistry {
  private localTools: StructuredTool[] = [];
  private localToolkitDefinitions: AgentToolkit[] = [];
  private localToolkits: AgentToolkit[] = [];
  private localCapabilityDefinitions: AgentCapability[] = [];
  private localCapabilities: AgentCapability[] = [];
  private userCapabilityDefinitions: LoadedUserCapability[] = [];
  private userCapabilities: LoadedUserCapability[] = [];
  private readonly deps: LocalAgentCapabilityRegistryDeps;
  private readonly capabilityArtifactStore: FileCapabilityArtifactStore;

  constructor(options: LocalAgentCapabilityRegistryOptions = {}) {
    const { capabilityArtifactRoot, ...deps } = options;
    this.deps = {
      ...defaultDeps,
      ...deps,
    };
    this.capabilityArtifactStore = new FileCapabilityArtifactStore(capabilityArtifactRoot);
  }

  async load() {
    this.localTools = await this.deps.loadLocalTools();
    this.localToolkitDefinitions = this.deps.createLocalToolkits(this.localTools);
    this.localToolkitDefinitions.forEach(validateToolkitDefinition);
    this.localToolkits = await this.deps.resolveAvailableToolkits(this.localToolkitDefinitions);
    this.localCapabilityDefinitions = this.deps.createLocalCapabilities();
    const availableLocalCapabilities = await this.deps.resolveAvailableCapabilities(
      this.localCapabilityDefinitions,
      { availableToolkits: this.localToolkits },
    );
    this.localCapabilities = compileAgentRegistry({
      toolkits: this.localToolkits,
      capabilities: availableLocalCapabilities,
      generalUses: [],
    }).capabilities.map(({ capability }) => capability);
    this.userCapabilityDefinitions = await this.deps.loadUserCapabilities();
    this.userCapabilities = await filterAvailableUserCapabilities(
      this.userCapabilityDefinitions,
      (capability, options) => this.deps.resolveCapabilityAvailability(capability, {
        ...options,
        availableToolkits: this.localToolkits,
      }),
    );
  }

  getLocalTools(): StructuredTool[] {
    return this.localTools;
  }

  getLocalToolkits(): AgentToolkit[] {
    return this.localToolkits;
  }

  getLocalToolkitDefinitions(): AgentToolkit[] {
    return this.localToolkitDefinitions;
  }

  getCapabilityArtifactStore(): FileCapabilityArtifactStore {
    return this.capabilityArtifactStore;
  }

  async deleteThreadArtifacts(threadId: string) {
    await this.capabilityArtifactStore.deleteThreadArtifacts(threadId);
  }

  getLocalCapabilities(): AgentCapability[] {
    return this.localCapabilities;
  }

  getLocalCapabilityDefinitions(): AgentCapability[] {
    return this.localCapabilityDefinitions;
  }

  getUserCapabilities(): LoadedUserCapability[] {
    return this.userCapabilities;
  }

  getUserCapabilityDefinitions(): LoadedUserCapability[] {
    return this.userCapabilityDefinitions;
  }

  async rescanUserCapabilities(): Promise<{
    userCapabilityDefinitions: LoadedUserCapability[];
    userCapabilities: LoadedUserCapability[];
  }> {
    this.userCapabilityDefinitions = await this.deps.loadUserCapabilities();
    this.userCapabilities = await filterAvailableUserCapabilities(
      this.userCapabilityDefinitions,
      (capability, options) => this.deps.resolveCapabilityAvailability(capability, {
        ...options,
        availableToolkits: this.localToolkits,
      }),
      { force: true },
    );
    return {
      userCapabilityDefinitions: this.userCapabilityDefinitions,
      userCapabilities: this.userCapabilities,
    };
  }
}
