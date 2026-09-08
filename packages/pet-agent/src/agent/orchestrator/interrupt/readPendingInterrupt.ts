import {
  isHumanReviewBatchInterruptPayload,
  isHumanReviewInterruptPayload,
  type ReviewSpec,
} from '../review/reviewSpec';
import {
  isPauseTaskInterruptPayload,
  PAUSE_TASK_INTERRUPT_KIND,
} from './pauseTaskInterrupt';

export const HUMAN_REVIEW_INTERRUPT_KIND = 'human_review' as const;

/**
 * What a pending interrupt looks like once decoded. The Host carries this
 * shape without reading `kind`; only the Runtime and the interface renderers
 * interpret the payload. Reviews stay in their stored `ReviewSpec` form —
 * projecting them onto the wire is the Host's job, not the decoder's.
 */
export type PendingInterruptPayload =
  | { kind: typeof HUMAN_REVIEW_INTERRUPT_KIND; reviews: ReviewSpec[] }
  | { kind: typeof PAUSE_TASK_INTERRUPT_KIND };

export type PendingInterrupt = {
  interruptId: string;
  payload: PendingInterruptPayload;
};

/**
 * Thrown when the graph holds an interrupt this Runtime version cannot decode.
 * Reporting "no interrupt" instead would strand the run: the Host would admit
 * new work against a checkpoint that is waiting for a person.
 */
export class UnknownInterruptPayloadError extends Error {
  readonly interruptId: string;

  constructor(interruptId: string) {
    super(
      `Interrupt ${interruptId} carries a payload this Runtime cannot decode.`,
    );
    this.name = 'UnknownInterruptPayloadError';
    this.interruptId = interruptId;
  }
}

type RawInterrupt = { id: string; value: unknown };

/**
 * Subgraph interrupts bubble to a parent task, so the first task carrying one
 * owns the pending interaction regardless of the depth it was raised at.
 */
function readRawInterrupt(snapshot: unknown): RawInterrupt | null {
  const tasks = Array.isArray((snapshot as { tasks?: unknown } | null)?.tasks)
    ? (snapshot as { tasks: unknown[] }).tasks
    : [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const interrupts = Array.isArray((task as { interrupts?: unknown }).interrupts)
      ? (task as { interrupts: unknown[] }).interrupts
      : [];
    const first = interrupts[0];
    if (!first || typeof first !== 'object' || !('value' in first)) continue;
    const { id, value } = first as { id?: unknown; value: unknown };
    if (typeof id !== 'string' || !id) return null;
    return { id, value };
  }
  return null;
}

function decodePayload(value: unknown): PendingInterruptPayload | null {
  if (isHumanReviewBatchInterruptPayload(value)) {
    const reviews = value.reviews.map((item) => item.review);
    return reviews.length
      ? { kind: HUMAN_REVIEW_INTERRUPT_KIND, reviews }
      : null;
  }
  if (isHumanReviewInterruptPayload(value)) {
    return { kind: HUMAN_REVIEW_INTERRUPT_KIND, reviews: [value.review] };
  }
  if (isPauseTaskInterruptPayload(value)) {
    return { kind: PAUSE_TASK_INTERRUPT_KIND };
  }
  return null;
}

/**
 * Decode the interrupt a graph snapshot is waiting on, if any.
 *
 * This is the one place that knows how a payload maps to a kind. The Host
 * calls it and forwards the result; it holds no kind knowledge of its own.
 */
export function readPendingInterrupt(snapshot: unknown): PendingInterrupt | null {
  const raw = readRawInterrupt(snapshot);
  if (!raw) {
    return null;
  }
  const payload = decodePayload(raw.value);
  if (!payload) {
    throw new UnknownInterruptPayloadError(raw.id);
  }
  return { interruptId: raw.id, payload };
}

/**
 * What a kind does when fresh user input arrives while it is pending.
 *
 * - `refuse`: the interaction must be answered first. A review holds a tool
 *   call open, so a new message cannot be admitted without stranding it.
 * - `supersede`: the input starts a new task and the unfinished work is
 *   detached. A paused task is resumable, not owed an answer.
 */
export type PendingInterruptInputPolicy = 'refuse' | 'supersede';

export function readPendingInterruptInputPolicy(
  payload: PendingInterruptPayload,
): PendingInterruptInputPolicy {
  return payload.kind === HUMAN_REVIEW_INTERRUPT_KIND ? 'refuse' : 'supersede';
}
