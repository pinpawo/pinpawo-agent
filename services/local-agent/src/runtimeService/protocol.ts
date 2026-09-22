import { Socket } from 'node:net';

export const RUNTIME_PROTOCOL_VERSION = 2;
export const MAX_RUNTIME_MESSAGE_BYTES = 32 * 1024 * 1024;

export class RuntimeServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeServiceError';
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeServiceError('invalid_request', 'Expected an object.');
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new RuntimeServiceError('invalid_request', `Invalid ${field}.`);
  }
  return value;
}

export function send(socket: Socket, message: unknown): void {
  if (socket.destroyed) return;
  const frame = JSON.stringify(message) + '\n';
  if (Buffer.byteLength(frame) > MAX_RUNTIME_MESSAGE_BYTES) {
    throw new RuntimeServiceError('message_too_large', 'Runtime response exceeded the transport limit.');
  }
  // Slow clients must not grow the service's output queue without a bound.
  if (socket.writableLength + Buffer.byteLength(frame) > MAX_RUNTIME_MESSAGE_BYTES * 2) {
    socket.destroy(new RuntimeServiceError('slow_client', 'Runtime client is not reading responses.'));
    return;
  }
  socket.write(frame);
}

export function receive(socket: Socket, onMessage: (message: Record<string, unknown>) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_RUNTIME_MESSAGE_BYTES) {
      socket.destroy(new RuntimeServiceError('message_too_large', 'Runtime message exceeded the transport limit.'));
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const frame = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        onMessage(record(JSON.parse(frame)));
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error('Invalid runtime frame.'));
        return;
      }
    }
  });
}
