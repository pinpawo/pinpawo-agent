# Resident Dispatch controls

The Host exposes controls on `resident.dispatch`. Studio's existing submission port and Pet Head are unchanged. The resident coordinator remains the only owner of the work queue and execution slot.

- `dispatch(request)` accepts ordinary work under the existing admission rules.
- `stop(target)` requests cancellation of the exact active selection from the queue snapshot. The opaque token distinguishes a new selection even if the caller reuses a dispatch ID. A selected but unstarted entry does not open an Agent request. An executing entry uses the existing request cancellation. A positive acknowledgement is not completion: the coordinator retains the slot through Agent settlement and the settled-state read. A native review remains pending if the Agent settled into review.
- `supersede(request, options)` requires an explicit Session and scope. It validates every named pending ID against the live queue, removes those pending entries from scheduling, emits an observable `superseded` lifecycle, and admits the replacement at the tail. If any ID is stale, ambiguous or out of scope, neither queue change is applied. Other entries retain their ordering; this is not a priority change. If supplied, an exact stop target in the same Session and scope is handled separately after admission; its receipt does not change whether replacement work was admitted.

An asynchronous readiness check is not a reservation of its candidate. The coordinator rechecks live membership before claiming it, so a superseded candidate cannot execute when its old readiness check finally completes. Ready-item FIFO, not global strict FIFO, still applies. The queue and its lifecycle events do not become durable storage through this change.
