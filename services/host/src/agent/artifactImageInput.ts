import { HumanMessage } from '@langchain/core/messages';
import { isJsonObject, parseArtifactUri, parseDeliverables, type Deliverable } from '@pinpawo/agent-contracts';
import type { ArtifactReader } from '../artifacts/http';
import {
  admitImageAttachmentBytes,
  assertImageAttachmentLimits,
  ImageAdmissionError,
  type AdmittedLocalImageAttachment,
  type SupportedLocalImageMimeType,
} from './attachmentAdmission';
import { createAdmittedLocalChatHumanMessage } from './chatMessageInput';

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Artifact image loading was aborted.', 'AbortError');
}

async function readImageBody(
  body: ReadableStream<Uint8Array>,
  options: { allowImages: boolean; imageCount: number; totalBytes: number; signal?: AbortSignal },
): Promise<Buffer> {
  const reader = body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    aborted(options.signal);
    while (true) {
      const next = await reader.read();
      aborted(options.signal);
      if (next.done) return Buffer.concat(chunks, size);
      size += next.value.byteLength;
      assertImageAttachmentLimits({ ...options, byteSize: size, totalBytes: options.totalBytes + size });
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** Resolve explicit references on the Host; only admitted image bytes enter the model message. */
export async function createArtifactChatHumanMessage(
  message: string,
  references: readonly Deliverable[],
  store: ArtifactReader | undefined,
  options: { allowImages: boolean; signal?: AbortSignal },
): Promise<HumanMessage> {
  const refs = parseDeliverables(references);
  const images: AdmittedLocalImageAttachment[] = [];
  const referenceOnly: string[] = [];
  let totalBytes = 0;
  for (const [index, reference] of refs.entries()) {
    aborted(options.signal);
    if (!/^artifact:/i.test(reference.uri)) {
      referenceOnly.push(`Reference ${index + 1}: not an artifact image reference.`);
      continue;
    }
    let body: ReadableStream<Uint8Array> | undefined;
    try {
      try { parseArtifactUri(reference.uri); } catch {
        throw new ImageAdmissionError('image_invalid', 'Artifact image reference is invalid.');
      }
      if (!store) throw new ImageAdmissionError('image_invalid', 'Artifact storage is unavailable for image input.');
      const fetched = await store.fetch(reference.uri);
      if ('body' in fetched) body = fetched.body;
      aborted(options.signal);
      const { ref } = fetched;
      if (ref.uri !== reference.uri) throw new ImageAdmissionError('image_invalid', 'Artifact metadata does not match the supplied reference.');
      const mimeType = ref.mimeType.toLowerCase().split(';')[0]!.trim();
      if (!mimeType.startsWith('image/')) {
        referenceOnly.push(`Reference ${index + 1}: its artifact is not an image.`);
        continue;
      }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
        throw new ImageAdmissionError('image_invalid', 'Unsupported artifact image format; only PNG, JPEG and WebP are supported.');
      }
      if (!Number.isSafeInteger(ref.size) || ref.size < 0 || !/^[a-f0-9]{64}$/i.test(ref.sha256)) {
        throw new ImageAdmissionError('image_invalid', 'Artifact image metadata is invalid.');
      }
      const imageCount = images.length + 1;
      assertImageAttachmentLimits({ ...options, imageCount, byteSize: ref.size, totalBytes: totalBytes + ref.size });
      if ('url' in fetched) {
        const response = await fetch(fetched.url, { signal: options.signal, redirect: 'error' });
        body = response.body ?? undefined;
        if (!response.ok || !body) throw new ImageAdmissionError('image_invalid', 'Artifact image could not be downloaded.');
      }
      const bytes = await readImageBody(body!, { ...options, imageCount, totalBytes });
      body = undefined;
      const image = admitImageAttachmentBytes({ id: `artifact-image-${index}`, name: ref.name, bytes,
        mimeType: mimeType as SupportedLocalImageMimeType }, { ...options, imageCount, totalBytes: totalBytes + bytes.length });
      if (image.byteSize !== ref.size || image.sha256 !== ref.sha256.toLowerCase()) {
        throw new ImageAdmissionError('image_invalid', 'Artifact image does not match its published snapshot.');
      }
      images.push(image);
      totalBytes += image.byteSize;
    } catch (error) {
      aborted(options.signal);
      if (error instanceof ImageAdmissionError) throw error;
      throw new ImageAdmissionError('image_invalid', 'Artifact image could not be loaded.');
    } finally {
      await body?.cancel().catch(() => undefined);
    }
  }
  const result = new HumanMessage({ ...createAdmittedLocalChatHumanMessage(message, images) });
  if (referenceOnly.length) {
    const note = `These supplied references were not loaded as images; do not claim to have inspected them:\n${referenceOnly.join('\n')}`;
    result.content = [...(typeof result.content === 'string'
      ? result.content ? [{ type: 'text' as const, text: result.content }] : []
      : result.content), { type: 'text', text: note }];
  }
  const metadata = result.additional_kwargs.pinpawo;
  result.additional_kwargs.pinpawo = { ...(isJsonObject(metadata) ? metadata : {}), artifactReferences: refs };
  return result;
}
