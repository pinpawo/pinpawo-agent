import type {
  StudioPet,
  StudioPetAssembler,
  StudioPetDefinition,
  StudioPetRegistration,
  StudioPetRuntime,
} from '../types';
import type { PetRow, PetStore } from './store/petStore';
import type { StudioPetCredentials } from './petCredentials';

/** Thrown for a request that names an unknown Pet or breaks a Pet rule. */
export class StudioPetError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'exists' | 'not_found' | 'locked' | 'busy' | 'confirmation_required') {
    super(message);
    this.name = 'StudioPetError';
  }
}

/** Creating and managing Channel-owned Pet instances without recycling identity. */
export type StudioPets = {
  /** In creation order. */
  list: () => Promise<StudioPet[]>;
  get: (petId: string) => Promise<StudioPet | undefined>;
  /** The definitions this Studio may create Pets from. */
  definitions: () => StudioPetDefinition[];
  /** Record a new Pet and assemble its runtime; it takes work as soon as this resolves. */
  create: (input: { petId: unknown; definitionId: unknown; name: unknown; channelId: unknown }) => Promise<StudioPet>;
  /** Temporarily close one instance; preserve its identity, credentials and sessions. */
  closeInstance: (petId: unknown, options?: { confirmStop?: boolean }) => Promise<StudioPet>;
  reopenInstance: (petId: unknown) => Promise<StudioPet>;
  /** Stop, wait for quiescence, then permanently remove. Never deletes history. */
  removeInstance: (petId: unknown, options?: { confirmStop?: boolean }) => Promise<StudioPet>;
  rename: (petId: unknown, name: unknown) => Promise<StudioPet>;
  /** Each Pet's own environment variables for its commands; values are write-only. */
  credentials: StudioPetCredentials;
};

/** A live Pet: its registration and the runtime ports the Host lent Studio. */
export type LiveStudioPet = {
  registration: StudioPetRegistration;
  runtime: StudioPetRuntime;
};

const PET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readPetId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!PET_ID.test(id)) {
    throw new StudioPetError('Pet id must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.', 'invalid');
  }
  return id;
}

function readName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80) throw new StudioPetError('Pet name must be 1-80 characters.', 'invalid');
  return name;
}

function toPet(row: PetRow): StudioPet {
  return { ...row };
}

function registration(row: PetRow): StudioPetRegistration {
  return { petId: row.petId, name: row.name, definitionId: row.definitionId, channelId: row.channelId, createdAt: row.createdAt };
}

/**
 * The Studio's Pets: the records in the Studio database and their runtimes.
 * Changes run one at a time, so a Pet id is never assembled twice.
 */
export class StudioPetRegistry implements StudioPets {
  private readonly closing = new Map<string, { kind: 'close' | 'remove' | 'reopen'; promise: Promise<StudioPet> }>();
  /** A failed/uncertain teardown is not permission to dispatch or reassemble. */
  private readonly unavailable = new Set<string>();
  private readonly live = new Map<string, LiveStudioPet>();
  private readonly definitionsById: ReadonlyMap<string, StudioPetDefinition>;
  private changes: Promise<unknown> = Promise.resolve();
  private restored: Promise<void> | null = null;
  private closed = false;
  readonly credentials: StudioPetCredentials;

  constructor(private readonly options: {
    studioId: string;
    store: () => Promise<PetStore>;
    credentials: StudioPetCredentials;
    definitions: readonly StudioPetDefinition[];
    assemble: StudioPetAssembler;
    requireChannel: (channelId: string) => Promise<void>;
    /** A Pet became live (restored or created). */
    onLive: (pet: LiveStudioPet) => void;
    /** A live Pet's runtime has closed. */
    onClosed: (petId: string) => void;
    /** A record changed; Studio publishes it. */
    onChange: (type: 'pet.created' | 'pet.renamed' | 'pet.closed' | 'pet.reopened' | 'pet.removed', pet: StudioPet) => void;
  }) {
    const definitions = new Map<string, StudioPetDefinition>();
    for (const definition of options.definitions) {
      if (definitions.has(definition.definitionId)) {
        throw new Error(`studio "${options.studioId}": duplicate Pet definition "${definition.definitionId}"`);
      }
      definitions.set(definition.definitionId, { ...definition });
    }
    this.definitionsById = definitions;
    this.credentials = options.credentials;
  }

  /** The live Pet with this id. */
  getLive(petId: string): LiveStudioPet | undefined {
    return this.closing.has(petId) || this.unavailable.has(petId) ? undefined : this.live.get(petId);
  }

  listLive(): LiveStudioPet[] {
    return [...this.live.values()].filter(pet => !this.closing.has(pet.registration.petId) && !this.unavailable.has(pet.registration.petId));
  }

  /** Assemble every active, owned Pet once. Fails, naming the Pet, when its definition is gone. */
  restore(): Promise<void> {
    this.restored ??= this.serialize(() => this.restoreSafely());
    return this.restored;
  }

