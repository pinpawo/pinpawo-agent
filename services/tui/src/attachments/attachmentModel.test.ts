import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentLocalAttachment } from '@pinpawo/agent-session';
import { AGENT_LOCAL_ATTACHMENT_LIMIT } from '@pinpawo/agent-session';
import {
  formatAttachmentDisplayText,
  formatAttachmentStrip,
  mergeAttachments,
  removeLastAttachment,
} from './attachmentModel';

const first: AgentLocalAttachment = {
  id: 'first',
  source: 'local-path',
  kind: 'file',
  path: '/tmp/hello.txt',
  name: 'hello.txt',
};
const second: AgentLocalAttachment = {
  id: 'second',
  source: 'local-path',
  kind: 'directory',
  path: '/tmp/project',
  name: 'project',
};

test('attachment model merges by path and removes the last chip', () => {
  const merged = mergeAttachments([first], [first, second]);
  assert.deepEqual(merged, [first, second]);
  assert.deepEqual(removeLastAttachment(merged), [first]);
});

test('attachment model caps cumulative attachments at the protocol limit', () => {
  const incoming = Array.from(
    { length: AGENT_LOCAL_ATTACHMENT_LIMIT + 2 },
    (_, index): AgentLocalAttachment => ({
      ...first,
      id: `attachment-${index}`,
      path: `/tmp/file-${index}.txt`,
      name: `file-${index}.txt`,
    }),
  );
  assert.equal(mergeAttachments([], incoming).length, AGENT_LOCAL_ATTACHMENT_LIMIT);
});

test('attachment model renders visible chips and transcript-safe labels', () => {
  assert.equal(
    formatAttachmentStrip([first, second]),
    '📎 [file:hello.txt] [dir:project] · ⌫ remove last',
  );
  assert.equal(
    formatAttachmentDisplayText('inspect these', [first, second]),
    [
      'inspect these',
      '',
      'Attachments:',
      '- file: hello.txt',
      '- directory: project',
    ].join('\n'),
  );
});
