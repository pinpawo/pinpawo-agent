import { DEFAULT_CHAT_PET } from './defaultPet';

/** Host identity and invocation metadata. Authored behavior belongs to PET.md. */
export type AgentContext = {
  pet: { id: string; name: string };
  /** Optional attribution for Host tracing callbacks only. */
  traceUserId?: string;
};

export function buildAgentContext(petId = DEFAULT_CHAT_PET.petId): AgentContext {
  return { pet: { id: petId, name: DEFAULT_CHAT_PET.name } };
}

/** Injectable Host identity loader; no cloud profile, memory or history hydration. */
export async function loadAgentContext(petId: string): Promise<AgentContext> {
  return buildAgentContext(petId);
}
