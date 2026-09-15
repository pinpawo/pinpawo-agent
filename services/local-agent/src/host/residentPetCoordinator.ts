import {
  ResidentPetOperationCancelledError,
  type PetDispatchQueueSnapshot,
  type PetDispatchSettledState,
  type PetDispatchState,
  type QueuedOperation,
  type ResidentPetCoordinatorOptions,
} from './contracts';

function defaultLogError(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.message : error);
}

/** One non-preemptive graph admission point shared by conversation and dispatch. */
export class ResidentPetCoordinator {
  private readonly dispatchQueue: QueuedOperation[] = [];
  /** Conversations currently holding the gate busy; they never enter a queue. */
  private conversations = 0;
  private readonly listeners = new Set<(state: PetDispatchState) => void>();
  private readonly queueListeners = new Set<(snapshot: PetDispatchQueueSnapshot) => void>();
  private readonly readSettledState: ResidentPetCoordinatorOptions['readSettledState'];
  private readonly logError: NonNullable<ResidentPetCoordinatorOptions['logError']>;
  private state: PetDispatchState;
  private active: Promise<void> | null = null;
  private activeOperation: PetDispatchQueueSnapshot['activeOperation'] = null;
  private refreshing: Promise<PetDispatchState> | null = null;
  private closing = false;

  constructor(options: ResidentPetCoordinatorOptions) {
    this.state = options.initialState ?? 'open';
    this.readSettledState = options.readSettledState;
    this.logError = options.logError ?? defaultLogError;
  }

  getState(): PetDispatchState {
    return this.state;
  }

  getQueueSnapshot(): PetDispatchQueueSnapshot {
    return {
      state: this.state,
      activeOperation: this.activeOperation,
      // Conversations hold the gate but never queue, so this is the count of
      // conversations currently holding it. Kept because StudioDispatchQueue
      // publishes the field.
      queuedConversations: this.conversations,
      queuedDispatches: this.dispatchQueue.length,
    };
  }

  onStateChange(listener: (state: PetDispatchState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onQueueChange(listener: (snapshot: PetDispatchQueueSnapshot) => void): () => void {
    this.queueListeners.add(listener);
    return () => this.queueListeners.delete(listener);
  }

  /**
   * Run a conversation operation while holding the gate busy.
   *
   * Conversation does not join the dispatch queue. dispatch is Studio's
   * scheduling concept and this coordinator is the gate that answers "can
   * this Agent take new work"; conversation is not a competitor for that
   * gate, it is one of the reasons the Agent becomes busy. Conversation has
   * its own admission (SessionAdmission) and thread-level coordination
   * (ThreadInvocationCoordinator), so queueing it here would be a second,
   * unrelated queue.
   *
   * The gate is still held for the operation's duration and refreshed after
   * it settles, so a dispatch cannot start mid-conversation and a pending
   * interrupt raised by the conversation leaves the gate `waiting`.
   */
  async holdForConversation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      throw new ResidentPetOperationCancelledError('Resident Pet Host is closing.');
    }
    // The hold is claimed synchronously, before waiting out an active
    // dispatch. A queued dispatch reads Session state when it starts, so a
    // session switch already in flight has to land first — waiting before
    // claiming would let that dispatch drain against the old thread.
    this.conversations += 1;
    try {
      while (this.active) {
        await this.active;
      }
    } catch {
      // The active operation's own caller owns its failure.
    }
    this.setState('busy');
    this.publishQueueSnapshot();
    let value: T;
    try {
      value = await operation();
    } finally {
      this.conversations -= 1;
      if (this.conversations === 0) {
        this.publishQueueSnapshot();
      }
    }
    // Awaited, not fire-and-forget: callers rely on the gate being settled by
    // the time the operation resolves, the way the queue's own run() refreshed
    // before resolving. A failed refresh leaves the gate `blocked` and is
    // logged rather than failing the conversation, which already succeeded.
    if (this.conversations === 0) {
      try {
        await this.refreshState();
      } catch (error) {
        this.logError('[resident-pet] failed to refresh state after a conversation:', error);
      }
    }
    return value;
  }

