import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentLocalAttachment } from '@pinpawo/agent-session';
import {
  detectSupportedImageMimeType,
  LocalImageAdmissionError,
  LocalImageAttachmentAdmission,
  MAX_LOCAL_IMAGE_ATTACHMENTS,
  MAX_LOCAL_IMAGE_BYTES,
} from './localImageAttachments';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('test-png-payload'),
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP'),
]);

function attachment(
  id: string,
  path: string,
  name = `${id}.png`,
): AgentLocalAttachment {
  return {
    id,
    source: 'local-path',
    kind: 'file',
    path,
    name,
  };
}

test('supported image MIME is determined by bounded file signatures', () => {
  assert.equal(detectSupportedImageMimeType(PNG_BYTES), 'image/png');
  assert.equal(detectSupportedImageMimeType(JPEG_BYTES), 'image/jpeg');
  assert.equal(detectSupportedImageMimeType(WEBP_BYTES), 'image/webp');
  assert.equal(
    detectSupportedImageMimeType(Buffer.from('fake.png contents')),
    null,
  );
});

test('image admission prepares a standard block payload and preserves ordinary files', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinpawo-input-images-'));
  const imagePath = join(root, 'renamed.txt');
  const textPath = join(root, 'notes.png');
  await fs.writeFile(imagePath, PNG_BYTES);
  await fs.writeFile(textPath, 'not really an image');
  const admission = new LocalImageAttachmentAdmission();

  try {
    const admitted = await admission.admit([
      attachment('image-1', imagePath, 'renamed.txt'),
      attachment('file-1', textPath, 'notes.png'),
    ], { allowImages: true });

    assert.equal(admitted[0]?.source, 'local-image');
    if (admitted[0]?.source !== 'local-image') return;
    assert.equal(admitted[0].mimeType, 'image/png');
    assert.equal(admitted[0].byteSize, PNG_BYTES.length);
    assert.equal(admitted[0].data, PNG_BYTES.toString('base64'));
    // The admitted attachment must not leak the host path it came from.
    assert.doesNotMatch(JSON.stringify(admitted[0]), new RegExp(root));
    assert.deepEqual(admitted[1], attachment('file-1', textPath, 'notes.png'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('text-only admission rejects a real image', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinpawo-input-images-text-'));
  const imagePath = join(root, 'image.png');
  await fs.writeFile(imagePath, PNG_BYTES);
  const admission = new LocalImageAttachmentAdmission();

  try {
    await assert.rejects(
      () => admission.admit(
        [attachment('image-1', imagePath)],
        { allowImages: false },
      ),
      (error: unknown) => (
        error instanceof LocalImageAdmissionError
        && error.code === 'image_model_unsupported'
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('image admission enforces count and byte limits', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinpawo-input-images-limit-'));
  const admission = new LocalImageAttachmentAdmission();
  try {
    const attachments: AgentLocalAttachment[] = [];
    for (let index = 0; index < MAX_LOCAL_IMAGE_ATTACHMENTS + 1; index += 1) {
      const path = join(root, `${index}.png`);
      await fs.writeFile(path, PNG_BYTES);
      attachments.push(attachment(`image-${index}`, path));
    }
    await assert.rejects(
      () => admission.admit(attachments, { allowImages: true }),
      (error: unknown) => (
        error instanceof LocalImageAdmissionError
        && error.code === 'image_count_limit'
      ),
    );

    const oversizedPath = join(root, 'oversized.png');
    const oversized = await fs.open(oversizedPath, 'w');
    await oversized.write(PNG_BYTES, 0, PNG_BYTES.length, 0);
    await oversized.truncate(MAX_LOCAL_IMAGE_BYTES + 1);
    await oversized.close();
    await assert.rejects(
      () => admission.admit(
        [attachment('oversized', oversizedPath)],
        { allowImages: true },
      ),
      (error: unknown) => (
        error instanceof LocalImageAdmissionError
        && error.code === 'image_size_limit'
      ),
    );

    const admitted = await admission.admit(
      [attachment('valid', attachments[0]!.path)],
      { allowImages: true },
    );
    const image = admitted[0];
    assert.equal(image?.source, 'local-image');
    if (image?.source !== 'local-image') return;
    assert.equal(image.data, PNG_BYTES.toString('base64'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
