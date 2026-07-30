export const BROWSER_EXTENSION_PROTOCOL_VERSION = 2 as const;
export const BROWSER_NATIVE_HOST_NAME = 'com.pinpawo.browser_bridge';

export const BROWSER_EXTENSION_CAPABILITIES = [
  'navigate',
  'snapshot',
  'click',
  'type',
  'scroll',
  'wait',
  'extract',
  'screenshot',
  'detach',
] as const;

export type BrowserExtensionCapability = typeof BROWSER_EXTENSION_CAPABILITIES[number];
export type BrowserExtensionCommandName = BrowserExtensionCapability;

export type BrowserExtensionError = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

export type BrowserExtensionStateSnapshot = {
  revision: number;
  debuggerAttached: boolean;
  activeTab?: {
    tabId: number;
    ownership: 'agent' | 'user';
  };
};

export type BrowserRegisterMessage = {
  type: 'browser.register';
  protocolVersion: typeof BROWSER_EXTENSION_PROTOCOL_VERSION;
  connectionId: string;
  extensionId: string;
  capabilities: BrowserExtensionCapability[];
  activeTab?: {
    tabId: number;
    ownership: 'agent' | 'user';
  };
  state?: BrowserExtensionStateSnapshot;
};

export type BrowserCommandMessage = {
  type: 'browser.command';
  protocolVersion: typeof BROWSER_EXTENSION_PROTOCOL_VERSION;
  connectionId: string;
  requestId: string;
  command: BrowserExtensionCommandName;
  deadlineAt: string;
  params: Record<string, unknown>;
};

export type BrowserResultMessage = {
  type: 'browser.result';
  protocolVersion: typeof BROWSER_EXTENSION_PROTOCOL_VERSION;
  connectionId: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: BrowserExtensionError;
};

export type BrowserEventMessage = {
  type: 'browser.event';
  protocolVersion: typeof BROWSER_EXTENSION_PROTOCOL_VERSION;
  connectionId: string;
  event: 'debugger.attached' | 'debugger.detached' | 'target.closed' | 'tab.navigated';
  tabId?: number;
  url?: string;
  reason?: string;
};

export type ExtensionToAgentMessage =
  | BrowserRegisterMessage
  | BrowserResultMessage
  | BrowserEventMessage;

export type AgentToExtensionMessage = BrowserCommandMessage;

export type BridgeHelloMessage = {
  type: 'bridge.hello';
  protocolVersion: typeof BROWSER_EXTENSION_PROTOCOL_VERSION;
  token: string;
  hostPid: number;
};

export type BridgeReadyMessage = {
  type: 'bridge.ready';
  protocolVersion: typeof BROWSER_EXTENSION_PROTOCOL_VERSION;
};

