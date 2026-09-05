import type { AgentActor } from '@pinpawo/pet-agent';
import type { PetLocalConfig } from './petConfig';

/** Host display/attribution metadata; Pet behavior is supplied by PET.md. */
export function buildPetActorFromLocalConfig(
  petConfig: PetLocalConfig,
  ownerUserId: string | null,
): AgentActor {
  return { userId: ownerUserId, name: petConfig.name };
}
