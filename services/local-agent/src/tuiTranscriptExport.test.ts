import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSession } from './tui/state/tuiState';
import {
  exportSessionTranscript,
  formatTranscriptMarkdown,
  resolveTranscriptExportPath,
} from './tui/transcript/transcriptExport';

const FIXED_NOW = new Date('2026-06-01T01:02:03.000Z');

test('formatTranscriptMarkdown writes session metadata and messages', () => {
  const session = createSession({
    id: 'chat:pet-a',
    actor: { label: 'Momo' },
    timeline: [
      { id: 'u1', type: 'message', role: 'user', text: 'hello', status: 'completed', source: 'local-input', createdAt: '09:00:00' },
      { id: 'a1', type: 'message', role: 'assistant', text: 'hi', status: 'completed', source: 'live-event', createdAt: '09:00:01' },
      { id: 's1', type: 'message', role: 'system', text: 'tool ok', status: 'completed', source: 'live-event' },
    ],
  });

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

test('resolveTranscriptExportPath handles default, file, and directory paths', () => {
  assert.equal(
    resolveTranscriptExportPath({
      cwd: '/tmp/project',
      sessionId: 'chat:pet/a',
      now: FIXED_NOW,
    }),
    '/tmp/project/pinpawo-transcript-chat-pet-a-2026-06-01T01-02-03-000Z.md',
  );
  assert.equal(
    resolveTranscriptExportPath({
      cwd: '/tmp/project',
      requestedPath: 'out.md',
      sessionId: 'chat:pet/a',
      now: FIXED_NOW,
    }),
    '/tmp/project/out.md',
  );
  assert.equal(
    resolveTranscriptExportPath({
      cwd: '/tmp/project',
      requestedPath: 'transcripts',
      sessionId: 'chat:pet/a',
      now: FIXED_NOW,
    }),
    '/tmp/project/transcripts/pinpawo-transcript-chat-pet-a-2026-06-01T01-02-03-000Z.md',
  );
  assert.equal(
    resolveTranscriptExportPath({
      cwd: '/tmp/project',
      requestedPath: '~/out.md',
      sessionId: 'chat:pet/a',
      now: FIXED_NOW,
    }),
    path.join(os.homedir(), 'out.md'),
  );
  assert.equal(
    resolveTranscriptExportPath({
      cwd: '/tmp/project',
      requestedPath: '~',
      sessionId: 'chat:pet/a',
      now: FIXED_NOW,
    }),
    path.join(os.homedir(), 'pinpawo-transcript-chat-pet-a-2026-06-01T01-02-03-000Z.md'),
  );
});

test('exportSessionTranscript creates parent directories and writes markdown', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pinpawo-tui-export-'));
  const session = createSession({
    id: 'chat:pet-a',
    actor: { label: 'Momo' },
    timeline: [
      { id: 'u1', type: 'message', role: 'user', text: 'hello', status: 'completed', source: 'local-input' },
    ],
  });

  const result = await exportSessionTranscript({
    session,
    requestedPath: 'nested/out.md',
    cwd: tmp,
    now: FIXED_NOW,
  });

  assert.equal(result.filePath, path.join(tmp, 'nested/out.md'));
  assert.equal(await readFile(result.filePath, 'utf8'), result.content);
  assert.match(result.content, /# PinPawo TUI Transcript/);
  assert.match(result.content, /hello/);
});
