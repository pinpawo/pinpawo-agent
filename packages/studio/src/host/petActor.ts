import type { AgentActor } from '@pinpawo/pet-agent';

import type { PetLocalConfig } from './petConfig';

/**
 * 从 Studio pet 配置合成 AgentActor。
 *
 * Studio 模式下 pet 身份是**本地 source of truth** —— 名称 / personality
 * 等都来自 `<workdir>/.pinpawo/pets/<petId>.json`,不依赖服务端 pet 记录。
 * `ownerUserId` 通常为 null(纯离线);若已登录服务端,可传入对应 user id
 * 用于 trace / attribution。
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
