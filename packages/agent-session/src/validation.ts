import type {
  TokenUsageSnapshot,
  ToolAuthorizationSafetyLevel,
} from '@pinpawo/agent-contracts';
import type { AgentPlan } from './domain';
import {
  isHumanReviewRequest,
  isToolAuthorizationSafetyLevel,
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

export function isAutoAuthorizationSafetyLevel(
  value: unknown,
): value is ToolAuthorizationSafetyLevel {
  return isToolAuthorizationSafetyLevel(value);
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
