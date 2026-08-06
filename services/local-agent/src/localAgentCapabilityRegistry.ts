import type { StructuredTool } from '@langchain/core/tools';
import {
  type AgentCapability,
  type AgentToolkit,
  validateToolkitDefinition,
} from '@pinpawo/pet-agent';
import { loadUserCapabilities, type LoadedUserCapability } from './capabilityLoader';
import { resolveAvailableToolkits } from './toolkits/toolkitAvailability';
import { createExploreCapability } from './capabilities/explore';
import { browserIntegration } from './browserIntegration';
import { FileCapabilityArtifactStore } from './capabilityArtifactStore';
import { createBashToolkit, createGitToolkit, loadCoreLocalTools } from './toolkits/local';

type LocalAgentCapabilityRegistryDeps = {
  loadLocalTools: () => Promise<StructuredTool[]>;
  loadUserCapabilities: () => Promise<LoadedUserCapability[]>;
  createLocalToolkits: (
    localTools: StructuredTool[],
  ) => AgentToolkit[];
  createLocalCapabilities: () => AgentCapability[];
  resolveAvailableToolkits: typeof resolveAvailableToolkits;
};

type LocalAgentCapabilityRegistryOptions = Partial<LocalAgentCapabilityRegistryDeps> & {
  capabilityArtifactRoot?: string;
};

export type LoadLocalAgentCapabilityRegistryOptions = {
  /** Runs after static Toolkit validation and before availability checks. */
  startToolkitRuntimes?: (toolkits: readonly AgentToolkit[]) => Promise<void>;
};

const defaultDeps: LocalAgentCapabilityRegistryDeps = {
  loadLocalTools: loadCoreLocalTools,
  loadUserCapabilities,
  createLocalToolkits: () => [
    createBashToolkit(),
    createGitToolkit(),
    browserIntegration.toolkit,
  ],
  createLocalCapabilities: () => [
    createExploreCapability(),
    browserIntegration.capability,
  ],
  resolveAvailableToolkits,
};

export class LocalAgentCapabilityRegistry {
  private localTools: StructuredTool[] = [];
  private localToolkitDefinitions: AgentToolkit[] = [];
  private localToolkits: AgentToolkit[] = [];
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

  async load(options: LoadLocalAgentCapabilityRegistryOptions = {}) {
    this.localTools = await this.deps.loadLocalTools();
    this.localToolkitDefinitions = this.deps.createLocalToolkits(this.localTools);
    this.localToolkitDefinitions.forEach(validateToolkitDefinition);
    await options.startToolkitRuntimes?.(this.localToolkitDefinitions);
    this.localToolkits = await this.deps.resolveAvailableToolkits(this.localToolkitDefinitions);
    this.localCapabilities = this.deps.createLocalCapabilities();
    this.userCapabilities = await this.deps.loadUserCapabilities();
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

  getUserCapabilities(): LoadedUserCapability[] {
    return this.userCapabilities;
  }

  async rescanUserCapabilities(): Promise<LoadedUserCapability[]> {
    this.userCapabilities = await this.deps.loadUserCapabilities();
    return this.userCapabilities;
  }
}
