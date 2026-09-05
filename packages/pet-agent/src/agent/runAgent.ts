import type { BaseMessage } from '@langchain/core/messages';
import { getAgentRuntimeContext, type AgentRuntimeContext } from '../runtime/context';
import type { AgentCapability } from '../types/capability';
import {
  filterAvailableToolkits,
  type AgentToolkit,
  type ToolkitReviewCapabilities,
} from '../types/toolkit';
import { compileAgentRegistry } from './orchestrator/registry';
import type { CompiledAgentRegistry } from './orchestrator/registry';
import type { GlobalReviewPolicy } from './orchestrator/review/globalReviewPolicy';
import type { ActiveDelegationTransition } from './orchestrator/types';
import {
  buildOrchestratorRunInput,
  ORCHESTRATOR_RECURSION_LIMIT,
  type OrchestratorGraph,
} from './createAgentRuntime';

export type AgentInvokeInput = {
  /** Host-owned context reapplied on each invocation, including resumes. */
  context?: AgentRuntimeContext;
  messages: BaseMessage[];
  threadId?: string;
  capabilities?: AgentCapability[];
  toolkits?: AgentToolkit[];
  signal?: AbortSignal;
  globalReviewPolicy?: GlobalReviewPolicy;
  /** Optional allowlist exposed through the Supervisor document workspace. */
  allowedCapabilityNames?: string[];
  /**
   * Explicit fresh-turn treatment of an unfinished delegation. Ordinary user
   * requests supersede it; callers must opt in to continuation.
   */
  activeDelegationTransition?: ActiveDelegationTransition;
  /** Optional stable task identity supplied by a host that owns task lifecycle. */
  traceId?: string;
};

export type AgentRunResult = {
  reply: string;
  messages: BaseMessage[];
};

function readReply(messages: BaseMessage[]): string {
  const last = messages.at(-1);
  return typeof last?.content === 'string' ? last.content.trim() : '';
}

export async function runAgent(
  graph: OrchestratorGraph,
  input: AgentInvokeInput,
  options: {
    /** Host-precompiled registry. Reused as-is when the host owns run preparation. */
    registry?: CompiledAgentRegistry;
    /** Host runtime capabilities; independent from whether a human UI exists. */
    reviewCapabilities?: ToolkitReviewCapabilities;
  } = {},
): Promise<AgentRunResult> {
  const registry = options.registry ?? compileAgentRegistry({
    toolkits: await filterAvailableToolkits(input.toolkits ?? []),
    capabilities: input.capabilities ?? [],
  });

  const result = await graph.invoke(
    buildOrchestratorRunInput(input.messages, input),
    buildAgentRunnableConfig(input, { ...options, registry }),
  );

  const messages = (result as { messages?: BaseMessage[] }).messages ?? [];

  return {
    reply: readReply(messages),
    messages,
  };
}

/** Project invocation data once; Hosts may add framework callbacks and interface metadata. */
export function buildAgentRunnableConfig(
  input: AgentInvokeInput,
  options: {
    registry: CompiledAgentRegistry;
    reviewCapabilities?: ToolkitReviewCapabilities;
  },
) {
  return {
    context: getAgentRuntimeContext(input),
    signal: input.signal,
    configurable: {
      registry: options.registry,
      ...(input.threadId ? { thread_id: input.threadId } : {}),
      ...(input.globalReviewPolicy ? { globalReviewPolicy: input.globalReviewPolicy } : {}),
      ...(options.reviewCapabilities ? { reviewCapabilities: options.reviewCapabilities } : {}),
      ...(input.allowedCapabilityNames !== undefined
        ? { allowedCapabilityNames: input.allowedCapabilityNames }
        : {}),
    },
    // The soft iteration guard is the normal stop; this is the final loop breaker.
    recursionLimit: ORCHESTRATOR_RECURSION_LIMIT,
  };
}
