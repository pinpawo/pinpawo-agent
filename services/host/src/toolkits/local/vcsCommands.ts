/**
 * Permission levels of git and gh invocations.
 *
 * - `read`: only reads. Runs anywhere without review, `inspect_shell` included.
 * - `change`: an everyday, recoverable write. Runs in `git_shell` / `gh_shell`
 *   without review; `inspect_shell` redirects it there.
 * - `risky`: loses data, rewrites shared history, or affects others or
 *   credentials. Reviewed in `git_shell` / `gh_shell`.
 *
 * The policy leans permissive: only clearly irreversible or shared-impact forms
 * are `risky`. Unrecognized subcommands and aliases are `risky` too, because
 * their effect is unknown; the cost of a wrong "risky" is one review.
 */
export type VcsLevel = 'read' | 'change' | 'risky';
export type VcsVerdict = { level: 'read' } | { level: 'change' | 'risky'; reason: string };

const READ: VcsVerdict = { level: 'read' };
const change = (reason: string): VcsVerdict => ({ level: 'change', reason });
const risky = (reason: string): VcsVerdict => ({ level: 'risky', reason });

/** Flags that end option parsing; everything after is a pathspec or operand. */
function beforeDoubleDash(args: readonly string[]) {
  const end = args.indexOf('--');
  return end === -1 ? args : args.slice(0, end);
}

/** A bundle like `-vv` or `-dr`, checked one letter at a time. */
function shortBundle(arg: string) {
  return /^-[A-Za-z]+$/.test(arg) ? arg.slice(1).split('') : [];
}

/** Whether any option (before `--`) is one of the long names or short letters. */
function hasOption(args: readonly string[], long: readonly string[], short = '') {
  return beforeDoubleDash(args).some((arg) => long.includes(arg.split('=')[0])
    || shortBundle(arg).some((letter) => short.includes(letter)));
}

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

/** Everyday writes; each may still have a risky form in GIT_RISKY_FORMS. */
const GIT_CHANGE_SUBCOMMANDS = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'clean', 'stash', 'branch',
  'tag', 'push', 'pull', 'fetch', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'apply',
  'rm', 'mv', 'remote', 'config', 'worktree', 'submodule', 'notes', 'init', 'clone',
  'gc', 'maintenance', 'bisect', 'reflog', 'update-ref', 'sparse-checkout',
  'format-patch', 'archive', 'bundle',
]);

/** Forms that discard uncommitted work, delete refs or rewrite shared history. */
const GIT_RISKY_FORMS: Record<string, (args: readonly string[]) => string | undefined> = {
  reset: (args) => (hasOption(args, ['--hard']) ? 'reset --hard 会丢弃未提交改动' : undefined),
  clean: (args) => (hasOption(args, ['--dry-run'], 'n') ? undefined : 'clean 会删除未跟踪文件'),
  checkout: (args) => (args.includes('--') || args.includes('.') || hasOption(args, ['--force'], 'f')
    ? 'checkout 会用其他版本覆盖工作区改动' : undefined),
  switch: (args) => (hasOption(args, ['--force', '--discard-changes'], 'f')
    ? 'switch --discard-changes 会丢弃工作区改动' : undefined),
  restore: (args) => (hasOption(args, ['--staged'], 'S') && !hasOption(args, ['--worktree'], 'W')
    ? undefined : 'restore 会覆盖工作区改动'),
  stash: (args) => (['drop', 'clear'].includes(args[0] ?? '') ? `stash ${args[0]} 会删除暂存的改动` : undefined),
  branch: (args) => (hasOption(args, ['--force'], 'DfMC') ? '强制删除或覆盖分支' : undefined),
  tag: (args) => (hasOption(args, ['--delete', '--force'], 'df') ? '删除或覆盖标签' : undefined),
  push: (args) => (hasOption(args, ['--force', '--force-with-lease', '--force-if-includes',
    '--delete', '--mirror', '--prune'], 'fd')
    || beforeDoubleDash(args).some((arg) => /^[+:]/.test(arg))
    ? '强推或删除远端引用会改写共享历史' : undefined),
  rm: (args) => (hasOption(args, ['--force'], 'f') ? 'rm -f 会丢弃文件的本地改动' : undefined),
  reflog: (args) => (['expire', 'delete', 'drop'].includes(args[0] ?? '') ? 'reflog 删除会去掉恢复点' : undefined),
  gc: (args) => (args.some((arg) => /^--prune=(?:now|all)$/.test(arg)) ? 'gc --prune=now 会删除不可达对象' : undefined),
  'update-ref': (args) => (hasOption(args, [], 'd') ? 'update-ref -d 会删除引用' : undefined),
  worktree: (args) => (args[0] === 'remove' && hasOption(args, ['--force'], 'f')
    ? 'worktree remove --force 会删除未提交改动' : undefined),
  submodule: (args) => (args[0] === 'deinit' && hasOption(args, ['--force'], 'f')
    ? 'submodule deinit --force 会丢弃子模块改动' : undefined),
};

