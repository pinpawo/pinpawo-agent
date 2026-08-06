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

export type AgentConfig = {
  toolAuthorization?: {
    mode: ToolAuthorizationMode;
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

function parseToolAuthorization(value: unknown): AgentConfig['toolAuthorization'] | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['mode'])) return null;
  return isToolAuthorizationMode(value.mode) ? { mode: value.mode } : null;
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
