type ThreadInvocationRecord = {
  abort: () => void;
  settled: Promise<void>;
  settle: () => void;
};

export type ThreadInvocation = {
  requestId: string;
  threadId: string;
  isCurrent: () => boolean;
  waitForTurn: () => Promise<void>;
  settle: () => void;
};

function createAbortError(message: string) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * Serializes graph invocations by conversation thread.
 *
 * Registering a replacement immediately aborts its predecessor, but the
 * replacement cannot start until that predecessor has actually settled.
 */
export class ThreadInvocationCoordinator {
  private readonly activeByThreadId = new Map<string, ThreadInvocationRecord>();

  enqueue(params: {
    threadId: string;
    requestId: string;
    signal: AbortSignal;
    abort: () => void;
  }): ThreadInvocation {
    const previous = this.activeByThreadId.get(params.threadId) ?? null;
    let settled = false;
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const record: ThreadInvocationRecord = {
      abort: params.abort,
      settled: settledPromise,
      settle: () => {
        if (settled) return;
        settled = true;
        resolveSettled();
        if (this.activeByThreadId.get(params.threadId) === record) {
          this.activeByThreadId.delete(params.threadId);
        }
      },
    };

    this.activeByThreadId.set(params.threadId, record);
    if (previous) {
      previous.abort();
    }

    const isCurrent = () =>
      this.activeByThreadId.get(params.threadId) === record
      && !params.signal.aborted;

    return {
      requestId: params.requestId,
      threadId: params.threadId,
      isCurrent,
      waitForTurn: async () => {
        await previous?.settled;
        if (!isCurrent()) {
          throw createAbortError(
            `Invocation ${params.requestId} was superseded before it started.`,
          );
        }
      },
      settle: record.settle,
    };
  }
}