  private async restoreSafely(): Promise<void> {
    try { await this.restoreNow(); }
    catch (error) { await this.closeLive(); throw error; }
  }

  private async restoreNow(): Promise<void> {
    const rows = await (await this.options.store()).listPets();
    // Validate every active identity before assembling any resident.
    for (const row of rows.filter(row => !row.closedAt && !row.removedAt)) {
      if (!row.channelId) throw new Error(`Pet "${row.petId}" has no owner Channel. This active record has no valid ownership. Do not delete data or infer an owner; restore an ownership-consistent backup or use a new Studio database.`);
      await this.options.requireChannel(row.channelId);
      if (!this.definitionsById.has(row.definitionId)) {
        throw new Error(`studio "${this.options.studioId}": Pet "${row.petId}" uses definition "${row.definitionId}", which this Studio no longer lists`);
      }
    }
    for (const row of rows.filter(row => !row.closedAt && !row.removedAt)) {
      if (this.live.has(row.petId) || this.closing.has(row.petId) || this.unavailable.has(row.petId)) continue;
      await this.goLive(row);
    }
  }

  async list(): Promise<StudioPet[]> {
    return (await (await this.options.store()).listPets()).map(toPet);
  }

  async get(petId: string): Promise<StudioPet | undefined> {
    const row = await (await this.options.store()).getPet(petId);
    return row ? toPet(row) : undefined;
  }

  definitions(): StudioPetDefinition[] {
    return [...this.definitionsById.values()].map(definition => ({ ...definition }));
  }

  async create(input: { petId: unknown; definitionId: unknown; name: unknown; channelId: unknown }): Promise<StudioPet> {
    const petId = readPetId(input.petId);
    const name = readName(input.name);
    const channelId = typeof input.channelId === 'string' ? input.channelId.trim() : '';
    if (!channelId || channelId.length > 256) throw new StudioPetError('An existing owner Channel is required.', 'invalid');
    const definitionId = typeof input.definitionId === 'string' ? input.definitionId.trim() : '';
    if (!this.definitionsById.has(definitionId)) {
      throw new StudioPetError(`No Pet definition "${definitionId}" in this Studio.`, 'invalid');
    }
    return this.serialize(async () => {
      // Already inside the queue: restore inline rather than wait behind ourselves.
      this.restored ??= this.restoreSafely();
      await this.restored;
      const store = await this.options.store();
      await this.options.requireChannel(channelId);
      const row: PetRow = { petId, definitionId, name, channelId, createdAt: new Date().toISOString() };
      if (!(await store.createPet(row))) throw new StudioPetError(`Pet "${petId}" already exists.`, 'exists');
      try {
        await this.goLive(row);
      } catch (error) {
        // Assembly may already have created Host state. Retain the identity and
        // its owner rather than recycle an id with another instance's history.
        await store.closePet(petId, new Date().toISOString());
        throw error;
      }
      this.options.onChange('pet.created', toPet(row));
      return toPet(row);
    });
  }

  async closeInstance(petId: unknown, options: { confirmStop?: boolean } = {}): Promise<StudioPet> {
    return this.endInstance(petId, 'close', options.confirmStop === true);
  }

  async removeInstance(petId: unknown, options: { confirmStop?: boolean } = {}): Promise<StudioPet> {
    return this.endInstance(petId, 'remove', options.confirmStop === true);
  }

  private async endInstance(petId: unknown, kind: 'close' | 'remove', confirmStop = false): Promise<StudioPet> {
    const target = readPetId(petId);
    const transition = await this.serialize(async () => {
      const pending = this.closing.get(target);
      if (pending) {
        if (pending.kind !== kind) throw new StudioPetError(`Pet "${target}" has another lifecycle operation in progress.`, 'busy');
        return pending;
      }
      const store = await this.options.store();
      const row = await store.getPet(target);
      if (!row) throw new StudioPetError(`No Pet "${target}".`, 'not_found');
      if (row.removedAt) {
        if (kind === 'close') throw new StudioPetError(`Pet "${target}" was permanently removed.`, 'invalid');
        return { promise: Promise.resolve(toPet(row)) };
      }
      const live = this.live.get(target);
      // A failed Reopen cleanup can retain a runtime beside an older closed
      // marker. That marker alone is not proof that this runtime has stopped.
      if (kind === 'close' && row.closedAt && !live) return { promise: Promise.resolve(toPet(row)) };
      if (live && !confirmStop) {
        throw new StudioPetError(`Confirm ${kind === 'remove' ? 'permanent removal' : 'temporary Close'}: stop current task and cancel unstarted queued tasks, retain history.`, 'confirmation_required');
      }
      const promise = Promise.resolve().then(async () => {
        this.unavailable.add(target);
        // No lifecycle marker is committed until the runtime proves quiescence.
        // A thrown close or uncertain DB acknowledgment must reach the caller.
        await live?.runtime.close();
        if (live) {
          this.live.delete(target);
          this.options.onClosed(target);
        }
        const ended = kind === 'remove' ? { ...row, removedAt: new Date().toISOString() }
          : { ...row, closedAt: new Date().toISOString() };
        if (kind === 'remove') await store.removePet(target, ended.removedAt!);
        else await store.closePet(target, ended.closedAt!);
        this.options.onChange(kind === 'remove' ? 'pet.removed' : 'pet.closed', toPet(ended));
        return toPet(ended);
      }).finally(() => { this.closing.delete(target); });
      this.closing.set(target, { kind, promise });
      void promise.catch(() => undefined);
      return { promise };
    });
    return transition.promise;
  }

