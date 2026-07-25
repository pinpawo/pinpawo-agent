import {
  defineCapability,
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import type { DailyPostPayload } from './types';
import { dailyPostInstructions } from './instructions';

export { dailyPostResultSchema } from './schemas';
export { buildDailyPostTaskMessage } from './task';
export type {
  DailyImagePlan,
  DailyPostPayload,
  RecentDailyPost,
  TrendPromptItem,
} from './types';

export type DailyPostResult = {
  status: 'created' | 'skipped' | 'failed';
  postId: string | null;
  reason: string | null;
  payload: DailyPostPayload | null;
  imageRequested: boolean;
};

export type DailyPostCapabilityOptions = {
  instructions?: string;
};

export function createDailyPostCapability(
  options: DailyPostCapabilityOptions = {},
): AgentCapability {
  return defineCapability({
    name: 'daily_post',
    description: '生成、保存或跳过 daily post，并产出本轮动态处理结果。',
    uses: ['daily_post'],
    instructions: defineInstructionDocument({
      content: options.instructions ?? dailyPostInstructions,
    }),
  });
}

export { createDailyPostToolkit } from './tools';
export type { DailyPostToolOptions } from './tools';
