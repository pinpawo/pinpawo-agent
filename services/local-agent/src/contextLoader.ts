import { LOCAL_ACTOR_ID, LOCAL_ACTOR_NAME } from './actorSelection';

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

/**
 * The pet profile the local host runs under.
 *
 * The Hasura-backed profile and memory query were removed with the hosted-app
 * relay: this host no longer talks to a backend. A Studio plugin owns any
 * remote-sourced profile or memory (#638), so nothing here is async.
 */
export function buildAgentContext(actorId = LOCAL_ACTOR_ID): AgentContext {
  return {
    pet: {
      id: actorId,
      name: LOCAL_ACTOR_NAME,
      personality: null,
      species: 'local',
      stage: null,
      growth_value: null,
      stage_asset_id: null,
    },
    context: {
      petMemoryText: '',
      recentChatTurns: [],
      today: new Date().toISOString().slice(0, 10),
    },
  };
}

/**
 * Async wrapper kept because it is the injection seam the server handlers and
 * the TUI host tests override (`loadContext`). Loading is local and synchronous
 * now, but a Studio-plugin-backed profile would be async again.
 */
export async function loadAgentContext(actorId: string): Promise<AgentContext> {
  return buildAgentContext(actorId);
}
