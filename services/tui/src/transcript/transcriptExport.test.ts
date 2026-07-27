import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentSession } from '@pinpawo/agent-session';
import {
  exportSessionTranscript,
  formatTranscriptMarkdown,
  resolveTranscriptExportPath,
} from './transcriptExport';

const FIXED_NOW = new Date('2026-06-01T01:02:03.000Z');

test('transcript markdown uses completed canonical user and assistant messages', () => {
  const session = createSession([{
    id: 'u1',
    type: 'message',
    role: 'user',
    text: 'hello',
    status: 'completed',
    createdAt: '09:00:00',
  }, {
    id: 'a1',
    type: 'message',
    role: 'assistant',
    text: 'hi',
    status: 'completed',
    createdAt: '09:00:01',
  }, {
    id: 'stream',
    type: 'message',
    role: 'assistant',
    text: 'partial',
    status: 'streaming',
  }, {
    id: 'system',
    type: 'message',
    role: 'system',
    text: 'tool ok',
    status: 'completed',
  }]);

  assert.equal(formatTranscriptMarkdown(session, FIXED_NOW), [
    '# PinPawo TUI Transcript',
    '',
    '- Session: chat:pet-a',
    '- Kind: chat',
    '- Actor: Momo',
    '- Exported: 2026-06-01T01:02:03.000Z',
    '',
    '## Messages',
    '',
    '### User · 09:00:00',
    '',
    'hello',
    '',
    '### Assistant · 09:00:01',
    '',
    'hi',
    '',
  ].join('\n'));
});

test('transcript export path handles default, file, directory, and home paths', () => {
  const expectedName =
    'pinpawo-transcript-chat-pet-a-2026-06-01T01-02-03-000Z.md';
  assert.equal(resolveTranscriptExportPath({
    cwd: '/tmp/project',
    sessionId: 'chat:pet/a',
    now: FIXED_NOW,
  }), `/tmp/project/${expectedName}`);
  assert.equal(resolveTranscriptExportPath({
    cwd: '/tmp/project',
    requestedPath: 'out.md',
    sessionId: 'chat:pet/a',
    now: FIXED_NOW,
  }), '/tmp/project/out.md');
  assert.equal(resolveTranscriptExportPath({
    cwd: '/tmp/project',
    requestedPath: 'transcripts',
    sessionId: 'chat:pet/a',
    now: FIXED_NOW,
  }), `/tmp/project/transcripts/${expectedName}`);
  assert.equal(resolveTranscriptExportPath({
    cwd: '/tmp/project',
    requestedPath: '~/out.md',
    sessionId: 'chat:pet/a',
    now: FIXED_NOW,
  }), path.join(os.homedir(), 'out.md'));
});

test('transcript export creates parents and defaults to canonical runtime cwd', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinpawo-v2-export-'));
  const session = createSession([{
    id: 'u1',
    type: 'message',
    role: 'user',
    text: 'hello',
    status: 'completed',
  }], root);
  const result = await exportSessionTranscript({
    session,
    requestedPath: 'nested/out.md',
    now: FIXED_NOW,
  });

  assert.equal(result.filePath, path.join(root, 'nested/out.md'));
  assert.equal(await readFile(result.filePath, 'utf8'), result.content);
  assert.match(result.content, /hello/);
});

function createSession(
  timeline: AgentSession['timeline'],
  cwd = '/tmp/project',
): AgentSession {
  return {
    sessionId: 'chat:pet-a',
    kind: 'chat',
    actor: {
      label: 'Momo',
      summary: 'Local agent',
    },
    timeline,
    activeRun: null,
    runtime: { cwd },
  };
}
