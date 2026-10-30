import { parse } from 'shell-quote';
import { shortBundle } from '../cli/cliArgs';
import { ghWriteReason } from '../cli/ghCommands';
import { gitWriteReason } from '../cli/gitCommands';

/**
 * Admission for `inspect_shell`: a blocklist, not an allowlist.
 *
 * The model is trusted to keep mutations out of `inspect_shell`; its tool
 * description says so. This check refuses the bottom line — operations with
 * obvious irreversible effects — and the common write forms: git/gh writes,
 * file writes (redirects, `sed -i`, `mv`, `cp`, `tee`…), package installs and
 * publishes, curl/wget writes, `make` and running script files. Each refusal
 * names the tool to use instead, usually `run_shell`, where git/gh writes are
 * reviewed only in their risky forms.
 * It is not a shell parser or a sandbox: loop and case bodies, interpreter
 * code (`python -c`, `node -e`) and other dynamic code are not inspected.
 */
export type ReadOnlyShellVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; redirect: string };

type Refusal = { reason: string; redirect: string };

const RUN_SHELL = '需要执行时改用 run_shell，它会走工具审批。';
const FILE_TOOLS = '写文件改用 apply_patch、write_file 等文件工具；其他写操作改用 run_shell，它会走工具审批。';
const GIT_TOOLS = 'git 暂存、提交和普通推送改用 git_add、git_commit、git_push；其他 git 写操作改用 run_shell，它会走工具审批。';
const GH_TOOLS = '创建 PR、issue 改用 gh_pr_create、gh_issue_create；其他 GitHub 写操作改用 run_shell，它会走工具审批。';

const DESTRUCTIVE_COMMANDS = new Set(['rm', 'shred', 'dd', 'mkfs', 'sudo', 'su', 'doas', 'shutdown', 'reboot']);
const KILL_COMMANDS = new Set(['kill', 'pkill', 'killall']);
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'time', 'nohup']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SEPARATORS = new Set(['|', '&&', '||', ';', '&', '|&']);
const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a',
  '--max-args', '--max-procs', '--max-lines', '--delimiter', '--eof', '--max-chars', '--arg-file']);
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FILE_WRITE_COMMANDS = new Set(['mv', 'cp', 'ln', 'touch', 'mkdir', 'rmdir', 'unlink', 'chmod', 'chown',
  'chgrp', 'truncate', 'install', 'tee', 'patch']);
const IN_PLACE_EDITORS = new Set(['sed', 'perl']);
/** Read-only subcommands; any other subcommand installs, publishes or runs scripts. */
const PACKAGE_MANAGER_READS: Record<string, ReadonlySet<string>> = {
  npm: new Set(['ls', 'list', 'll', 'la', 'view', 'v', 'info', 'show', 'outdated', 'why', 'explain', 'search',
    'help', 'root', 'bin', 'prefix', 'doctor', 'ping', 'whoami', 'query', 'fund', 'config', 'audit']),
  pnpm: new Set(['ls', 'list', 'll', 'why', 'outdated', 'view', 'info', 'root', 'bin', 'help', 'audit',
    'licenses', 'config']),
  yarn: new Set(['list', 'info', 'why', 'outdated', 'help', 'licenses', 'audit', 'bin', 'config']),
  bun: new Set(['outdated', 'help']),
  pip: new Set(['list', 'show', 'freeze', 'check', 'help', 'config', 'index', 'inspect', 'debug']),
  pip3: new Set(['list', 'show', 'freeze', 'check', 'help', 'config', 'index', 'inspect', 'debug']),
};
const VERSION_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h']);
/** Redirections that open their target for writing. */
const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '>&', '<>']);
/** Redirections whose target is only read: an input file, a descriptor or a here-doc word. */
const INPUT_REDIRECTS = new Set(['<', '<&', '<<', '<<<']);
const REDIRECT_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
/** `>&1`, `>&-`: duplicating or closing a descriptor writes no file. */
const isDescriptor = (word: string = '') => /^(?:\d+|-)$/.test(word);
/** `sh -c "…"` is followed this many levels deep. */
const MAX_NESTING = 3;

