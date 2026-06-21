import type { BaseMessage } from '@langchain/core/messages';
import type { AgentCapability } from '../types/capability';
import type { AgentActor, AgentExecution } from '../types/agent';
import type { SubagentToolEventHandler } from '../types/subagent';
import type { AgentToolkit } from '../types/toolkit';
import type { GlobalReviewPolicy } from './orchestrator/review/globalReviewPolicy';
import { buildOrchestratorRunInput, type OrchestratorGraph } from './createAgentRuntime';

export type AgentInvokeInput = {
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
  onToolEvent?: SubagentToolEventHandler;
  globalReviewPolicy?: GlobalReviewPolicy;
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
): Promise<AgentRunResult> {
  const configurable: Record<string, unknown> = {};
  if (input.actor) configurable.actor = input.actor;
  if (input.threadId) configurable.thread_id = input.threadId;
  if (input.capabilities) configurable.capabilities = input.capabilities;
  if (input.toolkits && input.toolkits.length > 0) configurable.toolkits = input.toolkits;
  if (input.execution) configurable.execution = input.execution;
  if (input.workdir) configurable.workdir = input.workdir;
  if (input.runtimeEnvironment) configurable.runtimeEnvironment = input.runtimeEnvironment;
  if (input.onToolEvent) configurable.onToolEvent = input.onToolEvent;
  if (input.globalReviewPolicy) configurable.globalReviewPolicy = input.globalReviewPolicy;

  const result = await graph.invoke(
    buildOrchestratorRunInput(input.messages),
    {
      signal: input.signal,
      configurable: Object.keys(configurable).length > 0 ? configurable : undefined,
    },
  );

  const messages = (result as { messages?: BaseMessage[] }).messages ?? [];

  return {
    reply: readReply(messages),
    messages,
  };
}
