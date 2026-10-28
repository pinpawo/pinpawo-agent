export type PetRow = {
  petId: string;
  definitionId: string;
  name: string;
  createdAt: string;
};

/**
 * Pet instance persistence. Data operations only; the rules (id format, which
 * definitions exist, assembling the runtime) belong to the registry above it.
 */
export interface PetStore {
  /** Runs `work` atomically against the store it is given; nested calls join the outer transaction. */
  transaction<T>(work: (store: PetStore) => Promise<T>): Promise<T>;
  /** Inserts the Pet; returns false when the id is already taken. */
  createPet(row: PetRow): Promise<boolean>;
  /** Removes a Pet whose runtime could not be assembled, so its id can be used again. */
  deletePet(petId: string): Promise<void>;
  getPet(petId: string): Promise<PetRow | undefined>;
  /** In creation order. */
  listPets(): Promise<PetRow[]>;
  renamePet(petId: string, name: string): Promise<void>;
}
