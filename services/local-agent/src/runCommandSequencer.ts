type PendingReviewResolution = {
  interruptQueued: boolean;
};

/**
 * Preserves client command order across a review resolution without blocking
 * the long-running agent execution. This is server-local transport control
 * state; it is not part of a session projection or checkpoint snapshot.
 */
export class RunCommandSequencer {
  private readonly pendingReviewResolutions = new Map<string, PendingReviewResolution>();

  beginReviewResolution(requestId: string) {
    if (this.pendingReviewResolutions.has(requestId)) return false;
    this.pendingReviewResolutions.set(requestId, { interruptQueued: false });
    return true;
  }

  queueRunInterrupt(requestId: string) {
    const pending = this.pendingReviewResolutions.get(requestId);
    if (!pending) return false;
    pending.interruptQueued = true;
    return true;
  }

  markReviewResolutionCheckpointed(requestId: string) {
    const pending = this.pendingReviewResolutions.get(requestId);
    if (!pending) return false;
    this.pendingReviewResolutions.delete(requestId);
    return pending.interruptQueued;
  }

  abandonReviewResolution(requestId: string) {
    this.pendingReviewResolutions.delete(requestId);
  }
}
