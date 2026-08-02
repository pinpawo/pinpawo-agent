export const PROTOCOL_VERSION = 3;
export const NATIVE_HOST_NAME = 'com.pinpawo.browser_bridge';
export const CAPABILITIES = [
  'navigate',
  'snapshot',
  'click',
  'type',
  'scroll',
  'wait',
  'extract',
  'screenshot',
  'detach',
];

export function parseBrowserCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('browser command must be an object');
  }
  if (value.type !== 'browser.command' || value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('unsupported browser command protocol');
  }
  for (const key of ['connectionId', 'requestId', 'deadlineAt']) {
    if (typeof value[key] !== 'string' || !value[key]) {
      throw new Error(`browser command ${key} must be a non-empty string`);
    }
  }
  if (!CAPABILITIES.includes(value.command)) {
    throw new Error(`unsupported browser command: ${String(value.command)}`);
  }
  if (!value.params || typeof value.params !== 'object' || Array.isArray(value.params)) {
    throw new Error('browser command params must be an object');
  }
  if (Number.isNaN(Date.parse(value.deadlineAt))) {
    throw new Error('browser command deadlineAt must be an ISO timestamp');
  }
  return value;
}

export function parseBrowserCancel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('browser cancel must be an object');
  }
  if (value.type !== 'browser.cancel' || value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('unsupported browser cancel protocol');
  }
  for (const key of ['connectionId', 'requestId']) {
    if (typeof value[key] !== 'string' || !value[key]) {
      throw new Error(`browser cancel ${key} must be a non-empty string`);
    }
  }
  return value;
}

export function successResult(command, result) {
  return {
    type: 'browser.result',
    protocolVersion: PROTOCOL_VERSION,
    connectionId: command.connectionId,
    requestId: command.requestId,
    ok: true,
    result,
  };
}

export function errorResult(command, error) {
  return {
    type: 'browser.result',
    protocolVersion: PROTOCOL_VERSION,
    connectionId: command.connectionId,
    requestId: command.requestId,
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'browser_extension_error',
      message: error instanceof Error ? error.message : String(error),
      retryable: error?.retryable === true,
      ...(error?.details && typeof error.details === 'object'
        ? { details: error.details }
        : {}),
    },
  };
}
