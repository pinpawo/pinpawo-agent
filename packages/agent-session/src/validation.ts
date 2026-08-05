import type {
  BuiltinGlobalReviewPolicyMode,
  TokenUsageSnapshot,
} from '@pinpawo/pet-agent';
import type { AgentPlan } from './domain';
import {
  isReviewSpecValue,
  parseTokenUsageSnapshot,
} from '@pinpawo/pet-agent/protocol-validation';

export type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';

export const BUILTIN_GLOBAL_REVIEW_POLICY_MODES = {
  require_authorization: true,
  auto_authorization: true,
  full_access: true,
} as const satisfies Record<BuiltinGlobalReviewPolicyMode, true>;

export {
  isReviewSpecValue as isAgentReviewSpecValue,
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
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(
      BUILTIN_GLOBAL_REVIEW_POLICY_MODES,
      value,
    );
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
