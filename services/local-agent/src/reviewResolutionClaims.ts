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

/**
 * Identifies *which* review an action currently carries.
 *
 * LangGraph reuses one interrupt id for successive `interrupt()` calls in the
 * same node, so the action id alone cannot tell a resolved review apart from
 * the follow-up that replaces it. The review ids can.
 */
function readReviewIdentity(route: ReviewResolutionRoute): string {
  const reviews = (route as { reviews?: unknown }).reviews;
  if (!Array.isArray(reviews)) return '';
  return reviews
    .map((review) => (review as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string')
    .join(',');
}

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
   * Which review each action last resolved, keyed by actionId.
   *
   * The checkpoint is the authority on what is pending, but it is read
   * asynchronously, so a review whose resume already landed can still appear
   * there briefly; without this, a decision arriving in that window would
   * resolve it a second time. The value records *which* review was resolved,
   * because LangGraph reuses one interrupt id across successive `interrupt()`
   * calls — so the id alone would also suppress the legitimate follow-up.
   * Kept bounded: it only has to outlive that window.
   */
  private readonly resolvedActionIds = new Map<string, string>();

  constructor(private readonly maxResolved = 1000) {}

  /**
   * Records the route for a pending review action.
   *
   * Pass `observedPending` when the review was seen first-hand — the graph
   * raised it during this run — as opposed to being read back from a
   * checkpoint, which can still show a review whose resume already landed.
   * Returns false when the route was ignored as such a stale echo.
   */
  register(route: TRoute, options: { observedPending?: boolean } = {}) {
    // A stale echo only if this action already resolved *this same* review; a
    // different review under a reused interrupt id is genuinely new.
    if (this.isResolved(route) && !options.observedPending) {
      return false;
    }
    this.resolvedActionIds.delete(route.actionId);
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
      if (route && this.isResolved(route)) route = null;
      if (route) this.register(route);
    }

    const actionId = params.actionId ?? route?.actionId;
    if (!actionId || this.claims.has(actionId)) {
      return null;
    }

    route ??= this.findRoute(params) ?? await recover();
    if (!route || this.isResolved(route)) {
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
    const route = this.routesByActionId.get(actionId);
    this.routesByActionId.delete(actionId);
    this.resolvedActionIds.set(actionId, route ? readReviewIdentity(route) : '');
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

  /** True when this action already resolved exactly this review. */
  private isResolved(route: TRoute) {
    const resolved = this.resolvedActionIds.get(route.actionId);
    return resolved !== undefined && resolved === readReviewIdentity(route);
  }

  private findRoute(params: { requestId: string; actionId?: string }) {
    if (params.actionId) {
      const direct = this.routesByActionId.get(params.actionId) ?? null;
      return direct && this.isResolved(direct) ? null : direct;
    }
    return this.routes().find((route) => route.requestId === params.requestId) ?? null;
  }

  private pruneResolved() {
    if (this.resolvedActionIds.size <= this.maxResolved) return;
    for (const actionId of this.resolvedActionIds.keys()) {
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
