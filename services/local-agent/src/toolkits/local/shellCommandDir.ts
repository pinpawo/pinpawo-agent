import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rgPath } from '@vscode/ripgrep';

/**
 * Directories no search should descend into. `.pinpawo` holds the agent's own
 * checkpoint and artifact storage: searching it feeds serialized conversation
 * state (single lines of hundreds of KB) back into context.
 */
const RG_EXCLUDED_DIRS = ['.pinpawo'];

/** Longest line rg prints before replacing the rest with a preview marker. */
const RG_MAX_COLUMNS = 2_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `rg` commands in this RS run: the bundled ripgrep, so it is always
 * present and the same version everywhere, with the RS's defaults in front
 * of the caller's arguments (which can still add to them).
 */
export function rgWrapperScript(binary: string = rgPath): string {
  const defaults = [
    ...RG_EXCLUDED_DIRS.flatMap((name) => ['--glob', `!${name}`]),
    '--max-columns', RG_MAX_COLUMNS.toString(),
    '--max-columns-preview',
  ];
  return [
    '#!/bin/sh',
    `exec ${[binary, ...defaults].map(shellQuote).join(' ')} "$@"`,
    '',
  ].join('\n');
}

/**
 * Prepare the directory of commands this RS provides and return its path.
 * `PosixShellRS` puts it first on every command's PATH. Written through a
 * rename so concurrent service candidates never expose a partial file.
 */
export async function prepareShellCommandDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = resolve(dir, 'rg');
  const temporary = `${target}.${process.pid.toString()}.tmp`;
  await writeFile(temporary, rgWrapperScript(), { mode: 0o700 });
  await chmod(temporary, 0o700);
  await rename(temporary, target);
  return dir;
}
