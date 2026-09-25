import type { Socket } from 'node:net';

/**
 * Framing shared by the RS service and its clients: one JSON object per line
 * over a private local socket.
 *
 * The transport carries requests, responses, cancellations and bounded
 * output. Operations and their errors belong to each RS contract; native
 * process objects, callbacks and `Error` instances never cross it.
 */

export const RS_SERVICE_PROTOCOL_VERSION = 1;
export const MAX_RS_MESSAGE_BYTES = 32 * 1024 * 1024;

/**
 * An error as it crosses the transport. `retryable` and `details` carry a
 * contract's own structured error fields (Browser errors use them to tell the
 * model whether and how to recover); the transport does not interpret them.
 */
export class RSServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable?: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RSServiceError';
  }
}

export function asRecord(value: unknown, what = 'message'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RSServiceError('invalid_request', `Expected an object for ${what}.`);
  }
  return value as Record<string, unknown>;
}

export function sendFrame(socket: Socket, message: unknown): void {
  if (socket.destroyed) return;
  const frame = `${JSON.stringify(message)}\n`;
  const bytes = Buffer.byteLength(frame);
  if (bytes > MAX_RS_MESSAGE_BYTES) {
    throw new RSServiceError('message_too_large', 'RS message exceeded the transport limit.');
  }
  // A peer that stops reading must not grow the writer's queue without bound.
  if (socket.writableLength + bytes > MAX_RS_MESSAGE_BYTES * 2) {
    socket.destroy(new RSServiceError('slow_peer', 'RS peer is not reading messages.'));
    return;
  }
  socket.write(frame);
}

/**
 * Deliver each complete line as a parsed object. Chunks are kept as a list and
 * joined once per message, so a large message costs linear time.
 */
export function receiveFrames(
  socket: Socket,
  onMessage: (message: Record<string, unknown>) => void,
): void {
  let parts: Buffer[] = [];
  let pendingBytes = 0;
  socket.on('data', (chunk: Buffer | string) => {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(10, offset);
      const end = newline < 0 ? data.length : newline;
      const part = data.subarray(offset, end);
      parts.push(part);
      pendingBytes += part.length;
      if (pendingBytes > MAX_RS_MESSAGE_BYTES) {
        socket.destroy(new RSServiceError('message_too_large', 'RS message exceeded the transport limit.'));
        return;
      }
      if (newline < 0) return;
      let message: Record<string, unknown>;
      try {
        message = asRecord(JSON.parse(Buffer.concat(parts, pendingBytes).toString('utf8')));
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error('Invalid RS frame.'));
        return;
      }
      parts = [];
      pendingBytes = 0;
      offset = newline + 1;
      onMessage(message);
    }
  });
}

export type WireError = Readonly<{
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}>;

function plainDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    // Only what survives JSON crosses; anything else is dropped, not guessed.
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function toWireError(error: unknown): WireError {
  const record = (error ?? {}) as { code?: unknown; retryable?: unknown; details?: unknown };
  const details = plainDetails(record.details);
  return {
    code: typeof record.code === 'string' && record.code ? record.code : 'internal',
    message: error instanceof Error ? error.message : String(error),
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
    ...(details ? { details } : {}),
  };
}
