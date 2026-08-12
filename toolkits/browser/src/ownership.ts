import type { SubagentExecutionScope } from '@pinpawo/pet-agent';
import { BrowserOperationError } from './errors';

/**
 * Browser state belongs to the conversation, not to one transient capability
 * execution. `runId` and `delegationId` remain useful tracing data in the
 * generic runtime scope, but must not decide whether the next browser tool in
 * the same thread can resume its tab.
 */
export type BrowserExecutionOwner = Pick<SubagentExecutionScope, 'threadId'>;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new BrowserOperationError(
    'browser_command_cancelled',
    'Browser command was cancelled before it started.',
    true,
  );
}

function isSameOwner(
  left: BrowserExecutionOwner,
  right: BrowserExecutionOwner,
): boolean {
  return left.threadId === right.threadId;
}

/**
 * A navigation timeout is not an ownership failure: the navigation was
 * dispatched and its tab can still be used by the same thread. Retaining
 * ownership makes the recovery named in the error (`browser_wait`) possible.
 *
 * Keep this deliberately narrow. A generic retryable transport error does not
 * prove that a usable target remains, while target-close and origin-change
 * errors must never expose the old context to a later operation.
 */
function retainsOwnerAfterOpenFailure(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'navigation_timeout';
}

export class BrowserContextOwnership {
  private owner: BrowserExecutionOwner | null = null;
  /** Last cleanly released thread, eligible to resume the retained page. */
  private resumableOwner: BrowserExecutionOwner | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  private enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.operationTail.then(async () => {
      throwIfAborted(signal);
      return await operation();
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireOwner(owner: BrowserExecutionOwner | null): BrowserExecutionOwner {
    if (!owner) {
      throw new BrowserOperationError(
        'browser_context_missing',
        'Browser operation is missing its thread context.',
        false,
      );
    }
    return owner;
  }

  private assertCurrentOwner(owner: BrowserExecutionOwner): void {
    if (!this.owner) {
      throw new BrowserOperationError(
        'browser_not_open',
        'No browser is owned by this thread. Use browser_open first.',
        true,
      );
    }
    if (!isSameOwner(this.owner, owner)) {
      throw new BrowserOperationError(
        'browser_context_conflict',
        'The active browser belongs to another thread. Use browser_open to start from an explicit URL.',
        true,
      );
    }
  }

  acquire(owner: BrowserExecutionOwner | null): Promise<void> {
    return this.enqueue(async () => {
      const nextOwner = this.requireOwner(owner);
      if (
        !this.owner
        && this.resumableOwner
        && isSameOwner(this.resumableOwner, nextOwner)
      ) {
        this.owner = nextOwner;
      }
    });
  }

  release(owner: BrowserExecutionOwner | null): Promise<void> {
    return this.enqueue(async () => {
      const releasedOwner = this.requireOwner(owner);
      if (this.owner && isSameOwner(this.owner, releasedOwner)) {
        this.owner = null;
        this.resumableOwner = releasedOwner;
      }
    });
  }

  runOpen<T>(
    owner: BrowserExecutionOwner | null,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.enqueue(async () => {
      const nextOwner = this.requireOwner(owner);
      // browser_open is the explicit handoff boundary. Serializing the claim
      // with page operations prevents a previous thread from acting on
      // the newly opened page after ownership changes.
      this.resumableOwner = null;
      this.owner = nextOwner;
      try {
        return await operation();
      } catch (error) {
        if (retainsOwnerAfterOpenFailure(error)) {
          // `browser_open` already established this thread as the explicit
          // handoff target. Keep it active so a same-thread browser_wait
          // can continue the in-flight navigation rather than failing with
          // browser_not_open.
          throw error;
        }
        this.owner = null;
        this.resumableOwner = null;
        throw error;
      }
    }, signal);
  }

  runOwned<T>(
    owner: BrowserExecutionOwner | null,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.enqueue(async () => {
      const currentOwner = this.requireOwner(owner);
      this.assertCurrentOwner(currentOwner);
      return operation();
    }, signal);
  }

  closeOwned<T>(
    owner: BrowserExecutionOwner | null,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.enqueue(async () => {
      const currentOwner = this.requireOwner(owner);
      this.assertCurrentOwner(currentOwner);
      try {
        return await operation();
      } finally {
        this.owner = null;
        this.resumableOwner = null;
      }
    }, signal);
  }

  shutdown<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      try {
        return await operation();
      } finally {
        this.owner = null;
        this.resumableOwner = null;
      }
    });
  }
}
