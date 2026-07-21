import type { BrowserOpenOptions } from '../../session';
import {
  buildBrowserSnapshotPayload,
  parseBrowserRawSnapshot,
  type BrowserExtractOptions,
} from '../../snapshotPayload';
import {
  BrowserBridgeError,
  localAgentBrowserBridge,
  type LocalAgentBrowserBridge,
} from './bridge';

const DEFAULT_SESSION = 'default';

function approvedOriginFor(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Chrome extension browser backend only supports http:// and https:// URLs.');
  }
  return parsed.origin;
}

function unsupportedExtensionOperation(operation: string): never {
  throw new Error(
    `Chrome extension backend P0 does not support ${operation}; use navigate, snapshot or close/detach.`,
  );
}

export class ChromeExtensionBrowserSession {
  private approvedOrigin: string | null = null;

  constructor(
    private readonly bridge: Pick<LocalAgentBrowserBridge, 'sendCommand'> = localAgentBrowserBridge,
  ) {}

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
      );
    }
    if (snapshotOrigin !== approvedOrigin) {
      throw new BrowserBridgeError(
        'origin_changed',
        `Chrome extension snapshot origin changed from ${approvedOrigin} to ${snapshotOrigin}.`,
      );
    }
    return JSON.stringify(buildBrowserSnapshotPayload(snapshot), null, 2);
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
    if (!this.approvedOrigin) {
      throw new Error('No approved Chrome extension page. Use browser_open first.');
    }
    return this.buildSnapshot(await this.bridge.sendCommand('snapshot', {
      approvedOrigin: this.approvedOrigin,
    }), this.approvedOrigin);
  }

  async click(_selector: string): Promise<string> {
    return unsupportedExtensionOperation('click');
  }

  async type(_selector: string, _text: string, _submit = false): Promise<string> {
    return unsupportedExtensionOperation('type');
  }

  async wait(_selector?: string, _timeoutMs = 3_000): Promise<string> {
    return unsupportedExtensionOperation('wait');
  }

  async extract(_options: BrowserExtractOptions = {}): Promise<string> {
    return unsupportedExtensionOperation('extract');
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
