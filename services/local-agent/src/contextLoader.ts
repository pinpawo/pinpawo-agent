import { LOCAL_ACTOR_ID, LOCAL_ACTOR_NAME } from './actorSelection';

/** Host identity and invocation metadata. Authored behavior belongs to PET.md. */
export type AgentContext = {
  pet: { id: string; name: string };
  /** Optional attribution for Host tracing callbacks only. */
  traceUserId?: string;
};

export function buildAgentContext(actorId = LOCAL_ACTOR_ID): AgentContext {
  return { pet: { id: actorId, name: LOCAL_ACTOR_NAME } };
}

/** Injectable Host identity loader; no cloud profile, memory or history hydration. */
export async function loadAgentContext(actorId: string): Promise<AgentContext> {
  return buildAgentContext(actorId);
}
