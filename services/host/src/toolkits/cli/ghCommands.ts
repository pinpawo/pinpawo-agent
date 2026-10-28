
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

/**
 * Why a gh invocation is not read-only, or undefined when it only reads.
 * This is an allowlist: anything not listed as a read is not one. `args`
 * excludes the leading `gh`.
 */
export function ghWriteReason(args: readonly string[]): string | undefined {
  const [group, action] = args;
  if (!group) return '缺少 gh 子命令';
  if (['--version', '--help', 'version', 'help', 'status'].includes(group)) return undefined;
  if (group === 'api') {
    // The endpoint decides the effect, which this check cannot see.
    return ghApiReadOnly(args.slice(1)) ? undefined : 'gh api 写请求的影响取决于具体接口';
  }
  if (group === 'auth' && args.some((arg) => arg === '--show-token' || arg === '-t')) {
    return 'gh auth status --show-token 会输出凭据';
  }
  const name = `gh ${[group, action].filter(Boolean).join(' ')}`;
  const reads = GH_READ_ACTIONS[group];
  if (reads !== 'any' && !reads?.has(action ?? '')) return `${name} 不是只读操作`;
  // `--web` opens a browser on the Host; `-w` means --web except on `run list`.
  return args.some((arg) => arg === '--web' || (arg === '-w' && !(group === 'run' && action === 'list')))
    ? `${name} --web 会在 Host 上打开浏览器`
    : undefined;
}
