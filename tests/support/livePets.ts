import {
  prepareStudio,
  type CreateStudioInput,
  type PreparedStudio,
  type Studio,
  type StudioPetRuntime,
} from '@pinpawo/studio-core';

/** A Pet whose runtime the test built itself. */
export type LivePet = {
  registration: { petId: string; name: string; definitionId?: string };
  dispatch: StudioPetRuntime['dispatch'];
  sessions?: StudioPetRuntime['sessions'];
};

export type CreateStudioWithPetsInput = Omit<CreateStudioInput, 'definitions' | 'assemblePet'> & {
  pets: LivePet[];
  /** Connect preassembled resident Hosts to this Studio's Plugin context resolver. */
  onPreparedContextResolver?: (resolver: PreparedStudio['resolveInvocationContext']) => void;
};

/**
 * Create a Studio over Pets whose runtimes already exist, the way tests and
 * embedded Hosts compose one. Each Pet uses its own definition (named by
 * `definitionId`, or its petId) and is created before Plugins start, unless the
 * Studio database already holds it (a restarted Studio).
 */
export async function createStudioWithPets(input: CreateStudioWithPetsInput): Promise<Studio> {
  const { pets, onPreparedContextResolver, ...rest } = input;
  const byId = new Map(pets.map(pet => [pet.registration.petId, pet]));
  const definitions = new Map(pets.map(({ registration }) => {
    const definitionId = registration.definitionId ?? registration.petId;
    return [definitionId, { definitionId, name: registration.name }];
  }));
  const prepared = prepareStudio({
    ...rest,
    definitions: [...definitions.values()],
    assemblePet: async ({ petId }) => {
      const pet = byId.get(petId);
      if (!pet) throw new Error(`No live runtime for Pet "${petId}".`);
      return { dispatch: pet.dispatch, ...(pet.sessions ? { sessions: pet.sessions } : {}), close: async () => undefined };
    },
  });
  onPreparedContextResolver?.(prepared.resolveInvocationContext);
  try {
    await prepared.restorePets();
    for (const { registration } of pets) {
      if (await prepared.studio.pets.get(registration.petId)) continue;
      await prepared.studio.pets.create({
        petId: registration.petId,
        definitionId: registration.definitionId ?? registration.petId,
        name: registration.name,
      });
    }
    await prepared.activatePlugins();
  } catch (error) {
    await prepared.studio.shutdown();
    throw error;
  }
  return prepared.studio;
}
