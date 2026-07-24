import type { StructuredTool } from '@langchain/core/tools';
import {
  type AgentCapability,
  type AgentToolkit,
  validateToolkitDefinition,
} from '@pinpawo/pet-agent';
import { loadUserCapabilities, type LoadedUserCapability } from './capabilityLoader';
import { resolveAvailableToolkits } from './toolkits/toolkitAvailability';
import { createBrowserCapability } from './capabilities/browserCapability';
import { createExploreCapability } from './capabilities/explore';
import { createBrowserToolkit } from './toolkits/browser';
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
};

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
    // Capability availability is scoped to a compiled registry generation.
    // Keep definitions here; run-scoped Toolkits are registered by the host
    // immediately before compileAgentRegistry().
    this.localCapabilities = [...this.localCapabilityDefinitions];
    this.userCapabilityDefinitions = await this.deps.loadUserCapabilities();
    this.userCapabilities = [...this.userCapabilityDefinitions];
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
    this.userCapabilities = [...this.userCapabilityDefinitions];
    return {
      userCapabilityDefinitions: this.userCapabilityDefinitions,
      userCapabilities: this.userCapabilities,
    };
  }
}
