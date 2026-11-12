import type {
  StudioPet,
  StudioPetAssembler,
  StudioPetDefinition,
} from '../types';
import type { PetRow, PetStore } from './store/petStore';
import type { StudioPetCredentials } from './petCredentials';
import { PetInstance, StudioPetError, type LiveStudioPet } from './petInstance';

export { StudioPetError } from './petInstance';
export type { LiveStudioPet } from './petInstance';

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

/**
 * The Studio's Pets: the records in the Studio database and their runtimes.
 * Changes run one at a time, so a Pet id is never assembled twice.
 */
export class StudioPetRegistry implements StudioPets {
  private readonly instances = new Map<string, PetInstance>();
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
    return this.instances.get(petId)?.live;
  }

  listLive(): LiveStudioPet[] {
    return [...this.instances.values()].flatMap(instance => instance.live ? [instance.live] : []);
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
      const instance = this.instance(row);
      if (instance.needsRestore) await instance.restore(row);
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
    // Reserve startup before creation enters the queue. A concurrent restore()
    // must never be queued behind a create that is waiting for that restore.
    const restored = this.restore();
    // Shutdown can reject creation before its queued callback observes startup.
    void restored.catch(() => undefined);
    return this.serialize(async () => {
      await restored;
      const store = await this.options.store();
      await this.options.requireChannel(channelId);
      const row: PetRow = { petId, definitionId, name, channelId, createdAt: new Date().toISOString() };
      if (!(await store.createPet(row))) throw new StudioPetError(`Pet "${petId}" already exists.`, 'exists');
      await this.instance(row).create(row, closed => store.closePet(petId, closed.closedAt!));
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
      const pending = this.instances.get(target)?.pendingFor(kind);
      if (pending) return pending;
      const store = await this.options.store();
      const row = await store.getPet(target);
      if (!row) throw new StudioPetError(`No Pet "${target}".`, 'not_found');
      return this.instance(row).end(row, kind, confirmStop, async ended => {
        if (kind === 'remove') await store.removePet(target, ended.removedAt!);
        else await store.closePet(target, ended.closedAt!);
      });
    });
    return transition.promise;
  }

  async reopenInstance(petId: unknown): Promise<StudioPet> {
    const target = readPetId(petId);
    const transition = await this.serialize(async () => {
      const pending = this.instances.get(target)?.pendingFor('reopen');
      if (pending) return pending;
      const store = await this.options.store();
      const row = await store.getPet(target);
      if (!row) throw new StudioPetError(`No Pet "${target}".`, 'not_found');
      const instance = this.instance(row);
      if (!instance.needsReopen(row)) return { promise: Promise.resolve(toPet(row)) };
      await this.options.requireChannel(row.channelId);
      if (!this.definitionsById.has(row.definitionId)) throw new StudioPetError(`No Pet definition "${row.definitionId}" in this Studio.`, 'invalid');
      return instance.reopen(row, () => store.reopenPet(target));
    });
    return transition.promise;
  }

  async rename(petId: unknown, name: unknown): Promise<StudioPet> {
    const target = readPetId(petId);
    const next = readName(name);
    return this.serialize(async () => {
      this.instances.get(target)?.assertRenameable();
      const store = await this.options.store();
      const row = await store.getPet(target);
      if (!row) throw new StudioPetError(`No Pet "${target}".`, 'not_found');
      await store.renamePet(target, next);
      const renamed = { ...row, name: next };
      this.instances.get(target)?.rename(next);
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
    const transitions = await Promise.allSettled([...this.instances.values()].flatMap(instance => instance.pending ? [instance.pending] : []));
    // Keep observing each runtime until its final lifecycle events settle.
    const results = await Promise.allSettled([...this.instances.values()].map(instance => instance.shutdown()));
    for (const result of [...transitions, ...results]) {
      if (result.status === 'rejected') {
        console.error('[studio] Pet runtime failed to close:', result.reason instanceof Error ? result.reason.message : result.reason);
      }
    }
  }

  private instance(row: PetRow): PetInstance {
    let instance = this.instances.get(row.petId);
    if (!instance) {
      const created: PetInstance = new PetInstance(row, {
        assemble: this.options.assemble,
        onClosed: this.options.onClosed,
        onChange: this.options.onChange,
        onLive: pet => {
          // Preserve the live collection's activation order after Reopen.
          this.instances.delete(row.petId);
          this.instances.set(row.petId, created);
          this.options.onLive(pet);
        },
      });
      instance = created;
      this.instances.set(row.petId, instance);
    }
    return instance;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`studio "${this.options.studioId}": already shut down`));
    const next = this.changes.then(work, work);
    this.changes = next.catch(() => undefined);
    return next;
  }
}
