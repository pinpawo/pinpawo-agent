export type ServerWirePeer<TMessage extends object> = {
  isConnected: () => boolean;
  send: (message: TMessage) => boolean;
};

export type ServerWireLogError = (message: string, error: unknown) => void;
export type ServerWireLogWarn = (message: string) => void;

type MaybePromise<T> = T | Promise<T>;

/**
 * Protocol-neutral hooks for the loopback WebSocket and stdio framing layer.
 * The transport treats each incoming frame as opaque bytes/text and only
 * serializes outbound objects; the owning Host parses and dispatches them.
 */
export type ServerWireHandlers<TMessage extends object> = {
  onMessage: (
    peer: ServerWirePeer<TMessage>,
    data: Buffer | string,
  ) => MaybePromise<void>;
  onClose?: (peer: ServerWirePeer<TMessage>) => MaybePromise<void>;
  log?: (message: string) => void;
  logError?: ServerWireLogError;
  logWarn?: ServerWireLogWarn;
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
  logError: ServerWireLogError,
) {
  return Promise.resolve()
    .then(handler)
    .catch((error) => {
      logError(`[local-server] ${name} error:`, error);
    });
}
