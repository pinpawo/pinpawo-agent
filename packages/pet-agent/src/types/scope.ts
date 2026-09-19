/**
 * The identity layers a piece of work belongs to.
 *
 * Session (`threadId`) holds a conversation. Task (`taskId`) is the stable
 * identity a host gives one user-facing task; it outlives a run. Run (`runId`)
 * is one user request, and a delegation is one dispatched execution within it.
 *
 * These are ours, not LangChain's: its `run_id` identifies a single runnable
 * invocation, of which one run here contains many.
 *
 * The layers nest, so each type extends the one above it and a consumer asks
 * for the shallowest layer it actually needs. Structures that carry an identity
 * extend these rather than redeclaring the fields, so adding or renaming a
 * layer is one edit instead of a repo-wide sweep.
 *
 * `DelegationMessageScope` in agent/messages/metadata deliberately stays
 * separate: it is a persisted message tag whose equality drives lane selection,
 * so its shape is a storage contract rather than an execution identity.
 */

export type SessionScope = {
  threadId: string | null;
};

export type TaskScope = SessionScope & {
  taskId: string;
};

export type RunScope = TaskScope & {
  runId: string;
};

export type DelegationScope = RunScope & {
  delegationId: string;
};
