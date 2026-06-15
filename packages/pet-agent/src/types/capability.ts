import type { BaseMessage } from '@langchain/core/messages';
import type { ZodType } from 'zod';
import type { AgentActor, AgentExecution, AgentModels } from './agent';
import type { SubagentInput, SubagentResult } from './subagent';
import type { SubagentContextPolicy } from './subagent';
import type { AgentToolset } from './toolkit';

export type CapabilityContext = {
  models: AgentModels;
  actor: AgentActor;
  messages: BaseMessage[];
  execution?: AgentExecution;
  availableToolkits?: ReadonlyArray<{
    name: string;
    description: string;
  }>;
};

export type CapabilityInstructionContext = CapabilityContext;

export type CapabilityMiddleware = {
  beforeRun?: (input: SubagentInput) => SubagentInput | Promise<SubagentInput>;
  afterRun?: (result: SubagentResult) => SubagentResult | Promise<SubagentResult>;
};

export type CapabilityRuntime = {
  /**
   * Reusable toolkits this capability needs. The orchestrator resolves these
   * before creating the subagent and injects their tools/instructions.
   */
  uses?: string[];
  /**
   * Capability-private tool groups. New capability-local tools should use
   * toolsets so tools and operation metadata stay under the same typed owner.
  */
  toolsets?: AgentToolset[];
  contextPolicy?: SubagentContextPolicy;
  instructions?: string[] | ((ctx: CapabilityInstructionContext) => string[] | Promise<string[]>);
  middleware?: CapabilityMiddleware;
};

export type CapabilityAvailability = {
  available: boolean;
  reason?: string;
  detail?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type CapabilityAvailabilityConfig = {
  /**
   * Called by the host at startup to decide whether this capability should be
   * registered. Hosts may also call it again for explicit refresh actions.
   */
  check: () => CapabilityAvailability | Promise<CapabilityAvailability>;
  cache?: 'startup' | 'none';
};

export type AgentCapability = {
  name: string;
  description: string;
  availability?: CapabilityAvailabilityConfig;
  createRuntime: (ctx: CapabilityContext) => CapabilityRuntime | Promise<CapabilityRuntime>;
  resultSchema?: ZodType;
};
