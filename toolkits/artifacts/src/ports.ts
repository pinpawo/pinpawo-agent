import type { ArtifactRef } from '@pinpawo/agent-contracts';

export type ArtifactStore = {
  put(input: {
    threadId: string; name: string; title?: string; mimeType: string;
    body: ReadableStream<Uint8Array>;
  }): Promise<ArtifactRef>;
  list(threadId: string): Promise<ArtifactRef[]>;
  fetch(uri: string): Promise<
    | { ref: ArtifactRef; body: ReadableStream<Uint8Array> }
    | { ref: ArtifactRef; url: string; expiresAt: string }
  >;
};

export type ArtifactSourceReader = (input: {
  path: string; workdir: string | null;
}) => Promise<{
  name: string; mimeType: string; body: ReadableStream<Uint8Array>;
}>;

/** The Host resolves destinations and removes partial files on stream failure. */
export type ArtifactDownloadWriter = (input: {
  threadId: string;
  path?: string;
  workdir: string | null;
  ref: ArtifactRef;
  body: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}) => Promise<string>;
