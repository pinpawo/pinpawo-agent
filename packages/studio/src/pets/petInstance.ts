import type { StudioPet, StudioPetAssembler, StudioPetRegistration, StudioPetRuntime } from '../types';

/** Thrown for a request that names an unknown Pet or breaks a Pet rule. */
export class StudioPetError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'exists' | 'not_found' | 'locked' | 'busy' | 'confirmation_required') {
    super(message);
    this.name = 'StudioPetError';
  }
}

/** The registration and runtime ports the Host lent Studio. */
export type LiveStudioPet = { registration: StudioPetRegistration; runtime: StudioPetRuntime };
type LifecycleKind = 'close' | 'remove' | 'reopen';
type Transition = { kind: LifecycleKind; promise: Promise<StudioPet> };

/**
 * One Channel-owned identity and its resident lifecycle. Persisted markers are
 * deliberately not cached: each operation receives the registry's fresh record.
 */
export class PetInstance {
  private readonly identity: Readonly<Omit<StudioPetRegistration, 'name'>>;
  private resident: LiveStudioPet | undefined;
  private transition: Transition | undefined;
  /** Failed/uncertain teardown is not permission to dispatch or reassemble. */
  private unavailable = false;

  constructor(pet: StudioPetRegistration, private readonly options: {
    assemble: StudioPetAssembler;
    onLive: (pet: LiveStudioPet) => void;
    onClosed: (petId: string) => void;
    onChange: (type: 'pet.closed' | 'pet.removed' | 'pet.reopened', pet: StudioPet) => void;
  }) {
    const { petId, definitionId, channelId, createdAt } = pet;
    this.identity = Object.freeze({ petId, definitionId, channelId, createdAt });
  }

  get petId(): string { return this.identity.petId; }
  get ownerChannelId(): string { return this.identity.channelId; }
  get live(): LiveStudioPet | undefined {
    return this.transition || this.unavailable ? undefined : this.resident;
  }
  get pending(): Promise<StudioPet> | undefined { return this.transition?.promise; }
  get needsRestore(): boolean { return !this.resident && !this.transition && !this.unavailable; }

  pendingFor(kind: LifecycleKind): Transition | undefined {
    if (this.transition && this.transition.kind !== kind) {
      throw new StudioPetError(`Pet "${this.petId}" has another lifecycle operation in progress.`, 'busy');
    }
    return this.transition;
  }

  async activate(name: string): Promise<void> {
    if (!this.needsRestore) throw new StudioPetError(`Pet "${this.petId}" already has a resident lifecycle.`, 'busy');
    await this.activateRuntime(name);
  }

  private async activateRuntime(name: string): Promise<void> {
    const registration = { ...this.identity, name };
    const live = { registration, runtime: await this.options.assemble({ ...registration }) };
    this.resident = live;
    try { this.options.onLive(live); }
    catch (error) {
      // onLive may have partially exposed this runtime. Fence admission and
      // retain its handle/observation until cleanup proves it actually stopped.
      this.unavailable = true;
      await this.stop();
      throw error;
    }
  }

  end(row: StudioPet, kind: 'close' | 'remove', confirmStop: boolean, persist: (ended: StudioPet) => Promise<void>): { promise: Promise<StudioPet> } {
    const pending = this.pendingFor(kind);
    if (pending) return pending;
    if (row.removedAt) {
      if (kind === 'close') throw new StudioPetError(`Pet "${this.petId}" was permanently removed.`, 'invalid');
      return { promise: Promise.resolve({ ...row }) };
    }
    // An older closed marker does not prove a failed-Reopen runtime stopped.
    if (kind === 'close' && row.closedAt && !this.resident) return { promise: Promise.resolve({ ...row }) };
    if (this.resident && !confirmStop) {
      throw new StudioPetError(`Confirm ${kind === 'remove' ? 'permanent removal' : 'temporary Close'}: stop current task and cancel unstarted queued tasks, retain history.`, 'confirmation_required');
    }
    return this.begin(kind, async () => {
      this.unavailable = true;
      // Fence admission first. Keep the handle if stop fails; commit only after
      // the Host confirms business settlement, including its unstarted queue.
      await this.stop();
      const ended = kind === 'remove' ? { ...row, removedAt: new Date().toISOString() }
        : { ...row, closedAt: new Date().toISOString() };
      await persist(ended);
      this.options.onChange(kind === 'remove' ? 'pet.removed' : 'pet.closed', { ...ended });
      return ended;
    });
  }

  /** Whether this fresh record needs activation; all other outcomes are final or busy. */
  needsReopen(row: StudioPet): boolean {
    if (row.removedAt) throw new StudioPetError(`Pet "${this.petId}" was permanently removed and cannot reopen.`, 'invalid');
    if (this.unavailable && this.resident) {
      throw new StudioPetError(`Pet "${this.petId}" still has an unsettled runtime teardown. Stop it before reopening.`, 'busy');
    }
    if (!row.closedAt && this.unavailable) {
      throw new StudioPetError(`Pet "${this.petId}" has an unsettled lifecycle outcome. Check its state before retrying.`, 'busy');
    }
    return !!row.closedAt;
  }

  reopen(row: StudioPet, persist: () => Promise<void>): { promise: Promise<StudioPet> } {
    const pending = this.pendingFor('reopen');
    if (pending) return pending;
    if (!this.needsReopen(row)) return { promise: Promise.resolve({ ...row }) };
    const { closedAt: _closedAt, ...reopened } = row;
    return this.begin('reopen', async () => {
      await this.activateRuntime(row.name);
      try { await persist(); }
      catch (error) {
        this.unavailable = true;
        // A failed/unknown write must clean up its replacement before a retry.
        // If cleanup fails, stop() retains the handle, even beside closedAt.
        await this.stop();
        throw error;
      }
      this.unavailable = false;
      this.options.onChange('pet.reopened', { ...reopened });
      return reopened;
    });
  }

  assertRenameable(): void {
    if (this.transition) throw new StudioPetError(`Pet "${this.petId}" has a lifecycle operation in progress.`, 'busy');
  }

  rename(name: string): void {
    this.assertRenameable();
    if (this.resident) this.resident.registration.name = name;
  }

  /** Studio shutdown is not Close/Remove and never writes a lifecycle marker. */
  async shutdown(): Promise<void> {
    const live = this.resident;
    this.resident = undefined;
    // Let registry shutdown detach every resident before any close callback.
    await Promise.resolve();
    if (live) {
      try { await live.runtime.close(); }
      finally { this.options.onClosed(this.petId); }
    }
  }

  private async stop(): Promise<void> {
    const live = this.resident;
    await live?.runtime.close();
    if (live) {
      this.resident = undefined;
      this.options.onClosed(this.petId);
    }
  }

  private begin(kind: LifecycleKind, work: () => Promise<StudioPet>): Transition {
    const promise = Promise.resolve().then(work).finally(() => { this.transition = undefined; });
    this.transition = { kind, promise };
    void promise.catch(() => undefined);
    return this.transition;
  }
}
