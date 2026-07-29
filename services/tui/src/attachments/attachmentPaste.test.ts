import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AGENT_LOCAL_ATTACHMENT_LIMIT } from '@pinpawo/agent-session';
import {
  applyAttachmentPaste,
} from './attachmentPaste';

test('attachment paste separates multiple paths and reports duplicates', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-attachment-paste-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first file.txt');
  const second = join(root, '第二.txt');
  await writeFile(first, 'first');
  await writeFile(second, 'second');
  const ids = ['attachment-1', 'attachment-2'];

  const attached = applyAttachmentPaste(
    [],
    `'${first}' "${second}"`,
    { idFactory: () => ids.shift() ?? 'unexpected' },
  );
  assert.equal(attached.handled, true);
  if (!attached.handled) assert.fail('expected attachment paste');
  assert.equal(attached.notice, 'attached 2 local paths');
  assert.deepEqual(
    attached.attachments.map(({ id, path }) => ({ id, path })),
    [{
      id: 'attachment-1',
      path: first,
    }, {
      id: 'attachment-2',
      path: second,
    }],
  );

  assert.deepEqual(
    applyAttachmentPaste(attached.attachments, `"${first}"`),
    {
      handled: true,
      attachments: attached.attachments,
      notice: 'attachment already added',
    },
  );
});

test('attachment paste preserves prose and reports the protocol limit', async (context) => {
  assert.deepEqual(applyAttachmentPaste([], 'please inspect this text'), {
    handled: false,
    attachments: [],
    pendingNotice: null,
  });

  const root = await mkdtemp(join(tmpdir(), 'pinpawo-attachment-limit-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const extra = join(root, 'extra.txt');
  await writeFile(extra, 'extra');
  const current = Array.from(
    { length: AGENT_LOCAL_ATTACHMENT_LIMIT },
    (_, index) => ({
      id: `attachment-${index}`,
      source: 'local-path' as const,
      kind: 'file' as const,
      path: join(root, `existing-${index}.txt`),
      name: `existing-${index}.txt`,
    }),
  );

  assert.deepEqual(applyAttachmentPaste(current, `"${extra}"`), {
    handled: true,
    attachments: current,
    notice: 'attachment limit reached',
  });
});
