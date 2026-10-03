import { parse } from 'shell-quote';

/** A small command-head heuristic, not shell validation or a security boundary. */
const DANGEROUS_COMMANDS = new Set(['rm', 'shred', 'dd', 'mkfs', 'sudo', 'su', 'doas', 'shutdown', 'reboot']);
const SEPARATORS = new Set(['|', '&&', '||', ';', '&', '|&']);
export type ReadOnlyShellVerdict = { allowed: true } | { allowed: false; reason: string };

const basename = (word: string = '') => word.replace(/^.*\//, '');
const assignment = (word: string = '') => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

function checkCommand(words: string[]): string | undefined {
  const tokens = [...words];
  while (['if', 'then', 'else', 'elif', '!'].includes(tokens[0])) tokens.shift();
  // Resolve transparent wrappers repeatedly; quoted arguments remain arguments.
  while (true) {
    while (assignment(tokens[0])) tokens.shift();
    if (!['env', 'command', 'builtin', 'exec', 'time', 'nohup'].includes(basename(tokens[0]))) break;
    const wrapper = basename(tokens.shift());
    if (wrapper === 'command' && ['-v', '-V'].includes(tokens[0])) return;
    while (tokens[0]?.startsWith('-') || assignment(tokens[0])) {
      const flag = tokens.shift()!;
      if ((wrapper === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(flag)) || (wrapper === 'exec' && flag === '-a')) tokens.shift();
      if (flag === '--') break;
    }
  }
  const name = basename(tokens.shift());
  if ((DANGEROUS_COMMANDS.has(name) || /^mkfs\./.test(name))
    && !tokens.slice(0, tokens.includes('--') ? tokens.indexOf('--') : tokens.length)
      .some((arg) => ['--help', '--version'].includes(arg))) return `命令 "${name}" 需要审批`;
  if (name === 'kill') {
    const flags = tokens.slice(0, tokens.includes('--') ? tokens.indexOf('--') : tokens.length);
    if (flags.some((arg, index) => /^-(?:9|(?:sig)?kill)$/i.test(arg)
      || /^--signal=(?:9|(?:sig)?kill)$/i.test(arg)
      || (['-s', '--signal'].includes(arg) && /^(?:9|(?:sig)?kill)$/i.test(flags[index + 1] ?? '')))) {
      return 'kill 强制终止需要审批';
    }
  }
}

/** Check only heads separated by the operators shell-quote exposes. */
export function classifyReadOnlyShellCommand(command: string): ReadOnlyShellVerdict {
  if (!command.trim()) return { allowed: false, reason: '空命令' };
  let tokens: ReturnType<typeof parse<never>>;
  try {
    // Never expand from Host env or erase unknown variables into different heads.
    tokens = parse(command, (name) => '${' + name + '}');
  } catch {
    // Syntax validity belongs to the executing shell, not this heuristic.
    return { allowed: true };
  }
  let words: string[] = [];
  for (const token of tokens) {
    if (typeof token === 'string') { words.push(token); continue; }
    if ('comment' in token) break;
    if (!SEPARATORS.has(token.op)) {
      words.push(token.op === 'glob' && 'pattern' in token ? token.pattern : token.op);
      continue;
    }
    const reason = checkCommand(words);
    if (reason) return { allowed: false, reason };
    words = [];
  }
  const reason = checkCommand(words);
  return reason ? { allowed: false, reason } : { allowed: true };
}
