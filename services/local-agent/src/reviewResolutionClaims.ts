/**
 * Server-local bookkeeping for review resolution.
 *
 * Whether a review action still exists is *not* tracked here. LangGraph answers
 * that authoritatively and promptly: a pending `interrupt()` appears in
 * `getState().tasks[].interrupts[]`, it bubbles to the parent graph's top-level
 * tasks from any nesting depth (so a review raised inside a capability subagent
 * is visible on the thread snapshot), and once a resume is applied the snapshot
 * no longer reports it. Mirroring that into memory produced a state machine
 * that could disagree with the checkpoint, which is what this module replaces.
 *
 * What remains is only what LangGraph does not cover:
 *
 * 1. Route details for a pending review — its reviews, interruptId and session
 *    scoping — so a resolution can be applied without re-deriving them, and so
 *    status snapshots have a synchronous read.
 * 2. A claim, so one review action is not resolved twice at once. This guards
 *    double submits from a single client (repeat clicks, resent messages), not
 *    competing clients: each transport owns its own instance and a review is
 *    scoped to one active session.
 * 3. The interrupt handoff, since a cancellation cannot take effect until its
 *    resume reaches a checkpoint.
 */

export type ReviewResolutionRoute = {
  actionId: string;
  requestId: string;
};

export type ReviewRunInterruptDisposition<TRoute> =
  | { type: 'cancel_pending'; route: TRoute }
  | { type: 'queued' }
  | { type: 'unhandled' };

type ClaimedResolution = {
  /** The run resolving this action, cleared once its resume is checkpointed. */
  requestId?: string;
  interruptQueued: boolean;
};

export class ReviewResolutionClaims<TRoute extends ReviewResolutionRoute> {
  /** Known routes for pending reviews, keyed by actionId. */
  private readonly routesByActionId = new Map<string, TRoute>();

  /** Actions being resolved right now. Absence means "free to claim". */
  private readonly claims = new Map<string, ClaimedResolution>();

  /** Records the route for a pending review action. */
  register(route: TRoute) {
    this.routesByActionId.set(route.actionId, route);
    return true;
  }

  /**
   * Claims an action for resolution, resolving its route first.
   *
   * Returns null when the action is already being resolved, or when neither the
   * cache nor the checkpoint knows of it — the caller then reports the review
   * as closed.
   */
  async claim(
    params: { requestId: string; actionId?: string },
    recover: () => Promise<TRoute | null>,
  ): Promise<{ actionId: string; route: TRoute } | null> {
    let route = this.findRoute(params);
    if (!route) {
      route = await recover();
    }

    const actionId = params.actionId ?? route?.actionId;
    if (!actionId || !route || this.claims.has(actionId)) {
      return null;
    }

    // The route may describe a different action than the one asked for; the
    // caller compares them and reports that as a stale review action, which is
    // a different condition from the review being closed.
    this.register(route);
    this.claims.set(actionId, { requestId: params.requestId, interruptQueued: false });
    return { actionId, route };
  }

  /**
   * Releases a claim once its run has settled.
   *
   * `resolved` means the resume was applied, so the cached route is dropped:
   * the checkpoint no longer reports that review, and any review raised after
   * it is registered in its own right. A failed resolution keeps the route, so
   * the next attempt can reuse it.
   */
  release(actionId: string, options: { resolved: boolean }) {
    this.claims.delete(actionId);
    if (options.resolved) {
      this.routesByActionId.delete(actionId);
    }
  }

  routes() {
    return [...this.routesByActionId.values()];
  }

  /**
   * Interprets a run-level interrupt against server-owned review state. A
   * client may still believe a run is active while the server has already moved
   * it into review, so transport handlers use this instead of inferring review
   * state from their last emitted event.
   */
  routeRunInterrupt(requestId: string): ReviewRunInterruptDisposition<TRoute> {
    if (this.queueInterrupt(requestId)) {
      return { type: 'queued' };
    }
    for (const route of this.routesByActionId.values()) {
      if (route.requestId === requestId && !this.claims.has(route.actionId)) {
        return { type: 'cancel_pending', route };
      }
    }
    return { type: 'unhandled' };
  }

  /** Marks that the run resolving this request must be interrupted. */
  queueInterrupt(requestId: string) {
    const claim = this.findClaimByRequestId(requestId);
    if (!claim) return false;
    claim.interruptQueued = true;
    return true;
  }

  /**
   * Reports that a resume reached a checkpoint, returning whether an interrupt
   * was queued for it. The request id is cleared so the same run is not
   * interrupted twice.
   */
  checkpoint(requestId: string) {
    const claim = this.findClaimByRequestId(requestId);
    if (!claim) return false;
    const { interruptQueued } = claim;
    delete claim.requestId;
    claim.interruptQueued = false;
    return interruptQueued;
  }

  removeRoutes(predicate: (route: TRoute) => boolean) {
    for (const [actionId, route] of this.routesByActionId) {
      if (predicate(route)) {
        this.routesByActionId.delete(actionId);
        this.claims.delete(actionId);
      }
    }
  }

  clear() {
    this.routesByActionId.clear();
    this.claims.clear();
  }

  private findRoute(params: { requestId: string; actionId?: string }) {
    const direct = params.actionId
      ? this.routesByActionId.get(params.actionId)
      : undefined;
    if (direct) return direct;
    // Fall back to the run: a client holding a stale actionId still identifies
    // the review by the request that raised it, and the caller decides whether
    // the mismatch makes the response stale.
    return this.routes().find((route) => route.requestId === params.requestId) ?? null;
  }

  private findClaimByRequestId(requestId: string) {
    for (const claim of this.claims.values()) {
      if (claim.requestId === requestId) return claim;
    }
    return null;
  }
}
