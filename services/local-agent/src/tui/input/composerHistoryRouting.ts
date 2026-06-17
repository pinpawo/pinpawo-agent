import type { CanonicalInputEvent } from './canonicalInput';

export type ComposerHistoryDirection = 'previous' | 'next';

export type ComposerHistoryBoundary = Record<ComposerHistoryDirection, boolean>;

export type ComposerHistoryAvailability = Record<ComposerHistoryDirection, boolean>;

export type ComposerHistoryRouteState = {
  boundary: ComposerHistoryBoundary;
  available: ComposerHistoryAvailability;
};

export function resolveComposerHistoryRoute(
  event: CanonicalInputEvent,
  state?: ComposerHistoryRouteState | null,
): ComposerHistoryDirection | null {
  if (!state) return null;
  if (event.type === 'cursor.up' && state.boundary.previous && state.available.previous) {
    return 'previous';
  }
  if (event.type === 'cursor.down' && state.boundary.next && state.available.next) {
    return 'next';
  }
  return null;
}