  async reopenInstance(petId: unknown): Promise<StudioPet> {
    const target = readPetId(petId);
    const transition = await this.serialize(async () => {
      const pending = this.closing.get(target);
      if (pending) {
        if (pending.kind !== 'reopen') throw new StudioPetError(`Pet "${target}" has another lifecycle operation in progress.`, 'busy');
        return pending;
      }
      const store = await this.options.store();
      const row = await store.getPet(target);
      if (!row) throw new StudioPetError(`No Pet "${target}".`, 'not_found');
      if (row.removedAt) throw new StudioPetError(`Pet "${target}" was permanently removed and cannot reopen.`, 'invalid');
      if (this.unavailable.has(target) && this.live.has(target)) {
        throw new StudioPetError(`Pet "${target}" still has an unsettled runtime teardown. Stop it before reopening.`, 'busy');
      }
      if (!row.closedAt) {
        if (this.unavailable.has(target)) throw new StudioPetError(`Pet "${target}" has an unsettled lifecycle outcome. Check its state before retrying.`, 'busy');
        return { promise: Promise.resolve(toPet(row)) };
      }
      await this.options.requireChannel(row.channelId);
      if (!this.definitionsById.has(row.definitionId)) throw new StudioPetError(`No Pet definition "${row.definitionId}" in this Studio.`, 'invalid');
      const { closedAt: _closedAt, ...reopened } = row;
      const promise = Promise.resolve().then(async () => {
        await this.goLive(reopened);
        try { await store.reopenPet(target); }
        catch (error) {
          this.unavailable.add(target);
          const live = this.live.get(target);
          await live?.runtime.close();
          this.live.delete(target);
          this.options.onClosed(target);
          throw error;
        }
        this.unavailable.delete(target);
        this.options.onChange('pet.reopened', toPet(reopened));
        return toPet(reopened);
      }).finally(() => { this.closing.delete(target); });
      this.closing.set(target, { kind: 'reopen', promise });
      void promise.catch(() => undefined);
      return { promise };
    });
    return transition.promise;
  }

  async rename(petId: unknown, name: unknown): Promise<StudioPet> {
    const target = readPetId(petId);
    const next = readName(name);
    return this.serialize(async () => {
      if (this.closing.has(target)) throw new StudioPetError(`Pet "${target}" has a lifecycle operation in progress.`, 'busy');
      const store = await this.options.store();
      const row = await store.getPet(target);
      if (!row) throw new StudioPetError(`No Pet "${target}".`, 'not_found');
      await store.renamePet(target, next);
      const renamed = { ...row, name: next };
      const live = this.live.get(target);
      if (live) live.registration.name = next;
      this.options.onChange('pet.renamed', toPet(renamed));
      return toPet(renamed);
    });
  }

  /** Close every live runtime; later changes are refused. */
  async close(): Promise<void> {
    this.closed = true;
    await this.changes.catch(() => undefined);
    await this.closeLive();
  }

  private async closeLive(): Promise<void> {
    // A reopen may still be assembling. Wait for each registry transition
    // before taking the remaining live runtimes, or shutdown could miss it.
    const transitions = await Promise.allSettled([...this.closing.values()].map(operation => operation.promise));
    const live = [...this.live.values()];
    for (const pet of live) this.live.delete(pet.registration.petId);
    // Observe each runtime through settlement so final lifecycle events still
    // reach Studio. A failed teardown is retained in the database, not removed.
    const results = await Promise.allSettled(live.map(async ({ registration: { petId }, runtime }) => {
      try { await runtime.close(); }
      finally { this.options.onClosed(petId); }
    }));
    for (const result of [...transitions, ...results]) {
      if (result.status === 'rejected') {
        console.error('[studio] Pet runtime failed to close:', result.reason instanceof Error ? result.reason.message : result.reason);
      }
    }
  }

  private async goLive(row: PetRow): Promise<void> {
    const live: LiveStudioPet = { registration: registration(row), runtime: await this.options.assemble(registration(row)) };
    this.live.set(row.petId, live);
    try { this.options.onLive(live); }
    catch (error) {
      this.live.delete(row.petId);
      try { await live.runtime.close(); } finally { this.options.onClosed(row.petId); }
      throw error;
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`studio "${this.options.studioId}": already shut down`));
    const next = this.changes.then(work, work);
    this.changes = next.catch(() => undefined);
    return next;
  }
}
