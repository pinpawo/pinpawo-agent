import { config } from './config';

export type PostPayload = {
  content: string;
  mood?: string | null;
  topic?: string | null;
  tags?: string[];
  citations?: string[];
  repost_trend_id?: string;
  image_url?: string | null;
  image_plan?: {
    prompt: string;
    negativePrompt?: string;
    style?: string;
    shot?: string;
    seed?: string;
  };
};

function assertApiConnected(operation: string) {
  if (config.connectionMode !== 'api-connected') {
    throw new Error(`${operation} requires API login; local-only mode does not have API server credentials`);
  }
}

export async function submitPost(payload: PostPayload): Promise<{ post_id: string }> {
  assertApiConnected('submitPost');
  const res = await fetch(`${config.apiBaseUrl}/agent/post`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.agentToken}`,
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json();

  if (!res.ok) {
    const msg = (json as { message?: string; error?: string }).message
      ?? (json as { message?: string; error?: string }).error
      ?? res.statusText;
    throw Object.assign(new Error(`POST /agent/post → ${res.status}: ${msg}`), {
      status: res.status,
    });
  }

  return json as { post_id: string };
}

export async function requestPostImage(postId: string): Promise<void> {
  assertApiConnected('requestPostImage');
  const res = await fetch(`${config.apiBaseUrl}/agent/post/${postId}/image-request`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.agentToken}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH /agent/post/${postId}/image-request → ${res.status}: ${text}`);
  }
}

export type TrendItemInput = {
  title: string;
  summary?: string;
  url?: string;
  topic?: string;
  hot_score?: number;
  liked_count?: number;
  image_urls?: string[];
  note_id?: string;
};

export async function postTrends(
  platform: string,
  items: TrendItemInput[],
): Promise<{ accepted: number; duplicates: number }> {
  assertApiConnected('postTrends');
  const res = await fetch(`${config.apiBaseUrl}/agent/trends`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.agentToken}`,
    },
    body: JSON.stringify({ platform, items }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /agent/trends → ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ accepted: number; duplicates: number }>;
}
