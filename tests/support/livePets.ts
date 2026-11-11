import {
  prepareStudio,
  type CreateStudioInput,
  type PreparedStudio,
  type Studio,
  type StudioPetRuntime,
  type StudioPlugin,
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
 * embedded Hosts compose one. Existing instances restore normally. Channel
 * integration tests provision fresh instances only after creating their owner
 * through createChannelWithPets; isolated Plugin tests use a declared synthetic
 * owner rather than an independently live, unowned Pet.
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
    plugins: rest.plugins?.some(plugin => plugin.name === 'channel') ? rest.plugins : [
      ...(rest.plugins ?? []),
      { name: 'channel', toolkits: [], petChannels: { requireChannel: async channelId => {
        if (channelId !== 'fixture') throw new Error('Unknown fixture Channel.');
      }, getChannelWorkdir: async () => undefined }, start: () => undefined } satisfies StudioPlugin,
    ],
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
    // Channel integration tests create their own Channels first via the helper
    // below. Isolated Plugin tests use the synthetic owner declared above.
    for (const { registration } of rest.plugins?.some(plugin => plugin.name === 'channel') ? [] : pets) {
      if (await prepared.studio.pets.get(registration.petId)) continue;
      await prepared.studio.pets.create({
        petId: registration.petId,
        definitionId: registration.definitionId ?? registration.petId,
        name: registration.name,
        channelId: 'fixture',
      });
    }
    await prepared.activatePlugins();
  } catch (error) {
    await prepared.studio.shutdown();
    throw error;
  }
  return prepared.studio;
}

/** Explicit test setup: the production Channel API never assembles definitions. */
export async function createChannelWithPets(
  studio: Studio,
  service: import('../../plugins/channel/src/channelService').ChannelService,
  actor: import('../../plugins/channel/src/store/channelStore').MemberRef,
  input: { title: string; pets: string[]; description?: string; prompt?: string },
  access: import('../../plugins/channel/src/channelService').ChannelManageAccess = {},
) {
  const { pets, ...metadata } = input;
  for (const petId of pets) {
    if (await studio.pets.get(petId)) throw new Error(`Test setup cannot reuse Pet "${petId}" in another Channel.`);
    if (!studio.pets.definitions().some(definition => definition.definitionId === petId)) throw new Error(`Unknown fixture definition "${petId}".`);
  }
  const result = await service.createChannel(actor, { ...metadata, pets: [] }, access);
  for (const petId of pets) {
    const definition = studio.pets.definitions().find(definition => definition.definitionId === petId)!;
    await studio.pets.create({ petId, definitionId: petId, name: definition.name, channelId: result.channel.channelId });
  }
  return { channel: result.channel, members: await service.members(result.channel.channelId) };
}
