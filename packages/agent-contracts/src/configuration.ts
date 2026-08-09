import {
  hasOnlyKeys,
  isJsonObject,
} from './json';

/**
 * The externally configurable authorization posture for tools. Resolution,
 * custom policy callbacks, and any model-assisted review stay in the runtime.
 */
export const TOOL_AUTHORIZATION_MODES = {
  require_authorization: true,
  auto_authorization: true,
  full_access: true,
} as const;

export type ToolAuthorizationMode = keyof typeof TOOL_AUTHORIZATION_MODES;

/**
 * The review threshold used when tool authorization is automatic. Every
 * level remains subject to the runtime's non-negotiable human-review rules.
 */
export const TOOL_AUTHORIZATION_SAFETY_LEVELS = {
  strict: true,
  relaxed: true,
} as const;

export type ToolAuthorizationSafetyLevel = keyof typeof TOOL_AUTHORIZATION_SAFETY_LEVELS;

export const DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL: ToolAuthorizationSafetyLevel = 'strict';

export type AgentConfig = {
  toolAuthorization?: {
    mode: ToolAuthorizationMode;
    safetyLevel?: ToolAuthorizationSafetyLevel;
  };
};

export type AgentConfigUpdate = AgentConfig;

/** Effective config observed by a caller after host/runtime defaults resolve. */
export type AgentConfigSnapshot = {
  config: AgentConfig;
};

export function isToolAuthorizationMode(value: unknown): value is ToolAuthorizationMode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(TOOL_AUTHORIZATION_MODES, value);
}

export function isToolAuthorizationSafetyLevel(
  value: unknown,
): value is ToolAuthorizationSafetyLevel {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(TOOL_AUTHORIZATION_SAFETY_LEVELS, value);
}

function parseToolAuthorization(value: unknown): AgentConfig['toolAuthorization'] | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['mode', 'safetyLevel'])) return null;
  if (!isToolAuthorizationMode(value.mode)) return null;
  if (value.safetyLevel !== undefined && !isToolAuthorizationSafetyLevel(value.safetyLevel)) {
    return null;
  }
  return {
    mode: value.mode,
    ...(value.safetyLevel !== undefined ? { safetyLevel: value.safetyLevel } : {}),
  };
}

export function parseAgentConfig(value: unknown): AgentConfig | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['toolAuthorization'])) return null;
  if (value.toolAuthorization === undefined) return {};
  const toolAuthorization = parseToolAuthorization(value.toolAuthorization);
  return toolAuthorization ? { toolAuthorization } : null;
}

export function isAgentConfig(value: unknown): value is AgentConfig {
  return parseAgentConfig(value) !== null;
}

export function parseAgentConfigSnapshot(value: unknown): AgentConfigSnapshot | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['config'])) return null;
  const config = parseAgentConfig(value.config);
  return config ? { config } : null;
}

export function isAgentConfigSnapshot(value: unknown): value is AgentConfigSnapshot {
  return parseAgentConfigSnapshot(value) !== null;
}
