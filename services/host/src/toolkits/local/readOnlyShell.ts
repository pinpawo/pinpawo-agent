/**
 * Admission control for `inspect_shell`.
 *
 * `inspect_shell` carries no review policy, so this module — not a model — is
 * what keeps it from running something with side effects. It is therefore an
 * allowlist in the strict sense: anything it does not positively recognise is
 * refused, and the caller falls back to the reviewed `run_shell`. A rejection
 * costs one retry; a wrong acceptance runs an unreviewed command, so every
 * rule here fails closed.
 */

/** Commands that only read. Anything absent from this set is refused. */
const READ_ONLY_COMMANDS = new Set([
  // navigation and trivia
  'cd', 'pwd', 'echo', 'true', 'false', 'basename', 'dirname', 'realpath',
  // reading files
  'cat', 'head', 'tail', 'less', 'more', 'nl', 'strings', 'file',
  // listing and locating
  'ls', 'find', 'tree', 'stat', 'readlink', 'which', 'type', 'whereis',
  // searching
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  // text processing (read-only usages; see REFUSED_ARGUMENTS for the rest)
  'sed', 'awk', 'cut', 'sort', 'uniq', 'wc', 'tr', 'column', 'paste', 'comm',
  'diff', 'cmp', 'rev', 'fold', 'expand', 'unexpand',
  // structured data
  'jq', 'yq', 'xmllint',
  // version control (inspection only)
  'git', 'gh',
  // environment
  'env', 'printenv', 'date', 'uname', 'hostname', 'whoami', 'id', 'uptime',
  'df', 'du', 'ps', 'top', 'wc', 'locale',
  // checksums
  'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum',
  // package metadata (read-only subcommands only; see SUBCOMMAND_ALLOWLIST)
  'npm', 'node', 'python3', 'python',
]);

/**
 * Commands whose safety depends on the subcommand. `git log` reads; `git push`
 * does not. Only the listed subcommands are accepted.
 */
const SUBCOMMAND_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  git: new Set([
    'log', 'status', 'diff', 'show', 'branch', 'tag', 'blame', 'describe',
    'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'shortlog',
    'config', 'remote', 'stash', 'reflog', 'whatchanged', 'grep', 'worktree',
  ]),
  gh: new Set([
    'pr', 'issue', 'repo', 'api', 'release', 'run', 'search', 'label',
  ]),
  npm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'why', 'root', 'prefix', 'config']),
};

/**
 * Arguments that turn an otherwise read-only command into an executor or a
 * writer. These are matched anywhere in the command's own arguments.
 */
const REFUSED_ARGUMENTS: Record<string, readonly string[]> = {
  // find spawns processes and deletes
  find: ['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'],
  // sed/awk/perl write files or shell out
  sed: ['-i', '--in-place', 'w', 'W'],
  awk: ['-i', '--in-place'],
  // git subcommands that mutate even under an allowed head
  git: ['--exec-path', '-c'],
  gh: ['--jq'],
  // node/python inline code is arbitrary execution
  node: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python3: ['-c'],
  npm: ['--ignore-scripts=false'],
};

/**
 * Subcommands that mutate despite living under an allowed command. Checked
 * against the first non-flag argument.
 */
const REFUSED_SUBCOMMANDS: Record<string, readonly string[]> = {
  git: ['push', 'commit', 'add', 'rm', 'mv', 'merge', 'rebase', 'reset', 'checkout',
    'switch', 'restore', 'clean', 'apply', 'am', 'cherry-pick', 'revert', 'fetch',
    'pull', 'clone', 'init', 'gc', 'prune', 'filter-branch', 'update-ref', 'submodule'],
  gh: ['auth'],
};

/** Shell metacharacters that can introduce an unchecked command or a write. */
const REFUSED_SYNTAX: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\$\(/, reason: '命令替换 $(...)' },
  { pattern: /`/, reason: '反引号命令替换' },
  { pattern: /(^|[^0-9<>&])>/, reason: '输出重定向' },
  { pattern: />>/, reason: '追加重定向' },
  { pattern: /<\(/, reason: '进程替换' },
  { pattern: />\(/, reason: '进程替换' },
  { pattern: /\$\{[^}]*[:#%/]/, reason: '带操作符的参数展开' },
  { pattern: /&\s*$/, reason: '后台执行' },
];

export type ReadOnlyShellVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Whether the command is recognisably read-only.
 *
 * Splits on the separators the allowlist tolerates (`&&`, `||`, `;`, `|`) and
 * requires every segment to pass on its own, so one refused segment refuses
 * the whole command.
 */
export function classifyReadOnlyShellCommand(command: string): ReadOnlyShellVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: '空命令' };

  for (const { pattern, reason } of REFUSED_SYNTAX) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `不支持${reason}` };
    }
  }
  // A newline is a statement separator like `;`, but it also hides heredoc
  // bodies whose content this module cannot vet.
  if (/<<-?\s*['"]?\w/.test(trimmed)) {
    return { allowed: false, reason: '不支持 heredoc' };
  }

  for (const segment of splitSegments(trimmed)) {
    const verdict = classifySegment(segment);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true };
}

function splitSegments(command: string) {
  return command
    .split(/\|\||&&|[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function classifySegment(segment: string): ReadOnlyShellVerdict {
  const tokens = tokenize(segment);
  const head = tokens[0];
  if (!head) return { allowed: false, reason: '空命令段' };
  // `VAR=x cmd` prefixes hide the real head; refuse rather than guess.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
    return { allowed: false, reason: '不支持环境变量前缀赋值' };
  }
  const name = head.replace(/^.*\//, '');
  if (!READ_ONLY_COMMANDS.has(name)) {
    return { allowed: false, reason: `命令 "${name}" 不在只读白名单内` };
  }

  const args = tokens.slice(1);
  const refusedArgs = REFUSED_ARGUMENTS[name];
  if (refusedArgs) {
    const hit = args.find((arg) => refusedArgs.some((refused) => (
      arg === refused || arg.startsWith(`${refused}=`)
    )));
    if (hit) {
      return { allowed: false, reason: `"${name}" 的参数 "${hit}" 可能产生副作用` };
    }
  }

  const subcommand = args.find((arg) => !arg.startsWith('-'));
  const refusedSubcommands = REFUSED_SUBCOMMANDS[name];
  if (subcommand && refusedSubcommands?.includes(subcommand)) {
    return { allowed: false, reason: `"${name} ${subcommand}" 会修改状态` };
  }
  const allowedSubcommands = SUBCOMMAND_ALLOWLIST[name];
  if (allowedSubcommands) {
    if (!subcommand) {
      return { allowed: false, reason: `"${name}" 需要一个只读子命令` };
    }
    if (!allowedSubcommands.has(subcommand)) {
      return { allowed: false, reason: `"${name} ${subcommand}" 不在只读白名单内` };
    }
  }
  return { allowed: true };
}

/** Split on whitespace, keeping quoted runs together. */
function tokenize(segment: string) {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}
