import { existsSync } from 'node:fs';
import type {
  TuiCoreRuntimeSnapshot,
  TuiCoreSessionSnapshot,
  TuiCoreTimelineEntry,
} from './tui/contracts/tuiCoreContract';
import type { PendingReviewSnapshot } from './localServerChatHandler';
import type { LocalServerDeps } from './localServerTypes';
import type { TuiHistoryMessage } from './localServerTuiSessions';
import { DEFAULT_STUDIO_CONFIG_PATH } from './studio/studioConfig';

export function buildLocalServerTuiSnapshot(params: {
  sessionId: string;
  kind: TuiCoreSessionSnapshot['kind'];
  messages: TuiHistoryMessage[];
  deps: LocalServerDeps;
  pendingReview?: PendingReviewSnapshot | null;
}): TuiCoreSessionSnapshot {
  const timeline = timelineFromHistoryMessages(params.messages);
  const pendingReview = params.pendingReview ?? null;
  return {
    sessionId: params.sessionId,
    kind: params.kind,
    timeline,
    runs: pendingReview
      ? [runFromPendingReview({
          pendingReview,
          sessionId: params.sessionId,
          kind: params.kind,
          timeline,
        })]
      : [],
    ...(pendingReview ? {
      activeRunId: pendingReview.requestId,
      pendingReviewId: pendingReview.reviewId,
    } : {}),
    runtime: buildLocalServerTuiRuntimeSnapshot(params.deps),
  };
}

export function buildLocalServerTuiRuntimeSnapshot(
  deps: LocalServerDeps,
): TuiCoreRuntimeSnapshot {
  const preferredPath = deps.runtimeConfig?.studioConfigPath ?? DEFAULT_STUDIO_CONFIG_PATH;
  const legacyAvailable = preferredPath !== DEFAULT_STUDIO_CONFIG_PATH
    && existsSync(DEFAULT_STUDIO_CONFIG_PATH);
  const activePath = existsSync(preferredPath)
    ? preferredPath
    : legacyAvailable
      ? DEFAULT_STUDIO_CONFIG_PATH
      : preferredPath;
  return {
    model: deps.llmConfig.model,
    ...(deps.llmConfig.contextWindowTokens !== undefined
      ? { contextWindow: deps.llmConfig.contextWindowTokens }
      : {}),
    cwd: deps.workdir,
    ...(deps.runtimeConfig ? {
      stateRoot: deps.runtimeConfig.stateRoot,
      studioConfigPath: deps.runtimeConfig.studioConfigPath,
      petsDir: deps.runtimeConfig.petsDir,
      studioWikiBaseDir: deps.runtimeConfig.studioWikiBaseDir,
    } : {}),
    studioConfigSource: existsSync(preferredPath)
      ? (deps.runtimeConfig ? 'workdir' : 'legacy_home')
      : legacyAvailable
        ? 'legacy_home'
        : 'missing',
    studioConfigActivePath: activePath,
    legacyStudioConfigPath: DEFAULT_STUDIO_CONFIG_PATH,
  };
}

function timelineFromHistoryMessages(messages: TuiHistoryMessage[]): TuiCoreTimelineEntry[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }
    const text = message.text.trim();
    if (!text) {
      return [];
    }
    return [{
      id: `message:${index}:${message.role}`,
      type: 'message',
      role: message.role,
      text,
      status: 'completed',
      source: 'checkpoint',
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    } satisfies TuiCoreTimelineEntry];
  });
}

function runFromPendingReview(params: {
  pendingReview: PendingReviewSnapshot;
  sessionId: string;
  kind: TuiCoreSessionSnapshot['kind'];
  timeline: TuiCoreTimelineEntry[];
}): TuiCoreSessionSnapshot['runs'][number] {
  const petId = params.pendingReview.actor?.petId;
  return {
    requestId: params.pendingReview.requestId,
    sessionId: params.pendingReview.sessionId ?? params.sessionId,
    kind: params.kind,
    phase: 'waiting_human',
    timelineEntryIds: params.timeline.map((entry) => entry.id),
    pendingReview: {
      requestId: params.pendingReview.requestId,
      ...(params.pendingReview.interruptId ? { interruptId: params.pendingReview.interruptId } : {}),
      reviewId: params.pendingReview.reviewId,
      status: 'waiting',
      review: params.pendingReview.review,
      ...(params.pendingReview.reviews ? { reviews: params.pendingReview.reviews } : {}),
      ...(petId ? { petId } : {}),
    },
  };
}
