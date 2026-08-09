export type ReviewResolutionRoute = {
  actionId: string;
  requestId: string;
};

type AvailableReviewResolution<TRoute> = {
  state: 'available';
  route: TRoute;
};

type ResolvingReviewResolution<TRoute> = {
  state: 'resolving';
  route?: TRoute;
  requestId?: string;
  interruptQueued: boolean;
  pendingAgain?: boolean;
};

type ConsumedReviewResolution = {
  state: 'consumed';
  requestId?: string;
  interruptQueued: boolean;
};

type ReviewResolution<TRoute> =
  | AvailableReviewResolution<TRoute>
  | ResolvingReviewResolution<TRoute>
  | ConsumedReviewResolution;

export type ReviewRunInterruptDisposition<TRoute> =
  | { type: 'cancel_pending'; route: TRoute }
  | { type: 'queued' }
  | { type: 'unhandled' };

/**
 * Owns the complete server-local lifecycle for a review action. Entries are
 * keyed only by actionId; requestId is retained only while ordering transport
 * commands for the run that resolves that action.
 */
export class ReviewResolutionLifecycle<TRoute extends ReviewResolutionRoute> {
  private readonly resolutions = new Map<string, ReviewResolution<TRoute>>();

  constructor(private readonly maxConsumed = 1000) {}

  register(route: TRoute, options: { observedPending?: boolean } = {}) {
    const current = this.resolutions.get(route.actionId);
    if (current?.state === 'consumed') {
      if (!options.observedPending) return false;
      this.resolutions.set(route.actionId, { state: 'available', route });
      return true;
    }
    if (current?.state === 'resolving') {
      this.resolutions.set(route.actionId, {
        ...current,
        route,
        ...(options.observedPending ? { pendingAgain: true } : {}),
      });
      return true;
    }
    this.resolutions.set(route.actionId, { state: 'available', route });
    return true;
  }

  async begin(
    params: { requestId: string; actionId?: string },
    recover: () => Promise<TRoute | null>,
  ): Promise<{ actionId: string; route: TRoute } | null> {
    let route = this.findRoute(params);
    if (!params.actionId && !route) {
      route = await recover();
      if (route) this.register(route);
    }

    const actionId = params.actionId ?? route?.actionId;
    if (!actionId || !this.claim(actionId, params.requestId)) {
      return null;
    }

    route ??= this.findRoute(params) ?? await recover();
    if (!route) {
      this.abandon(actionId);
      return null;
    }
    this.register(route);
    return { actionId, route };
  }

  routes() {
    return [...this.resolutions.values()].flatMap((resolution) => (
      resolution.state !== 'consumed' && resolution.route
        ? [resolution.route]
        : []
    ));
  }

  /**
   * Interprets a run-level interrupt against the authoritative review state.
   * A client may still believe a run is active while the server has already
   * moved it into review, so transport handlers should use this transition
   * instead of inferring review state from their last emitted event.
  */
  routeRunInterrupt(requestId: string): ReviewRunInterruptDisposition<TRoute> {
    if (this.queueInterrupt(requestId)) {
      return { type: 'queued' };
    }

    for (const resolution of this.resolutions.values()) {
      if (
        resolution.state === 'available'
        && resolution.route.requestId === requestId
      ) {
        return { type: 'cancel_pending', route: resolution.route };
      }
    }
    return { type: 'unhandled' };
  }

  queueInterrupt(requestId: string) {
    const resolution = this.findResolvingRun(requestId);
    if (!resolution) return false;
    resolution.interruptQueued = true;
    return true;
  }

  checkpoint(requestId: string) {
    const resolution = this.findResolvingRun(requestId);
    if (!resolution) return false;
    const interruptQueued = resolution.interruptQueued;
    delete resolution.requestId;
    resolution.interruptQueued = false;
    return interruptQueued;
  }

  consume(actionId: string) {
    const current = this.resolutions.get(actionId);
    if (!current || current.state === 'consumed') return;
    const consumed: ConsumedReviewResolution = {
      state: 'consumed',
      ...(current.state === 'resolving' && current.requestId
        ? { requestId: current.requestId }
        : {}),
      interruptQueued: current.state === 'resolving' && current.interruptQueued,
    };
    this.resolutions.delete(actionId);
    this.resolutions.set(actionId, consumed);
    this.pruneConsumed();
  }

  settle(actionId: string, consumed: boolean) {
    const current = this.resolutions.get(actionId);
    if (consumed && current?.state === 'resolving' && current.pendingAgain && current.route) {
      this.resolutions.set(actionId, { state: 'available', route: current.route });
      return;
    }
    if (consumed) this.consume(actionId);
    this.abandon(actionId, { discardRoute: !consumed });
  }

  abandon(actionId: string, options: { discardRoute?: boolean } = {}) {
    const current = this.resolutions.get(actionId);
    if (!current || current.state === 'available') return;
    if (current.state === 'resolving') {
      if (current.route && !options.discardRoute) {
        this.resolutions.set(actionId, { state: 'available', route: current.route });
      } else {
        this.resolutions.delete(actionId);
      }
      return;
    }
    if (current.requestId || current.interruptQueued) {
      this.resolutions.set(actionId, {
        state: 'consumed',
        interruptQueued: false,
      });
    }
  }

  removeRoutes(predicate: (route: TRoute) => boolean) {
    for (const [actionId, resolution] of this.resolutions) {
      if (resolution.state !== 'consumed' && resolution.route && predicate(resolution.route)) {
        this.resolutions.delete(actionId);
      }
    }
  }

  clear() {
    this.resolutions.clear();
  }

  private findRoute(params: { requestId: string; actionId?: string }) {
    if (params.actionId) {
      const direct = this.resolutions.get(params.actionId);
      if (direct?.state === 'consumed') return null;
      if (direct?.route) return direct.route;
    }
    return this.routes().find((route) => route.requestId === params.requestId) ?? null;
  }

  private claim(actionId: string, requestId: string) {
    const current = this.resolutions.get(actionId);
    if (current?.state === 'resolving' || current?.state === 'consumed') {
      return false;
    }
    this.resolutions.set(actionId, {
      state: 'resolving',
      ...(current?.route ? { route: current.route } : {}),
      requestId,
      interruptQueued: false,
    });
    return true;
  }

  private findResolvingRun(requestId: string) {
    for (const resolution of this.resolutions.values()) {
      if (
        resolution.state !== 'available'
        && resolution.requestId === requestId
      ) {
        return resolution;
      }
    }
    return null;
  }

  private pruneConsumed() {
    let consumedCount = 0;
    for (const resolution of this.resolutions.values()) {
      if (resolution.state === 'consumed') consumedCount += 1;
    }
    if (consumedCount <= this.maxConsumed) return;
    for (const [actionId, resolution] of this.resolutions) {
      if (resolution.state !== 'consumed') continue;
      this.resolutions.delete(actionId);
      consumedCount -= 1;
      if (consumedCount <= this.maxConsumed) return;
    }
  }
}
