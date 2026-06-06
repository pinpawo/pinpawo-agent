import type { StructuredTool } from '@langchain/core/tools';
import type { AgentCapability, AgentToolkit } from '@pinpawo/pet-agent';
import { loadUserCapabilities, type LoadedUserCapability } from './capabilityLoader';
import {
  resolveAvailableCapabilities,
  resolveAvailableToolkits,
  resolveCapabilityAvailability,
} from './capabilities/capabilityAvailability';
import { createBrowserCapability } from './capabilities/browserCapability';
import { createBrowserToolkit } from './toolkits/browser';
import { createBashToolkit, createGitToolkit, loadCoreLocalTools } from './toolkits/local';

type ResolveCapabilityAvailability = typeof resolveCapabilityAvailability;

type LocalAgentCapabilityRegistryDeps = {
  loadLocalTools: () => Promise<StructuredTool[]>;
  loadUserCapabilities: () => Promise<LoadedUserCapability[]>;
  createLocalToolkits: (localTools: StructuredTool[]) => AgentToolkit[];
  createLocalCapabilities: () => AgentCapability[];
  resolveAvailableToolkits: typeof resolveAvailableToolkits;
  resolveAvailableCapabilities: typeof resolveAvailableCapabilities;
  resolveCapabilityAvailability: ResolveCapabilityAvailability;
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

  constructor(deps: Partial<LocalAgentCapabilityRegistryDeps> = {}) {
    this.deps = {
      ...defaultDeps,
      ...deps,
    };
  }

  async load() {
    this.localTools = await this.deps.loadLocalTools();
    this.localToolkitDefinitions = this.deps.createLocalToolkits(this.localTools);
    this.localToolkits = await this.deps.resolveAvailableToolkits(this.localToolkitDefinitions);
    this.localCapabilityDefinitions = this.deps.createLocalCapabilities();
    this.localCapabilities = await this.deps.resolveAvailableCapabilities(this.localCapabilityDefinitions);
    this.userCapabilityDefinitions = await this.deps.loadUserCapabilities();
    this.userCapabilities = await filterAvailableUserCapabilities(
      this.userCapabilityDefinitions,
      this.deps.resolveCapabilityAvailability,
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
      this.deps.resolveCapabilityAvailability,
      { force: true },
    );
    return {
      userCapabilityDefinitions: this.userCapabilityDefinitions,
      userCapabilities: this.userCapabilities,
    };
  }
}
