import {
  readLatestToolArtifact,
  type AgentActor,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import type { DailyPostPayload, RecentDailyPost, TrendPromptItem } from './types';
import { dailyPostInstructions } from './instructions';
import { dailyPostResultSchema } from './schemas';
import { createDailyPostToolset } from './tools';

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
  recentDaily?: RecentDailyPost[];
  trendItems?: TrendPromptItem[];
  savePost: (params: {
    actor: AgentActor;
    payload: DailyPostPayload;
    trendItems: TrendPromptItem[];
    selectedTrendId: string | null;
    raw: string;
    attempts: number;
    duplicateRetries: number;
    dryRun?: boolean;
  }) => Promise<{ postId: string | null }>;
  markUsed?: (trendItemId: string, extra?: { sourcePostId?: string }) => Promise<void>;
  markSkipped?: (trendItemId: string, reason: string) => Promise<void>;
  requestImageProcessing?: (params: {
    postId: string;
    actor: AgentActor;
    payload: DailyPostPayload;
    selectedTrendId: string | null;
  }) => Promise<void>;
  instructions?: string[];
};

export function createDailyPostCapability(
  options: DailyPostCapabilityOptions,
): AgentCapability {
  return {
    name: 'daily_post',
    description: '生成、保存或跳过 daily post，并产出本轮动态处理结果。',
    createRuntime: async (context) => ({
      toolsets: [createDailyPostToolset({
        actor: context.actor,
        models: context.models,
        dryRun: context.execution?.dryRun,
        recentDaily: options.recentDaily,
        trendItems: options.trendItems,
        savePost: options.savePost,
        markUsed: options.markUsed,
        markSkipped: options.markSkipped,
        requestImageProcessing: options.requestImageProcessing,
      })],
      instructions: options.instructions ?? dailyPostInstructions,
      readResult: readLatestToolArtifact,
    }),
    resultSchema: dailyPostResultSchema,
  };
}