export type BridgeErrorMessage = {
  type: 'bridge.error';
  protocolVersion: typeof BROWSER_EXTENSION_PROTOCOL_VERSION;
  error: BrowserExtensionError;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readProtocolRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('browser extension message must be an object');
  }
  if (value.protocolVersion !== BROWSER_EXTENSION_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported browser extension protocol version: ${String(value.protocolVersion)}`,
    );
  }
  return value;
}

function requireNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`browser extension message ${key} must be a non-empty string`);
  }
  return value;
}

function parseCapabilities(value: unknown): BrowserExtensionCapability[] {
  if (!Array.isArray(value)) {
    throw new Error('browser.register capabilities must be an array');
  }
  const allowed = new Set<string>(BROWSER_EXTENSION_CAPABILITIES);
  const capabilities = value.map((item) => {
    if (typeof item !== 'string' || !allowed.has(item)) {
      throw new Error(`unsupported browser extension capability: ${String(item)}`);
    }
    return item as BrowserExtensionCapability;
  });
  return [...new Set(capabilities)];
}

function parseError(value: unknown): BrowserExtensionError {
  if (!isRecord(value)) {
    throw new Error('browser.result error must be an object');
  }
  const code = requireNonEmptyString(value, 'code');
  const message = requireNonEmptyString(value, 'message');
  if (value.retryable !== undefined && typeof value.retryable !== 'boolean') {
    throw new Error('browser.result error.retryable must be a boolean');
  }
  if (value.details !== undefined && !isRecord(value.details)) {
    throw new Error('browser.result error.details must be an object');
  }
  return {
    code,
    message,
    retryable: value.retryable as boolean | undefined,
    details: value.details as Record<string, unknown> | undefined,
  };
}

function parseActiveTab(
  value: unknown,
  field = 'activeTab',
): BrowserRegisterMessage['activeTab'] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Number.isInteger(value.tabId) || (value.tabId as number) < 0) {
    throw new Error(`browser.register ${field}.tabId must be a non-negative integer`);
  }
  if (value.ownership !== 'agent' && value.ownership !== 'user') {
    throw new Error(`browser.register ${field}.ownership must be agent or user`);
  }
  return {
    tabId: value.tabId as number,
    ownership: value.ownership,
  };
}

function parseStateSnapshot(value: unknown): BrowserExtensionStateSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('browser.register state must be an object');
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error('browser.register state.revision must be a non-negative safe integer');
  }
  if (typeof value.debuggerAttached !== 'boolean') {
    throw new Error('browser.register state.debuggerAttached must be a boolean');
  }
  const activeTab = parseActiveTab(value.activeTab, 'state.activeTab');
  if (value.debuggerAttached && !activeTab) {
    throw new Error('browser.register state cannot attach the debugger without an active tab');
  }
  return {
    revision: value.revision as number,
    debuggerAttached: value.debuggerAttached,
    activeTab,
  };
}

export function parseExtensionToAgentMessage(value: unknown): ExtensionToAgentMessage {
  const record = readProtocolRecord(value);
  const type = record.type;
  const connectionId = requireNonEmptyString(record, 'connectionId');

  if (type === 'browser.register') {
    const activeTab = parseActiveTab(record.activeTab);
    const state = parseStateSnapshot(record.state);
    if (
      activeTab
      && state
      && (
        !state.activeTab
        || activeTab.tabId !== state.activeTab.tabId
        || activeTab.ownership !== state.activeTab.ownership
      )
    ) {
      throw new Error('browser.register activeTab must match state.activeTab');
    }
    return {
      type,
      protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
      connectionId,
      extensionId: requireNonEmptyString(record, 'extensionId'),
      capabilities: parseCapabilities(record.capabilities),
      activeTab,
      state,
    };
  }

  if (type === 'browser.result') {
    if (typeof record.ok !== 'boolean') {
      throw new Error('browser.result ok must be a boolean');
    }
    const result = {
      type,
      protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
      connectionId,
      requestId: requireNonEmptyString(record, 'requestId'),
      ok: record.ok,
      result: record.result,
      error: record.error === undefined ? undefined : parseError(record.error),
    } satisfies BrowserResultMessage;
    if (result.ok && result.error) {
      throw new Error('successful browser.result must not include error');
    }
    if (!result.ok && !result.error) {
      throw new Error('failed browser.result must include error');
    }
    return result;
  }

  if (type === 'browser.event') {
    const allowedEvents = new Set([
      'debugger.attached',
      'debugger.detached',
      'target.closed',
      'tab.navigated',
    ]);
    if (typeof record.event !== 'string' || !allowedEvents.has(record.event)) {
      throw new Error(`unsupported browser event: ${String(record.event)}`);
    }
    if (record.tabId !== undefined && !Number.isInteger(record.tabId)) {
      throw new Error('browser.event tabId must be an integer');
    }
    if (record.url !== undefined && typeof record.url !== 'string') {
      throw new Error('browser.event url must be a string');
    }
    if (record.reason !== undefined && typeof record.reason !== 'string') {
      throw new Error('browser.event reason must be a string');
    }
    return {
      type,
      protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
      connectionId,
      event: record.event as BrowserEventMessage['event'],
      tabId: record.tabId as number | undefined,
      url: record.url as string | undefined,
      reason: record.reason as string | undefined,
    };
  }

  throw new Error(`unsupported extension message type: ${String(type)}`);
}

export function parseAgentToExtensionMessage(value: unknown): AgentToExtensionMessage {
  const record = readProtocolRecord(value);
  if (record.type !== 'browser.command') {
    throw new Error(`unsupported agent message type: ${String(record.type)}`);
  }
  if (!BROWSER_EXTENSION_CAPABILITIES.includes(record.command as BrowserExtensionCapability)) {
    throw new Error(`unsupported browser command: ${String(record.command)}`);
  }
  if (!isRecord(record.params)) {
    throw new Error('browser.command params must be an object');
  }
  const deadlineAt = requireNonEmptyString(record, 'deadlineAt');
  if (Number.isNaN(Date.parse(deadlineAt))) {
    throw new Error('browser.command deadlineAt must be an ISO timestamp');
  }
  return {
    type: 'browser.command',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: requireNonEmptyString(record, 'connectionId'),
    requestId: requireNonEmptyString(record, 'requestId'),
    command: record.command as BrowserExtensionCommandName,
    deadlineAt,
    params: record.params,
  };
}

export function parseBridgeHelloMessage(value: unknown): BridgeHelloMessage {
  const record = readProtocolRecord(value);
  if (record.type !== 'bridge.hello') {
    throw new Error(`expected bridge.hello, received ${String(record.type)}`);
  }
  if (!Number.isInteger(record.hostPid) || (record.hostPid as number) <= 0) {
    throw new Error('bridge.hello hostPid must be a positive integer');
  }
  return {
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: requireNonEmptyString(record, 'token'),
    hostPid: record.hostPid as number,
  };
}
