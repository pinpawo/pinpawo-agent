import type {
  TuiCoreRuntimeSnapshot,
  TuiCoreSessionSnapshot,
  TuiCoreTimelineEntry,
} from './tui/contracts/tuiCoreContract';
import type { PendingReviewSnapshot } from './localServerChatHandler';
import type { LocalServerDeps } from './localServerTypes';
import type { TuiHistoryMessage } from './localServerTuiSessions';
import { buildTuiCoreRuntimeSnapshot } from './localConfigProjection';

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
  return buildTuiCoreRuntimeSnapshot(deps);
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
      reviewId: params.pendingReview.reviewId,
      status: 'waiting',
      review: params.pendingReview.review,
      ...(petId ? { petId } : {}),
    },
  };
}
