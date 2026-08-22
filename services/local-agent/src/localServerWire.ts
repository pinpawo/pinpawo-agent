export type LocalServerWirePeer<TMessage extends object> = {
  isConnected: () => boolean;
  send: (message: TMessage) => boolean;
};

export type LocalServerWireLogError = (message: string, error: unknown) => void;
export type LocalServerWireLogWarn = (message: string) => void;

type MaybePromise<T> = T | Promise<T>;

/**
 * Protocol-neutral hooks for the loopback WebSocket and stdio framing layer.
 * The transport treats each incoming frame as opaque bytes/text and only
 * serializes outbound objects; the owning Host parses and dispatches them.
 */
export type LocalServerWireHandlers<TMessage extends object> = {
  onMessage: (
    peer: LocalServerWirePeer<TMessage>,
    data: Buffer | string,
  ) => MaybePromise<void>;
  onClose?: (peer: LocalServerWirePeer<TMessage>) => MaybePromise<void>;
  log?: (message: string) => void;
  logError?: LocalServerWireLogError;
  logWarn?: LocalServerWireLogWarn;
};

export function defaultLocalServerWireLogError(message: string, error: unknown) {
  console.error(message, error instanceof Error ? error.message : error);
}

export function defaultLocalServerWireLogWarn(message: string) {
  console.warn(message);
}

export function runLocalServerWireHandler(
  name: string,
  handler: () => MaybePromise<void>,
  logError: LocalServerWireLogError,
) {
  return Promise.resolve()
    .then(handler)
    .catch((error) => {
      logError(`[local-server] ${name} error:`, error);
    });
}
