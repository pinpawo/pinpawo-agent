import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { gql } from './graphqlClient';
import { config } from './config';
import { LOCAL_ONLY_ACTOR_ID, LOCAL_ONLY_ACTOR_NAME } from './contextLoader';
import { loadStoredConfig, saveStoredConfig } from './storage';

export type AvailableActor = {
  actorId: string;
  name: string;
  species: string | null;
  personality: string | null;
  stage: string | null;
};

type ActorQueryResult = {
  user_pets: Array<{
    pet: {
      id: string;
      name: string;
      personality: string | null;
      template: { species: string | null } | null;
      pet_state: { stage: string | null } | null;
    } | null;
  }>;
};

const AVAILABLE_ACTORS_QUERY = `
  query ListAvailableActors {
    user_pets(order_by: [{ is_primary: desc }, { created_at: desc }]) {
      pet {
        id
        name
        personality
        template {
          species
        }
        pet_state {
          stage
        }
      }
    }
  }
`;

function formatActorLabel(actor: AvailableActor) {
  const details = [
    actor.species,
    actor.stage,
    actor.personality,
  ].filter(Boolean);
  return details.length > 0
    ? `${actor.name} (${details.join(' / ')})`
    : actor.name;
}

function persistActor(actorId: string, actorName: string) {
  const stored = loadStoredConfig();
  saveStoredConfig({ ...stored, actor_id: actorId, actor_name: actorName });
}

function clearActorId() {
  const stored = loadStoredConfig();
  if (!stored.actor_id) return;
  saveStoredConfig({ ...stored, actor_id: undefined, actor_name: undefined });
}

export function loadSelectedActorId(): string | null {
  return loadStoredConfig().actor_id ?? null;
}

export function loadSelectedActorName(): string | null {
  return loadStoredConfig().actor_name ?? null;
}

export async function listAvailableActors(): Promise<AvailableActor[]> {
  if (config.connectionMode === 'local-only') {
    return [{
      actorId: LOCAL_ONLY_ACTOR_ID,
      name: LOCAL_ONLY_ACTOR_NAME,
      species: 'local runtime',
      personality: 'pragmatic local assistant',
      stage: 'local-only',
    }];
  }

  const data = await gql<ActorQueryResult>(AVAILABLE_ACTORS_QUERY);
  const seen = new Set<string>();
  const actors: AvailableActor[] = [];

  for (const row of data.user_pets) {
    const pet = row.pet;
    if (!pet || seen.has(pet.id)) continue;
    seen.add(pet.id);
    actors.push({
      actorId: pet.id,
      name: pet.name,
      species: pet.template?.species ?? null,
      personality: pet.personality,
      stage: pet.pet_state?.stage ?? null,
    });
  }

  return actors;
}

export async function selectActorInteractively(options?: {
  currentActorId?: string | null;
  reason?: string;
}): Promise<string> {
  const actors = await listAvailableActors();
  if (actors.length === 0) {
    throw new Error('No active actors found for this account');
  }

  const rl = createInterface({ input, output });
  try {
    if (options?.reason) {
      console.log(`\n${options.reason}\n`);
    } else {
      console.log('\nSelect the actor for this local agent:\n');
    }

    actors.forEach((actor, index) => {
      const marker = actor.actorId === options?.currentActorId ? ' [current]' : '';
      console.log(`  ${index + 1}. ${formatActorLabel(actor)}${marker}`);
    });

    while (true) {
      const answer = (await rl.question('\nActor number: ')).trim();
      const selectedIndex = Number(answer);
      if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= actors.length) {
        const selectedActor = actors[selectedIndex - 1];
        persistActor(selectedActor.actorId, selectedActor.name);
        console.log(`Selected actor: ${formatActorLabel(selectedActor)}\n`);
        return selectedActor.actorId;
      }
      console.log(`Please enter a number between 1 and ${actors.length}.`);
    }
  } finally {
    rl.close();
  }
}

export async function ensureActorSelected(options?: {
  interactive?: boolean;
}): Promise<string> {
  if (config.connectionMode === 'local-only') {
    return LOCAL_ONLY_ACTOR_ID;
  }

  const interactive = options?.interactive ?? false;
  const storedActorId = loadSelectedActorId();
  const actors = await listAvailableActors();
  const matchedActor = storedActorId
    ? actors.find((actor) => actor.actorId === storedActorId) ?? null
    : null;

  if (matchedActor) {
    return matchedActor.actorId;
  }

  if (storedActorId) {
    clearActorId();
  }

  if (!interactive || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      storedActorId
        ? 'Configured actor is no longer available. Run "pinpawo-agent actor select" to choose a new actor.'
        : 'No actor selected. Run "pinpawo-agent actor select" or start the agent in an interactive terminal.'
    );
  }

  return selectActorInteractively({
    currentActorId: storedActorId,
    reason: storedActorId
      ? 'The configured actor is no longer available. Please choose a new actor.'
      : 'An actor must be selected before the local agent can start.',
  });
}

export async function runActorSelect() {
  const currentActorId = loadSelectedActorId();
  await selectActorInteractively({
    currentActorId,
    reason: 'Choose the actor that this local agent should control.',
  });
}
