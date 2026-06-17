import type { BaseMessage } from '@langchain/core/messages';
import type { ZodType } from 'zod';
import type { AgentActor, AgentExecution, AgentModels } from './agent';
import type { SubagentInput, SubagentResult } from './subagent';
import type { SubagentContextPolicy } from './subagent';
import type { AgentToolset } from './toolkit';
import type { CapabilityArtifactRef, CapabilityArtifactStore } from './artifact';

export type CapabilityContext = {
  models: AgentModels;
  actor: AgentActor;
  messages: BaseMessage[];
  execution?: AgentExecution;
  availableToolkits?: ReadonlyArray<{
    name: string;
    description: string;
  }>;
  /**
   * Artifact store (port) the runtime injects so a capability can persist its
   * own artifacts by closure (afterRun / context-pressure ingest). Undefined on
   * surfaces without a store; capabilities skip writes when absent.
   */
  artifactStore?: CapabilityArtifactStore;
};

export type CapabilityInstructionContext = CapabilityContext;

/**
 * Context handed to `afterRun` so a capability can deterministically persist
 * artifacts (e.g. a structured result) in code, rather than relying on the
 * model to call a write tool inside the subagent loop.
 *
 * The capability supplies its own `CapabilityArtifactStore` (it is a host
 * concern that pet-agent core does not own — see CAPABILITY_ARTIFACT_REDESIGN
 * §26: the store reaches capabilities by closure, not via OrchestratorConfig).
 * pet-agent supplies the identifiers needed to address a write, and the
 * `recordCapabilityArtifact` sink that attaches the returned ref to the subagent
 * result so it reaches `state.capabilityArtifacts`.
 */
export type CapabilityMiddlewareContext = {
  recordCapabilityArtifact?: (ref: CapabilityArtifactRef) => void | Promise<void>;
  threadId?: string | null;
  capabilityId: string;
  delegationId: string;
  turnId: string;
};

export type CapabilityMiddleware = {
  beforeRun?: (input: SubagentInput) => SubagentInput | Promise<SubagentInput>;
  afterRun?: (
    result: SubagentResult,
    ctx: CapabilityMiddlewareContext,
  ) => SubagentResult | Promise<SubagentResult>;
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
