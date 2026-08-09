import type {
  TokenUsageSnapshot,
  ToolAuthorizationMode,
  ToolAuthorizationSafetyLevel,
} from '@pinpawo/agent-contracts';
import type { AgentPlan } from './domain';
import {
  isHumanReviewRequest,
  isToolAuthorizationMode,
  isToolAuthorizationSafetyLevel,
  parseTokenUsageSnapshot,
} from '@pinpawo/agent-contracts';

/** @deprecated Use ToolAuthorizationMode from @pinpawo/agent-contracts. */
export type BuiltinGlobalReviewPolicyMode = ToolAuthorizationMode;
export type {
  ToolAuthorizationMode,
  ToolAuthorizationSafetyLevel,
} from '@pinpawo/agent-contracts';

export const BUILTIN_GLOBAL_REVIEW_POLICY_MODES = {
  require_authorization: true,
  auto_authorization: true,
  full_access: true,
} as const satisfies Record<BuiltinGlobalReviewPolicyMode, true>;

export {
  isHumanReviewRequest as isAgentReviewSpecValue,
  parseTokenUsageSnapshot as parseAgentTokenUsageSnapshot,
};

export function isAgentTokenUsageSnapshot(
  value: unknown,
): value is TokenUsageSnapshot {
  return parseTokenUsageSnapshot(value) !== null;
}

export function isBuiltinGlobalReviewPolicyMode(
  value: unknown,
): value is BuiltinGlobalReviewPolicyMode {
  return isToolAuthorizationMode(value);
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
