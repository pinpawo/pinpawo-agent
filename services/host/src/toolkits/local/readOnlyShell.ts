import { parse } from 'shell-quote';
import { classifyGhArgs, classifyGitArgs } from './vcsCommands';

/**
 * Admission for `inspect_shell`: a blocklist, not an allowlist.
 *
 * The model is trusted to keep mutations out of `inspect_shell`; its tool
 * description says so. This check only refuses the bottom line — operations
 * with obvious irreversible effects, and git/gh writes, which belong to
 * `git_shell` / `gh_shell` where risky forms are reviewed — and names the tool
 * to use instead.
 * It is not a shell parser or a sandbox: loop and case bodies, scripts and
 * dynamic code are not inspected.
 */
export type ReadOnlyShellVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; redirect: string };

type Refusal = { reason: string; redirect: string };

const RUN_SHELL = '需要执行时改用 run_shell，它会走工具审批。';
const GIT_TOOLS = 'git 写操作改用 git_* 工具或 git_shell，它们按操作走审批；没有 git toolkit 时用 run_shell。';
const GH_TOOLS = 'GitHub 写操作改用 gh_* 工具或 gh_shell，它们按操作走审批；没有 git toolkit 时用 run_shell。';

const DESTRUCTIVE_COMMANDS = new Set(['rm', 'shred', 'dd', 'mkfs', 'sudo', 'su', 'doas', 'shutdown', 'reboot']);
const KILL_COMMANDS = new Set(['kill', 'pkill', 'killall']);
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'time', 'nohup']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SEPARATORS = new Set(['|', '&&', '||', ';', '&', '|&']);
const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a',
  '--max-args', '--max-procs', '--max-lines', '--delimiter', '--eof', '--max-chars', '--arg-file']);
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
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
  if (name === 'git') {
    const verdict = classifyGitArgs(tokens);
    return verdict.level === 'read' ? undefined : { reason: verdict.reason, redirect: GIT_TOOLS };
  }
  if (name === 'gh') {
    const verdict = classifyGhArgs(tokens);
    return verdict.level === 'read' ? undefined : { reason: verdict.reason, redirect: GH_TOOLS };
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
  if (SHELLS.has(name) && depth < MAX_NESTING) {
    const flag = options.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    const script = flag === -1 ? undefined : options[flag + 1];
    if (script) return checkSource(script, depth + 1);
  }
  return undefined;
}

/** Split on the separators shell-quote exposes and check every command head. */
function checkSource(source: string, depth: number): Refusal | undefined {
  // shell-quote reads a newline as plain whitespace, so each line is also
  // checked alone; otherwise `cd x⏎rm -rf y` would hide `rm` as an argument.
  const sources = source.includes('\n') ? [source, ...source.split('\n')] : [source];
  for (const text of sources) {
    let tokens: ReturnType<typeof parse<never>>;
    try {
      // Never expand from Host env or erase unknown variables into different heads.
      tokens = parse(text, (name) => '${' + name + '}');
    } catch {
      // Syntax validity belongs to the executing shell, not this check.
      continue;
    }
    let words: string[] = [];
    for (const token of tokens) {
      if (typeof token === 'string') { words.push(token); continue; }
      if ('comment' in token) break;
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
