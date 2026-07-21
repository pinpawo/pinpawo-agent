const HEADER_BYTES = 4;

export const MAX_NATIVE_MESSAGE_BYTES = 4 * 1024 * 1024;

export function encodeNativeMessage(
  value: unknown,
  maxBytes = MAX_NATIVE_MESSAGE_BYTES,
): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > maxBytes) {
    throw new Error(`native message exceeds ${maxBytes} bytes`);
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

export class NativeMessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBytes = MAX_NATIVE_MESSAGE_BYTES) {}

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0
      ? chunk
      : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    while (this.buffer.length >= HEADER_BYTES) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxBytes) {
        throw new Error(`native message exceeds ${this.maxBytes} bytes`);
      }
      if (this.buffer.length < HEADER_BYTES + length) break;
      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
      messages.push(JSON.parse(payload.toString('utf8')) as unknown);
    }

    return messages;
  }
}
