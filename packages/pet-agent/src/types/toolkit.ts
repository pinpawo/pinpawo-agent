import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import type { ZodType } from 'zod';
import type {
  PendingReviewAction,
  ReviewEffect,
  ReviewSpec,
  ToolAuthorizationMatcher,
} from '../agent/orchestrator/review/reviewSpec';
import type { ToolAuthorizationRecord } from '../agent/orchestrator/review/reviewAuthorizations';
import type { GlobalReviewPolicy } from '../agent/orchestrator/review/globalReviewPolicy';
import type { AgentActor, AgentExecution, AgentModels } from './agent';
import type { CapabilityAvailabilityConfig } from './capability';
import type { CapabilityArtifactRef } from './artifact';
import type { SubagentRuntimeEvent } from './subagent';

export type ToolkitContext = {
  models: AgentModels;
  actor: AgentActor;
  messages: BaseMessage[];
  threadId?: string | null;
  capabilityId?: string | null;
  resultSchema?: ZodType;
  delegationId?: string | null;
  runId?: string | null;
  execution?: AgentExecution;
  reviewCapabilities?: ToolkitReviewCapabilities;
  globalReviewPolicy?: GlobalReviewPolicy;
  toolAuthorizations?: ToolAuthorizationRecord[];
  recordToolAuthorization?: (authorization: ToolAuthorizationRecord) => void | Promise<void>;
  recordCapabilityArtifact?: (ref: CapabilityArtifactRef) => void | Promise<void>;
  emitRuntimeEvent?: (event: SubagentRuntimeEvent) => void | Promise<void>;
};

export type ToolkitReviewCapabilities = {
  humanReview: boolean;
  sessionAuthorization: boolean;
};

export type ToolkitResource<T> = T | ((ctx: ToolkitContext) => T | Promise<T>);

export type ToolkitToolReviewContext = ToolkitContext & {
  toolkitName: string;
  toolName: string;
  input: unknown;
  operation?: ToolOperationMetadata;
};

export type ToolkitToolAuthorizationMatcherContext = {
  toolkitName: string;
  toolName: string;
  input: unknown;
  operation?: ToolOperationMetadata;
  pendingAction: PendingReviewAction;
  effect: Extract<ReviewEffect, { type: 'graph.authorize_tool_action' }>;
};

export type ToolkitToolReviewBlock = {
  type: 'block';
  reason: string;
};

export type ToolkitToolReviewResult = ReviewSpec | ToolkitToolReviewBlock | null;

export type ToolkitToolReviewPolicy = {
  /**
   * Produce the review requirement for a single tool call.
   *
   * MUST be idempotent and side-effect free: the review middleware re-derives
   * the pending reviews from state on every afterModel pass, so `request` is
   * re-invoked for the same tool call when a review action is resumed. Do not
   * increment counters, emit events, or call external services here — build and
   * return the ReviewSpec/block purely from `ctx`.
   */
  request: (
    ctx: ToolkitToolReviewContext
  ) => ToolkitToolReviewResult | Promise<ToolkitToolReviewResult>;
  buildAuthorizationMatcher?: (
    ctx: ToolkitToolAuthorizationMatcherContext
  ) => ToolAuthorizationMatcher | null | Promise<ToolAuthorizationMatcher | null>;
};

export type ToolkitPolicy = {
  toolReview?: Record<string, ToolkitToolReviewPolicy>;
};

export type ToolOperationSummary = {
  target?: string;
  summary?: string;
  details?: Record<string, unknown>;
};

export type ToolOperationMetadata = {
  title?: string;
  titleKey?: string;
  summarizeInput?: (input: unknown) => ToolOperationSummary | null;
  summarizeOutput?: (output: unknown) => ToolOperationSummary | null;
  summarizeError?: (error: unknown) => ToolOperationSummary | null;
};

export type ToolOperationMetadataMap = Record<string, ToolOperationMetadata>;

export function hasToolOperationMetadata(
  operations: ToolOperationMetadataMap | undefined,
): operations is ToolOperationMetadataMap {
  return Boolean(operations && Object.keys(operations).length > 0);
}

export type ToolkitOperationSummary = ToolOperationSummary;
export type ToolkitOperationMetadata = ToolOperationMetadata;

export type NamedStructuredTool<TName extends string = string> = StructuredTool & {
  name: TName;
};

export type ToolkitToolName<TTools extends readonly NamedStructuredTool[]> =
  TTools[number]['name'];

