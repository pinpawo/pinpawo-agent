/**
 * Browser Runtime page-lifecycle controller.
 *
 * This is the seam where raw extension/CDP events are turned into Runtime
 * state. It owns:
 *
 * - the navigation generation registry (`createNavigationRegistry`)
 * - the active `NavigationState` (driven via `applyNavigationEvent`)
 * - the readiness verdict (`defaultPageReadinessPolicy`)
 * - staleness rules for late events (`isEventCurrent`)
 *
 * It is deliberately framework- and I/O-free: it is constructed with no
 * external dependencies and is fed events by whoever owns the transport (the
 * bridge/driver in production, or a test harness in unit tests). It never
 * reaches into the extension or session, so it stays independently testable and
 * is where the driver should converge its navigation/origin handling.
 */

import {
  applyNavigationEvent,
  createNavigation,
  createNavigationRegistry,
  defaultPageReadinessPolicy,
  type NavigationApplyEvent,
  type NavigationPhase,
  type NavigationState,
  type PageReadinessPolicy,
} from './navigation';
import {
  isEventCurrent,
  type BrowserRuntimeEvent,
  type EventGenerationContext,
} from './events';
import type { BrowserRuntimeError } from './navigation';

export const NAV_NAVIGATION_TIMEOUT_MS = 30_000;

export type BrowserLifecycleSnapshot = Readonly<{
  /** True once any navigation has been started and not yet succeeded/failed. */
  hasActiveNavigation: boolean;
  navigation: Readonly<{
    generation: number | null;
    phase: NavigationPhase | null;
    requestedUrl?: string;
    committedUrl?: string;
    readyState?: NavigationState['readyState'];
    inflightRequests?: number;
    readable: boolean;
    error?: BrowserRuntimeError;
  }> | null;
  /** The generation context this controller is currently bound to. */
  context: EventGenerationContext | null;
}>;

export type BrowserLifecycleControllerOptions = {
  /** Override the readiness policy (tests, driver-specific tuning). */
  readinessPolicy?: PageReadinessPolicy;
};

type PendingNavigation = {
  state: NavigationState;
  context: EventGenerationContext;
};

export class BrowserLifecycleController {
  private readonly registry = createNavigationRegistry();
  private readonly readinessPolicy: PageReadinessPolicy;
  private pending: PendingNavigation | null = null;

  constructor(options: BrowserLifecycleControllerOptions = {}) {
    this.readinessPolicy = options.readinessPolicy ?? defaultPageReadinessPolicy;
  }

  /** Begin a new navigation generation for `requestedUrl`. */
  beginNavigation(
    requestedUrl: string,
    approvedOrigin: string,
    connectionGeneration = 1,
    targetGeneration = 1,
  ): BrowserLifecycleSnapshot {
    const generation = this.registry.nextGeneration();
    const state = createNavigation(generation, requestedUrl, approvedOrigin);
    this.pending = {
      state,
      context: { connectionGeneration, targetGeneration, navigationGeneration: generation },
    };
    return this.getSnapshot();
  }

  /**
   * Feed a runtime event (from the bridge/driver or a test harness). Events
   * against a superseded navigation are dropped; only current events mutate
   * state. Returns the resulting snapshot.
   */
  handleEvent(event: BrowserRuntimeEvent): BrowserLifecycleSnapshot {
    if (!this.pending) return this.getSnapshot();
    const { state, context } = this.pending;

    // Detect a superseded connection/target generation. When the bridge moves
    // to a newer generation (target closed, extension reconnected), subsequent
    // events carry a *higher* generation than this navigation was bound to.
    // Staying silent would hang the navigation until its deadline with no
    // distinguishing error — instead fail deterministically so waiters get a
    // definitive result (per issue #583: on detach/reconnect, "等待者得到确定结果").
    const connectionSuperseded = event.connectionGeneration > context.connectionGeneration;
    const targetSuperseded = event.targetGeneration > context.targetGeneration;
    if ((connectionSuperseded || targetSuperseded) && state.phase !== 'failed') {
      return this.fail({
        code: connectionSuperseded ? 'runtime_disconnected' : 'target_closed',
        message: connectionSuperseded
          ? 'browser connection was superseded while navigation was in flight'
          : 'managed target was closed while navigation was in flight',
        retryable: true,
        details: { connectionGeneration: context.connectionGeneration, targetGeneration: context.targetGeneration },
      });
    }

    // Reject late events before touching state.
    if (!isEventCurrent(event, context)) return this.getSnapshot();

    const applyEvent = this.toApplyEvent(event);
    if (!applyEvent) return this.getSnapshot();

    const next = applyNavigationEvent(state, applyEvent, {
      readiness: this.readinessPolicy,
    });
    if (next === state) return this.getSnapshot();
    this.pending = { state: next, context };
    return this.getSnapshot();
  }

