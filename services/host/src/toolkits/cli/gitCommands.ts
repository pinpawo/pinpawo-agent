import { beforeDoubleDash, hasOption, shortBundle } from './cliArgs';

/**
 * Listing form of `git branch` / `git tag`. Positional names create a ref
 * unless a listing flag is present (these flags imply `--list` in git).
 */
function listingOnly(
  args: readonly string[],
  spec: {
    mutatingLong: readonly string[];
    mutatingShort: string;
    valueFlags: readonly string[];
    listFlags: readonly string[];
  },
): boolean {
  const options = beforeDoubleDash(args);
  let positionals = 0;
  let listing = false;
  for (let index = 0; index < options.length; index += 1) {
    const arg = options[index];
    const long = arg.split('=')[0];
    if (spec.mutatingLong.includes(long)) return false;
    if (shortBundle(arg).some((letter) => spec.mutatingShort.includes(letter))) return false;
    if (spec.listFlags.includes(long) || shortBundle(arg).includes('l')) listing = true;
    if (spec.valueFlags.includes(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) positionals += 1;
  }
  return positionals === 0 || listing;
}

const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'annotate', 'describe', 'shortlog',
  'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file',
  'grep', 'merge-base', 'name-rev', 'check-ignore', 'check-attr', 'check-ref-format',
  'show-ref', 'for-each-ref', 'show-branch', 'count-objects', 'whatchanged',
  'cherry', 'range-diff', 'diff-tree', 'diff-index', 'diff-files',
  'verify-commit', 'verify-tag', 'var', 'version',
]);

/** Options of otherwise read-only subcommands that write files or spawn programs. */
const GIT_WRITING_OPTIONS = ['--output', '-O', '--open-files-in-pager'];

/** Read-only forms of subcommands that can also write. */
const GIT_READ_FORMS: Record<string, (args: readonly string[]) => boolean> = {
  branch: (args) => listingOnly(args, {
    mutatingLong: ['--delete', '--move', '--copy', '--force', '--set-upstream-to',
      '--unset-upstream', '--edit-description', '--track', '--no-track',
      '--create-reflog', '--recurse-submodules'],
    mutatingShort: 'dDmMcCfut',
    valueFlags: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at',
      '--sort', '--format'],
    listFlags: ['--list', '--contains', '--no-contains', '--merged', '--no-merged',
      '--points-at'],
  }),
  tag: (args) => listingOnly(args, {
    mutatingLong: ['--annotate', '--sign', '--local-user', '--force', '--delete',
      '--message', '--file', '--edit', '--cleanup', '--create-reflog', '--trailer'],
    mutatingShort: 'asufdmFe',
    valueFlags: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at',
      '--sort', '--format'],
    listFlags: ['--list', '--contains', '--no-contains', '--merged', '--no-merged',
      '--points-at', '--verify', '-v'],
  }),
  stash: (args) => ['list', 'show'].includes(args[0] ?? ''),
  clean: (args) => hasOption(args, ['--dry-run'], 'n'),
  remote: (args) => args.length === 0
    || args.every((arg) => arg === '-v' || arg === '--verbose')
    || ['show', 'get-url'].includes(args[0]),
  config: (args) => {
    const options = beforeDoubleDash(args);
    if (options.some((arg) => ['--unset', '--unset-all', '--add', '--replace-all',
      '--rename-section', '--remove-section', '--edit', '-e'].includes(arg.split('=')[0]))) {
      return false;
    }
    const subcommand = options.find((arg) => !arg.startsWith('-'));
    return ['get', 'list'].includes(subcommand ?? '')
      || options.some((arg) => ['--get', '--get-all', '--get-regexp', '--get-urlmatch',
        '--get-color', '--get-colorbool', '--list', '-l'].includes(arg));
  },
  worktree: (args) => args[0] === 'list',
  reflog: (args) => !['expire', 'delete', 'drop'].includes(args[0] ?? ''),
  notes: (args) => args.length === 0 || ['list', 'show'].includes(args[0]),
  submodule: (args) => args.length === 0 || ['status', 'summary'].includes(args[0]),
};

/** Global options that only select the repository or the output mode. */
const GIT_GLOBAL_READ_OPTIONS = new Set(['--no-pager', '-P', '--no-optional-locks']);
const GIT_GLOBAL_PATH_OPTIONS = new Set(['-C', '--git-dir', '--work-tree']);

/**
 * Why a git invocation is not read-only, or undefined when it only reads.
 * This is an allowlist: an unknown subcommand, alias or global option is not
 * a read. `args` excludes the leading `git`.
 */
export function gitWriteReason(args: readonly string[]): string | undefined {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const arg = args[index];
    if (GIT_GLOBAL_READ_OPTIONS.has(arg) || /^--(?:git-dir|work-tree)=/.test(arg)) {
      index += 1;
    } else if (GIT_GLOBAL_PATH_OPTIONS.has(arg)) {
      index += 2;
    } else if (arg === '--version' || arg === '--help') {
      return undefined;
    } else {
      // `-c` can set core.pager, aliases or diff drivers, i.e. run programs.
      return `git 全局选项 ${arg} 可能执行任意程序`;
    }
  }
  const subcommand = args[index];
  if (!subcommand) return '缺少 git 子命令';
  const rest = args.slice(index + 1);
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    const writing = beforeDoubleDash(rest).find((arg) => GIT_WRITING_OPTIONS.includes(arg.split('=')[0]));
    return writing ? `git ${subcommand} ${writing} 会写文件或启动外部程序` : undefined;
  }
  if (GIT_READ_FORMS[subcommand]?.(rest)) return undefined;
  return `git ${subcommand} 不是只读操作`;
}
