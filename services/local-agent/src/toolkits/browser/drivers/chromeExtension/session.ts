import type {
  BrowserElementTarget,
  BrowserOpenOptions,
  BrowserScrollOptions,
  BrowserWaitState,
} from '../../session';
import {
  buildBrowserExtractPayloadFromRaw,
  buildBrowserSnapshotPayload,
  normalizeBrowserExtractOptions,
  parseBrowserRawExtract,
  parseBrowserRawSnapshot,
  type BrowserExtractOptions,
} from '../../snapshotPayload';
import {
  BrowserBridgeError,
  localAgentBrowserBridge,
  type LocalAgentBrowserBridge,
  type BrowserBridgeStatus,
} from './bridge';
import { persistBrowserScreenshot } from '../../screenshot';
import { BrowserOperationError } from '../../errors';

const DEFAULT_SESSION = 'default';
const DEFAULT_EXTENSION_COMMAND_TIMEOUT_MS = 30_000;
const MAX_EXTENSION_TYPE_TIMEOUT_MS = 300_000;
const HUMANIZED_TYPE_CHARACTER_LIMIT = 500;
const TRUSTED_INSERT_CHUNK_CHARACTERS = 2_000;

function extensionTypeCommandTimeoutMs(text: string): number {
  const characterCount = Array.from(text).length;
  const estimatedMs = characterCount <= HUMANIZED_TYPE_CHARACTER_LIMIT
    ? 15_000 + characterCount * 150
    : 30_000 + Math.ceil(characterCount / TRUSTED_INSERT_CHUNK_CHARACTERS) * 100;
  return Math.min(
    MAX_EXTENSION_TYPE_TIMEOUT_MS,
    Math.max(DEFAULT_EXTENSION_COMMAND_TIMEOUT_MS, estimatedMs),
  );
}

function approvedOriginFor(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Chrome extension browser backend only supports http:// and https:// URLs.');
  }
  return parsed.origin;
}

function normalizeTarget(target: string | BrowserElementTarget): BrowserElementTarget {
  const normalized = typeof target === 'string' ? { selector: target.trim() } : {
    selector: target.selector?.trim(),
    ref: target.ref?.trim(),
  };
  if ((normalized.selector ? 1 : 0) + (normalized.ref ? 1 : 0) !== 1) {
    throw new Error('browser element target requires exactly one of selector or ref');
  }
  return normalized;
}

export class ChromeExtensionBrowserSession {
  private approvedOrigin: string | null = null;

  constructor(
    private readonly bridge: Pick<LocalAgentBrowserBridge, 'sendCommand'>
      & Partial<Pick<LocalAgentBrowserBridge, 'getStatus'>> = localAgentBrowserBridge,
  ) {}

  private userBoundOrigin(): string | null {
    const status = this.bridge.getStatus?.() as BrowserBridgeStatus | undefined;
    if (status?.activeTabOwnership !== 'user' || !status.userBoundOrigin) return null;
    try {
      const origin = approvedOriginFor(status.userBoundOrigin);
      return origin === status.userBoundOrigin ? origin : null;
    } catch {
      return null;
    }
  }

  private validateOpenOptions(opts: BrowserOpenOptions) {
    if (opts.headless === true) {
      throw new Error('Chrome extension backend uses visible Chrome tabs and does not support headless mode.');
    }
    if (opts.userDataDir) {
      throw new Error('Chrome extension backend cannot select a Chrome user-data-dir.');
    }
    if (opts.session && opts.session !== DEFAULT_SESSION) {
      throw new Error('Chrome extension backend does not support named browser sessions.');
    }
  }

  private buildSnapshot(value: unknown, approvedOrigin: string): string {
    const snapshot = parseBrowserRawSnapshot(value);
    let snapshotOrigin: string;
    try {
      snapshotOrigin = approvedOriginFor(snapshot.url);
    } catch {
      throw new BrowserBridgeError(
        'origin_changed',
        'Chrome extension returned a snapshot without an approved http(s) URL.',
        false,
        { approvedOrigin },
      );
    }
    if (snapshotOrigin !== approvedOrigin) {
      throw new BrowserBridgeError(
        'origin_changed',
        `Chrome extension snapshot origin changed from ${approvedOrigin} to ${snapshotOrigin}.`,
        false,
        { approvedOrigin, actualOrigin: snapshotOrigin },
      );
    }
    return JSON.stringify(buildBrowserSnapshotPayload(snapshot), null, 2);
  }

