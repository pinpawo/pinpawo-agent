export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

/** Reject oversize snapshots without truncating them; errors cancel the source. */
export function limitArtifactBody(body: ReadableStream<Uint8Array>, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let size = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_ARTIFACT_BYTES) {
        throw new Error('Artifact exceeds the 100 MB single-file limit.');
      }
      controller.enqueue(chunk);
    },
  }), { signal });
}
