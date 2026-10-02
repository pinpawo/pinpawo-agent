/**
 * Best-effort dangerous-operation denylist for the unreviewed inspection path.
 * Unknown inspection commands are trusted; this is not a shell sandbox or a
 * proof of read-only behavior. Known writes and opaque execution use run_shell.
 */
const DANGEROUS_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'install', 'mkdir', 'rmdir', 'touch', 'truncate', 'tee',
  'chmod', 'chown', 'chgrp', 'kill', 'killall', 'pkill', 'sudo', 'su', 'doas',
  'dd', 'mkfs', 'shutdown', 'reboot', 'mount', 'umount', 'launchctl',
  'eval', 'exec', 'source', '.', 'bash', 'sh', 'zsh', 'fish', 'xargs',
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
]);
const DANGEROUS_SUBCOMMANDS: Record<string, readonly string[]> = {
  git: ['push', 'commit', 'add', 'rm', 'mv', 'merge', 'rebase', 'reset', 'checkout',
    'switch', 'restore', 'clean', 'apply', 'am', 'cherry-pick', 'revert', 'fetch',
    'pull', 'clone', 'init', 'gc', 'prune', 'filter-branch', 'update-ref', 'submodule'],
  npm: ['install', 'i', 'ci', 'uninstall', 'update', 'run', 'exec', 'publish', 'unpublish', 'link', 'rebuild'],
  pnpm: ['install', 'add', 'remove', 'update', 'run', 'exec', 'dlx', 'publish'],
  yarn: ['install', 'add', 'remove', 'upgrade', 'run', 'exec', 'dlx', 'publish'],
};
const DANGEROUS_ARGUMENTS: Record<string, readonly string[]> = {
  find: ['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'],
  sed: ['-i', '--in-place'], awk: ['-i', '--in-place'],
  node: ['-e', '--eval', '-p', '--print'], python: ['-c'], python3: ['-c'],
  git: ['--exec-path', '-c'],
};
export type ReadOnlyShellVerdict = { allowed: true } | { allowed: false; reason: string };