  private requireApprovedOrigin(): string {
    const userBoundOrigin = this.userBoundOrigin();
    if (userBoundOrigin) {
      this.approvedOrigin = userBoundOrigin;
      return userBoundOrigin;
    }
    if (!this.approvedOrigin) {
      throw new BrowserOperationError(
        'browser_not_open',
        'No approved Chrome extension page. Use browser_open first or click the extension action on the tab to bind it.',
        true,
      );
    }
    return this.approvedOrigin;
  }

  async open(url: string, opts: BrowserOpenOptions = {}): Promise<string> {
    this.validateOpenOptions(opts);
    const approvedOrigin = approvedOriginFor(url);
    const raw = await this.bridge.sendCommand('navigate', {
      url,
      approvedOrigin,
    });
    const snapshot = this.buildSnapshot(raw, approvedOrigin);
    this.approvedOrigin = approvedOrigin;
    return snapshot;
  }

  async snapshot(): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.buildSnapshot(await this.bridge.sendCommand('snapshot', {
      approvedOrigin,
    }), approvedOrigin);
  }

  async click(target: string | BrowserElementTarget): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.buildSnapshot(await this.bridge.sendCommand('click', {
      approvedOrigin,
      target: normalizeTarget(target),
    }), approvedOrigin);
  }

  async type(target: string | BrowserElementTarget, text: string, submit = false): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.buildSnapshot(await this.bridge.sendCommand('type', {
      approvedOrigin,
      target: normalizeTarget(target),
      text,
      submit,
    }, extensionTypeCommandTimeoutMs(text)), approvedOrigin);
  }

  async scroll(options: BrowserScrollOptions = {}): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.buildSnapshot(await this.bridge.sendCommand('scroll', {
      approvedOrigin,
      deltaX: options.deltaX ?? 0,
      deltaY: options.deltaY ?? 600,
      ...(options.target ? { target: normalizeTarget(options.target) } : {}),
    }), approvedOrigin);
  }

  async wait(
    target?: string | BrowserElementTarget,
    timeoutMs = 3_000,
    state: BrowserWaitState = 'visible',
  ): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.buildSnapshot(await this.bridge.sendCommand('wait', {
      approvedOrigin,
      timeoutMs,
      state,
      ...(target ? { target: normalizeTarget(target) } : {}),
    }), approvedOrigin);
  }

  async extract(options: BrowserExtractOptions = {}): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    const window = normalizeBrowserExtractOptions(options);
    const raw = parseBrowserRawExtract(await this.bridge.sendCommand('extract', {
      approvedOrigin,
      selector: options.selector,
      ...window,
    }));
    if (approvedOriginFor(raw.url) !== approvedOrigin) {
      throw new BrowserBridgeError(
        'origin_changed',
        `Chrome extension extract origin changed from ${approvedOrigin} to ${approvedOriginFor(raw.url)}.`,
      );
    }
    return JSON.stringify(buildBrowserExtractPayloadFromRaw(raw), null, 2);
  }

  async screenshot(): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    const value = await this.bridge.sendCommand('screenshot', { approvedOrigin });
    if (
      !value
      || typeof value !== 'object'
      || (value as Record<string, unknown>).mimeType !== 'image/jpeg'
      || typeof (value as Record<string, unknown>).data !== 'string'
    ) {
      throw new Error('Chrome extension returned an invalid screenshot');
    }
    return persistBrowserScreenshot({
      mimeType: 'image/jpeg',
      data: (value as Record<string, string>).data,
    });
  }

  async close(): Promise<string> {
    this.approvedOrigin = null;
    const result = await this.bridge.sendCommand('detach', {});
    return `Chrome extension browser detached: ${JSON.stringify(result)}`;
  }

  listSessions(): string[] {
    return [];
  }
}
