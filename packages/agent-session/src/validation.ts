import type {
  BuiltinGlobalReviewPolicyMode,
  TokenUsageSnapshot,
} from '@pinpawo/pet-agent';
import {
  isReviewSpecValue,
  parseTokenUsageSnapshot,
} from '@pinpawo/pet-agent/protocol-validation';

const BUILTIN_GLOBAL_REVIEW_POLICY_MODES = {
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
