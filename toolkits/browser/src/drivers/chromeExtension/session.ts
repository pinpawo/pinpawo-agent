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
  type BrowserExtensionBridge,
  type BrowserBridgeStatus,
} from './bridge';
import { persistBrowserScreenshot } from '../../screenshot';
import { BrowserOperationError } from '../../errors';
import { BrowserLifecycleController } from '../../lifecycle/controller';
import {
  OPEN_READINESS_DEADLINE_MS,
  driveOpenReadiness,
} from '../../lifecycle/openReadiness';
import type { BrowserRuntimeEvent } from '../../lifecycle/events';
import type { NavigationPhase } from '../../lifecycle/navigation';

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

  private readinessPhase: NavigationPhase | null = null;

  /** Readiness phase reached by the most recent `open()` (null before any open
   *  or when the last open did not reach a terminated navigation). Exposed for
   *  tests and instrumentation (issue #583 review M2). */
  get lastReadinessPhase(): NavigationPhase | null {
    return this.readinessPhase;
  }

  constructor(
    private readonly bridge: Pick<BrowserExtensionBridge, 'sendCommand'>
      & Partial<Pick<BrowserExtensionBridge, 'getStatus' | 'onRuntimeEvent' | 'onGenerationChanged'>>,
    private readonly workdir: () => string = () => process.cwd(),
  ) {}

  private userBoundOrigin(): string | null {
    const status = this.bridge.getStatus?.() as BrowserBridgeStatus | undefined;
    if (status?.activeTabBinding !== 'user' || !status.userBoundOrigin) return null;
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
    if (userBoundOrigin) return userBoundOrigin;
    if (!this.approvedOrigin) {
      throw new BrowserOperationError(
        'browser_not_open',
        'No approved Chrome extension page. Use browser_open first or click the extension action on the tab to bind it.',
        true,
      );
    }
    return this.approvedOrigin;
  }

  async open(
    url: string,
    opts: BrowserOpenOptions = {},
    signal?: AbortSignal,
  ): Promise<string> {
    this.validateOpenOptions(opts);
    const approvedOrigin = approvedOriginFor(url);
    return this.openAndAwaitReadiness(url, approvedOrigin, signal);
  }

  /**
   * Issue a navigation and drive it to `readable` through the Runtime lifecycle
   * state machine (issue #583). The extension reports the raw page lifecycle
   * events (`navigation.committed`, `document.ready`, `dom.changed`); this
   * session buffers them while the navigate command is in flight, then replays
   * them through a `BrowserLifecycleController` bound to the bridge's own
   * generation so a late or cross-origin result is surfaced deterministically
   * instead of only trusting the extension's `tab.status` polling.
   *
   * Backward compatible: when the page has not yet produced readable events
   * (still hydrating), the navigate command that already returned a snapshot is
   * still honored and the snapshot is returned — we do not regress a working
   * open into a timeout. When the events do show the page ready, cross-origin,
   * or the readiness deadline ultimately elapses, we surface the corresponding
   * structured error.
   */
  private async openAndAwaitReadiness(
    url: string,
    approvedOrigin: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const controller = new BrowserLifecycleController();
    const buffered: BrowserRuntimeEvent[] = [];
    const offEvents =
      this.bridge.onRuntimeEvent?.((event) => buffered.push(event)) ?? (() => {});
    const offGenerations =
      this.bridge.onGenerationChanged?.((change) => {
        controller.notifyGenerationAdvance(
          change.connectionGeneration,
          change.targetGeneration,
        );
      }) ?? (() => {});
    const startTime = Date.now();
    try {
      const raw = await this.bridge.sendCommand('navigate', {
        url,
        approvedOrigin,
      }, undefined, signal);
      const snapshot = this.buildSnapshot(raw, approvedOrigin);

      // Bind the controller to the bridge's authoritative generations (the
      // navigate dispatch already advanced the navigation generation). The
      // bridge stamps navigation-scoped events with the same generation, so
      // `isEventCurrent` drops any late/superseded event during replay.
      const status = this.bridge.getStatus?.() as BrowserBridgeStatus | undefined;
      controller.beginNavigation(
        url,
        approvedOrigin,
        status?.connectionGeneration ?? 1,
        status?.targetGeneration ?? 1,
        status?.navigationGeneration,
      );

      // The navigate round-trip usually emits a tightly grouped burst of events
      // (navigation.committed, document.ready, dom.changed) stamped ~same time.
      // Polling after *every* buffered event would re-run `advanceSettling` and
      // reset the network-settle baseline on each poll, so the final poll's
      // `now` equals the baseline it just wrote (delta 0 < settling window) and
      // the navigation never reaches `readable` (issue #583 review M1).
      // Poll once, after the last buffered event, so the readiness verdict is
      // evaluated against the fully-assembled state rather than mid-burst.
      const last = buffered[buffered.length - 1];
      const outcome = driveOpenReadiness(controller, buffered, startTime, {
        now: () => Date.now(),
        deadlineMs: OPEN_READINESS_DEADLINE_MS,
        shouldPoll: (event) => event === last,
      });

      this.readinessPhase = outcome.snapshot.navigation?.phase ?? null;

      if (outcome.status === 'failed') {
        throw this.readinessFailure(outcome.error, approvedOrigin);
      }
      if (outcome.status === 'timed_out') {
        throw new BrowserOperationError(
          'navigation_timeout',
          `Page did not become readable within ${OPEN_READINESS_DEADLINE_MS}ms of navigation to ${url}.`,
          true,
        );
      }
      if (outcome.status === 'pending') {
        // The events emitted during the navigate round-trip did not conclude the
        // page (still hydrating, body text not sampled yet). This is the
        // backward-compatible path: honor the already-returned snapshot instead
        // of regressing a working open into a timeout. The caller can re-poll.
        this.approvedOrigin = approvedOrigin;
        return snapshot;
      }

      this.approvedOrigin = approvedOrigin;
      return snapshot;
    } finally {
      offEvents();
      offGenerations();
    }
  }

  private readinessFailure(
    error: { code: string; message: string; retryable?: boolean; details?: unknown },
    approvedOrigin: string,
  ): Error {
    if (error.code === 'origin_changed') {
      return new BrowserBridgeError(error.code, error.message, false, {
        approvedOrigin,
        ...(error.details && typeof error.details === 'object'
          ? (error.details as Record<string, unknown>)
          : {}),
      });
    }
    return new BrowserBridgeError(
      error.code,
      error.message,
      error.retryable ?? false,
      error.details ? { approvedOrigin, ...(error.details as Record<string, unknown>) } : { approvedOrigin },
    );
  }

  async snapshot(signal?: AbortSignal): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.buildSnapshot(await this.bridge.sendCommand('snapshot', {
      approvedOrigin,
    }, undefined, signal), approvedOrigin);
  }

  async click(target: string | BrowserElementTarget, signal?: AbortSignal): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.buildSnapshot(await this.bridge.sendCommand('click', {
      approvedOrigin,
      target: normalizeTarget(target),
    }, undefined, signal), approvedOrigin);
  }

  async type(
    target: string | BrowserElementTarget,
    text: string,
    submit = false,
    signal?: AbortSignal,
  ): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.buildSnapshot(await this.bridge.sendCommand('type', {
      approvedOrigin,
      target: normalizeTarget(target),
      text,
      submit,
    }, extensionTypeCommandTimeoutMs(text), signal), approvedOrigin);
  }

  async scroll(options: BrowserScrollOptions = {}, signal?: AbortSignal): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.buildSnapshot(await this.bridge.sendCommand('scroll', {
      approvedOrigin,
      deltaX: options.deltaX ?? 0,
      deltaY: options.deltaY ?? 600,
      ...(options.target ? { target: normalizeTarget(options.target) } : {}),
    }, undefined, signal), approvedOrigin);
  }

  async wait(
    target?: string | BrowserElementTarget,
    timeoutMs = 3_000,
    state: BrowserWaitState = 'visible',
    signal?: AbortSignal,
  ): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.buildSnapshot(await this.bridge.sendCommand('wait', {
      approvedOrigin,
      timeoutMs,
      state,
      ...(target ? { target: normalizeTarget(target) } : {}),
    }, undefined, signal), approvedOrigin);
  }

  async extract(options: BrowserExtractOptions = {}, signal?: AbortSignal): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    const window = normalizeBrowserExtractOptions(options);
    const raw = parseBrowserRawExtract(await this.bridge.sendCommand('extract', {
      approvedOrigin,
      selector: options.selector,
      ...window,
    }, undefined, signal));
    if (approvedOriginFor(raw.url) !== approvedOrigin) {
      throw new BrowserBridgeError(
        'origin_changed',
        `Chrome extension extract origin changed from ${approvedOrigin} to ${approvedOriginFor(raw.url)}.`,
      );
    }
    return JSON.stringify(buildBrowserExtractPayloadFromRaw(raw), null, 2);
  }

  async screenshot(signal?: AbortSignal): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    const value = await this.bridge.sendCommand('screenshot', { approvedOrigin }, undefined, signal);
    if (
      !value
      || typeof value !== 'object'
      || (value as Record<string, unknown>).mimeType !== 'image/jpeg'
      || typeof (value as Record<string, unknown>).data !== 'string'
    ) {
      throw new Error('Chrome extension returned an invalid screenshot');
    }
    return persistBrowserScreenshot(
      {
        mimeType: 'image/jpeg',
        data: (value as Record<string, string>).data,
      },
      this.workdir(),
    );
  }

  async close(signal?: AbortSignal): Promise<string> {
    this.approvedOrigin = null;
    const result = await this.bridge.sendCommand('detach', {}, undefined, signal);
    return `Chrome extension browser detached: ${JSON.stringify(result)}`;
  }

  listSessions(): string[] {
    return [];
  }
}
