import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryCellModel, SessionModel } from '../state/tuiState';

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
    sessionId: params.session.id,
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
  const resolved = path.isAbsolute(requested)
    ? requested
    : path.resolve(params.cwd, requested);
  return path.extname(resolved) ? resolved : path.join(resolved, fileName);
}

export function formatTranscriptMarkdown(session: SessionModel, exportedAt: Date) {
  const lines = [
    `# PinPawo TUI Transcript`,
    '',
    `- Session: ${session.id}`,
    `- Kind: ${session.kind}`,
    `- Actor: ${session.actor.label}`,
    `- Exported: ${exportedAt.toISOString()}`,
    '',
    '## Messages',
    '',
  ];

  if (session.history.length === 0) {
    lines.push('_No messages in this session._', '');
    return lines.join('\n');
  }

  for (const cell of session.history) {
    lines.push(...formatHistoryCell(cell), '');
  }
  return lines.join('\n');
}

function formatHistoryCell(cell: HistoryCellModel) {
  const title = cell.timestamp
    ? `### ${formatRole(cell.kind)} · ${cell.timestamp}`
    : `### ${formatRole(cell.kind)}`;
  return [
    title,
    '',
    cell.text.trim() || '_empty_',
  ];
}

function formatRole(kind: HistoryCellModel['kind']) {
  switch (kind) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
    default:
      return kind;
  }
}

function defaultTranscriptFileName(sessionId: string, now: Date) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `pinpawo-transcript-${safeFilePart(sessionId)}-${stamp}.md`;
}

function safeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}
