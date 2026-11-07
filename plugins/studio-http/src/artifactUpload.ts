import { HttpRequestError } from './httpRequestError';

/** Uploads are shared artifact references, not writes into a caller-selected session. */
export const STUDIO_UPLOAD_THREAD_ID = 'studio-uploads';
export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 15_000;

export function readArtifactUploadMetadata(request: Request): { name: string; mimeType: string } {
  const params = new URL(request.url).searchParams;
  const names = params.getAll('name');
  const name = names[0];
  if ([...params.keys()].some(key => key !== 'name') || names.length !== 1 || !name
    || name !== name.trim() || name === '.' || name === '..'
    || /[/\\\u0000-\u001f\u007f]/.test(name) || Buffer.byteLength(name, 'utf8') > 240) {
    throw new HttpRequestError(400, 'name must be one safe filename of at most 240 UTF-8 bytes.');
  }
  const mimeType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!mimeType || mimeType.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)
    || mimeType.startsWith('multipart/')) {
    throw new HttpRequestError(415, 'Content-Type must describe a single file, not multipart data.');
  }
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new HttpRequestError(415, 'Encoded upload bodies are not supported.');
  }
  return { name, mimeType };
}

/** No aggregation: backpressure, errors and cancellation reach the store's pending write. */
export function prepareArtifactUpload(
  request: Request,
  options: { maxBytes: number; timeoutMs: number },
): { body: ReadableStream<Uint8Array>; dispose: () => void } {
  const limitError = () => new HttpRequestError(413, `Upload exceeds ${options.maxBytes} bytes.`);
  const lengthHeader = request.headers.get('content-length');
  const length = lengthHeader === null ? undefined : Number(lengthHeader);
  if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(length))) {
    throw new HttpRequestError(400, 'Invalid upload Content-Length.');
  }
  if (length !== undefined && length > options.maxBytes) throw limitError();
  if (!request.body) throw new HttpRequestError(400, 'Upload body is required.');
  if (request.signal.aborted) throw new HttpRequestError(400, 'Upload was cancelled.');
  const cancellation = new AbortController();
  const onAbort = () => cancellation.abort(new HttpRequestError(400, 'Upload was cancelled.'));
  request.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    cancellation.abort(new HttpRequestError(408, 'Upload body receive deadline exceeded.'));
  }, options.timeoutMs);
  timer.unref();
  const cleanup = () => {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
  };
  let size = 0;
  const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > options.maxBytes) throw limitError();
      controller.enqueue(chunk);
    },
    flush() {
      if (length !== undefined && size !== length) {
        throw new HttpRequestError(400, 'Upload body does not match Content-Length.');
      }
      cleanup();
    },
  }), { signal: cancellation.signal });
  return {
    body,
    dispose() {
      cleanup();
      cancellation.abort(new HttpRequestError(400, 'Upload was cancelled.'));
    },
  };
}
