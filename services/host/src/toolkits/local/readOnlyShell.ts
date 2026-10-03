/**
 * Heuristic guard against obvious high-risk mistakes, not a shell parser or
 * sandbox. Unknown commands and indirect code are trusted. Intentional writes
 * belong in run_shell; admission never proves a command read-only.
 */
const DANGEROUS_COMMANDS = new Set(['rm', 'shred', 'dd', 'mkfs', 'sudo', 'su', 'doas', 'shutdown', 'reboot']);
export type ReadOnlyShellVerdict = { allowed: true } | { allowed: false; reason: string };
type Token = { text: string; kind: 'word' | 'syntax' | 'operator' };

/** Keep quote provenance: a quoted keyword is an ordinary command/argument. */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  let started = false;
  let quoted = false;
  let quote = '';
  const flush = () => {
    if (started) tokens.push({ text, kind: quoted ? 'word' : 'syntax' });
    text = ''; started = false; quoted = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === "'" && quote !== '"') { quote = quote ? '' : "'"; started = true; quoted = true; continue; }
    if (c === '"' && quote !== "'") { quote = quote ? '' : '"'; started = true; quoted = true; continue; }
    if (c === '\\' && quote !== "'") {
      const next = command[++i];
      if (next === undefined) break;
      if (next !== '\n') {
        // Inside double quotes, backslash only escapes these four characters.
        if (quote === '"' && !'$`"\\'.includes(next)) text += '\\';
        text += next; started = true; quoted = true;
      }
      continue;
    }
    if (quote) { text += c; started = true; continue; }
    if (c === '#' && !started) {
      while (i < command.length && command[i] !== '\n') i += 1;
      if (i < command.length) tokens.push({ text: '\n', kind: 'operator' });
      continue;
    }
    if ('<>'.includes(c)) {
      if (/^\d+$/.test(text) && !quoted) { text = ''; started = false; }
      flush();
      const redirect = command.slice(i).match(/^[<>]+(?:&[0-9-]+)?/)![0];
      tokens.push({ text: redirect, kind: 'operator' });
      i += redirect.length - 1; continue;
    }
    if (';|&\n()'.includes(c)) {
      flush();
      const operator = command.slice(i).match(/^(;;&|;;|;&|&&|\|\||\|&)/)?.[0] ?? c;
      tokens.push({ text: operator, kind: 'operator' });
      i += operator.length - 1; continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    text += c; started = true;
  }
  flush();
  return tokens;
}

const basename = (word: string = '') => word.replace(/^.*\//, '');
const assignment = (word: string = '') => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

function checkCommand(words: string[]): string | undefined {
  const tokens = [...words];
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
  if (name === 'git') {
    let index = 0;
    while (tokens[index]?.startsWith('-')) {
      const flag = tokens[index++];
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(flag)) index += 1;
    }
    const [subcommand, ...args] = tokens.slice(index);
    if (subcommand === 'clean'
      || (subcommand === 'reset' && args.includes('--hard'))
      || (subcommand === 'push' && args.some((arg) => /^--(?:force(?:-with-lease|-if-includes)?|mirror|delete)(?:=|$)/.test(arg) || /^-[^-]*[fd]/.test(arg) || arg.startsWith('+')))
      || (subcommand === 'branch' && args.some((arg) => /^-[^-]*D/.test(arg)))) return 'git 破坏性操作需要审批';
  }
}

/** Scan common command positions without validating or pairing shell grammar. */
export function classifyReadOnlyShellCommand(command: string): ReadOnlyShellVerdict {
  if (!command.trim()) return { allowed: false, reason: '空命令' };
  let words: string[] = [];
  let data: '' | 'loop' | 'pattern' | 'test' = '';
  let redirectTarget = false;
  const flush = () => { const reason = checkCommand(words); words = []; return reason; };
  for (const token of tokenize(command)) {
    const { text, kind } = token;
    const plain = kind === 'syntax';
    // Only skip data regions we can recognize locally; no nested grammar stack.
    if (data === 'test') { if (plain && text === ']]') data = ''; continue; }
    if (data === 'pattern') { if ((text === ')' && kind === 'operator') || (plain && text === 'esac')) data = ''; continue; }
    if (kind === 'operator') {
      if (/^[<>]/.test(text)) { redirectTarget = !text.includes('&'); continue; }
      const reason = flush();
      if (reason) return { allowed: false, reason };
      if (data === 'loop' && [';', '\n'].includes(text)) data = '';
      if ([';;', ';&', ';;&'].includes(text)) data = 'pattern';
      continue;
    }
    if (redirectTarget) { redirectTarget = false; continue; }
    if (data === 'loop') continue;
    if (!words.length && plain) {
      if (['if', 'then', 'else', 'elif', 'while', 'until', 'do', 'done', 'fi', '{', '}', '!', 'time', '-p'].includes(text)) continue;
      if (text === 'for' || text === 'in') { data = 'loop'; continue; }
      if (text === 'case') { data = 'pattern'; continue; }
      if (text === '[[') { data = 'test'; continue; }
    }
    words.push(text);
  }
  const reason = flush();
  return reason ? { allowed: false, reason } : { allowed: true };
}
