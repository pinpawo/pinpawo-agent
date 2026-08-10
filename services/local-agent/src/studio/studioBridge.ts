import type { AgentActor } from '@pinpawo/pet-agent';

import type { PetLocalConfig } from './petConfig';

/**
 * Studio 的 pet 身份装配。
 *
 * HITL 相关的桥接曾经也住在这里(#561 前);现已随 Studio 私有 HITL 循环
 * 一并退役 —— review 不经 Studio,客户端与 pet-agent 直接往来。
 */

export function buildPetActorFromLocalConfig(
  petConfig: PetLocalConfig,
  ownerUserId: string | null,
): AgentActor {
  return {
    petId: petConfig.petId,
    userId: ownerUserId,
    name: petConfig.name,
    personality: petConfig.personality ?? null,
    stage: petConfig.stage ?? null,
    species: petConfig.species ?? null,
  };
}