/** Tokenize actual shell syntax, leaving quoted query expressions intact. */
function shellSegments(command: string): string[][] | string {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let started = false;
  let quote = '';
  const flush = () => { if (started) tokens.push(token); token = ''; started = false; };
  const segment = () => { flush(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === "'" && quote !== '"') { quote = quote ? '' : "'"; started = true; continue; }
    if (c === '"' && quote !== "'") { quote = quote ? '' : '"'; started = true; continue; }
    if (quote !== "'" && (c === '`' || (c === '$' && command[i + 1] === '('))) return '命令替换';
    if (c === '\\' && quote !== "'") {
      const next = command[++i];
      if (next === undefined) return '未完成的转义';
      if (next !== '\n') { token += next; started = true; }
      continue;
    }
    if (quote) { token += c; started = true; continue; }
    if (c === '#' && !started) { while (i < command.length && command[i] !== '\n') i += 1; segment(); continue; }
    if ('(){}'.includes(c)) return '复合执行语法';
    if (c === '<') return '输入重定向、heredoc 或进程替换';
    if (c === '>') {
      // Descriptor duplication and discarding diagnostics do not write files.
      const rest = command.slice(i);
      const safe = rest.match(/^>&[012](?=\s|$|[;|&])|^>\s*\/dev\/null(?=\s|$|[;|&])/);
      if (!safe) return '输出重定向';
      if (/^\d+$/.test(token)) { token = ''; started = false; }
      i += safe[0].length - 1; continue;
    }
    if (';|&\n'.includes(c)) {
      if (c === '&' && command[i + 1] !== '&') return '后台执行';
      segment();
      if (command[i + 1] === c) i += 1;
      continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    token += c; started = true;
  }
  if (quote) return '未闭合引号';
  segment();
  return segments;
}

export function classifyReadOnlyShellCommand(command: string): ReadOnlyShellVerdict {
  const segments = shellSegments(command.trim());
  if (typeof segments === 'string') return { allowed: false, reason: `需要审批：${segments}` };
  if (!segments.length) return { allowed: false, reason: '空命令' };
  for (const tokens of segments) {
    // Environment prefixes and transparent wrappers must not hide a blocked head.
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift();
    if (tokens[0]?.replace(/^.*\//, '') === 'command' && ['-v', '-V'].includes(tokens[1])) continue;
    while (['env', 'command', 'builtin', 'time'].includes(tokens[0]?.replace(/^.*\//, ''))) {
      const wrapper = tokens.shift()?.replace(/^.*\//, '');
      while (tokens[0]?.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) {
        const flag = tokens.shift()!;
        if (wrapper === 'env' && (/^-S/.test(flag) || flag.startsWith('--split-string'))) {
          return { allowed: false, reason: 'env 内联执行需要审批' };
        }
        if (wrapper === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(flag)) tokens.shift();
      }
    }
    const name = (tokens.shift() ?? '').replace(/^.*\//, '');
    if (DANGEROUS_COMMANDS.has(name)) return { allowed: false, reason: `命令 "${name}" 需要审批` };
    const args = tokens;
    const subcommand = name === 'git' ? gitCommandArgs(args)[0] : commandArgs(args)[0];
    if (subcommand && DANGEROUS_SUBCOMMANDS[name]?.includes(subcommand)) {
      return { allowed: false, reason: `"${name}" 的写入子命令需要审批` };
    }
    if (DANGEROUS_ARGUMENTS[name]?.some((flag) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)
      || (flag.length === 2 && arg.startsWith(flag))))) {
      return { allowed: false, reason: `"${name}" 的执行或写入参数需要审批` };
    }
    if (name === 'gh' && args.some((arg) => ['auth', 'create', 'edit', 'delete', 'merge', 'close', 'reopen', 'upload', 'set'].includes(arg))) {
      return { allowed: false, reason: 'gh 写入操作需要审批' };
    }
    if (name === 'gh' && args[0] === 'api' && args.some((arg) => ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'].includes(arg))) {
      return { allowed: false, reason: 'gh api 显式请求方法或请求体需要审批' };
    }
    if (name === 'git' && gitWrites(args)) {
      return { allowed: false, reason: 'git 写入操作需要审批' };
    }
    if (name === 'curl' && args.some((arg) => /^-[oOTdF]/.test(arg) || /^--(output|output-dir|remote-name|upload-file|data(?:-[a-z]+)?|form)(=|$)/.test(arg)
      || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(arg.toUpperCase()))) {
      return { allowed: false, reason: 'curl 文件写入或上传需要审批' };
    }
  }
  return { allowed: true };
}

/** Skip global git option operands before identifying the actual subcommand. */
function gitCommandArgs(args: string[]) {
  let index = 0;
  while (args[index]?.startsWith('-')) {
    const flag = args[index++];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(flag)) index += 1;
  }
  return args.slice(index);
}

function gitWrites(args: string[]) {
  const [subcommand, ...rest] = gitCommandArgs(args);
  if (rest.some((arg) => ['-d', '-D', '--delete', '-m', '-M', '--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section'].includes(arg))) {
    return ['branch', 'tag', 'config'].includes(subcommand);
  }
  if (subcommand === 'branch') {
    // Positional branch names create branches, except operands of list filters.
    for (let i = 0; i < rest.length; i += 1) {
      if (['--contains', '--no-contains', '--merged', '--no-merged', '--points-at'].includes(rest[i])) { i += 1; continue; }
      if (!rest[i].startsWith('-') && !rest.includes('--list') && !rest.includes('-l')) return true;
    }
  }
  if (subcommand === 'tag') return rest.some((arg) => !arg.startsWith('-')) && !rest.includes('--list') && !rest.includes('-l');
  if (subcommand === 'remote') return ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'update', 'prune'].includes(rest[0]);
  if (subcommand === 'stash') return !rest.length || ['push', 'save', 'pop', 'apply', 'drop', 'clear', 'store', 'create', 'branch'].includes(rest[0]);
  if (subcommand === 'worktree') return ['add', 'remove', 'move', 'prune', 'lock', 'unlock', 'repair'].includes(rest[0]);
  if (subcommand === 'config') {
    const positional = rest.filter((arg, index) => !arg.startsWith('-') && !['--file', '-f', '--blob'].includes(rest[index - 1]));
    return ['set', 'unset', 'rename-section', 'remove-section'].includes(positional[0])
      || (positional.length > 1 && !rest.some((arg) => ['--get', '--get-all', '--get-regexp', '--get-urlmatch', 'get', 'list'].includes(arg)));
  }
  return false;
}


function commandArgs(args: string[]) {
  let index = 0;
  while (args[index]?.startsWith('-')) {
    const flag = args[index++];
    if (['--prefix', '--workspace', '-w', '--filter', '-C', '--dir'].includes(flag)) index += 1;
  }
  return args.slice(index);
}
