import { gql } from './graphqlClient';
import { config } from './config';
import { LOCAL_ONLY_ACTOR_ID, LOCAL_ONLY_ACTOR_NAME } from './actorSelection';
import type { TrendPromptItem } from './capabilities/dailyPost';

export type PetProfile = {
  id: string;
  name: string;
  personality: string | null;
  species: string | null;
  stage: string | null;
  growth_value: number | null;
  stage_asset_id: string | null;
};

export type TrendItem = TrendPromptItem;

export type RecentPost = {
  content: string;
  topic: string | null;
  tags: string[] | null;
  created_at: string;
};

export type AgentContext = {
  pet: PetProfile;
  context: {
    petMemoryText: string;
    recentChatTurns: Array<{ userMessage: string | null; petMessage: string | null }>;
    recentDaily: RecentPost[];
    trendItems: TrendItem[];
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

type GqlPost = {
  content: string;
  topic: string | null;
  tags: string[] | null;
  created_at: string;
};

type GqlTrendImpression = {
  trend_item_id: string;
};

type GqlTrendItem = {
  id: string;
  platform: string;
  topic: string | null;
  title: string;
  summary: string | null;
  url?: string | null;
  hot_score: number;
  liked_count?: number | null;
  image_urls: string[] | null;
  cached_image_urls: string[] | null;
};

type GqlPet = {
  id: string;
  name: string;
  personality: string | null;
  template: { species: string | null } | null;
  pet_state: { stage: string; growth_value: number; stage_asset_id: string | null } | null;
  pet_agent_memories: GqlMemory[];
  pet_agent_posts: GqlPost[];
  pet_trend_impressions: GqlTrendImpression[];
};

type GqlPetAgent = {
  pet: GqlPet | null;
};

type ContextQueryResult = {
  pet_agents: GqlPetAgent[];
  trend_items: GqlTrendItem[];
};

// ---- Query ----

const CONTEXT_QUERY = `
  query GetAgentContext($since: timestamptz!, $actorId: uuid!) {
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
        pet_agent_posts(
          where: { post_type: { _eq: "daily" } }
          order_by: [{ created_at: desc }]
          limit: 8
        ) {
          content
          topic
          tags
          created_at
        }
        pet_trend_impressions(
          where: { status: { _eq: "used" } }
        ) {
          trend_item_id
        }
      }
    }
    trend_items(
      where: {
        status: { _eq: "active" }
        created_at: { _gte: $since }
      }
      order_by: [{ hot_score: desc_nulls_last }, { created_at: desc }]
      limit: 20
    ) {
      id
      platform
      topic
      title
      summary
      url
      hot_score
      liked_count
      image_urls
      cached_image_urls
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

// ---- next_tick_at query ----

const NEXT_TICK_QUERY = `
  query GetNextTick($actorId: uuid!) {
    pet_agents(
      where: {
        status: { _eq: "active" }
        pet_id: { _eq: $actorId }
      }
      limit: 1
    ) {
      next_tick_at
    }
  }
`;

export async function getNextTickAt(actorId: string): Promise<Date | null> {
  if (!config.apiConnected) return null;
  const data = await gql<{ pet_agents: { next_tick_at: string | null }[] }>(NEXT_TICK_QUERY, {
    actorId,
  });
  const raw = data.pet_agents[0]?.next_tick_at;
  return raw ? new Date(raw) : null;
}

// ---- Heartbeat mutation ----

const HEARTBEAT_MUTATION = `
  mutation Heartbeat($actorId: uuid!, $nextTickAt: timestamptz!) {
    update_pet_agents(
      where: {
        status: { _eq: "active" }
        pet_id: { _eq: $actorId }
      }
      _set: { next_tick_at: $nextTickAt }
    ) {
      affected_rows
    }
  }
`;

export async function sendHeartbeat(actorId: string): Promise<void> {
  if (!config.apiConnected) return;
  const nextTickAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await gql(HEARTBEAT_MUTATION, { actorId, nextTickAt });
}

// ---- Context loader ----

export function buildLocalOnlyAgentContext(actorId = LOCAL_ONLY_ACTOR_ID): AgentContext {
  const today = new Date().toISOString().slice(0, 10);
  return {
    pet: {
      id: actorId,
      name: LOCAL_ONLY_ACTOR_NAME,
      personality: 'Local-only mode. API-backed memory, posts, trends, hosted relay, and mobile control are unavailable until login.',
      species: 'local',
      stage: null,
      growth_value: null,
      stage_asset_id: null,
    },
    context: {
      petMemoryText: '',
      recentChatTurns: [],
      recentDaily: [],
      trendItems: [],
      today,
    },
  };
}

export async function loadAgentContext(actorId: string): Promise<AgentContext> {
  if (!config.apiConnected) {
    return buildLocalOnlyAgentContext(actorId);
  }
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const data = await gql<ContextQueryResult>(CONTEXT_QUERY, { since, actorId });

  const pet = data.pet_agents[0]?.pet;
  if (!pet) throw new Error(`No active actor found for actorId=${actorId}`);

  const usedTrendIds = new Set(pet.pet_trend_impressions.map((i) => i.trend_item_id));

  const trendItems: TrendItem[] = data.trend_items
    .filter((t) => !usedTrendIds.has(t.id))
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      platform: t.platform,
      topic: t.topic ?? null,
      title: t.title,
      summary: t.summary,
      url: t.url ?? null,
      score: t.hot_score,
      likedCount: t.liked_count ?? null,
      imageUrls: t.cached_image_urls ?? t.image_urls,
    }));

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
      recentDaily: pet.pet_agent_posts,
      trendItems,
      today,
    },
  };
}
