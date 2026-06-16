import { tool } from '@langchain/core/tools';
import {
  type AgentToolkit,
  type CapabilityArtifactKind,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';
import { z } from 'zod';

const artifactKindSchema = z.enum([
  'result',
  'report',
  'image',
  'video',
  'audio',
  'pdf',
  'file',
  'bundle',
]);

function requireThreadId(threadId: string | null | undefined) {
  if (!threadId) {
    throw new Error('capability artifact tools require a thread_id');
  }
  return threadId;
}

export function createCapabilityArtifactToolkit(store: CapabilityArtifactStore): AgentToolkit {
  return {
    name: 'capability_artifact',
    description: '读取、列出和写入当前会话线程的 capability artifacts。',
    exposure: {
      general: false,
    },
    tools: (ctx) => {
      return [
        tool(async (input) => {
          const threadId = requireThreadId(ctx.threadId);
          let content = input.content;
          if (input.kind === 'result' && ctx.resultSchema) {
            const parsed = ctx.resultSchema.safeParse(content);
            if (!parsed.success) {
              throw new Error(`capability result artifact failed schema validation: ${parsed.error.message}`);
            }
            content = parsed.data;
          }
          const ref = await store.writeArtifact({
            threadId,
            capabilityId: ctx.capabilityId || 'toolkit',
            delegationId: input.delegationId || ctx.delegationId || 'manual',
            turnId: input.turnId || ctx.turnId || 'manual',
            artifact: {
              kind: input.kind as CapabilityArtifactKind,
              mimeType: input.mimeType,
              title: input.title,
              preview: input.preview,
              schema: input.schema,
              content,
              externalUri: input.externalUri,
              metadata: input.metadata,
            },
          });
          await ctx.recordCapabilityArtifact?.(ref);
          return JSON.stringify(ref, null, 2);
        }, {
          name: 'capability_artifact_write',
          description: '把当前任务产出的文本、JSON、二进制内容或远程媒体引用保存为 capability artifact，并返回 artifact ref。',
          schema: z.object({
            kind: artifactKindSchema,
            mimeType: z.string().min(1),
            title: z.string().optional(),
            preview: z.string().optional(),
            schema: z.object({
              name: z.string().min(1),
              version: z.number().int().positive(),
            }).optional(),
            content: z.unknown().optional(),
            externalUri: z.string().url().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
            delegationId: z.string().optional(),
            turnId: z.string().optional(),
          }).refine((value) => (value.content !== undefined) !== Boolean(value.externalUri), {
            message: 'Provide exactly one of content or externalUri',
          }),
        }),
        tool(async (input) => {
          const threadId = requireThreadId(ctx.threadId);
          const refs = await store.listArtifacts({
            threadId,
            capabilityId: input.capabilityId,
            kind: input.kind,
            limit: input.limit,
          });
          return JSON.stringify(refs, null, 2);
        }, {
          name: 'capability_artifact_list',
          description: '列出当前会话线程已有的 capability artifact refs。只返回短引用和 preview。',
          schema: z.object({
            capabilityId: z.string().optional(),
            kind: artifactKindSchema.optional(),
            limit: z.number().int().positive().max(100).optional(),
          }),
        }),
        tool(async (input) => {
          const threadId = requireThreadId(ctx.threadId);
          const result = await store.readArtifact({
            uri: input.uri,
            maxBytes: input.maxBytes,
            threadId,
          });
          return JSON.stringify(result, null, 2);
        }, {
          name: 'capability_artifact_read',
          description: '读取一个 capability artifact 的内容。默认最多读取 64KB。',
          schema: z.object({
            uri: z.string().min(1),
            maxBytes: z.number().int().positive().max(1_000_000).optional(),
          }),
        }),
      ];
    },
    instructions: [
      '需要复用当前会话内已有能力产物时，先用 capability_artifact_list 查看短引用，再按需 capability_artifact_read。',
      '需要保存长报告、结构化结果或媒体产物引用时，使用 capability_artifact_write；inline 内容用 content，远程 URL 用 externalUri；不要把大内容直接写进普通回复。',
    ],
    operations: {
      capability_artifact_write: {
        title: '保存能力产物',
        summarizeInput: (input) => ({
          summary: '保存 capability artifact',
          details: input && typeof input === 'object' ? {
            kind: (input as Record<string, unknown>).kind,
            mimeType: (input as Record<string, unknown>).mimeType,
            title: (input as Record<string, unknown>).title,
          } : undefined,
        }),
      },
      capability_artifact_list: {
        title: '列出能力产物',
      },
      capability_artifact_read: {
        title: '读取能力产物',
        summarizeInput: (input) => ({
          summary: '读取 capability artifact',
          target: input && typeof input === 'object'
            ? String((input as Record<string, unknown>).uri ?? '')
            : undefined,
        }),
      },
    },
  };
}
