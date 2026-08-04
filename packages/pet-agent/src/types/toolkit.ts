import {
  isStructuredTool,
  type StructuredTool,
} from '@langchain/core/tools';
import type { ReviewSpec } from '../agent/orchestrator/review/reviewSpec';
import type { ToolAuthorizationMatcher } from '../agent/orchestrator/review/authorizationMatchers';
import { wrapToolCancellation } from './toolCancellation';

export type ToolkitReviewCapabilities = {
  humanReview: boolean;
  sessionAuthorization: boolean;
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

export type ToolReviewContext = {
  toolkitName: string;
  toolName: string;
  input: unknown;
  operation?: ToolOperationMetadata;
  reviewCapabilities?: ToolkitReviewCapabilities;
  authorizationMatcher?: ToolAuthorizationMatcher | null;
};

export type ToolAuthorizationContext = {
  toolkitName: string;
  toolName: string;
  input: unknown;
  operation?: ToolOperationMetadata;
};

export type ToolAuthorizationPolicy = {
  buildMatcher: (
    ctx: ToolAuthorizationContext,
  ) => ToolAuthorizationMatcher | null | Promise<ToolAuthorizationMatcher | null>;
};

export type ToolReviewBlock = {
  type: 'block';
  reason: string;
};

export type ToolReviewResult = ReviewSpec | ToolReviewBlock | null;

export type ToolReviewPolicy = {
  /**
   * Produce the review requirement for one tool call.
   *
   * The policy must be idempotent and side-effect free. Review middleware can
   * invoke it again when a suspended review resumes.
   */
  request: (
    ctx: ToolReviewContext,
  ) => ToolReviewResult | Promise<ToolReviewResult>;
  authorization?: ToolAuthorizationPolicy;
};

export type ToolkitReviewGuidance = {
  /**
   * Toolkit-owned guidance for a global review classifier.
   *
   * Deterministic per-tool requirements belong in `ToolDefinition.review`.
   */
  allow: string;
  ask: string;
};

export const TOOLKIT_REVIEW_GUIDANCE_FIELD_MAX_CHARS = 2_000;

export type NamedStructuredTool<TName extends string = string> = StructuredTool & {
  /**
   * Tool names are stable by convention for one registry generation. Hosts
   * must not rename an executable Tool after it has been registered.
   *
   * This remains mutable because StructuredTool declares a writable `name`;
   * an intersection cannot strengthen that inherited property to readonly.
   */
  name: TName;
};

export type ModelInputModality = 'text' | 'image';

export type ToolDefinition<
  TTool extends NamedStructuredTool = NamedStructuredTool,
> = {
  readonly tool: TTool;
  readonly operation?: ToolOperationMetadata;
  readonly review?: ToolReviewPolicy;
  /**
   * Model input capabilities this tool needs before it may be bound. Tools that
   * feed content back to the model in a non-text modality declare it here, so
   * binding is decided from the active model profile instead of being inferred
   * from a model name at call time.
   */
  readonly requiresInputModalities?: readonly ModelInputModality[];
};

export type ToolkitAvailability =
  | { available: true }
  | { available: false; reason: string };

export type ToolkitAvailabilityCheck = () =>
  | ToolkitAvailability
  | Promise<ToolkitAvailability>;

/**
 * Generic identity supplied when a Toolkit resolves resources for one
 * subagent execution. It deliberately contains no provider/session/backend
 * concepts: those remain private to the Toolkit runtime implementation.
 */
export type ToolkitRuntimeExecutionScope = {
  threadId: string | null;
  runId: string;
  delegationId: string;
  workdir: string | null;
  signal?: AbortSignal;
};

export type ToolkitRuntimeStartContext = {
  signal?: AbortSignal;
};

export type ToolkitRuntimeResolveContext = {
  execution: ToolkitRuntimeExecutionScope;
};

export type ToolkitRuntimeReleaseContext = ToolkitRuntimeResolveContext;

export type ToolkitRuntimeStopContext = {
  signal?: AbortSignal;
};

/**
 * Optional Toolkit-owned execution lifecycle.
 *
 * The root may be shared across executions. A resolved binding is opaque to
 * the framework and is only handed back to the same Toolkit's bindTools and
 * release hooks. bindTools may replace executable Tool instances, but the
 * framework verifies that the static tool inventory is unchanged.
 */
export type ToolkitRuntimeDefinition<TRoot = unknown, TBinding = TRoot> = {
  start: (
    context: ToolkitRuntimeStartContext,
  ) => TRoot | Promise<TRoot>;
  resolve?: (
    root: TRoot,
    context: ToolkitRuntimeResolveContext,
  ) => TBinding | Promise<TBinding>;
  bindTools?: (
    binding: TBinding,
    context: ToolkitRuntimeResolveContext,
  ) => readonly NamedStructuredTool[] | Promise<readonly NamedStructuredTool[]>;
  release?: (
    binding: TBinding,
    context: ToolkitRuntimeReleaseContext,
  ) => void | Promise<void>;
  stop?: (
    root: TRoot,
    context: ToolkitRuntimeStopContext,
  ) => void | Promise<void>;
};

export async function evaluateToolkitAvailability(
  toolkit: AgentToolkit,
): Promise<ToolkitAvailability> {
  if (!toolkit.availability) {
    return { available: true };
  }
  try {
    const availability = await toolkit.availability();
    if (availability?.available === true) {
      return { available: true };
    }
    if (
      availability?.available === false
      && typeof availability.reason === 'string'
      && availability.reason.trim()
    ) {
      return {
        available: false,
        reason: availability.reason,
      };
    }
    return {
      available: false,
      reason: `Toolkit "${toolkit.name}" availability returned an invalid result`,
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : 'availability check failed',
    };
  }
}

/**
 * Resolve one complete Toolkit inventory for the registry generation being
 * assembled. This function deliberately has no cross-generation cache.
 */
export async function filterAvailableToolkits(
  toolkits: readonly AgentToolkit[],
): Promise<AgentToolkit[]> {
  const records = await Promise.all(
    toolkits.map(async (toolkit) => ({
      toolkit,
      availability: await evaluateToolkitAvailability(toolkit),
    })),
  );
  return records
    .filter(({ availability }) => availability.available)
    .map(({ toolkit }) => toolkit);
}

export type AgentToolkit = {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly ToolDefinition[];
  readonly instructions?: string;
  readonly availability?: ToolkitAvailabilityCheck;
  readonly reviewGuidance?: ToolkitReviewGuidance;
  readonly runtime?: ToolkitRuntimeDefinition;
};

function assertToolkitReviewGuidance(
  ownerName: string,
  guidance: ToolkitReviewGuidance | undefined,
) {
  if (!guidance) return;
  if (typeof guidance !== 'object' || Array.isArray(guidance)) {
    throw new Error(`Toolkit "${ownerName}" review guidance must be an object`);
  }

  for (const field of ['allow', 'ask'] as const) {
    const value = guidance[field];
    if (typeof value !== 'string') {
      throw new Error(`Toolkit "${ownerName}" review guidance ${field} must be a string`);
    }
    if (value.length > TOOLKIT_REVIEW_GUIDANCE_FIELD_MAX_CHARS) {
      throw new Error(
        `Toolkit "${ownerName}" review guidance ${field} exceeds ${TOOLKIT_REVIEW_GUIDANCE_FIELD_MAX_CHARS.toString()} characters`,
      );
    }
  }
}

function assertOptionalFunction(
  owner: string,
  value: unknown,
) {
  if (value !== undefined && typeof value !== 'function') {
    throw new Error(`${owner} must be a function`);
  }
}

export function validateToolkitDefinition(toolkit: AgentToolkit) {
  if (!toolkit || typeof toolkit !== 'object' || Array.isArray(toolkit)) {
    throw new Error('Toolkit definition must be an object');
  }
  if (typeof toolkit.name !== 'string' || !toolkit.name.trim()) {
    throw new Error('Toolkit name must not be empty');
  }
  if (typeof toolkit.description !== 'string' || !toolkit.description.trim()) {
    throw new Error(`Toolkit "${toolkit.name}" description must not be empty`);
  }
  if (!Array.isArray(toolkit.tools) || toolkit.tools.length === 0) {
    throw new Error(`Toolkit "${toolkit.name}" must define at least one tool`);
  }
  if (toolkit.instructions !== undefined && typeof toolkit.instructions !== 'string') {
    throw new Error(`Toolkit "${toolkit.name}" instructions must be a string`);
  }
  if (toolkit.availability !== undefined && typeof toolkit.availability !== 'function') {
    throw new Error(`Toolkit "${toolkit.name}" availability must be a function`);
  }
  if (toolkit.runtime !== undefined) {
    if (
      typeof toolkit.runtime !== 'object'
      || Array.isArray(toolkit.runtime)
      || typeof toolkit.runtime.start !== 'function'
    ) {
      throw new Error(`Toolkit "${toolkit.name}" runtime must define start()`);
    }
    for (const hook of ['resolve', 'bindTools', 'release', 'stop'] as const) {
      if (toolkit.runtime[hook] !== undefined && typeof toolkit.runtime[hook] !== 'function') {
        throw new Error(`Toolkit "${toolkit.name}" runtime.${hook} must be a function`);
      }
    }
  }

  assertToolkitReviewGuidance(toolkit.name, toolkit.reviewGuidance);

  const toolNames = new Set<string>();
  for (const definition of toolkit.tools) {
    const toolName = definition?.tool?.name;
    if (typeof toolName !== 'string' || !toolName.trim()) {
      throw new Error(`Toolkit "${toolkit.name}" contains a tool without a name`);
    }
    if (
      !isStructuredTool(definition.tool)
      || typeof definition.tool.invoke !== 'function'
    ) {
      throw new Error(
        `Toolkit "${toolkit.name}" tool "${toolName}" must be an executable StructuredTool`,
      );
    }
    if (toolNames.has(toolName)) {
      throw new Error(`Toolkit "${toolkit.name}" defines duplicate tool "${toolName}"`);
    }
    if (
      definition.operation !== undefined
      && (typeof definition.operation !== 'object' || Array.isArray(definition.operation))
    ) {
      throw new Error(
        `Toolkit "${toolkit.name}" tool "${toolName}" operation must be an object`,
      );
    }
    if (definition.operation) {
      const owner = `Toolkit "${toolkit.name}" tool "${toolName}" operation`;
      assertOptionalFunction(
        `${owner}.summarizeInput`,
        definition.operation.summarizeInput,
      );
      assertOptionalFunction(
        `${owner}.summarizeOutput`,
        definition.operation.summarizeOutput,
      );
      assertOptionalFunction(
        `${owner}.summarizeError`,
        definition.operation.summarizeError,
      );
    }
    if (
      definition.review !== undefined
      && (
        typeof definition.review !== 'object'
        || Array.isArray(definition.review)
        || typeof definition.review.request !== 'function'
      )
    ) {
      throw new Error(
        `Toolkit "${toolkit.name}" tool "${toolName}" review must define request()`,
      );
    }
    if (definition.review) {
      const authorization = definition.review.authorization;
      if (
        authorization !== undefined
        && (
          typeof authorization !== 'object'
          || Array.isArray(authorization)
          || typeof authorization.buildMatcher !== 'function'
        )
      ) {
        throw new Error(
          `Toolkit "${toolkit.name}" tool "${toolName}" review.authorization must define buildMatcher()`,
        );
      }
    }
    if (definition.requiresInputModalities !== undefined) {
      if (
        !Array.isArray(definition.requiresInputModalities)
        || definition.requiresInputModalities.length === 0
        || definition.requiresInputModalities.some(
          (modality: unknown) => modality !== 'text' && modality !== 'image',
        )
      ) {
        throw new Error(
          `Toolkit "${toolkit.name}" tool "${toolName}" requiresInputModalities must contain supported modalities`,
        );
      }
    }
    toolNames.add(toolName);
  }
}

export function defineToolkit<
  const TTools extends readonly ToolDefinition[],
>(
  definition: Omit<AgentToolkit, 'tools'> & { tools: TTools },
): Omit<AgentToolkit, 'tools'> & { tools: TTools } {
  validateToolkitDefinition(definition);
  return {
    ...definition,
    // Cancellation must never reach the graph as a successful result. How a
    // tool cleans up when cancelled is its own business; that it propagates
    // at all is the toolkit contract's.
    tools: definition.tools.map((toolDefinition) => ({
      ...toolDefinition,
      tool: wrapToolCancellation(toolDefinition.tool),
    })) as unknown as TTools,
  };
}
