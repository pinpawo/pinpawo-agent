import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentMessageEntry,
  AgentSession,
} from '@pinpawo/agent-session';
import { sessionActorLabel } from '../session/sessionDisplay';

type TranscriptEntry = AgentMessageEntry & {
  role: 'user' | 'assistant';
};

export type TranscriptExportResult = {
  filePath: string;
  content: string;
};

export async function exportSessionTranscript(params: {
  session: AgentSession;
  requestedPath?: string;
  cwd?: string;
  now?: Date;
}): Promise<TranscriptExportResult> {
  const now = params.now ?? new Date();
  const filePath = resolveTranscriptExportPath({
    requestedPath: params.requestedPath,
    cwd: params.cwd ?? params.session.runtime?.cwd ?? process.cwd(),
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
  platform?: NodeJS.Platform;
  homeDir?: string;
}) {
  const requested = params.requestedPath?.trim();
  const fileName = defaultTranscriptFileName(params.sessionId, params.now);
  const platform = params.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!requested) {
    return pathApi.join(params.cwd, fileName);
  }
  const expanded = expandHomePath(
    requested,
    platform,
    params.homeDir ?? os.homedir(),
    pathApi,
  );
  const resolved = pathApi.isAbsolute(expanded)
    ? expanded
    : pathApi.resolve(params.cwd, expanded);
  return pathApi.extname(resolved)
    ? resolved
    : pathApi.join(resolved, fileName);
}

export function formatTranscriptMarkdown(
  session: AgentSession,
  exportedAt: Date,
) {
  const actor = sessionActorLabel(session);
  const lines = [
    '# PinPawo TUI Transcript',
    '',
    `- Session: ${session.sessionId}`,
    `- Kind: ${session.kind}`,
    ...(session.actor?.label ? [`- Actor: ${actor}`] : []),
    `- Exported: ${exportedAt.toISOString()}`,
    '',
    '## Messages',
    '',
  ];

  const entries = session.timeline.filter(isTranscriptEntry);
  if (entries.length === 0) {
    lines.push('_No messages in this session._', '');
    return lines.join('\n');
  }

  for (const entry of entries) {
    const title = entry.createdAt
      ? `### ${formatRole(entry)} · ${entry.createdAt}`
      : `### ${formatRole(entry)}`;
    lines.push(
      title,
      '',
      entry.text.trim() || '_empty_',
      '',
    );
  }
  return lines.join('\n');
}

function isTranscriptEntry(
  entry: AgentSession['timeline'][number],
): entry is TranscriptEntry {
  return entry.type === 'message'
    && entry.status === 'completed'
    && (entry.role === 'user' || entry.role === 'assistant');
}

function formatRole(entry: TranscriptEntry) {
  return entry.role === 'assistant' ? 'Assistant' : 'User';
}

function expandHomePath(
  value: string,
  platform: NodeJS.Platform,
  homeDir: string,
  pathApi: typeof path.posix,
) {
  if (value === '~') return homeDir;
  if (
    value.startsWith('~/')
    || (platform === 'win32' && value.startsWith('~\\'))
  ) {
    return pathApi.join(homeDir, value.slice(2));
  }
  return value;
}

function defaultTranscriptFileName(sessionId: string, now: Date) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `pinpawo-transcript-${safeFilePart(sessionId)}-${stamp}.md`;
}

function safeFilePart(value: string) {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'session';
}
