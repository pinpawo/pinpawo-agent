import type { TokenUsageSnapshot } from '@pinpawo/agent-contracts';
import type { AgentMessageToolCall, AgentPlan, AgentToolCallStatus } from './domain';
import {
  isHumanReviewRequest,
  parseTokenUsageSnapshot,
} from '@pinpawo/agent-contracts';

export type {
  ToolAuthorizationMode,
  ToolAuthorizationSafetyLevel,
} from '@pinpawo/agent-contracts';

export {
  isHumanReviewRequest as isAgentReviewSpecValue,
  parseTokenUsageSnapshot as parseAgentTokenUsageSnapshot,
};

export function isAgentTokenUsageSnapshot(
  value: unknown,
): value is TokenUsageSnapshot {
  return parseTokenUsageSnapshot(value) !== null;
}

const TOOL_CALL_STATUSES: readonly AgentToolCallStatus[] = ['running', 'completed', 'failed', 'interrupted'];

export function isAgentToolCallStatus(value: unknown): value is AgentToolCallStatus {
  return TOOL_CALL_STATUSES.includes(value as AgentToolCallStatus);
}

/** A message's tool calls; `withStatus` false reads the announcement shape. */
export function parseAgentMessageToolCalls(value: unknown, withStatus: true): AgentMessageToolCall[] | null;
export function parseAgentMessageToolCalls(value: unknown, withStatus: false): Omit<AgentMessageToolCall, 'status'>[] | null;
export function parseAgentMessageToolCalls(value: unknown, withStatus: boolean) {
  if (!Array.isArray(value)) return null;
  const calls = value.flatMap((call) => {
    if (
      !isRecord(call)
      || Object.keys(call).some(key => !['id', 'name', 'args', 'status'].includes(key))
      || typeof call.id !== 'string'
      || typeof call.name !== 'string'
      || !isRecord(call.args)
      || (withStatus ? !isAgentToolCallStatus(call.status) : call.status !== undefined)
    ) return [];
    return [{
      id: call.id, name: call.name, args: call.args,
      ...(withStatus ? { status: call.status as AgentToolCallStatus } : {}),
    }];
  });
  return calls.length === value.length ? calls : null;
}

export function parseAgentPlan(value: unknown): AgentPlan | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items = value.items.flatMap((item) => {
    if (
      !isRecord(item)
      || typeof item.id !== 'string'
      || typeof item.capability !== 'string'
      || typeof item.task !== 'string'
      || (item.status !== 'completed' && item.status !== 'active' && item.status !== 'pending')
    ) {
      return [];
    }
    return [{
      id: item.id,
      capability: item.capability,
      task: item.task,
      status: item.status === 'completed'
        ? 'completed' as const
        : item.status === 'active'
          ? 'active' as const
          : 'pending' as const,
    }];
  });
  return items.length === value.items.length ? { items } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
