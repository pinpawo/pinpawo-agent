import type { BaseMessage } from '@langchain/core/messages';
import { getAgentRuntimeContext, type AgentRuntimeContext } from '../runtime/context';
import type { AgentCapability } from '../types/capability';
import type { AgentActor, AgentExecution } from '../types/agent';
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
  actor?: AgentActor;
  threadId?: string;
  capabilities?: AgentCapability[];
  toolkits?: AgentToolkit[];
  execution?: AgentExecution;
  signal?: AbortSignal;
  /** Agent working directory passed into system prompt so the agent knows its file scope. */
  workdir?: string;
  /** Runtime environment summary injected into system prompts. Must not contain secrets. */
  runtimeEnvironment?: string;
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
  const configurable: Record<string, unknown> = {};
  configurable.registry = options.registry ?? compileAgentRegistry({
    toolkits: await filterAvailableToolkits(input.toolkits ?? []),
    capabilities: input.capabilities ?? [],
  });
  if (input.actor) configurable.actor = input.actor;
  if (input.threadId) configurable.thread_id = input.threadId;
  if (input.execution) configurable.execution = input.execution;
  if (input.workdir) configurable.workdir = input.workdir;
  if (input.runtimeEnvironment) configurable.runtimeEnvironment = input.runtimeEnvironment;
  if (input.globalReviewPolicy) configurable.globalReviewPolicy = input.globalReviewPolicy;
  if (options.reviewCapabilities) configurable.reviewCapabilities = options.reviewCapabilities;
  if (input.allowedCapabilityNames) {
    configurable.allowedCapabilityNames = input.allowedCapabilityNames;
  }

  const result = await graph.invoke(
    buildOrchestratorRunInput(input.messages, {
      activeDelegationTransition: input.activeDelegationTransition,
      traceId: input.traceId,
    }),
    {
      context: getAgentRuntimeContext(input),
      signal: input.signal,
      configurable: Object.keys(configurable).length > 0 ? configurable : undefined,
      // Last-resort breaker for a runaway control loop; the soft run-iteration
      // guard is the normal stop. Without this the graph would run to LangGraph's
      // default 25-node limit, which the soft guard can never beat. #275/P6.
      recursionLimit: ORCHESTRATOR_RECURSION_LIMIT,
    },
  );

  const messages = (result as { messages?: BaseMessage[] }).messages ?? [];

  return {
    reply: readReply(messages),
    messages,
  };
}
