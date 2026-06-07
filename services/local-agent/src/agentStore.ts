import { gql } from './graphqlClient';
import { submitPost, requestPostImage } from './apiClient';
import type { DailyPostPayload } from './capabilities/dailyPost';

type ImpressionStatus = 'seen' | 'selected' | 'used' | 'skipped';

type StoredCandidate = {
  pet_id: string;
  owner_user_id: string | null;
  name: string;
  personality: string | null;
  stage: string | null;
  growth_value: number | null;
  stage_asset_id: string | null;
  species: string | null;
};

type StoredTrendItem = {
  id: string;
  platform: string;
  topic: string | null;
  title: string;
  summary: string | null;
  url?: string | null;
  score: number;
  liked_count?: number | null;
  image_urls: string[] | null;
  cached_image_urls?: string[] | null;
};

type SavePostParams = {
  candidate: StoredCandidate;
  payload: DailyPostPayload;
  trendItems: StoredTrendItem[];
  selectedTrendId: string | null;
  raw: string;
  attempts: number;
  duplicateRetries: number;
};

type SavePostResult = {
  postId: string | null;
};

export async function savePost(params: SavePostParams): Promise<SavePostResult> {
  const { payload } = params;

  const repostTrendId = params.selectedTrendId && payload.citations.includes(params.selectedTrendId)
    ? params.selectedTrendId
    : undefined;

  const body = {
    content: payload.content,
    mood: payload.mood,
    topic: payload.topic,
    tags: payload.tags,
    citations: payload.citations,
    repost_trend_id: repostTrendId,
    image_url: null,
    image_plan: payload.image?.prompt
      ? {
          prompt: payload.image.prompt,
          negativePrompt: payload.image.negativePrompt,
          style: payload.image.style,
          shot: payload.image.shot,
          seed: payload.image.seed,
        }
      : undefined,
  };

  const json = await submitPost(body);
  return { postId: json.post_id ?? null };
}

const UPSERT_IMPRESSION_MUTATION = `
  mutation UpsertImpression($petId: uuid!, $trendItemId: uuid!, $status: String!, $reason: String, $sourcePostId: uuid) {
    insert_pet_trend_impressions_one(
      object: {
        pet_id: $petId
        trend_item_id: $trendItemId
        status: $status
        reason: $reason
        source_post_id: $sourcePostId
      }
      on_conflict: {
        constraint: uq_pet_trend_impressions_pet_trend
        update_columns: [status, updated_at]
      }
    ) { id }
  }
`;

export async function upsertImpression(
  petId: string,
  trendItemId: string,
  status: ImpressionStatus,
  extra?: { sourcePostId?: string; reason?: string },
): Promise<void> {
  await gql(UPSERT_IMPRESSION_MUTATION, {
    petId,
    trendItemId,
    status,
    reason: extra?.reason ?? null,
    sourcePostId: extra?.sourcePostId ?? null,
  });
}

export async function requestImageProcessing(postId: string): Promise<void> {
  await requestPostImage(postId);
}

export const agentStore = {
  savePost,
  upsertImpression,
  requestImageProcessing,
};
