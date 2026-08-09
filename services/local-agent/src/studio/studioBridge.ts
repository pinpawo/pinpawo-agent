import {
  type AgentActor,
  projectHumanReviewRequest,
  type ReviewResponse,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
import {
  type HumanReviewer,
  type HumanReviewerRequest,
} from '@pinpawo/studio';

import type { PetLocalConfig } from './petConfig';

/**
 * 当前 ws 连接上正等用户答复的 HITL。
 *
 * 设计立场:
 * - Studio 内 pet 触发 humanReviewer → 把 promise resolver 放进 slot
 * - local server 收到 canonical human_review_response → 调 resolveReview 喂给 resolver
 * - **同一 ws 连接上同时只允许一个 pending review**(顺序 dispatch + 单 user TUI 假设)
 *   如果 pet runtime 在前一个 review 未答时又触发 humanReviewer,直接 reject。
 */
export type PendingReview = {
  resolve: (response: ReviewResponse) => void;
  reject: (error: Error) => void;
  petId: string;
  reviewId: string;
  reviewSpec: ReviewSpec;
};

export type PendingReviewSlot = {
  current: PendingReview | null;
};

export function createPendingReviewSlot(): PendingReviewSlot {
  return { current: null };
}

/**
 * 喂答复给当前 pending review。返回 true 表示有 pending 被 resolve;false 表示 slot 空。
 */
export function resolveReview(slot: PendingReviewSlot, response: ReviewResponse): boolean {
  const pending = slot.current;
  if (!pending) return false;
  slot.current = null;
  pending.resolve(response);
  return true;
}

/**
 * 主动拒绝当前 pending review(用于 ws 断开 / signal abort 等清理场景)。
 */
export function rejectReview(slot: PendingReviewSlot, error: Error): boolean {
  const pending = slot.current;
  if (!pending) return false;
  slot.current = null;
  pending.reject(error);
  return true;
}

/**
 * 构造一个绑定到当前 ws 连接的 humanReviewer 回调,交给 PetAgentRuntime 构造时注入。
 *
 * 内部:
 * - 推 `human_review.requested` 事件
 * - 把 promise resolver 寄存到 slot,等待外部 `resolveReview()` 喂答复
 */
export function createWsHumanReviewer(opts: {
  send: (msg: unknown) => void;
  requestId: string;
  petId: string;
  slot: PendingReviewSlot;
}): HumanReviewer {
  return (request: HumanReviewerRequest) => {
    return new Promise<ReviewResponse>((resolve, reject) => {
      if (opts.slot.current) {
        reject(new Error(
          `Another HITL is already pending (petId=${opts.slot.current.petId}, reviewId=${opts.slot.current.reviewId})`,
        ));
        return;
      }
      const reviewId = request.review.id;
      const review = request.review;
      opts.slot.current = { resolve, reject, petId: opts.petId, reviewId, reviewSpec: review };
      opts.send({
        requestId: opts.requestId,
        type: 'event',
        event: {
          type: 'human_review.requested',
          requestId: opts.requestId,
          review: projectHumanReviewRequest(review),
          actor: { petId: opts.petId },
        },
      });
    });
  };
}

/**
 * 从本地 pet 配置合成 AgentActor。
 *
 * Studio 模式下 pet 身份是**本地 source of truth**——pet 名称 / personality 等都
 * 来自 `<workdir>/.pinpawo/pets/<petId>.json`,不依赖服务端 pet 记录。`ownerUserId` 通常为 null
 * (纯离线模式);若 local-agent 已登录服务端,可传入对应 user id 用于 trace / attribution。
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
