import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessageEntry } from '@pinpawo/agent-session';
import type { SessionModel } from '../state/tuiState';

type TranscriptTimelineEntry = AgentMessageEntry & { role: 'user' | 'assistant' };

export type TranscriptExportResult = {
  filePath: string;
  content: string;
};

export async function exportSessionTranscript(params: {
  session: SessionModel;
  requestedPath?: string;
  cwd?: string;
  now?: Date;
}): Promise<TranscriptExportResult> {
  const now = params.now ?? new Date();
  const filePath = resolveTranscriptExportPath({
    requestedPath: params.requestedPath,
    cwd: params.cwd ?? process.cwd(),
    sessionId: params.session.sessionId,
    now,
  });
  const content = formatTranscriptMarkdown(params.session, now);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return { filePath, content };
}

export function resolveTranscriptExportPath(params: {
  requestedPath?: string;
  cwd: string;
  sessionId: string;
  now: Date;
}) {
  const requested = params.requestedPath?.trim();
  const fileName = defaultTranscriptFileName(params.sessionId, params.now);
  if (!requested) {
    return path.join(params.cwd, fileName);
  }
  const expanded = expandHomePath(requested);
  const resolved = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(params.cwd, expanded);
  return path.extname(resolved) ? resolved : path.join(resolved, fileName);
}

function expandHomePath(value: string) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function formatTranscriptMarkdown(session: SessionModel, exportedAt: Date) {
  const lines = [
    `# PinPawo TUI Transcript`,
    '',
    `- Session: ${session.sessionId}`,
    `- Kind: ${session.kind}`,
    `- Actor: ${session.actor.label}`,
    `- Exported: ${exportedAt.toISOString()}`,
    '',
    '## Messages',
    '',
  ];

  const transcriptEntries = session.timeline.filter(isTranscriptTimelineEntry);
  if (transcriptEntries.length === 0) {
    lines.push('_No messages in this session._', '');
    return lines.join('\n');
  }

  for (const entry of transcriptEntries) {
    lines.push(...formatTranscriptEntry(entry), '');
  }
  return lines.join('\n');
}

function isTranscriptTimelineEntry(entry: SessionModel['timeline'][number]): entry is TranscriptTimelineEntry {
  return entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant');
}

function formatTranscriptEntry(entry: TranscriptTimelineEntry) {
  const createdAt = 'createdAt' in entry ? entry.createdAt : undefined;
  const title = createdAt
    ? `### ${formatRole(entry)} · ${createdAt}`
    : `### ${formatRole(entry)}`;
  return [
    title,
    '',
    entry.text.trim() || '_empty_',
  ];
}

function formatRole(entry: TranscriptTimelineEntry) {
  return entry.role === 'assistant' ? 'Assistant' : 'User';
}

function defaultTranscriptFileName(sessionId: string, now: Date) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `pinpawo-transcript-${safeFilePart(sessionId)}-${stamp}.md`;
}

function safeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}
