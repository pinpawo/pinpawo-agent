import { hostConfiguration, type HostConfigurationPort } from '../persistence/configuration';
import type { ToolAuthorizationSafetyLevel, ToolAuthorizationMode } from '@pinpawo/agent-contracts';
import { setConfig } from './config';
import {
  loadStoredConfig,
  saveStoredConfig,
} from '../storage';

/**
 * Persist the process-wide review policy at the host boundary. Independent
 * clients request the change through the shared protocol and never reach into
 * host storage directly.
 */
export async function persistGlobalReviewPolicyMode(
  mode: ToolAuthorizationMode,
  safetyLevel: ToolAuthorizationSafetyLevel,
  configuration: HostConfigurationPort = hostConfiguration,
) {
  await saveStoredConfig({
    ...await loadStoredConfig(configuration),
    global_review_policy: mode,
    auto_authorization_safety_level: safetyLevel,
  }, configuration);
  setConfig({
    globalReviewPolicyMode: mode,
    autoAuthorizationSafetyLevel: safetyLevel,
  });
}
