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
import type { BrowserExtensionCommandName } from './protocol';
import { persistBrowserScreenshot } from '../../screenshot';
import { BrowserOperationError } from '../../errors';
import { BrowserLifecycleController } from '../../lifecycle/controller';
import {
  OPEN_READINESS_DEADLINE_MS,
} from '../../lifecycle/openReadiness';
import {
  waitForReadiness,
  WAIT_FOR_READINESS_DEADLINE_MS,
  type ReadinessEventSource,
} from '../../lifecycle/waitForReadiness';
import {
  INTERACTION_SETTLE_DEADLINE_MS,
  driveInteractionSettle,
} from '../../lifecycle/interactionSettle';
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

  /** Readiness phase reached by the most recent `open()` or interaction
   *  (`click`/`type`/`scroll`) (null before any, or when the last operation did
   *  not reach a terminated navigation). Exposed for tests and instrumentation
   *  (issue #583 review M2/S1). */
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
   * state machine (issue #583 / #601). The extension now fires-and-forgets
   * navigate (returns immediately without a snapshot), and live CDP events
   * (Page.frameNavigated, Network.*, Page.loadEventFired, tabs.onUpdated)
   * drive the `BrowserLifecycleController` through the bridge. This session
   * uses `waitForReadiness` backed by a `PendingWait` to reach a terminal
   * verdict — `readable`, `failed` (cross-origin / target closed / connection
   * lost), or `timed_out` — instead of trusting `tab.status` polling.
   *
   * Backward compatible: when the bridge is not wired for live events, a
   * blocking snapshot is taken after the navigate returns.
   */
  private async openAndAwaitReadiness(
    url: string,
    approvedOrigin: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // Issue #601: navigate is fire-and-forget — the extension returns
    // { ok: true } immediately and the Runtime owns the readiness wait.
    // Subscribe to the live event stream before dispatching so the
    // controller captures every event from navigation start.
    const controller = new BrowserLifecycleController();
    const source: ReadinessEventSource | undefined =
      this.bridge.onRuntimeEvent && this.bridge.onGenerationChanged
        ? {
            onRuntimeEvent: (listener) => this.bridge.onRuntimeEvent!(listener),
            onGenerationChanged: (listener) => this.bridge.onGenerationChanged!(listener),
          }
        : undefined;

    const wait = source
      ? waitForReadiness(controller, {
          deadlineMs: WAIT_FOR_READINESS_DEADLINE_MS,
          source,
        })
      : null;

    try {
      // Fire-and-forget navigate: the extension returns immediately and
      // live CDP events drive the controller through the bridge.
      const raw = await this.bridge.sendCommand('navigate', {
        url,
        approvedOrigin,
      }, undefined, signal);

      const navigateResult = raw as { ok?: boolean; tabId?: number; url?: string } | undefined;
      if (!navigateResult?.ok) {
        throw new BrowserBridgeError(
          'navigation_failed',
          'extension navigate did not return ok',
          false,
          { approvedOrigin },
        );
      }

      // Bind the controller to the bridge's *post-navigate* generation. The
      // bridge bumps its navigation generation when the `navigate` command is
      // dispatched (`sendCommand('navigate', …)` calls `beginNavigation()`), so
      // events emitted after the navigation are stamped with the bumped value.
      // Binding before the dispatch would tie the controller to the pre-navigate
      // generation and `isEventCurrent` would drop *every* live event as stale,
      // wedging `browser_open` in a 30s timeout (#603 review M1). Reading the
      // status *after* navigate returns the exact generation the live events
      // carry, so the two always agree.
      const status = this.bridge.getStatus?.() as BrowserBridgeStatus | undefined;
      controller.beginNavigation(
        url,
        approvedOrigin,
        status?.connectionGeneration ?? 1,
        status?.targetGeneration ?? 1,
        status?.navigationGeneration,
      );

      // Wait for the live event stream to drive the controller to a terminal
      // state. Without a live source (e.g. bridge not wired), fall back to a
      // blocking snapshot.
      if (!wait) {
        // Backward-compatible: bridge not wired for live events.
        // Take a snapshot and return it.
        const snapshot = await this.bridge.sendCommand('snapshot', {
          approvedOrigin,
        }, undefined, signal);
        const built = this.buildSnapshot(snapshot, approvedOrigin);
        this.approvedOrigin = approvedOrigin;
        return built;
      }

      const result = await wait.finished;
      this.readinessPhase = result.snapshot.navigation?.phase ?? null;

      if (result.status === 'failed') {
        throw this.readinessFailure(result.failure.error, approvedOrigin);
      }
      if (result.status === 'timed_out') {
        const nav = result.snapshot.navigation;
        throw this.readinessTimeoutError(
          url,
          nav?.phase ?? null,
          nav?.committedUrl,
          nav?.readyState,
        );
      }

      // Page is readable: take a fresh snapshot from the live page.
      const snapshot = await this.bridge.sendCommand('snapshot', {
        approvedOrigin,
      }, undefined, signal);
      const built = this.buildSnapshot(snapshot, approvedOrigin);
      this.approvedOrigin = approvedOrigin;
      return built;
    } finally {
      wait?.dispose();
    }
  }

  /**
   * Issue an interaction command (`click` / `type` / `scroll`) and drive the
   * resulting page through the Runtime settle state machine (issue #583, step
   * 4). Mirrors `openAndAwaitReadiness`: the session buffers the page-lifecycle
   * events the extension emits around the interaction, then replays them
   * through a `BrowserLifecycleController` bound to the bridge's *current*
   * navigation generation and classifies how the page settled.
   *
   * Backward compatible: when the interaction did not produce a terminal
   * verdict (`pending`) or started a new navigation (`nav_generation`), the
   * already-returned snapshot is still honored — we do not regress a working
   * interaction into a timeout. A deterministic failure (`failed`) or settle
   * timeout (`timed_out`) surfaces the corresponding structured error.
   *
   * The `nav_generation` outcome's full readiness hand-off is intentionally
   * deferred: the extension has already returned a snapshot of the produced
   * page, and driving that navigation to `readable` is the follow-up once a
   * live navigation event stream lets the Runtime own the wait (see README).
   */
  private async interactAndAwaitSettle(
    command: BrowserExtensionCommandName,
    params: Record<string, unknown>,
    approvedOrigin: string,
    timeoutMs: number | undefined,
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
      const raw = await this.bridge.sendCommand(command, params, timeoutMs, signal);
      const snapshot = this.buildSnapshot(raw, approvedOrigin);

      // Bind the controller to the bridge's *current* navigation generation. An
      // interaction does not dispatch `navigate`, so the counter is unchanged;
      // the settle driver folds the interaction's events into that same
      // generation and flags `nav_generation` when the action starts a new one.
      // The first argument is `approvedOrigin` (not a real requested URL): an
      // interaction has no URL of its own, so we seed `requestedUrl` with the
      // approved origin; `createNavigation` normalizes it and any commit during
      // the interaction is same-origin, so it never mis-classifies.
      const status = this.bridge.getStatus?.() as BrowserBridgeStatus | undefined;
      controller.beginNavigation(
        approvedOrigin,
        approvedOrigin,
        status?.connectionGeneration ?? 1,
        status?.targetGeneration ?? 1,
        status?.navigationGeneration,
      );

      // Poll once, after the last buffered event, so the settle verdict is
      // evaluated against the fully-assembled post-action state rather than
      // re-arming the settle window mid-burst (issue #583 review M1).
      const last = buffered[buffered.length - 1];
      const outcome = driveInteractionSettle(controller, buffered, startTime, {
        now: () => Date.now(),
        deadlineMs: INTERACTION_SETTLE_DEADLINE_MS,
        shouldPoll: (event) => event === last,
      });

      // Expose the phase the post-action page reached, mirroring the `open()`
      // path (#583 review S1). Without this, `lastReadinessPhase` would keep the
      // previous `open()` value after an interaction, which is misleading for
      // debuggers and instrumentation.
      this.readinessPhase = outcome.snapshot.navigation?.phase ?? null;

      if (outcome.status === 'failed') {
        throw this.readinessFailure(outcome.error, approvedOrigin);
      }
      if (outcome.status === 'timed_out') {
        throw new BrowserOperationError(
          'navigation_timeout',
          `Page did not settle within ${INTERACTION_SETTLE_DEADLINE_MS}ms after ${command}.`,
          true,
        );
      }

      // settled / pending / nav_generation: honor the freshly captured snapshot.
      // `nav_generation` means the action started a new navigation; the
      // extension already returned a snapshot of the produced page, so we return
      // it rather than regressing a working interaction into a timeout. Full
      // Runtime-owned readiness for post-action navigation is the follow-up once
      // the extension emits a live navigation event stream.
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

  /** Build a structured `navigation_timeout` (issue #601) that carries the page
   *  state seen at timeout (phase / committed URL / readyState) and guides the
   *  caller toward `browser_wait` instead of a blind retry of a page that is
   *  still loading. */
  private readinessTimeoutError(
    url: string,
    phase: string | null,
    committedUrl: string | undefined,
    readyState: string | undefined,
  ): Error {
    return new BrowserOperationError(
      'navigation_timeout',
      `Page did not become readable within ${OPEN_READINESS_DEADLINE_MS}ms of navigation to ${url}. ` +
        `Page state: phase=${phase}${committedUrl ? `, committedUrl=${committedUrl}` : ''}` +
        `${readyState ? `, readyState=${readyState}` : ''}. ` +
        `Use browser_wait to poll for the page to finish loading.`,
      true,
      { phase, committedUrl, readyState, url },
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
    return this.interactAndAwaitSettle('click', {
      approvedOrigin,
      target: normalizeTarget(target),
    }, approvedOrigin, undefined, signal);
  }

  async type(
    target: string | BrowserElementTarget,
    text: string,
    submit = false,
    signal?: AbortSignal,
  ): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.interactAndAwaitSettle('type', {
      approvedOrigin,
      target: normalizeTarget(target),
      text,
      submit,
    }, approvedOrigin, extensionTypeCommandTimeoutMs(text), signal);
  }

  async scroll(options: BrowserScrollOptions = {}, signal?: AbortSignal): Promise<string> {
    const approvedOrigin = this.requireApprovedOrigin();
    return this.interactAndAwaitSettle('scroll', {
      approvedOrigin,
      deltaX: options.deltaX ?? 0,
      deltaY: options.deltaY ?? 600,
      ...(options.target ? { target: normalizeTarget(options.target) } : {}),
    }, approvedOrigin, undefined, signal);
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
