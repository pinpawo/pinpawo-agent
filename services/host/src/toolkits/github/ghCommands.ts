import { change, type CliVerdict, READ, risky } from '../cli/cliLevels';

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
export function classifyGhArgs(args: readonly string[]): CliVerdict {
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
