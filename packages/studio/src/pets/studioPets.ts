import type {
  StudioPet,
  StudioPetAssembler,
  StudioPetDefinition,
  StudioPetRegistration,
  StudioPetRuntime,
} from '../types';
import type { PetRow, PetStore } from './store/petStore';

/** Thrown for a request that names an unknown Pet or breaks a Pet rule. */
export class StudioPetError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'exists' | 'not_found' | 'pet_archived') {
    super(message);
    this.name = 'StudioPetError';
  }
}

/** Creating, renaming and archiving this Studio's Pets. */
export type StudioPets = {
  /** In creation order; archived Pets only when asked for. */
  list: (options?: { includeArchived?: boolean }) => Promise<StudioPet[]>;
  get: (petId: string) => Promise<StudioPet | undefined>;
  /** The definitions this Studio may create Pets from. */
  definitions: () => StudioPetDefinition[];
  /** Record a new Pet and assemble its runtime; it takes work as soon as this resolves. */
  create: (input: { petId: unknown; definitionId: unknown; name: unknown }) => Promise<StudioPet>;
  rename: (petId: unknown, name: unknown) => Promise<StudioPet>;
  /**
   * Stop taking work: new dispatches are refused at once, queued ones fail,
   * a running turn finishes, then the runtime closes. History stays.
   */
  archive: (petId: unknown) => Promise<StudioPet>;
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
  return { petId: row.petId, name: row.name, definitionId: row.definitionId };
}

/**
 * The Studio's Pets: the records in the Studio database and the runtimes of
 * the active ones. Changes run one at a time, so a Pet id is never assembled
 * twice and an archive never races the create it follows.
 */
export class StudioPetRegistry implements StudioPets {
  private readonly live = new Map<string, LiveStudioPet>();
  private readonly definitionsById: ReadonlyMap<string, StudioPetDefinition>;
  private changes: Promise<unknown> = Promise.resolve();
  private restored: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: {
    studioId: string;
    store: () => Promise<PetStore>;
    definitions: readonly StudioPetDefinition[];
    assemble: StudioPetAssembler;
    /** A Pet became live (restored or created). */
    onLive: (pet: LiveStudioPet) => void;
    /** A live Pet stopped taking work. */
    onRetired: (petId: string) => void;
    /** A record changed; Studio publishes it. */
    onChange: (type: 'pet.created' | 'pet.renamed' | 'pet.archived', pet: StudioPet) => void;
  }) {
    const definitions = new Map<string, StudioPetDefinition>();
    for (const definition of options.definitions) {
      if (definitions.has(definition.definitionId)) {
        throw new Error(`studio "${options.studioId}": duplicate Pet definition "${definition.definitionId}"`);
      }
      definitions.set(definition.definitionId, { ...definition });
    }
    this.definitionsById = definitions;
  }

  /** The live Pet with this id, if it takes work. */
  getLive(petId: string): LiveStudioPet | undefined {
    return this.live.get(petId);
  }

  listLive(): LiveStudioPet[] {
    return [...this.live.values()];
  }

  /** Assemble every active Pet once. Fails, naming the Pet, when its definition is gone. */
  restore(): Promise<void> {
    this.restored ??= this.serialize(() => this.restoreNow());
    return this.restored;
  }

  private async restoreNow(): Promise<void> {
    const rows = await (await this.options.store()).listPets();
    for (const row of rows) {
      if (row.archivedAt || this.live.has(row.petId)) continue;
      if (!this.definitionsById.has(row.definitionId)) {
        throw new Error(
          `studio "${this.options.studioId}": Pet "${row.petId}" uses definition "${row.definitionId}", which this Studio no longer lists`,
        );
      }
      await this.goLive(row);
    }
  }

  async list(options: { includeArchived?: boolean } = {}): Promise<StudioPet[]> {
    const rows = await (await this.options.store()).listPets();
    return rows.filter(row => options.includeArchived || !row.archivedAt).map(toPet);
  }

  async get(petId: string): Promise<StudioPet | undefined> {
    const row = await (await this.options.store()).getPet(petId);
    return row ? toPet(row) : undefined;
  }

  definitions(): StudioPetDefinition[] {
    return [...this.definitionsById.values()].map(definition => ({ ...definition }));
  }

  async create(input: { petId: unknown; definitionId: unknown; name: unknown }): Promise<StudioPet> {
    const petId = readPetId(input.petId);
    const name = readName(input.name);
    const definitionId = typeof input.definitionId === 'string' ? input.definitionId.trim() : '';
    if (!this.definitionsById.has(definitionId)) {
      throw new StudioPetError(`No Pet definition "${definitionId}" in this Studio.`, 'invalid');
    }
    return this.serialize(async () => {
      // Already inside the queue: restore inline rather than wait behind ourselves.
      this.restored ??= this.restoreNow();
      await this.restored;
      const store = await this.options.store();
      const row: PetRow = { petId, definitionId, name, createdAt: new Date().toISOString() };
      if (!(await store.createPet(row))) throw new StudioPetError(`Pet "${petId}" already exists.`, 'exists');
      try {
        await this.goLive(row);
      } catch (error) {
        // A Pet that never ran leaves no history; free its id for another try.
        await store.deletePet(petId);
        throw error;
      }
      this.options.onChange('pet.created', toPet(row));
      return toPet(row);
    });
  }

  async rename(petId: unknown, name: unknown): Promise<StudioPet> {
    const target = readPetId(petId);
    const next = readName(name);
    return this.serialize(async () => {
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

  async archive(petId: unknown): Promise<StudioPet> {
    const target = readPetId(petId);
    return this.serialize(async () => {
      const store = await this.options.store();
      const row = await store.getPet(target);
      if (!row) throw new StudioPetError(`No Pet "${target}".`, 'not_found');
      if (row.archivedAt) return toPet(row);
      const archived = { ...row, archivedAt: new Date().toISOString() };
      await store.archivePet(target, archived.archivedAt);
      // Refuse new work before waiting on the running turn.
      const live = this.live.get(target);
      this.live.delete(target);
      if (live) {
        this.options.onRetired(target);
        await live.runtime.close();
      }
      this.options.onChange('pet.archived', toPet(archived));
      return toPet(archived);
    });
  }

  /** Why a Pet id takes no work: archived, or unknown. */
  async explainUnavailable(petId: string): Promise<StudioPetError> {
    const row = await (await this.options.store()).getPet(petId);
    return row?.archivedAt
      ? new StudioPetError(`Pet "${petId}" is archived.`, 'pet_archived')
      : new StudioPetError(`studio "${this.options.studioId}": unknown petId "${petId}"`, 'not_found');
  }

  /** Close every live runtime; later changes are refused. */
  async close(): Promise<void> {
    this.closed = true;
    await this.changes.catch(() => undefined);
    const live = [...this.live.values()];
    this.live.clear();
    const results = await Promise.allSettled(live.map(({ registration: { petId }, runtime }) => {
      this.options.onRetired(petId);
      return runtime.close();
    }));
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[studio] Pet runtime failed to close:', result.reason instanceof Error ? result.reason.message : result.reason);
      }
    }
  }

  private async goLive(row: PetRow): Promise<void> {
    const live: LiveStudioPet = { registration: registration(row), runtime: await this.options.assemble(registration(row)) };
    this.live.set(row.petId, live);
    this.options.onLive(live);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`studio "${this.options.studioId}": already shut down`));
    const next = this.changes.then(work, work);
    this.changes = next.catch(() => undefined);
    return next;
  }
}