/** Global options that only select the repository or the output mode. */
const GIT_GLOBAL_READ_OPTIONS = new Set(['--no-pager', '-P', '--no-optional-locks']);
const GIT_GLOBAL_PATH_OPTIONS = new Set(['-C', '--git-dir', '--work-tree']);

/** `args` excludes the leading `git`. */
export function classifyGitArgs(args: readonly string[]): VcsVerdict {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const arg = args[index];
    if (GIT_GLOBAL_READ_OPTIONS.has(arg) || /^--(?:git-dir|work-tree)=/.test(arg)) {
      index += 1;
    } else if (GIT_GLOBAL_PATH_OPTIONS.has(arg)) {
      index += 2;
    } else if (arg === '--version' || arg === '--help') {
      return READ;
    } else {
      // `-c` can set core.pager, aliases or diff drivers, i.e. run programs.
      return risky(`git 全局选项 ${arg} 可能执行任意程序`);
    }
  }
  const subcommand = args[index];
  if (!subcommand) return risky('缺少 git 子命令');
  const rest = args.slice(index + 1);
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    const writing = beforeDoubleDash(rest).find((arg) => GIT_WRITING_OPTIONS.includes(arg.split('=')[0]));
    return writing ? change(`git ${subcommand} ${writing} 会写文件或启动外部程序`) : READ;
  }
  if (GIT_READ_FORMS[subcommand]?.(rest)) return READ;
  if (!GIT_CHANGE_SUBCOMMANDS.has(subcommand)) return risky(`git ${subcommand} 不是已知的 git 子命令`);
  const danger = GIT_RISKY_FORMS[subcommand]?.(rest);
  return danger ? risky(danger) : change(`git ${subcommand} 会修改仓库状态`);
}

const GH_READ_ACTIONS: Record<string, ReadonlySet<string> | 'any'> = {
  pr: new Set(['list', 'view', 'diff', 'checks', 'status']),
  issue: new Set(['list', 'view', 'status']),
  run: new Set(['list', 'view']),
  workflow: new Set(['list', 'view']),
  release: new Set(['list', 'view']),
  repo: new Set(['list', 'view']),
  label: new Set(['list']),
  cache: new Set(['list']),
  gist: new Set(['list', 'view']),
  ruleset: new Set(['list', 'view', 'check']),
  secret: new Set(['list']),
  variable: new Set(['list']),
  auth: new Set(['status']),
  search: 'any',
};

/** Everyday collaboration: comments, reviews, edits, CI reruns, local clones. */
const GH_CHANGE_ACTIONS: Record<string, ReadonlySet<string>> = {
  pr: new Set(['create', 'comment', 'review', 'edit', 'ready', 'close', 'reopen', 'checkout',
    'lock', 'unlock', 'update-branch']),
  issue: new Set(['create', 'comment', 'edit', 'close', 'reopen', 'pin', 'unpin', 'lock',
    'unlock', 'develop']),
  label: new Set(['create', 'edit', 'clone']),
  run: new Set(['rerun', 'cancel', 'download', 'watch']),
  workflow: new Set(['run', 'enable', 'disable']),
  release: new Set(['download']),
  repo: new Set(['clone', 'fork']),
  gist: new Set(['create', 'edit', 'clone']),
};

/** `gh api` reads only as a GET without request fields (fields imply POST). */
function ghApiReadOnly(args: readonly string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (/^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/.test(arg) || /^-[fF]./.test(arg)) return false;
    const method = arg === '-X' || arg === '--method'
      ? args[index + 1]
      : /^-X(.+)$/.exec(arg)?.[1] ?? /^--method=(.+)$/.exec(arg)?.[1];
    if (method !== undefined && method.toUpperCase() !== 'GET') return false;
  }
  return true;
}

/** `args` excludes the leading `gh`. */
export function classifyGhArgs(args: readonly string[]): VcsVerdict {
  const [group, action] = args;
  if (!group) return risky('缺少 gh 子命令');
  if (['--version', '--help', 'version', 'help', 'status'].includes(group)) return READ;
  if (group === 'api') {
    // The endpoint decides the effect, which this check cannot see.
    return ghApiReadOnly(args.slice(1)) ? READ : risky('gh api 写请求的影响取决于具体接口');
  }
  if (group === 'auth' && args.some((arg) => arg === '--show-token' || arg === '-t')) {
    return risky('gh auth status --show-token 会输出凭据');
  }
  const name = `gh ${[group, action].filter(Boolean).join(' ')}`;
  const reads = GH_READ_ACTIONS[group];
  if (reads === 'any' || reads?.has(action ?? '')) {
    // `--web` opens a browser on the Host; `-w` means --web except on `run list`.
    return args.some((arg) => arg === '--web' || (arg === '-w' && !(group === 'run' && action === 'list')))
      ? change(`${name} --web 会在 Host 上打开浏览器`)
      : READ;
  }
  if (GH_CHANGE_ACTIONS[group]?.has(action ?? '')) return change(`${name} 会修改 GitHub 状态`);
  // Merging, deleting, releasing, secrets, credentials, settings and extensions.
  return risky(`${name} 影响共享状态、凭据或无法撤销`);
}