export type ToolOperationMetadataMapFor<TTools extends readonly NamedStructuredTool[]> =
  Partial<Record<ToolkitToolName<TTools>, ToolOperationMetadata>>;

export type ToolkitToolReviewPolicyMapFor<TTools extends readonly NamedStructuredTool[]> =
  Partial<Record<ToolkitToolName<TTools>, ToolkitToolReviewPolicy>>;

type NoExtraToolkitToolKeys<TMap, TTools extends readonly NamedStructuredTool[]> =
  TMap & Record<Exclude<keyof TMap, ToolkitToolName<TTools>>, never>;

export type AgentToolkit = {
  name: string;
  description: string;
  exposure?: {
    general?: boolean;
    capability?: boolean;
  };
  availability?: CapabilityAvailabilityConfig;
  tools?: ToolkitResource<StructuredTool[]>;
  instructions?: ToolkitResource<string[]>;
  operations?: ToolOperationMetadataMap;
  policy?: ToolkitPolicy;
};

export type AgentToolset = {
  name?: string;
  description?: string;
  tools: StructuredTool[];
  operations?: ToolOperationMetadataMap;
  policy?: ToolkitPolicy;
};

type StaticToolsetDefinition<
  TTools extends readonly NamedStructuredTool[],
  TOperations extends Partial<Record<string, ToolOperationMetadata>>,
  TToolReview extends Partial<Record<string, ToolkitToolReviewPolicy>>,
> = Omit<AgentToolset, 'tools' | 'operations' | 'policy'> & {
  tools: TTools;
  operations?: NoExtraToolkitToolKeys<TOperations, TTools>;
  policy?: Omit<ToolkitPolicy, 'toolReview'> & {
    toolReview?: NoExtraToolkitToolKeys<TToolReview, TTools>;
  };
};

function assertStaticToolsetDefinition(
  definition: StaticToolsetDefinition<
    readonly NamedStructuredTool[],
    Partial<Record<string, ToolOperationMetadata>>,
    Partial<Record<string, ToolkitToolReviewPolicy>>
  >,
) {
  const ownerName = definition.name ?? 'anonymous';
  const toolNames = new Set<string>();

  for (const tool of definition.tools) {
    if (toolNames.has(tool.name)) {
      throw new Error(`Toolkit/toolset "${ownerName}" defines duplicate tool "${tool.name}"`);
    }
    toolNames.add(tool.name);
  }

  for (const operationKey of Object.keys(definition.operations ?? {})) {
    if (!toolNames.has(operationKey)) {
      throw new Error(`Toolkit/toolset "${ownerName}" operation metadata references unknown tool "${operationKey}"`);
    }
  }

  for (const reviewKey of Object.keys(definition.policy?.toolReview ?? {})) {
    if (!toolNames.has(reviewKey)) {
      throw new Error(`Toolkit/toolset "${ownerName}" review policy references unknown tool "${reviewKey}"`);
    }
  }
}

export function defineToolset<
  const TTools extends readonly NamedStructuredTool[],
  const TOperations extends Partial<Record<string, ToolOperationMetadata>> = ToolOperationMetadataMapFor<TTools>,
  const TToolReview extends Partial<Record<string, ToolkitToolReviewPolicy>> = ToolkitToolReviewPolicyMapFor<TTools>,
>(definition: StaticToolsetDefinition<TTools, TOperations, TToolReview>): AgentToolset {
  assertStaticToolsetDefinition(definition);
  return {
    ...definition,
    tools: [...definition.tools],
    operations: definition.operations as ToolOperationMetadataMap | undefined,
    policy: definition.policy as ToolkitPolicy | undefined,
  };
}

export function defineToolkit<
  const TTools extends readonly NamedStructuredTool[],
  const TOperations extends Partial<Record<string, ToolOperationMetadata>> = ToolOperationMetadataMapFor<TTools>,
  const TToolReview extends Partial<Record<string, ToolkitToolReviewPolicy>> = ToolkitToolReviewPolicyMapFor<TTools>,
>(definition: Omit<AgentToolkit, 'tools' | 'operations' | 'policy'> & {
  tools: TTools;
  operations?: NoExtraToolkitToolKeys<TOperations, TTools>;
  policy?: Omit<ToolkitPolicy, 'toolReview'> & {
    toolReview?: NoExtraToolkitToolKeys<TToolReview, TTools>;
  };
}): AgentToolkit {
  const toolset = defineToolset(definition);
  return {
    ...definition,
    tools: toolset.tools,
    operations: toolset.operations,
    policy: toolset.policy,
  };
}
