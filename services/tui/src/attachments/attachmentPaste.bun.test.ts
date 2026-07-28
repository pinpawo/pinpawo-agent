import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  TextareaRenderable,
  type PasteEvent,
} from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import type { AgentLocalAttachment } from '@pinpawo/agent-session';
import {
  handleAttachmentPasteEvent,
} from './attachmentPaste';

test('production attachment paste keeps paths out of the OpenTUI textarea', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-native-attachments-'));
  const first = join(root, 'first file.txt');
  const second = join(root, '第二.txt');
  await writeFile(first, 'first');
  await writeFile(second, 'second');
  const setup = await createTestRenderer({
    width: 80,
    height: 12,
  });
  context.after(async () => {
    setup.renderer.destroy();
    await rm(root, { recursive: true, force: true });
  });

  let attachments: AgentLocalAttachment[] = [];
  let notice: string | null = null;
  const textarea = new TextareaRenderable(setup.renderer, {
    id: 'attachment-composer',
    width: '100%',
    height: 5,
    onPaste: (event: PasteEvent) => {
      const result = handleAttachmentPasteEvent(
        attachments,
        event,
      );
      attachments = result.attachments;
      if (result.handled) {
        notice = result.notice;
      } else {
        notice = result.pendingNotice;
      }
    },
  });
  setup.renderer.root.add(textarea);
  textarea.focus();

  await setup.mockInput.pasteBracketedText(`'${first}' "${second}"`);
  await setup.flush();
  assert.equal(textarea.plainText, '');
  assert.deepEqual(
    attachments.map(({ path, name }) => ({ path, name })),
    [{
      path: first,
      name: 'first file.txt',
    }, {
      path: second,
      name: '第二.txt',
    }],
  );
  assert.equal(notice, 'attached 2 local paths');

  await setup.mockInput.pasteBracketedText('ordinary\nmultiline text');
  await setup.flush();
  assert.equal(textarea.plainText, 'ordinary\nmultiline text');
  assert.equal(notice, null);
});
