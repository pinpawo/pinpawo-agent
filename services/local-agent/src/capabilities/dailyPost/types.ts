export type TrendPromptItem = {
  id: string;
  platform: string;
  topic: string | null;
  title: string;
  summary: string | null;
  url?: string | null;
  score: number;
  likedCount?: number | null;
  imageUrls: string[] | null;
  raw?: Record<string, unknown> | null;
};

export type RecentDailyPost = {
  content: string;
  topic: string | null;
  tags: string[] | null;
  createdAt: Date | string;
};

export type DailyImagePlan = {
  prompt: string;
  negativePrompt: string;
  style: string;
  shot: string;
  seed: string;
};

export type DailyPostPayload = {
  intent: string | null;
  angle: string | null;
  whyToday: string | null;
  content: string;
  mood: string | null;
  topic: string | null;
  tags: string[];
  citations: string[];
  image: DailyImagePlan | null;
};
