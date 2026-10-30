import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { readToolExecutionContext, type OperationBlock } from '@pinpawo/pet-agent';
import { parse } from 'shell-quote';

const SOURCE_LIMIT_BYTES = 24_000;
const NPM_SCRIPTS = new Set(['run', 'run-script', 'test', 't', 'tst', 'start', 'stop', 'restart']);

function scriptKind(words: string[]) {
  const program = basename(words[0] ?? '');
  if (program === 'npm' && (NPM_SCRIPTS.has(words[1] ?? '')
    || (words[1]?.startsWith('-') && words.slice(2).some(word => NPM_SCRIPTS.has(word))))) return 'npm';
  if (program === 'make' || program === 'gmake') return 'make';
  if (/^(?:node|python3?|bash|sh|pnpm|yarn|bun)$/.test(program) || /\.(?:sh|js|mjs|cjs|py)$/.test(program)) return 'script';
  return null;
}

function commandParts(command: string) {
  return command.split(/\r?\n/).flatMap(line => [...parse(line, name => '${' + name + '}'), { op: ';' as const }]);
}

/** Mutable script execution has no reusable argv-only authorization identity. */
export function invokesShellScript(command: string) {
  try {
    let words: string[] = [];
    for (const token of commandParts(command)) {
      if (typeof token === 'string') words.push(token);
      else {
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words.shift();
        // Wrappers can select another command or directory; do not infer their execution options.
        if (basename(words[0] ?? '') === 'env') return true;
        if (scriptKind(words)) return true;
        words = [];
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** Read only a directly located package/Makefile; never evaluate scripts or follow includes. */
export async function shellScriptContext(input: unknown): Promise<OperationBlock[]> {
  const args = input as { command?: unknown; cwd?: unknown } | null;
  if (typeof args?.command !== 'string' || !invokesShellScript(args.command)) return [];
  const unavailable = (reason: string): OperationBlock[] => [{ kind: 'text', text: `Script source unavailable: ${reason}` }];
  let words;
  try { words = parse(args.command, name => '${' + name + '}'); }
  catch { return unavailable('command syntax is not a direct invocation.'); }
  if (/[$`\n\r]/.test(args.command) || !words.every((word): word is string => typeof word === 'string')) {
    return unavailable('compound or dynamic command; source location was not inferred.');
  }
  const kind = scriptKind(words);
  if (!kind) return unavailable('wrapped invocation; source location was not inferred.');
  if (kind !== 'npm' && kind !== 'make') return [];
  // Match the executor's existing invocation context. Never substitute the Host's process cwd.
  const { workdir } = readToolExecutionContext(AsyncLocalStorageProviderSingleton.getRunnableConfig());
  if (typeof args.cwd === 'string' && args.cwd !== args.cwd.trim()) return unavailable('cwd has surrounding whitespace.');
  const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : '.';
  if (!isAbsolute(cwd) && (!workdir || !isAbsolute(workdir))) return unavailable('execution workdir is unknown.');
  const directory = isAbsolute(cwd) ? cwd : resolve(workdir!, cwd);
  const sourceArgs = words.slice(1, words.indexOf('--') === -1 ? undefined : words.indexOf('--'));
  if (sourceArgs.some(arg => arg.startsWith('-') && !(kind === 'make' && ['-n', '-q', '-p'].includes(arg)))) {
    return unavailable('source-selecting options were not resolved.');
  }
  const paths = (kind === 'npm' ? ['package.json'] : ['GNUmakefile', 'makefile', 'Makefile']).map(file => resolve(directory, file));
  for (const path of paths) {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      if (!(await file.stat()).isFile()) return unavailable(`${path} is not a regular file.`);
      const buffer = Buffer.alloc(SOURCE_LIMIT_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return [
        { kind: 'text', text: `Untrusted source snapshot: ${path}. Referenced scripts, includes and configuration are not expanded.` },
        { kind: 'code', language: kind === 'npm' ? 'json' : 'makefile',
          text: buffer.subarray(0, Math.min(bytesRead, SOURCE_LIMIT_BYTES)).toString('utf8'),
          ...(bytesRead > SOURCE_LIMIT_BYTES ? { truncated: true as const } : {}) },
      ];
    } catch (error) {
      // Make chooses the first existing standard filename; permission errors cannot select another.
      if (kind === 'npm' || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return unavailable(`cannot read ${path}; parent directories were not searched.`);
      }
    } finally { await file?.close(); }
  }
  return unavailable(`cannot read ${paths.join(', ')}.`);
}
