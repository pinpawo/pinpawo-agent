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
export function persistToolAuthorizationMode(
  mode: ToolAuthorizationMode,
  safetyLevel: ToolAuthorizationSafetyLevel,
) {
  saveStoredConfig({
    ...loadStoredConfig(),
    global_review_policy: mode,
    auto_authorization_safety_level: safetyLevel,
  });
  setConfig({
    toolAuthorizationMode: mode,
    autoAuthorizationSafetyLevel: safetyLevel,
  });
}
