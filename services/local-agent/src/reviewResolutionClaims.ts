/**
 * Server-local bookkeeping for review resolution.
 *
 * Whether a review action still exists is *not* tracked here. LangGraph already
 * answers that authoritatively: a pending `interrupt()` shows up in
 * `getState().tasks[].interrupts[]`, and it bubbles to the parent graph's
 * top-level tasks from any nesting depth, so a review raised inside a
 * capability subagent is visible on the thread's snapshot. Mirroring that into
 * memory produced a shadow state machine that could disagree with the
 * checkpoint, which is what this module replaces.
 *
 * What remains is the part LangGraph does not cover:
 *
 * 1. Route details for a pending review (its reviews, interruptId, session
 *    scoping) so a resolution can be applied without re-deriving them, plus a
 *    cheap synchronous read for status snapshots.
 * 2. A claim, so the same review action is not resolved twice concurrently.
 *    This guards double submits from one client — repeated clicks, resent
 *    messages — not competing clients: each transport owns its own instance,
 *    and a review is scoped to a single active session.
 * 3. The interrupt handoff, since cancelling cannot take effect until the
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
  /**
   * A pending review was observed for this action while it was being resolved.
   *
   * A batch raises its next review from the same interrupt, so the follow-up
   * reuses the action id. Without this the settle would mark that id resolved
   * and the new review could never be answered.
   */
  raisedAgain?: boolean;
};

export class ReviewResolutionClaims<TRoute extends ReviewResolutionRoute> {
  /** Known routes for pending reviews, keyed by actionId. */
  private readonly routesByActionId = new Map<string, TRoute>();

  /** Actions currently being resolved. Absence means "free to claim". */
  private readonly claims = new Map<string, ClaimedResolution>();

  /**
   * Actions whose resume was applied.
   *
   * The checkpoint is the authority on what is pending, but it is read
   * asynchronously and a resumed review can still appear there briefly — and
   * the review that follows a batch may reuse the same interrupt id. Without
   * this, a second decision arriving right after the first would recover the
   * stale review and resolve it twice. Kept bounded, since it only has to
   * outlive the window between applying a resume and observing its effect.
   */
  private readonly resolvedActionIds = new Set<string>();

  constructor(private readonly maxResolved = 1000) {}

  /**
   * Records the route for a pending review action. Re-registering an action
   * that is already being resolved refreshes its route: the checkpoint decides
   * whether the review still exists, so a newer observation is never stale.
   */
  register(route: TRoute, options: { observedPending?: boolean } = {}) {
    if (this.resolvedActionIds.has(route.actionId)) {
      // Already resolved. A checkpoint read can still surface this action for a
      // moment, so only a first-hand observation of a *new* pending review
      // revives it; a recovered route is treated as stale.
      if (!options.observedPending) return false;
      this.resolvedActionIds.delete(route.actionId);
    }
    const claim = this.claims.get(route.actionId);
    if (claim && options.observedPending) {
      // Raised again mid-resolution: the settle must not retire this id.
      claim.raisedAgain = true;
    }
    this.routesByActionId.set(route.actionId, route);
    return true;
  }

  /**
   * Claims an action for resolution, resolving its route first.
   *
   * Returns null when the action is already being resolved, or when no route
   * can be found for it — the caller reports the review as closed, and the
   * checkpoint remains the authority on whether it truly is.
   */
  async claim(
    params: { requestId: string; actionId?: string },
    recover: () => Promise<TRoute | null>,
  ): Promise<{ actionId: string; route: TRoute } | null> {
    let route = this.findRoute(params);
    if (!params.actionId && !route) {
      route = await recover();
      if (route && this.resolvedActionIds.has(route.actionId)) route = null;
      if (route) this.register(route);
    }

    const actionId = params.actionId ?? route?.actionId;
    if (!actionId || this.claims.has(actionId) || this.resolvedActionIds.has(actionId)) {
      return null;
    }

    route ??= this.findRoute(params) ?? await recover();
    if (!route || this.resolvedActionIds.has(route.actionId)) {
      return null;
    }
    this.register(route);
    this.claims.set(actionId, { requestId: params.requestId, interruptQueued: false });
    return { actionId, route };
  }

  /**
   * Releases a claim once its run has settled.
   *
   * `resolved` means the resume was applied, so the route is dropped: any
   * review still pending after it is a new one, and re-reading the checkpoint
   * will surface it. A failed resolution keeps the route so the next attempt
   * can reuse it without another checkpoint read.
   */
  release(actionId: string, options: { resolved: boolean }) {
    const claim = this.claims.get(actionId);
    this.claims.delete(actionId);
    if (!options.resolved || claim?.raisedAgain) return;
    this.routesByActionId.delete(actionId);
    this.resolvedActionIds.add(actionId);
    this.pruneResolved();
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
   * was queued for it. The request id is cleared so a later interrupt for the
   * same run is not delivered twice.
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
    this.resolvedActionIds.clear();
  }

  private findRoute(params: { requestId: string; actionId?: string }) {
    if (params.actionId) {
      if (this.resolvedActionIds.has(params.actionId)) return null;
      return this.routesByActionId.get(params.actionId) ?? null;
    }
    return this.routes().find((route) => route.requestId === params.requestId) ?? null;
  }

  private pruneResolved() {
    if (this.resolvedActionIds.size <= this.maxResolved) return;
    for (const actionId of this.resolvedActionIds) {
      this.resolvedActionIds.delete(actionId);
      if (this.resolvedActionIds.size <= this.maxResolved) return;
    }
  }

  private findClaimByRequestId(requestId: string) {
    for (const claim of this.claims.values()) {
      if (claim.requestId === requestId) return claim;
    }
    return null;
  }
}