  enqueueDispatch<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation);
  }

  /** Accept a one-way dispatch and own every later execution outcome inside the runtime. */
  submitDispatch(operation: () => Promise<void>): void {
    if (this.closing) {
      throw new ResidentPetOperationCancelledError('Resident Pet Host is closing.');
    }
    void this.enqueue(operation).catch((error) => {
      if (error instanceof ResidentPetOperationCancelledError) return;
      this.logError('[resident-pet] dispatch execution failed:', error);
    });
    // A pending review can be resolved through a reconnect or another
    // session client. Do not let the queue keep that old settled state and
    // strand a later one-way dispatch behind it.
    void this.refreshState().catch((error) => {
      this.logError('[resident-pet] failed to refresh dispatch admission state:', error);
    });
  }

  async refreshState(): Promise<PetDispatchState> {
    if (this.active) return this.state;
    if (this.refreshing) return this.refreshing;
    const refreshing = Promise.resolve().then(async () => {
      try {
        const next = await this.readNextSettledState();
        this.setState(next);
        return next;
      } catch (error) {
        this.setState('blocked');
        throw error;
      }
    });
    this.refreshing = refreshing;
    try {
      return await refreshing;
    } finally {
      if (this.refreshing === refreshing) this.refreshing = null;
      this.drain();
    }
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.cancelQueue(this.dispatchQueue);
    }
    await Promise.all([this.active, this.refreshing]);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new ResidentPetOperationCancelledError());
    }
    return new Promise<T>((resolve, reject) => {
      this.dispatchQueue.push({
        kind: 'dispatch',
        run: operation,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.publishQueueSnapshot();
      this.drain();
    });
  }

  private drain(): void {
    // A conversation holding the gate keeps dispatch waiting, same as an
    // active dispatch does.
    if (this.active || this.refreshing || this.closing || this.conversations > 0) return;
    const entry = this.state === 'open' ? this.dispatchQueue.shift() : undefined;
    if (!entry) return;
    this.activeOperation = entry.kind;
    const active = Promise.resolve().then(() => this.run(entry));
    this.active = active;
    this.setState('busy');
    void active.then(() => {
      if (this.active === active) {
        this.active = null;
        this.activeOperation = null;
        this.publishQueueSnapshot();
      }
      this.drain();
    });
  }

  private async run(entry: QueuedOperation): Promise<void> {
    let value: unknown;
    let operationError: unknown;
    try {
      value = await entry.run();
    } catch (error) {
      operationError = error;
    }
    try {
      this.setState(await this.readNextSettledState());
    } catch (error) {
      this.setState('blocked');
      if (operationError === undefined) operationError = error;
      else this.logError('[resident-pet] failed to refresh settled state:', error);
    }
    if (operationError !== undefined) entry.reject(operationError);
    else entry.resolve(value);
  }

  private async readNextSettledState(): Promise<PetDispatchSettledState> {
    const next = await this.readSettledState();
    if (next === 'busy') {
      throw new Error('Resident Pet remained busy after its active operation settled.');
    }
    return next;
  }

  private setState(next: PetDispatchState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (error) {
        this.logError('[resident-pet] state listener failed:', error);
      }
    }
    // The active operation clears immediately after its settled state is read.
    // Publish that single coherent snapshot from the completion callback instead
    // of briefly reporting an idle state while an operation is still active.
    if (this.active && next !== 'busy') return;
    this.publishQueueSnapshot();
  }

  private publishQueueSnapshot(): void {
    const snapshot = this.getQueueSnapshot();
    for (const listener of this.queueListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logError('[resident-pet] queue listener failed:', error);
      }
    }
  }

  private cancelQueue(queue: QueuedOperation[]): void {
    for (const entry of queue.splice(0)) {
      entry.reject(new ResidentPetOperationCancelledError('Resident Pet Host is closing.'));
    }
    this.publishQueueSnapshot();
  }
}