const basename = (word: string = '') => word.replace(/^.*\//, '');
const assignment = (word: string = '') => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const beforeDoubleDash = (args: string[]) => (args.includes('--') ? args.slice(0, args.indexOf('--')) : args);

function forcesKill(args: string[]) {
  return args.some((arg, index) => /^-(?:9|(?:sig)?kill)$/i.test(arg)
    || /^--signal=(?:9|(?:sig)?kill)$/i.test(arg)
    || (['-s', '--signal'].includes(arg) && /^(?:9|(?:sig)?kill)$/i.test(args[index + 1] ?? '')));
}

function checkCommand(words: string[], depth: number): Refusal | undefined {
  const tokens = [...words];
  while (['if', 'then', 'else', 'elif', '!'].includes(tokens[0])) tokens.shift();
  // Resolve transparent wrappers repeatedly; quoted arguments remain arguments.
  while (true) {
    while (assignment(tokens[0])) tokens.shift();
    if (!WRAPPERS.has(basename(tokens[0]))) break;
    const wrapper = basename(tokens.shift());
    if (wrapper === 'command' && ['-v', '-V'].includes(tokens[0])) return;
    while (tokens[0]?.startsWith('-') || assignment(tokens[0])) {
      const flag = tokens.shift()!;
      if ((wrapper === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(flag)) || (wrapper === 'exec' && flag === '-a')) tokens.shift();
      if (flag === '--') break;
    }
  }
  const name = basename(tokens.shift());
  const options = beforeDoubleDash(tokens);

  if ((DESTRUCTIVE_COMMANDS.has(name) || /^mkfs\./.test(name))
    && !options.some((arg) => ['--help', '--version'].includes(arg))) {
    return { reason: `${name} 有不可逆副作用`, redirect: RUN_SHELL };
  }
  if (KILL_COMMANDS.has(name) && forcesKill(options)) {
    return { reason: `${name} 强制终止进程`, redirect: RUN_SHELL };
  }
  const write = checkWrite(name, tokens);
  if (write) return write;
  if (name === 'git') {
    const reason = gitWriteReason(tokens);
    return reason ? { reason, redirect: GIT_TOOLS } : undefined;
  }
  if (name === 'gh') {
    const reason = ghWriteReason(tokens);
    return reason ? { reason, redirect: GH_TOOLS } : undefined;
  }
  // One level of indirection that hides the same heads.
  if (name === 'find') {
    if (tokens.includes('-delete')) return { reason: 'find -delete 会删除文件', redirect: RUN_SHELL };
    for (let index = 0; index < tokens.length; index += 1) {
      if (!FIND_EXEC_ACTIONS.has(tokens[index])) continue;
      const end = tokens.findIndex((arg, at) => at > index && (arg === ';' || arg === '+'));
      const refusal = checkCommand(tokens.slice(index + 1, end === -1 ? undefined : end), depth);
      if (refusal) return refusal;
    }
  }
  if (name === 'xargs') {
    let index = 0;
    while (tokens[index]?.startsWith('-')) index += XARGS_VALUE_FLAGS.has(tokens[index]) ? 2 : 1;
    if (index < tokens.length) return checkCommand(tokens.slice(index), depth);
  }
  if (SHELLS.has(name)) {
    const flag = options.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    const script = flag === -1 ? undefined : options[flag + 1];
    if (script) return depth < MAX_NESTING ? checkSource(script, depth + 1) : undefined;
    const syntaxOnly = options.some((arg) => shortBundle(arg).includes('n'));
    if (!syntaxOnly && !(tokens.length > 0 && tokens.every((arg) => VERSION_FLAGS.has(arg)))) {
      return { reason: `${name} 会运行脚本`, redirect: RUN_SHELL };
    }
  }
  if (name === 'source' || name === '.') return { reason: `${name} 会运行脚本`, redirect: RUN_SHELL };
  return undefined;
}

/** Common write forms of otherwise ordinary commands. `args` excludes the program. */
function checkWrite(name: string, args: string[]): Refusal | undefined {
  const options = beforeDoubleDash(args);
  if (FILE_WRITE_COMMANDS.has(name) && !options.some((arg) => VERSION_FLAGS.has(arg))) {
    return { reason: `${name} 会写文件`, redirect: FILE_TOOLS };
  }
  if (IN_PLACE_EDITORS.has(name)
    && options.some((arg) => arg.startsWith('--in-place') || (/^-[A-Za-z]*i/.test(arg) && !arg.startsWith('--')))) {
    return { reason: `${name} -i 会原地改写文件`, redirect: FILE_TOOLS };
  }
  const reads = PACKAGE_MANAGER_READS[name];
  if (reads) {
    const subcommand = options.find((arg) => !arg.startsWith('-'));
    const readOnly = subcommand === undefined
      ? options.some((arg) => VERSION_FLAGS.has(arg))
      : reads.has(subcommand)
        && !(subcommand === 'audit' && options.includes('fix'))
        && !(subcommand === 'config' && !['get', 'list', 'ls'].includes(options[options.indexOf(subcommand) + 1] ?? ''));
    if (!readOnly) return { reason: `${[name, subcommand].filter(Boolean).join(' ')} 会安装、发布或运行脚本`, redirect: RUN_SHELL };
  }
  if (name === 'curl' && curlWrites(options)) return { reason: 'curl 会发送写请求或写文件', redirect: RUN_SHELL };
  if (name === 'wget' && !wgetToStdout(options)) return { reason: 'wget 会下载并写文件', redirect: RUN_SHELL };
  if (name === 'make' && !options.some((arg) => ['--dry-run', '--just-print', '--recon', '--question', '--help',
    '--version'].includes(arg) || shortBundle(arg).some((letter) => 'nqv'.includes(letter)))) {
    return { reason: 'make 会构建或运行任务', redirect: RUN_SHELL };
  }
  return undefined;
}

function curlWrites(args: string[]) {
  return args.some((arg, index) => {
    const next = args[index + 1] ?? '';
    const method = arg === '-X' || arg === '--request' ? next
      : arg.startsWith('--request=') ? arg.slice('--request='.length)
        : /^-X./.test(arg) ? arg.slice(2) : null;
    if (method !== null) return !['GET', 'HEAD'].includes(method.toUpperCase());
    if (/^--(?:data|json|form|upload-file|remote-name)/.test(arg)) return true;
    if (arg === '--output' || arg.startsWith('--output=')) {
      const target = arg === '--output' ? next : arg.slice('--output='.length);
      return !['-', '/dev/null'].includes(target);
    }
    const letters = shortBundle(arg);
    if (letters.some((letter) => 'dFTO'.includes(letter))) return true;
    return letters.at(-1) === 'o' && !['-', '/dev/null'].includes(next);
  });
}

function wgetToStdout(args: string[]) {
  return args.some((arg, index) => arg === '--spider' || arg === '--output-document=-' || /^-[A-Za-z]*O-$/.test(arg)
    || ((arg === '--output-document' || /^-[A-Za-z]*O$/.test(arg)) && args[index + 1] === '-'));
}

/** Split on the separators shell-quote exposes and check every command head. */
function checkSource(source: string, depth: number): Refusal | undefined {
  // shell-quote reads a newline as plain whitespace, so each line is also
  // checked alone; otherwise `cd x⏎rm -rf y` would hide `rm` as an argument.
  const sources = source.includes('\n') ? [source, ...source.split('\n')] : [source];
  for (const text of sources) {
    let tokens: ReturnType<typeof parse<never>>;
    try {
      // shell-quote splits `2>&1` into an argument `2` and `>&`; drop the
      // descriptor number first so it never reaches the command's arguments.
      // `git branch 2 >x` keeps its space, so `2` stays a branch name.
      const unnumbered = text.replace(/(^|[\s;&|()])\d+(?=[<>])/g, '$1');
      // Never expand from Host env or erase unknown variables into different heads.
      tokens = parse(unnumbered, (name) => '${' + name + '}');
    } catch {
      // Syntax validity belongs to the executing shell, not this check.
      continue;
    }
    let words: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (typeof token === 'string') { words.push(token); continue; }
      if ('comment' in token) break;
      if (OUTPUT_REDIRECTS.has(token.op) || INPUT_REDIRECTS.has(token.op)) {
        // Redirections are not arguments: classify the command without them.
        const next = tokens[index + 1];
        const target = typeof next === 'string' ? next : '';
        if (typeof next === 'string') index += 1;
        const sink = REDIRECT_SINKS.has(target) || (token.op.endsWith('&') && isDescriptor(target));
        if (OUTPUT_REDIRECTS.has(token.op) && !sink) {
          return { reason: `重定向 ${token.op} 会写文件`, redirect: FILE_TOOLS };
        }
        continue;
      }
      if (!SEPARATORS.has(token.op)) {
        words.push(token.op === 'glob' && 'pattern' in token ? token.pattern : token.op);
        continue;
      }
      const refusal = checkCommand(words, depth);
      if (refusal) return refusal;
      words = [];
    }
    const refusal = checkCommand(words, depth);
    if (refusal) return refusal;
  }
  return undefined;
}

export function classifyReadOnlyShellCommand(command: string): ReadOnlyShellVerdict {
  if (!command.trim()) return { allowed: false, reason: '空命令', redirect: '请提供要执行的检查命令。' };
  const refusal = checkSource(command, 0);
  return refusal ? { allowed: false, ...refusal } : { allowed: true };
}
