import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import type { AgentCapability } from '../types/capability';
import type { AgentActor, AgentExecution } from '../types/agent';
import type { SubagentToolEventHandler } from '../types/subagent';
import type { AgentToolkit } from '../types/toolkit';
import { buildOrchestratorTurnInput, type OrchestratorGraph } from './createAgentRuntime';

export type AgentInvokeInput = {
  messages: BaseMessage[];
  actor?: AgentActor;
  threadId?: string;
  capabilities?: AgentCapability[];
  tools?: StructuredTool[];
  toolkits?: AgentToolkit[];
  execution?: AgentExecution;
  signal?: AbortSignal;
  /** Agent working directory passed into system prompt so the agent knows its file scope. */
  workdir?: string;
  /** Runtime environment summary injected into system prompts. Must not contain secrets. */
  runtimeEnvironment?: string;
  onToolEvent?: SubagentToolEventHandler;
};

export type AgentRunResult = {
  reply: string;
  messages: BaseMessage[];
};

export type ToolCallLog = {
  toolName: string;
  input: string;
  output: string;
};

function readReply(messages: BaseMessage[]): string {
  const last = messages.at(-1);
  return typeof last?.content === 'string' ? last.content.trim() : '';
}

export function extractToolCallLogs(messages: BaseMessage[]): ToolCallLog[] {
  const logs: ToolCallLog[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg._getType() !== 'ai') continue;

    const toolCalls = 'tool_calls' in msg && Array.isArray(msg.tool_calls)
      ? msg.tool_calls
      : [];

    for (const tc of toolCalls) {
      const toolName = tc.name ?? 'unknown';
      const input = typeof tc.args === 'string'
        ? tc.args
        : JSON.stringify(tc.args ?? '');

      // Find the matching tool message
      let output = '';
      for (let j = i + 1; j < messages.length; j++) {
        const candidate = messages[j];
        if (candidate._getType() === 'tool' && 'tool_call_id' in candidate && candidate.tool_call_id === tc.id) {
          output = typeof candidate.content === 'string'
            ? candidate.content
            : JSON.stringify(candidate.content ?? '');
          break;
        }
      }

      logs.push({ toolName, input: input.slice(0, 400), output: output.slice(0, 300) });
    }
  }

  return logs;
}

export async function runAgent(
  graph: OrchestratorGraph,
  input: AgentInvokeInput,
): Promise<AgentRunResult> {
  const configurable: Record<string, unknown> = {};
  if (input.actor) configurable.actor = input.actor;
  if (input.threadId) configurable.thread_id = input.threadId;
  if (input.capabilities) configurable.capabilities = input.capabilities;
  if (input.tools) configurable.tools = input.tools;
  if (input.toolkits) configurable.toolkits = input.toolkits;
  if (input.execution) configurable.execution = input.execution;
  if (input.workdir) configurable.workdir = input.workdir;
  if (input.runtimeEnvironment) configurable.runtimeEnvironment = input.runtimeEnvironment;
  if (input.onToolEvent) configurable.onToolEvent = input.onToolEvent;

  const result = await graph.invoke(
    buildOrchestratorTurnInput(input.messages),
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
