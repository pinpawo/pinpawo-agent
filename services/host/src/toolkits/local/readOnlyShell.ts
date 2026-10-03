/**
 * Best-effort high-risk-operation denylist for the unreviewed inspection path.
 * Unknown commands are trusted; this is neither a sandbox nor proof of read-only
 * behavior. The caller must still use run_shell for intentional state changes.
 */
const DANGEROUS_COMMANDS = new Set([
  'rm', 'rmdir', 'shred', 'dd', 'mkfs', 'sudo', 'su', 'doas',
  'chmod', 'chown', 'chgrp', 'kill', 'killall', 'pkill', 'shutdown', 'reboot',
]);
// These execute text/files that this shell-syntax check cannot inspect.
const OPAQUE_EXECUTORS = new Set(['eval', 'source', '.', 'bash', 'sh', 'zsh', 'fish', 'xargs']);
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
    if (quote !== "'" && (c === '`' || (c === '$' && command[i + 1] === '('))) throw new Error('命令替换');
    if (c === '\\' && quote !== "'") {
      const next = command[++i];
      if (next === undefined) throw new Error('未完成的转义');
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
      // Keep diagnostic redirections transparent to command-head detection.
      const safe = command.slice(i).match(/^>&[012](?=\s|$|[;|&])|^>\s*\/dev\/null(?=\s|$|[;|&])/);
      if (!safe) throw new Error('文件重定向、heredoc 或进程替换');
      if (/^\d+$/.test(text) && !quoted) { text = ''; started = false; }
      flush(); i += safe[0].length - 1; continue;
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
  if (quote) throw new Error('未闭合引号');
  flush();
  return tokens;
}

/**
 * Walk shell command positions, including every compound-command body. Words
 * in for-lists, case patterns and test expressions are data, not command heads.
 * Unsupported/unfinished syntax goes to review rather than skipping a body.
 */
function shellCommands(tokens: Token[]): string[][] {
  let index = 0;
  const commands: string[][] = [];
  const at = (...words: string[]) => tokens[index]?.kind !== 'word' && words.includes(tokens[index]?.text);
  const take = (word: string) => { if (!at(word)) throw new Error(`未完成的 shell 语法：${word}`); index += 1; };
  const word = () => {
    const token = tokens[index++];
    if (!token || token.kind === 'operator') throw new Error('缺少 shell 词');
    return token.text;
  };
  const list = (stops: string[] = []) => {
    while (index < tokens.length && !at(...stops)) {
      if (at(';', '\n', '&&', '||', '|', '|&', '&')) { index += 1; continue; }
      statement();
    }
  };
  const statement = () => {
    if (at('!', 'time')) {
      index += 1;
      if (at('-p')) index += 1;
      statement(); return;
    }
    if (at('if')) {
      index += 1; list(['then']); take('then'); list(['elif', 'else', 'fi']);
      while (at('elif')) { index += 1; list(['then']); take('then'); list(['elif', 'else', 'fi']); }
      if (at('else')) { index += 1; list(['fi']); }
      take('fi'); return;
    }
    if (at('while', 'until')) {
      index += 1; list(['do']); take('do'); list(['done']); take('done'); return;
    }
    if (at('for', 'select')) {
      index += 1;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(word())) throw new Error('不支持的循环变量');
      while (at('\n')) index += 1;
      if (at('in')) {
        index += 1;
        while (index < tokens.length && !at(';', '\n')) word();
      }
      if (at(';')) index += 1;
      while (at('\n')) index += 1;
      take('do'); list(['done']); take('done'); return;
    }
    if (at('case')) {
      index += 1; word();
      while (at('\n')) index += 1;
      take('in');
      while (index < tokens.length) {
        while (at('\n')) index += 1;
        if (at('esac')) break;
        if (at('(')) index += 1;
        while (index < tokens.length && !at(')')) {
          if (at('|')) index += 1; else word();
        }
        take(')'); list([';;', ';&', ';;&', 'esac']);
        if (at(';;', ';&', ';;&')) index += 1;
      }
      take('esac'); return;
    }
    if (at('(', '{')) {
      const close = at('(') ? ')' : '}';
      index += 1; list([close]); take(close); return;
    }
    if (at('[[')) {
      index += 1;
      while (index < tokens.length && !at(']]')) index += 1;
      take(']]'); return;
    }
    // Function definitions are inspected even if they are never called.
    if (at('function') || (tokens[index + 1]?.text === '(' && tokens[index + 1]?.kind === 'operator')) {
      if (at('function')) index += 1;
      word();
      if (at('(')) { index += 1; take(')'); }
      while (at('\n')) index += 1;
      if (!at('{', '(')) throw new Error('不支持的函数体');
      statement(); return;
    }
    if (at('then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}', ')', ';;', ';&', ';;&')) {
      throw new Error('意外的 shell 控制语法');
    }
    const words: string[] = [];
    while (index < tokens.length && tokens[index].kind !== 'operator') words.push(word());
    if (!words.length) throw new Error('不支持的 shell 语法');
    commands.push(words);
  };
  list();
  return commands;
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
      if (wrapper === 'env' && (/^-S/.test(flag) || flag.startsWith('--split-string'))) return 'env 内联执行需要审批';
      if ((wrapper === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(flag)) || (wrapper === 'exec' && flag === '-a')) tokens.shift();
      if (flag === '--') break;
    }
  }
  const name = basename(tokens.shift());
  if (name !== '[' && /[$*?\[\]{}]/.test(name)) return '动态命令名需要审批';
  if (DANGEROUS_COMMANDS.has(name) || /^mkfs\./.test(name)) return `命令 "${name}" 需要审批`;
  if (OPAQUE_EXECUTORS.has(name)) return `"${name}" 的间接执行需要审批`;
  if ((name === 'node' && tokens.some((arg) => /^-(?:[ep]|-(?:eval|print)(?:=|$))/.test(arg)))
    || (/^python(?:\d+(?:\.\d+)*)?$/.test(name) && tokens.some((arg) => /^-c/.test(arg)))) return '内联代码需要审批';
  if (name === 'find' && tokens.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(arg))) return 'find 删除或间接执行需要审批';
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

export function classifyReadOnlyShellCommand(command: string): ReadOnlyShellVerdict {
  try {
    const tokens = tokenize(command.trim());
    if (!tokens.length) return { allowed: false, reason: '空命令' };
    for (const words of shellCommands(tokens)) {
      const reason = checkCommand(words);
      if (reason) return { allowed: false, reason };
    }
    return { allowed: true };
  } catch (error) {
    return { allowed: false, reason: `需要审批：${(error as Error).message}` };
  }
}
