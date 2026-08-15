import type { AgentCapability } from '@pinpawo/pet-agent';
import { loadUserCapabilities, type LoadedUserCapability } from './capabilityLoader';
import { createExploreCapability } from './capabilities/explore';
import { loadGeneralCapability } from './capabilities/general';
import { browserIntegration } from './browserIntegration';
import { FileCapabilityArtifactStore } from './capabilityArtifactStore';

type LocalAgentCapabilityRegistryDeps = {
  loadUserCapabilities: () => Promise<LoadedUserCapability[]>;
  createDefaultCapabilities: () => AgentCapability[];
};

type LocalAgentCapabilityRegistryOptions = Partial<LocalAgentCapabilityRegistryDeps> & {
  capabilityArtifactRoot?: string;
};

function createDefaultLocalCapabilities(): AgentCapability[] {
  const general = loadGeneralCapability();
  if (!general) {
    throw new Error('local-agent requires the built-in "general" Capability.');
  }
  return [
    general,
    createExploreCapability(),
    browserIntegration.capability,
  ];
}

const defaultDeps: LocalAgentCapabilityRegistryDeps = {
  loadUserCapabilities,
  createDefaultCapabilities: createDefaultLocalCapabilities,
};

export class LocalAgentCapabilityRegistry {
  private localCapabilities: AgentCapability[] = [];
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
    this.localCapabilities = this.deps.createDefaultCapabilities();
    this.userCapabilities = await this.deps.loadUserCapabilities();
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

  getUserCapabilities(): LoadedUserCapability[] {
    return this.userCapabilities;
  }

  async rescanUserCapabilities(): Promise<LoadedUserCapability[]> {
    this.userCapabilities = await this.deps.loadUserCapabilities();
    return this.userCapabilities;
  }
}
