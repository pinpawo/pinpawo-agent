import type { JsonRecord } from './types.js';

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

export type BrowserCapability = typeof CAPABILITIES[number];
export type BrowserCommandParams = Record<string, any>;

export interface BrowserCommand {
  type: 'browser.command';
  protocolVersion: typeof PROTOCOL_VERSION;
  connectionId: string;
  requestId: string;
  deadlineAt: string;
  command: BrowserCapability;
  params: BrowserCommandParams;
}

type BrowserCommandIdentity = Pick<BrowserCommand, 'connectionId' | 'requestId'>;

export interface BrowserCancel {
  type: 'browser.cancel';
  protocolVersion: typeof PROTOCOL_VERSION;
  connectionId: string;
  requestId: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseBrowserCommand(value: unknown): BrowserCommand {
  if (!isRecord(value)) {
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
  if (typeof value.command !== 'string' || !CAPABILITIES.includes(value.command as BrowserCapability)) {
    throw new Error(`unsupported browser command: ${String(value.command)}`);
  }
  if (!value.params || typeof value.params !== 'object' || Array.isArray(value.params)) {
    throw new Error('browser command params must be an object');
  }
  if (Number.isNaN(Date.parse(value.deadlineAt as string))) {
    throw new Error('browser command deadlineAt must be an ISO timestamp');
  }
  return value as unknown as BrowserCommand;
}

export function parseBrowserCancel(value: unknown): BrowserCancel {
  if (!isRecord(value)) {
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
  return value as unknown as BrowserCancel;
}

export function successResult(command: BrowserCommandIdentity, result: unknown) {
  return {
    type: 'browser.result',
    protocolVersion: PROTOCOL_VERSION,
    connectionId: command.connectionId,
    requestId: command.requestId,
    ok: true,
    result,
  };
}

export function errorResult(command: BrowserCommandIdentity, error: unknown) {
  const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
  return {
    type: 'browser.result',
    protocolVersion: PROTOCOL_VERSION,
    connectionId: command.connectionId,
    requestId: command.requestId,
    ok: false,
    error: {
      code: isRecord(error) && typeof error.code === 'string' ? error.code : 'browser_extension_error',
      message: error instanceof Error ? error.message : String(error),
      retryable: isRecord(error) && error.retryable === true,
      ...(details
        ? { details }
        : {}),
    },
  };
}
