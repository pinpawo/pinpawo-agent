/**
 * Unified Browser Runtime event envelope.
 *
 * The extension/CDP driver reports raw events (navigation, commit, document
 * ready, network, dom, target, popup, download, debugger). The Runtime consumes
 * them and stamps generation context; events that arrive against a superseded
 * connection/target/navigation generation are dropped.
 */

export const BROWSER_RUNTIME_EVENT_TYPES = [
  'target.created',
  'target.updated',
  'target.closed',
  'navigation.requested',
  'navigation.committed',
  'document.ready',
  'network.activity',
  'dom.changed',
  'popup.created',
  'download.started',
  'download.finished',
  'debugger.attached',
  'debugger.detached',
  'runtime.disconnected',
] as const;

export type BrowserRuntimeEventType = typeof BROWSER_RUNTIME_EVENT_TYPES[number];

export type BrowserRuntimeEvent<TType extends BrowserRuntimeEventType = BrowserRuntimeEventType> = {
  /** Which native-host / extension connection produced this event. */
  connectionGeneration: number;
  /** Which managed target produced this event. */
  targetGeneration: number;
  /** Which navigation/action generation produced this event. */
  navigationGeneration?: number;
  tabId: number;
  /** Timestamp of the event. */
  timestamp: number;
  type: TType;
  payload?: Record<string, unknown>;
};

export type EventGenerationContext = {
  connectionGeneration: number;
  targetGeneration: number;
  navigationGeneration?: number;
};

/**
 * True when the event belongs to the current connection + target + navigation
 * context. Stale events (old connection, closed target, superseded navigation)
 * must not mutate current Runtime state.
 */
export function isEventCurrent(
  event: BrowserRuntimeEvent,
  current: EventGenerationContext,
): boolean {
  if (event.connectionGeneration !== current.connectionGeneration) return false;
  if (event.targetGeneration !== current.targetGeneration) return false;
  if (event.navigationGeneration !== undefined && current.navigationGeneration !== undefined) {
    if (event.navigationGeneration !== current.navigationGeneration) return false;
  }
  return true;
}
