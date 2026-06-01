import type { LocalAgentEvent } from '../events/localAgentEvent';
import type { LocalAgentEventMessage } from '../localAgentProtocol';
import { buildLegacyServerMessageFromLocalAgentEvent } from './legacyProtocolAdapter';

type WsLike = {
  readyState: number;
  send(data: string): unknown;
};

const WS_OPEN = 1;

/**
 * Compatibility bridge for the unmigrated pinpawo-app API path.
 * New clients should use sendLocalAgentEvent from localAgentProtocol.
 */
export function sendAppCompatibilityEvent(ws: WsLike, event: LocalAgentEvent) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  ws.send(JSON.stringify({
    type: 'event',
    requestId: event.requestId,
    event,
  } satisfies LocalAgentEventMessage));
  const legacyMessage = buildLegacyServerMessageFromLocalAgentEvent(event);
  if (legacyMessage) {
    ws.send(JSON.stringify(legacyMessage));
  }
  return true;
}
