import { gql } from './graphqlClient';
import { getConfig } from './config';
import { LOCAL_ONLY_ACTOR_ID, LOCAL_ONLY_ACTOR_NAME } from './actorSelection';

export type PetProfile = {
  id: string;
  name: string;
  personality: string | null;
  species: string | null;
  stage: string | null;
  growth_value: number | null;
  stage_asset_id: string | null;
};

export type AgentContext = {
  pet: PetProfile;
  context: {
    petMemoryText: string;
    recentChatTurns: Array<{ userMessage: string | null; petMessage: string | null }>;
    today: string;
  };
};

// ---- GraphQL response types ----

type GqlMemory = {
  memory_type: string;
  content: string;
  importance: number;
  confidence: number;
};

type GqlPet = {
  id: string;
  name: string;
  personality: string | null;
  template: { species: string | null } | null;
  pet_state: { stage: string; growth_value: number; stage_asset_id: string | null } | null;
  pet_agent_memories: GqlMemory[];
};

type GqlPetAgent = {
  pet: GqlPet | null;
};

type ContextQueryResult = {
  pet_agents: GqlPetAgent[];
};

// ---- Query ----

const CONTEXT_QUERY = `
  query GetAgentContext($actorId: uuid!) {
    pet_agents(
      where: {
        status: { _eq: "active" }
        pet_id: { _eq: $actorId }
      }
      order_by: [{ updated_at: desc }, { pet_id: asc }]
      limit: 1
    ) {
      pet {
        id
        name
        personality
        template {
          species
        }
        pet_state {
          stage
          growth_value
          stage_asset_id
        }
        pet_agent_memories(
          where: { status: { _eq: "active" } }
          order_by: [{ importance: desc }, { confidence: desc }, { updated_at: desc }]
          limit: 6
        ) {
          memory_type
          content
          importance
          confidence
        }
      }
    }
  }
`;

// ---- Formatter ----

function formatMemories(memories: GqlMemory[]): string {
  if (memories.length === 0) return '';
  return memories
    .map((m) => `[${m.memory_type}] ${m.content}`)
    .join('\n');
}

// ---- Context loader ----

export function buildLocalOnlyAgentContext(actorId = LOCAL_ONLY_ACTOR_ID): AgentContext {
  const today = new Date().toISOString().slice(0, 10);
  return {
    pet: {
      id: actorId,
      name: LOCAL_ONLY_ACTOR_NAME,
      personality: 'Local-only mode. API-backed memory, hosted relay, and mobile control are unavailable until login.',
      species: 'local',
      stage: null,
      growth_value: null,
      stage_asset_id: null,
    },
    context: {
      petMemoryText: '',
      recentChatTurns: [],
      today,
    },
  };
}

export async function loadAgentContext(actorId: string): Promise<AgentContext> {
  if (!getConfig().apiConnected) {
    return buildLocalOnlyAgentContext(actorId);
  }
  const data = await gql<ContextQueryResult>(CONTEXT_QUERY, { actorId });

  const pet = data.pet_agents[0]?.pet;
  if (!pet) throw new Error(`No active actor found for actorId=${actorId}`);

  const today = new Date().toISOString().slice(0, 10);

  return {
    pet: {
      id: pet.id,
      name: pet.name,
      personality: pet.personality,
      species: pet.template?.species ?? null,
      stage: pet.pet_state?.stage ?? null,
      growth_value: pet.pet_state?.growth_value ?? null,
      stage_asset_id: pet.pet_state?.stage_asset_id ?? null,
    },
    context: {
      petMemoryText: formatMemories(pet.pet_agent_memories),
      recentChatTurns: [],
      today,
    },
  };
}
