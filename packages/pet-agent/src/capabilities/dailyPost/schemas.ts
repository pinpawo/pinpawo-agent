import { z } from 'zod';

export const finalizePostSchema = z.object({
  mode: z.enum(['original', 'repost']),
  content: z.string().min(1),
  intent: z.string().nullable().optional(),
  angle: z.string().nullable().optional(),
  whyToday: z.string().nullable().optional(),
  mood: z.string().nullable().optional(),
  topic: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  citations: z.array(z.string()).optional(),
  repostTrendId: z.string().nullable().optional(),
  requestImage: z.boolean().optional(),
});

export const imagePlanSchema = z.object({
  prompt: z.string().min(1),
  negativePrompt: z.string().min(1),
  style: z.string().min(1),
  shot: z.string().min(1),
  seed: z.string().min(1),
});

export const dailyPostResultSchema = z.object({
  status: z.enum(['created', 'skipped', 'failed']),
  postId: z.string().nullable(),
  reason: z.string().nullable(),
  payload: z.any().nullable(),
  imageRequested: z.boolean(),
});

export type DailyPostResultShape = z.infer<typeof dailyPostResultSchema>;
