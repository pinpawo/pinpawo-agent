import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseTerminalCommand,
  type TerminalCommand,
} from '../terminal/commandLine';

export type ExternalEditorCommand = TerminalCommand;

export type ExternalEditorSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: 'inherit';
  },
) => ChildProcess;

export type ExternalEditorOptions = {
  initialText: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnEditor?: ExternalEditorSpawn;
  tmpRoot?: string;
};

export function resolveExternalEditorCommand(
  env: NodeJS.ProcessEnv = process.env,
): ExternalEditorCommand | null {
  const raw = env.VISUAL?.trim() || env.EDITOR?.trim() || '';
  return raw ? parseTerminalCommand(raw) : null;
}

export async function editTextWithExternalEditor(
  options: ExternalEditorOptions,
): Promise<string> {
  const env = options.env ?? process.env;
  const editor = resolveExternalEditorCommand(env);
  if (!editor) {
    throw new Error('missing VISUAL or EDITOR');
  }

  const dir = await mkdtemp(path.join(
    options.tmpRoot ?? tmpdir(),
    'pinpawo-editor-',
  ));
  const filePath = path.join(dir, 'message.md');
  await writeFile(filePath, options.initialText, 'utf8');

  try {
    await runExternalEditor({
      editor,
      filePath,
      cwd: options.cwd,
      env,
      spawnEditor: options.spawnEditor ?? spawn,
    });
    return await readFile(filePath, 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runExternalEditor(options: {
  editor: ExternalEditorCommand;
  filePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnEditor: ExternalEditorSpawn;
}) {
  return new Promise<void>((resolve, reject) => {
    const child = options.spawnEditor(
      options.editor.command,
      [...options.editor.args, options.filePath],
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
        ? `editor exited by ${signal}`
        : `editor exited with code ${code ?? 'unknown'}`));
    });
  });
}
