import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  defineToolset,
  readBoolean,
  readRecord,
  readString,
  readStringArray,
  resultStatusSummary,
  type AgentActor,
  type AgentModels,
  type AgentToolset,
  type NamedStructuredTool,
  type ToolkitOperationMetadata,
} from '@pinpawo/pet-agent';
import type { DailyPostPayload, RecentDailyPost, TrendPromptItem } from './types';
import { isSemanticDuplicate, isUuid } from './utils';
import { dailyPostResultSchema, finalizePostSchema } from './schemas';
import type { DailyPostResultShape } from './schemas';

type SavePostParams = {
  actor: AgentActor;
  payload: DailyPostPayload;
  trendItems: TrendPromptItem[];
  selectedTrendId: string | null;
  raw: string;
  attempts: number;
  duplicateRetries: number;
  dryRun?: boolean;
};

type SavePostResult = {
  postId: string | null;
};

type RetryableToolResult = {
  ok: false;
  reason: string;
  hint: string;
  imageRequested: false;
};

export type DailyPostToolOptions = {
  actor: AgentActor;
  models: AgentModels;
  dryRun?: boolean;
  recentDaily?: RecentDailyPost[];
  trendItems?: TrendPromptItem[];
  savePost: (params: SavePostParams) => Promise<SavePostResult>;
  markUsed?: (trendItemId: string, extra?: { sourcePostId?: string }) => Promise<void>;
  markSkipped?: (trendItemId: string, reason: string) => Promise<void>;
  requestImageProcessing?: (params: {
    postId: string;
    actor: AgentActor;
    payload: DailyPostPayload;
    selectedTrendId: string | null;
  }) => Promise<void>;
};

function findTrendById(trendItems: TrendPromptItem[], id: string | null | undefined): TrendPromptItem | null {
  if (!id) return null;
  return trendItems.find((t) => t.id === id) ?? null;
}

function buildDailyPostPayload(
  value: Awaited<ReturnType<typeof finalizePostSchema.parseAsync>>,
  selectedTrend: TrendPromptItem | null,
): DailyPostPayload {
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim()).slice(0, 4)
    : [];
  const citations = Array.isArray(value.citations)
    ? value.citations.filter((id) => typeof id === 'string' && isUuid(id.trim())).map((id) => id.trim()).slice(0, 3)
    : [];

  if (selectedTrend && !citations.includes(selectedTrend.id)) {
    citations.push(selectedTrend.id);
    if (citations.length > 3) {
      citations.length = 3;
    }
  }

  return {
    intent: typeof value.intent === 'string' && value.intent.trim() ? value.intent.trim() : null,
    angle: typeof value.angle === 'string' && value.angle.trim() ? value.angle.trim() : null,
    whyToday: typeof value.whyToday === 'string' && value.whyToday.trim() ? value.whyToday.trim() : null,
    content: value.content.trim(),
    mood: typeof value.mood === 'string' && value.mood.trim() ? value.mood.trim() : null,
    topic: typeof value.topic === 'string' && value.topic.trim() ? value.topic.trim() : null,
    tags,
    citations,
    image: null,
  };
}

function retryableResult(result: RetryableToolResult): [string, null] {
  return [JSON.stringify(result), null];
}

function finalResult(result: DailyPostResultShape): [string, DailyPostResultShape] {
  const parsed = dailyPostResultSchema.parse(result);
  return [JSON.stringify(parsed), parsed];
}

function finalizePostInputSummary(input: unknown) {
  const record = readRecord(input);
  const mode = readString(record, 'mode');
  const topic = readString(record, 'topic');
  const content = readString(record, 'content');
  const tags = readStringArray(record, 'tags');
  const citations = readStringArray(record, 'citations');
  const requestImage = readBoolean(record, 'requestImage');
  return mode || topic
    ? {
        target: topic ?? mode,
        summary: mode === 'repost' ? '转发动态' : '保存原创动态',
        details: {
          mode,
          topic,
          requestImage,
          contentLength: content?.length,
          tagCount: tags.length,
          citationCount: citations.length,
        },
      }
    : null;
}

function skipPostInputSummary(input: unknown) {
  const record = readRecord(input);
  const reason = readString(record, 'reason');
  return {
    summary: '跳过动态',
    details: {
      reason,
    },
  };
}

const dailyPostResultLabels: Record<string, string> = {
  created: '动态已保存',
  skipped: '动态已跳过',
  failed: '动态处理失败',
};

