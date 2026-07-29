import type { SubagentExecutionScope } from '@pinpawo/pet-agent';
import { BrowserOperationError } from './errors';

export type BrowserExecutionOwner = SubagentExecutionScope;

function isSameOwner(
  left: BrowserExecutionOwner,
  right: BrowserExecutionOwner,
): boolean {
  return left.threadId === right.threadId
    && left.runId === right.runId
    && left.delegationId === right.delegationId;
}

export class BrowserContextOwnership {
  private owner: BrowserExecutionOwner | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
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
        'Browser operation is missing its delegation context.',
        false,
      );
    }
    return owner;
  }

  private assertCurrentOwner(owner: BrowserExecutionOwner): void {
    if (!this.owner) {
      throw new BrowserOperationError(
        'browser_not_open',
        'No browser is owned by this delegation. Use browser_open first.',
        true,
      );
    }
    if (!isSameOwner(this.owner, owner)) {
      throw new BrowserOperationError(
        'browser_context_conflict',
        'The active browser belongs to another delegation. Use browser_open to start from an explicit URL.',
        true,
      );
    }
  }

  runOpen<T>(
    owner: BrowserExecutionOwner | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const nextOwner = this.requireOwner(owner);
      // browser_open is the explicit handoff boundary. Serializing the claim
      // with page operations prevents the previous delegation from acting on
      // the newly opened page after ownership changes.
      this.owner = nextOwner;
      try {
        return await operation();
      } catch (error) {
        this.owner = null;
        throw error;
      }
    });
  }

  runOwned<T>(
    owner: BrowserExecutionOwner | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const currentOwner = this.requireOwner(owner);
      this.assertCurrentOwner(currentOwner);
      return operation();
    });
  }

  closeOwned<T>(
    owner: BrowserExecutionOwner | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const currentOwner = this.requireOwner(owner);
      this.assertCurrentOwner(currentOwner);
      try {
        return await operation();
      } finally {
        this.owner = null;
      }
    });
  }

  shutdown<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      try {
        return await operation();
      } finally {
        this.owner = null;
      }
    });
  }
}
