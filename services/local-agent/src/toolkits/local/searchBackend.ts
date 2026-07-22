import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { DEFAULT_WALK_IGNORED_DIRS } from './fileSystemUtils';

const RG_LINE_PREVIEW_CHARS = 2_000;
const MAX_BACKEND_ERROR_CHARS = 10_000;
const RG_LONG_LINE_MARKER = ' [... omitted end of long line]';

export type SearchLine = {
  path: string;
  lineNumber: number;
  line: string;
  isMatch: boolean;
  backendTruncated: boolean;
};

export type GrepBackendResult = {
  lines: SearchLine[];
  matchCount: number;
  stoppedAtMatchLimit: boolean;
};

export type GlobBackendResult = {
  paths: string[];
  stoppedAtResultLimit: boolean;
};

export interface SearchBackend {
  grep(options: {
    rootPath: string;
    query: string;
    literal: boolean;
    caseSensitive: boolean;
    glob?: string;
    context: number;
    maxMatches: number;
    signal?: AbortSignal;
  }): Promise<GrepBackendResult>;
  glob(options: {
    rootPath: string;
    pattern: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<GlobBackendResult>;
}

type SearchRoot = {
  cwd: string;
  target: string;
  normalizePath: (path: string) => string;
};

function containsHardExcludedSegment(path: string) {
  return resolve(path)
    .split(sep)
    .some((part) => DEFAULT_WALK_IGNORED_DIRS.has(part));
}

function resolveSearchRoot(rootPath: string): SearchRoot {
  const canonicalRootPath = realpathSync(rootPath);
  if (
    containsHardExcludedSegment(rootPath)
    || containsHardExcludedSegment(canonicalRootPath)
  ) {
    throw new Error(
      `search root is inside a hard-excluded directory (${[...DEFAULT_WALK_IGNORED_DIRS].join(', ')})`,
    );
  }

  const stat = statSync(rootPath);
  const isDirectory = stat.isDirectory();
  if (!isDirectory && !stat.isFile()) {
    throw new Error(`search root must be a file or directory: ${rootPath}`);
  }

  const cwd = isDirectory ? rootPath : dirname(rootPath);
  const target = isDirectory ? '.' : basename(rootPath);
  return {
    cwd,
    target,
    normalizePath: (rawPath) => {
      const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
      const stablePath = isDirectory ? relative(rootPath, absolutePath) : basename(absolutePath);
      return stablePath.split(sep).join('/');
    },
  };
}

function hardExcludeArgs() {
  return [...DEFAULT_WALK_IGNORED_DIRS].flatMap((name) => [
    '--glob',
    `!${name}/**`,
    '--glob',
    `!**/${name}/**`,
  ]);
}

function matchesGlob(path: string, pattern: string) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? '';
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const matcher = new RegExp(`^${expression}$`);
  return matcher.test(path) || matcher.test(basename(path));
}

function createAbortError() {
  const error = new Error('search aborted');
  error.name = 'AbortError';
  return error;
}

async function runRipgrep(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  consumeStdout: (chunk: string, stop: () => void) => void,
) {
  if (signal?.aborted) throw createAbortError();

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(rgPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    let stderr = '';
    let stopped = false;
    let aborted = false;
    let spawnError: Error | null = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGTERM');
    };
    const abort = () => {
      aborted = true;
      stop();
    };
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: string) => {
      if (!stopped) consumeStdout(chunk, stop);
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_BACKEND_ERROR_CHARS) {
        stderr += chunk.slice(0, MAX_BACKEND_ERROR_CHARS - stderr.length);
      }
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (aborted) {
        reject(createAbortError());
        return;
      }
      if (spawnError) {
        const codeValue = (spawnError as NodeJS.ErrnoException).code;
        reject(codeValue === 'ENOENT'
          ? new Error(`bundled ripgrep executable is unavailable: ${rgPath}`)
          : spawnError);
        return;
      }
      if (!stopped && code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `ripgrep failed with exit code ${code ?? '?'}`));
        return;
      }
      resolvePromise();
    });
  });
}

function commonArgs() {
  return [
    '--no-config',
    '--hidden',
    '--no-require-git',
    '--sort',
    'path',
  ];
}

export const ripgrepSearchBackend: SearchBackend = {
  async grep(options) {
    const root = resolveSearchRoot(options.rootPath);
    const args = [
      ...commonArgs(),
      '--null',
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--max-columns',
      RG_LINE_PREVIEW_CHARS.toString(),
      '--max-columns-preview',
      ...(options.literal ? ['--fixed-strings'] : []),
      options.caseSensitive ? '--case-sensitive' : '--ignore-case',
      ...hardExcludeArgs(),
      ...(options.context > 0
        ? ['--context', options.context.toString(), '--no-context-separator']
        : []),
      '--',
      options.query,
      root.target,
    ];

    const lines: SearchLine[] = [];
    let matchCount = 0;
    let stoppedAtMatchLimit = false;
    let buffer = '';
    let pendingPath: string | null = null;

    const consumeRecord = (path: string, payload: string, stop: () => void) => {
      const parsed = /^(\d+)([:\-])(.*)$/.exec(payload);
      if (!parsed) return;
      const stablePath = root.normalizePath(path);
      if (options.glob && !matchesGlob(stablePath, options.glob)) return;
      const isMatch = parsed[2] === ':';
      if (isMatch) {
        matchCount += 1;
        if (matchCount > options.maxMatches) {
          stoppedAtMatchLimit = true;
          stop();
          return;
        }
      }
      const rawLine = (parsed[3] ?? '').replace(/\r$/, '');
      const backendTruncated = rawLine.endsWith(RG_LONG_LINE_MARKER);
      lines.push({
        path: stablePath,
        lineNumber: Number(parsed[1]),
        line: backendTruncated ? rawLine.slice(0, -RG_LONG_LINE_MARKER.length) : rawLine,
        isMatch,
        backendTruncated,
      });
      if (isMatch && matchCount === options.maxMatches && options.context === 0) {
        stoppedAtMatchLimit = true;
        stop();
      }
    };

    await runRipgrep(args, root.cwd, options.signal, (chunk, stop) => {
      buffer += chunk;
      while (true) {
        if (pendingPath === null) {
          const separator = buffer.indexOf('\0');
          if (separator < 0) return;
          pendingPath = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 1);
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const payload = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consumeRecord(pendingPath, payload, stop);
        pendingPath = null;
      }
    });

    return { lines, matchCount, stoppedAtMatchLimit };
  },

  async glob(options) {
    const root = resolveSearchRoot(options.rootPath);
    const args = [
      ...commonArgs(),
      '--files',
      '--null',
      ...hardExcludeArgs(),
      root.target,
    ];
    const paths: string[] = [];
    let stoppedAtResultLimit = false;
    let buffer = '';

    await runRipgrep(args, root.cwd, options.signal, (chunk, stop) => {
      buffer += chunk;
      while (true) {
        const separator = buffer.indexOf('\0');
        if (separator < 0) return;
        const path = root.normalizePath(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 1);
        if (!matchesGlob(path, options.pattern)) continue;
        paths.push(path);
        if (paths.length >= options.maxResults) {
          stoppedAtResultLimit = true;
          stop();
          return;
        }
      }
    });

    return { paths, stoppedAtResultLimit };
  },
};