const dailyPostOperationMetadata = {
  finalize_post: {
    title: '保存动态',
    summarizeInput: finalizePostInputSummary,
    summarizeOutput: (output) => resultStatusSummary(output, dailyPostResultLabels),
    summarizeError: () => ({ summary: '动态保存失败' }),
  },
  skip_post: {
    title: '跳过动态',
    summarizeInput: skipPostInputSummary,
    summarizeOutput: (output) => resultStatusSummary(output, dailyPostResultLabels),
    summarizeError: () => ({ summary: '跳过动态失败' }),
  },
} satisfies Record<'finalize_post' | 'skip_post', ToolkitOperationMetadata>;

export function createFinalizePostTool(options: DailyPostToolOptions): StructuredTool {
  let duplicateRetries = 0;
  const maxDuplicateRetries = 2;

  return tool(
    async (input) => {
      const parsed = finalizePostSchema.safeParse(input);
      if (!parsed.success) {
        return retryableResult({
          ok: false,
          reason: 'invalid-input',
          hint: parsed.error.issues[0]?.message ?? 'invalid payload',
          imageRequested: false,
        });
      }

      const value = parsed.data;
      const selectedTrend = findTrendById(options.trendItems ?? [], value.repostTrendId);

      if (value.mode === 'repost') {
        if (!selectedTrend) {
          return retryableResult({
            ok: false,
            reason: 'repost-unavailable',
            hint: '转发模式需要提供 repostTrendId，且该 id 必须存在于可用热点中。',
            imageRequested: false,
          });
        }
      }

      const payload = buildDailyPostPayload(value, selectedTrend);
      if (isSemanticDuplicate(payload, options.recentDaily ?? [])) {
        duplicateRetries += 1;
        if (duplicateRetries >= maxDuplicateRetries) {
          return finalResult({
            status: 'skipped',
            postId: null,
            reason: 'duplicate-limit',
            payload: null,
            imageRequested: false,
          });
        }
        return retryableResult({
          ok: false,
          reason: 'duplicate',
          hint: '内容与近期动态重复，请换一个角度或话题重新创作。',
          imageRequested: false,
        });
      }

      let saveResult: SavePostResult;
      try {
        saveResult = await options.savePost({
          actor: options.actor,
          payload,
          trendItems: options.trendItems ?? [],
          selectedTrendId: selectedTrend?.id ?? null,
          raw: JSON.stringify(payload),
          attempts: 1,
          duplicateRetries,
          dryRun: options.dryRun,
        });
      } catch (error) {
        return finalResult({
          status: 'failed',
          postId: null,
          reason: `save-error:${error instanceof Error ? error.message : error}`,
          payload: null,
          imageRequested: false,
        });
      }

      if (!saveResult.postId) {
        return finalResult({
          status: 'failed',
          postId: null,
          reason: 'save-no-post',
          payload: null,
          imageRequested: false,
        });
      }

      for (const trendItemId of payload.citations) {
        await options.markUsed?.(trendItemId, { sourcePostId: saveResult.postId }).catch(() => {});
      }

      const isRepost = value.mode === 'repost';
      const imageRequested = value.requestImage === true && !isRepost;
      if (imageRequested && options.requestImageProcessing) {
        await options.requestImageProcessing({
          postId: saveResult.postId,
          actor: options.actor,
          payload,
          selectedTrendId: selectedTrend?.id ?? null,
        }).catch(() => {});
      }

      return finalResult({
        status: 'created',
        postId: saveResult.postId,
        reason: null,
        payload,
        imageRequested,
      });
    },
    {
      name: 'finalize_post',
      description: '确定正文和发布方式。若原创内容适合配图，在 finalize_post 中设置 requestImage: true。repost 不需要配图。',
      schema: finalizePostSchema,
      responseFormat: 'content_and_artifact',
    },
  );
}

export function createSkipPostTool(options: DailyPostToolOptions): StructuredTool {
  return tool(
    async (input: { reason: string }) => {
      return finalResult({
        status: 'skipped',
        postId: null,
        reason: input.reason,
        payload: null,
        imageRequested: false,
      });
    },
    {
      name: 'skip_post',
      description: '今天确实写不出来时跳过。',
      schema: z.object({ reason: z.string() }),
      responseFormat: 'content_and_artifact',
    },
  );
}

export function buildDailyPostTools(options: DailyPostToolOptions): StructuredTool[] {
  return [
    createFinalizePostTool(options),
    createSkipPostTool(options),
  ];
}

export function createDailyPostToolset(options: DailyPostToolOptions): AgentToolset {
  const tools = buildDailyPostTools(options) as [
    NamedStructuredTool<'finalize_post'>,
    NamedStructuredTool<'skip_post'>,
  ];
  return defineToolset({
    name: 'daily_post',
    description: '生成、保存或跳过 daily post 的 capability-private toolset。',
    tools,
    operations: dailyPostOperationMetadata,
  });
}
