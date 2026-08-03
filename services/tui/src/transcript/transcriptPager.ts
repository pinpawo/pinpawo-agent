import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSession } from '@pinpawo/agent-session';
import { sessionActorLabel } from '../session/sessionDisplay';
import {
  parseTerminalCommand,
  type TerminalCommand,
} from '../terminal/commandLine';
import { formatTimelineEntry } from '../timeline/timelineModel';

export type TranscriptPagerSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: 'inherit';
  },
) => ChildProcess;

export type TranscriptPagerOptions = {
  session: AgentSession;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnPager?: TranscriptPagerSpawn;
  tmpRoot?: string;
  fallbackCommand?: string;
};

export function resolveTranscriptPagerCommand(
  env: NodeJS.ProcessEnv = process.env,
  fallbackCommand = process.platform === 'win32' ? 'more' : 'less',
  platform: NodeJS.Platform = process.platform,
): TerminalCommand {
  return parseTerminalCommand(env.PAGER ?? '', platform)
    ?? { command: fallbackCommand, args: [] };
}

export async function pageSessionTranscript(
  options: TranscriptPagerOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const pager = resolveTranscriptPagerCommand(
    env,
    options.fallbackCommand,
  );
  const dir = await mkdtemp(path.join(
    options.tmpRoot ?? tmpdir(),
    'pinpawo-transcript-',
  ));
  const filePath = path.join(dir, 'transcript.txt');
  await writeFile(
    filePath,
    formatTranscriptPagerText(options.session),
    'utf8',
  );

  try {
    await runTranscriptPager({
      pager,
      filePath,
      cwd: options.cwd,
      env,
      spawnPager: options.spawnPager ?? spawn,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function formatTranscriptPagerText(session: AgentSession) {
  const actor = sessionActorLabel(session);
  const lines = [
    'PinPawo Transcript',
    `Session: ${sanitizePagerText(session.sessionId)}`,
    `Kind: ${session.kind}`,
    ...(session.actor?.label
      ? [`Actor: ${actor}`]
      : []),
    `Entries: ${session.timeline.length}`,
    'Browse: ↑↓ · PageUp/PageDown · g/G · q to return',
    '',
    '────────────────────────────────────────',
    '',
  ];

  if (session.timeline.length === 0) {
    lines.push('No timeline entries.', '');
    return lines.join('\n');
  }

  for (const entry of session.timeline) {
    lines.push(
      sanitizePagerText(formatTimelineEntry(entry)),
      '',
    );
  }
  return lines.join('\n');
}

async function runTranscriptPager(options: {
  pager: TerminalCommand;
  filePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnPager: TranscriptPagerSpawn;
}) {
  await new Promise<void>((resolve, reject) => {
    const child = options.spawnPager(
      options.pager.command,
      [...options.pager.args, options.filePath],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(signal
        ? `pager exited by ${signal}`
        : `pager exited with code ${code ?? 'unknown'}`));
    });
  });
}

function sanitizePagerText(value: string) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '�');
}
