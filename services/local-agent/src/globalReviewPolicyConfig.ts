import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';
import type { ToolAuthorizationSafetyLevel } from '@pinpawo/agent-contracts';
import { setConfig } from './config';
import {
  loadStoredConfig,
  saveStoredConfig,
} from './storage';

/**
 * Persist the process-wide review policy at the host boundary. Independent
 * clients request the change through the shared protocol and never reach into
 * local-agent storage directly.
 */
export function persistGlobalReviewPolicyMode(
  mode: BuiltinGlobalReviewPolicyMode,
  safetyLevel: ToolAuthorizationSafetyLevel,
) {
  saveStoredConfig({
    ...loadStoredConfig(),
    global_review_policy: mode,
    auto_authorization_safety_level: safetyLevel,
  });
  setConfig({
    globalReviewPolicyMode: mode,
    autoAuthorizationSafetyLevel: safetyLevel,
  });
}
