import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';
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
) {
  saveStoredConfig({
    ...loadStoredConfig(),
    global_review_policy: mode,
  });
  setConfig({ globalReviewPolicyMode: mode });
}
