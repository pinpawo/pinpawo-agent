import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentLocalAttachment } from '@pinpawo/agent-session';

export const LOCAL_IMAGE_REFERENCE_SCHEME = 'pinpawo-local-image:';
export const MAX_LOCAL_IMAGE_ATTACHMENTS = 4;
export const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_LOCAL_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

export type SupportedLocalImageMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp';

export type AdmittedLocalImageAttachment = Readonly<{
  id: string;
  source: 'local-image';
  kind: 'image';
  uri: string;
  name: string;
  mimeType: SupportedLocalImageMimeType;
  byteSize: number;
  sha256: string;
}>;

export type AdmittedLocalAttachment =
  | AgentLocalAttachment
  | AdmittedLocalImageAttachment;

export class LocalImageAdmissionError extends Error {
  constructor(
    public readonly code:
      | 'image_model_unsupported'
      | 'image_count_limit'
      | 'image_size_limit'
      | 'image_total_size_limit'
      | 'image_reference_invalid'
      | 'image_reference_corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'LocalImageAdmissionError';
  }
}

type ClassifiedImage = {
  attachment: AgentLocalAttachment;
  bytes: Buffer;
  mimeType: SupportedLocalImageMimeType;
  sha256: string;
};

export class LocalChatImageStore {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  async admit(
    attachments: readonly AgentLocalAttachment[],
    options: { allowImages: boolean },
  ): Promise<AdmittedLocalAttachment[]> {
    const images: ClassifiedImage[] = [];
    let totalBytes = 0;
    for (const attachment of attachments) {
      const image = await this.classify(attachment);
      if (!image) continue;
      if (!options.allowImages) {
        throw new LocalImageAdmissionError(
          'image_model_unsupported',
          'The selected model profile does not support image input.',
        );
      }
      if (images.length >= MAX_LOCAL_IMAGE_ATTACHMENTS) {
        throw new LocalImageAdmissionError(
          'image_count_limit',
          `A single message may include at most ${MAX_LOCAL_IMAGE_ATTACHMENTS} images.`,
        );
      }
      totalBytes += image.bytes.length;
      if (totalBytes > MAX_LOCAL_IMAGE_TOTAL_BYTES) {
        throw new LocalImageAdmissionError(
          'image_total_size_limit',
          `Image attachments exceed the ${MAX_LOCAL_IMAGE_TOTAL_BYTES} byte total limit.`,
        );
      }
      images.push(image);
    }

    const admittedById = new Map<string, AdmittedLocalImageAttachment>();
    for (const image of images) {
      await this.persist(image.sha256, image.bytes);
      admittedById.set(image.attachment.id, Object.freeze({
        id: image.attachment.id,
        source: 'local-image',
        kind: 'image',
        uri: buildLocalImageReferenceUri(image.sha256),
        name: image.attachment.name,
        mimeType: image.mimeType,
        byteSize: image.bytes.length,
        sha256: image.sha256,
      }));
    }
    return attachments.map((attachment) => (
      admittedById.get(attachment.id) ?? attachment
    ));
  }

  async read(referenceUri: string): Promise<{
    bytes: Buffer;
    mimeType: SupportedLocalImageMimeType;
    sha256: string;
  }> {
    const sha256 = parseLocalImageReferenceUri(referenceUri);
    if (!sha256) {
      throw new LocalImageAdmissionError(
        'image_reference_invalid',
        'Local image reference is invalid.',
      );
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(resolve(this.rootPath, sha256));
    } catch {
      throw new LocalImageAdmissionError(
        'image_reference_invalid',
        'Local image reference is unavailable.',
      );
    }
    if (
      bytes.length > MAX_LOCAL_IMAGE_BYTES
      || sha256Digest(bytes) !== sha256
    ) {
      throw new LocalImageAdmissionError(
        'image_reference_corrupt',
        'Local image reference failed integrity validation.',
      );
    }
    const mimeType = detectSupportedImageMimeType(bytes);
    if (!mimeType) {
      throw new LocalImageAdmissionError(
        'image_reference_corrupt',
        'Local image reference no longer contains a supported image.',
      );
    }
    return { bytes, mimeType, sha256 };
  }

  private async classify(
    attachment: AgentLocalAttachment,
  ): Promise<ClassifiedImage | null> {
    if (attachment.kind !== 'file') return null;
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(attachment.path, 'r');
    } catch {
      return null;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const mimeType = detectSupportedImageMimeType(header.subarray(0, bytesRead));
      if (!mimeType) return null;
      if (stat.size > MAX_LOCAL_IMAGE_BYTES) {
        throw new LocalImageAdmissionError(
          'image_size_limit',
          `Image "${attachment.name}" exceeds the ${MAX_LOCAL_IMAGE_BYTES} byte limit.`,
        );
      }
      const bytes = await handle.readFile();
      if (bytes.length > MAX_LOCAL_IMAGE_BYTES) {
        throw new LocalImageAdmissionError(
          'image_size_limit',
          `Image "${attachment.name}" exceeds the ${MAX_LOCAL_IMAGE_BYTES} byte limit.`,
        );
      }
      const verifiedMimeType = detectSupportedImageMimeType(bytes);
      if (!verifiedMimeType || verifiedMimeType !== mimeType) {
        throw new LocalImageAdmissionError(
          'image_reference_corrupt',
          `Image "${attachment.name}" changed while it was being admitted.`,
        );
      }
      return {
        attachment,
        bytes,
        mimeType,
        sha256: sha256Digest(bytes),
      };
    } finally {
      await handle.close();
    }
  }

  private async persist(sha256: string, bytes: Buffer) {
    await fs.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    const targetPath = resolve(this.rootPath, sha256);
    try {
      const existing = await fs.readFile(targetPath);
      if (sha256Digest(existing) !== sha256) {
        throw new LocalImageAdmissionError(
          'image_reference_corrupt',
          'Existing local image content failed integrity validation.',
        );
      }
      return;
    } catch (error) {
      if (
        error instanceof LocalImageAdmissionError
        || (error as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        throw error;
      }
    }

    const temporaryPath = resolve(
      this.rootPath,
      `.${sha256}.${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temporaryPath, bytes, {
        flag: 'wx',
        mode: 0o600,
      });
      await fs.rename(temporaryPath, targetPath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }
}

export function buildLocalImageReferenceUri(sha256: string) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new LocalImageAdmissionError(
      'image_reference_invalid',
      'Local image digest is invalid.',
    );
  }
  return `${LOCAL_IMAGE_REFERENCE_SCHEME}//sha256/${sha256}`;
}

export function parseLocalImageReferenceUri(value: string) {
  const match = /^pinpawo-local-image:\/\/sha256\/([a-f0-9]{64})$/.exec(value);
  return match?.[1] ?? null;
}

export function detectSupportedImageMimeType(
  bytes: Uint8Array,
): SupportedLocalImageMimeType | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12
    && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function sha256Digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
