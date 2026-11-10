import {
  ResidentPetOperationCancelledError,
  type PetDispatchQueueSnapshot,
  type PetDispatchQueueEntry,
  type PetDispatchTarget,
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
  private readonly conversationHolds = new Set<Promise<void>>();
  private readonly listeners = new Set<(state: PetDispatchState) => void>();
  private readonly queueListeners = new Set<(snapshot: PetDispatchQueueSnapshot) => void>();
  private readonly readSettledState: ResidentPetCoordinatorOptions['readSettledState'];
  private readonly logError: NonNullable<ResidentPetCoordinatorOptions['logError']>;
  private state: PetDispatchState;
  private active: Promise<void> | null = null;
  private activeOperation: PetDispatchQueueSnapshot['activeOperation'] = null;
  private activeDispatch: PetDispatchQueueEntry | undefined;
  private refreshing: Promise<PetDispatchState> | null = null;
  private closing = false;
  /** Admission/refresh changes observed while an asynchronous scan owns the slot. */
  private schedulingVersion = 0;
  private preferredDispatch: QueuedOperation | undefined;

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
      ...(this.dispatchQueue.some(entry => entry.observation) ? {
        entries: this.dispatchQueue.flatMap(entry => entry.observation ? [structuredClone(entry.observation)] : []),
      } : {}),
      ...(this.activeDispatch ? { activeDispatch: structuredClone(this.activeDispatch) } : {}),
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

  /** Select, but do not consume, the next input for an executing scoped turn. */
  prioritizePendingDispatch(target: PetDispatchTarget): boolean {
    const matching = this.dispatchQueue.find(({ observation }) => observation
      && observation.sessionId === target.sessionId
      && observation.scope?.namespace === target.scope.namespace
      && observation.scope.id === target.scope.id);
    if (!matching) return false;
    // An immediate input may wake the turn, but earlier inputs to this same
    // session still come first. Unrelated sessions retain their relative order.
    this.preferredDispatch = matching;
    return true;
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
    // Claim both admission and lifetime synchronously, including the wait for
    // an active dispatch. Close cancels a hold that has not started its work.
    this.conversations += 1;
    let release!: () => void;
    const settled = new Promise<void>(resolve => { release = resolve; });
    this.conversationHolds.add(settled);
    try {
      try {
        while (this.active) await this.active;
      } catch {
        // The active operation's own caller owns its failure.
      }
      if (this.closing) {
        throw new ResidentPetOperationCancelledError('Resident Pet Host is closing.');
      }
      this.setState('busy');
      this.publishQueueSnapshot();
      if (this.closing) {
        throw new ResidentPetOperationCancelledError('Resident Pet Host is closing.');
      }
      return await operation();
    } finally {
      this.conversations -= 1;
      try {
        if (this.conversations === 0) {
          this.publishQueueSnapshot();
          // Await refresh before releasing the lifetime hold, including when
          // the operation failed. Close itself must not start another read.
          if (!this.closing) {
            try {
              await this.refreshState();
            } catch (error) {
              this.logError('[resident-pet] failed to refresh state after a conversation:', error);
            }
          }
        }
      } finally {
        this.conversationHolds.delete(settled);
        release();
      }
    }
  }

  enqueueDispatch<T>(operation: () => Promise<T>, ready?: () => Promise<boolean>): Promise<T> {
    return this.enqueue(operation, ready);
  }

  /** Accept a one-way dispatch and own every later execution outcome inside the runtime. */
  submitDispatch(operation: () => Promise<void>, ready?: () => Promise<boolean>, observation?: PetDispatchQueueEntry): void {
    if (this.closing) {
      throw new ResidentPetOperationCancelledError('Resident Pet Host is closing.');
    }
    void this.enqueue(operation, ready, observation).catch((error) => {
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
    this.schedulingVersion++;
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
    // Execution failures belong to their callers, not to resource cleanup.
    await Promise.allSettled([this.active, this.refreshing, ...this.conversationHolds]);
  }

  private enqueue<T>(operation: () => Promise<T>, ready?: () => Promise<boolean>, observation?: PetDispatchQueueEntry): Promise<T> {
    if (this.closing) {
      return Promise.reject(new ResidentPetOperationCancelledError());
    }
    return new Promise<T>((resolve, reject) => {
      this.schedulingVersion++;
      this.dispatchQueue.push({
        kind: 'dispatch',
        ready,
        run: operation,
        resolve: (value) => resolve(value as T),
        reject,
        ...(observation ? { observation: structuredClone(observation) } : {}),
      });
      this.publishQueueSnapshot();
      this.drain();
    });
  }

  private drain(): void {
    // A conversation holding the gate keeps dispatch waiting, same as an
    // active dispatch does.
    if (this.active || this.refreshing || this.closing || this.conversations > 0) return;
    if (this.dispatchQueue.some((entry) => entry.ready)) {
      // Own the single slot while checking targets. Waiting sessions stay queued;
      // another session may run, but no two executions overlap.
      const schedulingVersion = this.schedulingVersion;
      let ran = false;
      let blocked = false;
      const active = Promise.resolve().then(async () => {
        const candidates = [...this.dispatchQueue];
        const preferred = this.preferredDispatch && candidates.indexOf(this.preferredDispatch);
        if (preferred !== undefined && preferred > 0) candidates.unshift(...candidates.splice(preferred, 1));
        for (const candidate of candidates) {
          if (this.closing || this.conversations > 0) return;
          let ready: boolean;
          try { ready = candidate.ready ? await candidate.ready() : (await this.readNextSettledState()) === 'open'; }
          catch (error) {
            // A failed read says nothing about the work itself. Keep it queued and
            // report the gate blocked, as a failed settled-state refresh does; the
            // next admission or refresh scans again.
            blocked = true;
            this.logError('[resident-pet] failed to read dispatch readiness:', error);
            continue;
          }
          if (this.closing || this.conversations > 0) return;
          if (!ready) continue;
          this.dispatchQueue.splice(this.dispatchQueue.indexOf(candidate), 1);
          if (this.preferredDispatch === candidate) this.preferredDispatch = undefined;
          ran = true;
          this.activeOperation = candidate.kind;
          this.activeDispatch = candidate.observation;
          this.setState('busy');
          await this.run(candidate);
          return;
        }
        if (this.dispatchQueue.length) this.setState(blocked ? 'blocked' : 'waiting');
      });
      this.active = active;
      void active.finally(() => {
        if (this.active === active) { this.active = null; this.activeOperation = null; this.activeDispatch = undefined; }
        this.publishQueueSnapshot();
        if (ran || this.schedulingVersion !== schedulingVersion) this.drain();
      });
      return;
    }
    const index = this.preferredDispatch ? this.dispatchQueue.indexOf(this.preferredDispatch) : -1;
    const entry = this.state === 'open' ? this.dispatchQueue.splice(index < 0 ? 0 : index, 1)[0] : undefined;
    if (!entry) return;
    if (this.preferredDispatch === entry) this.preferredDispatch = undefined;
    this.activeOperation = entry.kind;
    this.activeDispatch = entry.observation;
    const active = Promise.resolve().then(() => this.run(entry));
    this.active = active;
    this.setState('busy');
    void active.then(() => {
      if (this.active === active) {
        this.active = null;
        this.activeOperation = null;
        this.activeDispatch = undefined;
        this.publishQueueSnapshot();
      }
      this.drain();
    });
  }

  private async run(entry: QueuedOperation): Promise<void> {
    // Selection reserves the slot before execution's first microtask. Stop
    // must also cancel that selected-but-unstarted entry, not only the queue.
    if (this.closing) {
      entry.reject(new ResidentPetOperationCancelledError('Resident Pet Host is closing.'));
      return;
    }
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
