import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSession } from '@pinpawo/agent-session';
import {
  formatTranscriptPagerText,
  pageSessionTranscript,
  resolveTranscriptPagerCommand,
  type TranscriptPagerSpawn,
} from './transcriptPager';

test('transcript pager resolves PAGER arguments and a platform fallback', () => {
  assert.deepEqual(resolveTranscriptPagerCommand({
    PAGER: 'less -R',
  }), {
    command: 'less',
    args: ['-R'],
  });
  assert.deepEqual(resolveTranscriptPagerCommand({}, 'test-pager'), {
    command: 'test-pager',
    args: [],
  });
});

test('transcript pager text includes the complete ordered canonical timeline', () => {
  const content = formatTranscriptPagerText(createSession([{
    id: 'u1',
    type: 'message',
    role: 'user',
    text: 'hello',
    status: 'completed',
    createdAt: '09:00:00',
  }, {
    id: 'op1',
    type: 'operation',
    requestId: 'r1',
    operationKey: 'tool:1',
    kind: 'tool',
    title: 'Read',
    phase: 'completed',
    target: '/tmp/file',
  }, {
    id: 'sub1',
    type: 'message',
    role: 'subagent',
    text: 'done\u001b[31m',
    status: 'completed',
  }]));

  assert.ok(content.indexOf('user       hello') < content.indexOf('Read'));
  assert.ok(content.indexOf('Read') < content.indexOf('subagent   done'));
  assert.doesNotMatch(content, /\u001b/);
  assert.match(content, /done�\[31m/);
});

test('transcript pager receives a temporary snapshot and cleans it up', async () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'pinpawo-pager-test-'));
  let pagedFile = '';
  let pagedContent = '';
  const spawnPager: TranscriptPagerSpawn = (command, args, options) => {
    assert.equal(command, 'test-pager');
    assert.equal(options.cwd, tmpRoot);
    pagedFile = args.at(-1) ?? '';
    const child = new EventEmitter();
    setImmediate(async () => {
      pagedContent = await readFile(pagedFile, 'utf8');
      child.emit('exit', 0, null);
    });
    return child as ReturnType<TranscriptPagerSpawn>;
  };

  await pageSessionTranscript({
    session: createSession([{
      id: 'a1',
      type: 'message',
      role: 'assistant',
      text: 'answer',
      status: 'completed',
    }]),
    cwd: tmpRoot,
    tmpRoot,
    env: { PAGER: 'test-pager --flag' },
    spawnPager,
  });

  assert.match(pagedContent, /assistant  answer/);
  await assert.rejects(
    () => readFile(pagedFile, 'utf8'),
    /ENOENT/,
  );
});

function createSession(
  timeline: AgentSession['timeline'],
): AgentSession {
  return {
    sessionId: 'chat:one',
    kind: 'chat',
    actor: {
      label: 'Momo',
      summary: 'Local agent',
    },
    timeline,
    activeRun: null,
  };
}