  /** Feed a `settle_verdict` derived from the current state + `now`. */
  pollReadiness(now: number): BrowserLifecycleSnapshot {
    if (!this.pending) return this.getSnapshot();
    const { state, context } = this.pending;
    const applyEvent = {
      kind: 'settle_verdict' as const,
      readable: this.readinessPolicy({
        readyState: state.readyState,
        inflightRequests: state.inflightRequests,
        textLength: state.textLength,
        textRevision: state.textRevision,
        lastNetworkActivityAt: state.lastNetworkActivityAt,
        lastDomActivityAt: state.lastDomActivityAt,
        now,
      }),
      now,
    };
    const next = applyNavigationEvent(state, applyEvent, { readiness: this.readinessPolicy });
    if (next === state) return this.getSnapshot();
    this.pending = { state: next, context };
    return this.getSnapshot();
  }

  /** Mark the active navigation failed (`failed` is terminal). */
  fail(error: BrowserRuntimeError): BrowserLifecycleSnapshot {
    if (!this.pending) return this.getSnapshot();
    const { state, context } = this.pending;
    const next = applyNavigationEvent(state, { kind: 'fail', error });
    if (next === state) return this.getSnapshot();
    this.pending = { state: next, context };
    return this.getSnapshot();
  }

  getSnapshot(): BrowserLifecycleSnapshot {
    if (!this.pending) {
      return Object.freeze({ hasActiveNavigation: false, navigation: null, context: null });
    }
    const { state, context } = this.pending;
    const readable = state.phase === 'readable';
    return Object.freeze({
      hasActiveNavigation: true,
      navigation: Object.freeze({
        generation: state.generation,
        phase: state.phase,
        ...(state.requestedUrl !== undefined ? { requestedUrl: state.requestedUrl } : {}),
        ...(state.committedUrl !== undefined ? { committedUrl: state.committedUrl } : {}),
        ...(state.readyState !== undefined ? { readyState: state.readyState } : {}),
        ...(state.inflightRequests !== undefined ? { inflightRequests: state.inflightRequests } : {}),
        readable,
        ...(state.error ? { error: state.error } : {}),
      }),
      context: Object.freeze({ ...context }),
    });
  }

  private toApplyEvent(
    event: BrowserRuntimeEvent,
  ): NavigationApplyEvent | null {
    switch (event.type) {
      case 'navigation.committed':
        // A commit URL is required to evaluate the origin. A url-less commit is
        // malformed (the legacy `tab.navigated` can arrive without a URL): it is
        // not a benign intermediate nor a genuine origin change, so explicitly
        // ignore it rather than route `''` through the origin comparison.
        if (typeof event.url !== 'string') return null;
        return { kind: 'commit', url: event.url };
      case 'document.ready': {
        const readyState = event.payload?.readyState as
          | 'loading'
          | 'interactive'
          | 'complete'
          | undefined;
        if (!readyState) return null;
        return { kind: 'document.ready', readyState };
      }
      case 'network.activity': {
        const inflightRequests = event.payload?.inflightRequests as number | undefined;
        if (typeof inflightRequests !== 'number') return null;
        return { kind: 'network', inflightRequests, now: event.timestamp };
      }
      case 'dom.changed': {
        const textLength = event.payload?.textLength as number | undefined;
        const textRevision = event.payload?.textRevision as number | undefined;
        if (typeof textLength !== 'number') return null;
        return {
          kind: 'dom',
          textLength,
          textRevision: typeof textRevision === 'number' ? textRevision : 0,
          now: event.timestamp,
        };
      }
      default:
        // navigation.requested, target.*, debugger.*, popup.*, download.* and
        // runtime.disconnected do not map directly onto the navigation reducer.
        return null;
    }
  }
}
