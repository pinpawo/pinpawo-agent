import { Command } from '@langchain/langgraph';
import type { OrchestratorStateType } from '../state';
import { pauseTaskInterrupt } from './pauseTaskInterrupt';
import { readPendingInterrupt, type PendingInterrupt } from './readPendingInterrupt';

/**
 * The minimum a graph runtime must offer to settle an aborted invocation.
 * Deliberately narrower than the Host's graph service: settling reads and
 * advances one thread, and the caller cannot choose a node or edit a
 * checkpoint through it.
 */
export type AbortSettlementGraph = {
  getState: () => Promise<unknown>;
  /** Write `values` as though `asNode` produced them. */
  updateState: (
    values: Partial<OrchestratorStateType> | Command,
    asNode?: string,
  ) => Promise<unknown>;
  /** Continue the thread from its committed boundary. */
  resume: () => Promise<unknown>;
};

export type AbortSettlement =
  | { status: 'paused'; pendingInterrupt: PendingInterrupt }
  | { status: 'finished' };

/**
 * Where a cancelled run can be left pending.
 *
 * Cancelling inside a delegation leaves its own node pending, because the node
 * never returned. Cancelling between nodes is caught by the orchestrator's
 * error handler, which commits its cleanup and routes to the failure node to
 * rethrow. Either way the delegation's committed state is intact and the task
 * is satisfied by writing through the node that holds it.
 */
const SETTLEABLE_NODES = ['capability', 'throwRunFailure'] as const;

/** The node that raises `PauseTaskInterrupt`, whatever the pause's origin. */
const PAUSE_GATE_NODE = 'pauseGate';

function readNextNodes(snapshot: unknown): string[] {
  const next = (snapshot as { next?: unknown } | null)?.next;
  return Array.isArray(next) ? next.filter((n): n is string => typeof n === 'string') : [];
}

function readValues(snapshot: unknown): Record<string, unknown> | null {
  const values = (snapshot as { values?: unknown } | null)?.values;
  return values && typeof values === 'object' && !Array.isArray(values)
    ? values as Record<string, unknown>
    : null;
}

function readResumableDelegationStatus(snapshot: unknown): string | null {
  const delegation = readValues(snapshot)?.taskActiveDelegation;
  if (!delegation || typeof delegation !== 'object') {
    return null;
  }
  const status = (delegation as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

/**
 * Turn a cancelled invocation into a pending interrupt when it left work
 * behind.
 *
 * An abort produces no interrupt of its own: the run stops at the failure
 * node, so the checkpoint holds unfinished work that nothing above the
 * Runtime has an id to continue. This settles that boundary here, inside the
 * Runtime, and the result is indistinguishable from a Review-origin pause
 * everywhere else.
 *
 * Nothing is re-executed. The failure node's pending task is replaced by a
 * jump to the gate, so the delegation's committed work stands and no model,
 * tool, or Supervisor call is made to reach the pause.
 *
 * An abort with nothing to continue is not a pause. A run cancelled while
 * answering or planning has no delegation the person could steer, so this
 * reports `finished` and leaves the thread alone.
 */
export async function settleAbortedRun(
  graph: AbortSettlementGraph,
): Promise<AbortSettlement> {
  const snapshot = await graph.getState();

  // An interrupt raised before the abort landed already owns this boundary;
  // settling again would strand it.
  const existing = readPendingInterrupt(snapshot);
  if (existing) {
    return { status: 'paused', pendingInterrupt: existing };
  }

  const pendingNode = readNextNodes(snapshot)
    .find((node): node is typeof SETTLEABLE_NODES[number] => (
      (SETTLEABLE_NODES as readonly string[]).includes(node)
    ));
  if (!pendingNode) {
    return { status: 'finished' };
  }

  // Only an unfinished delegation is continuable. `awaiting_decision` belongs
  // to the Supervisor boundary, not to a person, so it is not a pause either.
  if (readResumableDelegationStatus(snapshot) !== 'pending') {
    return { status: 'finished' };
  }

  // Writing *as* the pending node satisfies its task, so resuming advances
  // instead of repeating the work it was cancelled in. The jump names the gate
  // directly because the node never returned, so its own routing never ran.
  // Clearing the terminal error keeps the resume from rethrowing the abort.
  await graph.updateState(
    new Command({
      goto: PAUSE_GATE_NODE,
      update: {
        runTerminalError: null,
        taskPauseInterrupt: pauseTaskInterrupt.interaction(),
      },
    }),
    pendingNode,
  );
  await graph.resume();

  const settled = readPendingInterrupt(await graph.getState());
  return settled
    ? { status: 'paused', pendingInterrupt: settled }
    : { status: 'finished' };
}
