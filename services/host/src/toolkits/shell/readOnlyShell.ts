import { parse } from 'shell-quote';
import { ghWriteReason } from '../cli/ghCommands';
import { gitWriteReason } from '../cli/gitCommands';

/** A small admission allowlist, not a sandbox. Unrecognized forms use run_shell. */
export type ReadOnlyShellVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; redirect: string };

type Refusal = { reason: string; redirect: string };

const RUN_SHELL = '需要执行时改用 run_shell，它会走工具审批。';
const FILE_TOOLS = '写文件改用 apply_patch、write_file 等文件工具；其他写操作改用 run_shell，它会走工具审批。';
const GIT_TOOLS = 'git 暂存、提交和普通推送改用 git_add、git_commit、git_push；其他 git 写操作改用 run_shell，它会走工具审批。';
const GH_TOOLS = '创建 PR、issue 改用 gh_pr_create、gh_issue_create；其他 GitHub 写操作改用 run_shell，它会走工具审批。';

const SEPARATORS = new Set(['|', '&&', '||', ';', '|&']);
const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '>&', '<>']);
const INPUT_REDIRECTS = new Set(['<', '<&']);
const REDIRECT_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
const isDescriptor = (word: string = '') => /^(?:\d+|-)$/.test(word);
const READS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'pwd', 'stat', 'file', 'du', 'df',
  'basename', 'dirname', 'realpath', 'readlink', 'echo', 'true', 'false', 'test', '[',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'rg', 'grep', 'jq', 'cd']);
// These tools have executable/output options. Only the ordinary query forms bypass review.
const FLAGS: Record<string, RegExp> = {
  file: /^(?:--(?:help|version|mime|mime-type|mime-encoding|brief|dereference)|-[bhiLNz0]+)$/,
  rg: /^(?:--(?:files|hidden|no-ignore|no-heading|heading|line-number|ignore-case|fixed-strings|count|files-with-matches|files-without-match|glob|type|type-add|context|before-context|after-context|color|sort|stats|max-count|max-depth|no-messages|multiline|pcre2)(?:=.*)?|-[nilLoSsvwFxzUPcHgABCemtf0-9]+)$/,
  grep: /^(?:--(?:color|include|exclude|exclude-dir)(?:=.*)?|-[nrilLEFvwxcsHhoABCe0-9]+)$/,
  jq: /^(?:--(?:arg|argjson|slurpfile|rawfile|raw-output|compact-output|null-input|slurp|raw-input|exit-status|sort-keys|monochrome-output)|-[rscnRejSMC]+)$/,
  sort: /^(?:--(?:numeric-sort|reverse|unique|key|field-separator)(?:=.*)?|-[nruhkVt]+)$/,
  diff: /^(?:--(?:stat|brief|recursive|unified|exclude)(?:=.*)?|-[uqrwaBbiIEUN0-9]+)$/,
};

function checkCommand(words: string[]): Refusal | undefined {
  if (!words.length) return;
  const [name, ...args] = words;
  const refuse = (reason = `${name} 的调用形式不在免审白名单内`): Refusal => ({ reason, redirect: RUN_SHELL });
  // Assignments, paths, wrappers and dynamic programs require review.
  if (!/^[a-z][a-z0-9_-]*$/.test(name) && name !== '[') return refuse();
  if (name === 'git' && args.some(arg => ['--ext-diff', '--textconv'].includes(arg) || /^-O/.test(arg))) return refuse();
  if (name === 'git') { const reason = gitWriteReason(args); return reason ? { reason, redirect: GIT_TOOLS } : undefined; }
  if (name === 'gh') { const reason = ghWriteReason(args); return reason ? { reason, redirect: GH_TOOLS } : undefined; }
  if (name === 'sed') {
    // No e/w/r extensions, script files or in-place editing. Keep the common range-print query.
    return args[0] === '-n' && /^\d+(?:,\d+|,\$)?p$/.test(args[1] ?? '')
      && args.slice(2).every(arg => !arg.startsWith('-')) ? undefined : refuse();
  }
  if (name === 'find') {
    const allowed = new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth',
      '-size', '-mtime', '-mmin', '-print', '-print0', '-empty', '-readable', '-writable', '-executable', '-not', '-a', '-o']);
    return args.some(arg => arg.startsWith('-') && !allowed.has(arg)) ? refuse() : undefined;
  }
  if (!READS.has(name)) return refuse();
  // uniq's second positional operand is an output file; only pipeline filters bypass review.
  if (name === 'uniq') return args.every(arg => /^-[cduiz]+$/.test(arg)) ? undefined : refuse();
  const options = args.slice(0, args.indexOf('--') === -1 ? undefined : args.indexOf('--'));
  if (FLAGS[name] && options.some(arg => arg.startsWith('-') && arg !== '-' && !FLAGS[name].test(arg))) return refuse();
  if (FLAGS[name]) return undefined;
  // Unknown output/control options use reviewed execution.
  if (options.some(arg => /^(?:--(?:output|follow|files0-from|reference|use-compress-program)(?:=|$)|-o.+)/.test(arg))) return refuse();
  if (['sort', 'diff', 'cat', 'ls', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df', 'cut', 'tr', 'uniq', 'cmp', 'realpath', 'readlink', 'basename', 'dirname'].includes(name)
    && options.some(arg => arg.startsWith('--') && !/^--(?:help|version|all|human-readable|bytes|lines|words|count|recursive|dereference|format|printf|size|summarize|total|zero|zero-terminated|number|number-nonblank|show-all|color|directory|long|parents|relative-to|relative-base)(?:=|$)/.test(arg))) return refuse();
  return undefined;
}

/** Split on the separators shell-quote exposes and check every command head. */
function checkSource(source: string): Refusal | undefined {
  // shell-quote reads a newline as plain whitespace, so check each line
  // alone; otherwise `cd x⏎rm -rf y` would hide `rm` as an argument.
  const sources = source.split(/\r?\n/);
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
      return { reason: '无法解析检查命令', redirect: RUN_SHELL };
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
        if (typeof next !== 'string') return { reason: '重定向缺少目标', redirect: RUN_SHELL };
        index += 1;
        const sink = REDIRECT_SINKS.has(target) || (token.op.endsWith('&') && isDescriptor(target));
        if (OUTPUT_REDIRECTS.has(token.op) && !sink) {
          return { reason: `重定向 ${token.op} 会写文件`, redirect: FILE_TOOLS };
        }
        continue;
      }
      if (!SEPARATORS.has(token.op)) {
        if (token.op === 'glob' && 'pattern' in token) { words.push(token.pattern); continue; }
        return { reason: '动态或复杂 shell 形式需要审核', redirect: RUN_SHELL };
      }
      const refusal = checkCommand(words);
      if (refusal) return refusal;
      words = [];
    }
    const refusal = checkCommand(words);
    if (refusal) return refusal;
  }
  return undefined;
}

function hasDynamicExpansion(source: string) {
  // Admission parses each line separately; comment quotes cannot mask expansion on a later line.
  for (const line of source.split(/\r?\n/)) {
    let quote = '';
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (char === '\\' && quote !== "'") { index++; continue; }
      if ((char === "'" || char === '"') && (!quote || quote === char)) {
        quote = quote ? '' : char;
      } else if (quote !== "'" && (char === '$' || char === '`')) return true;
    }
  }
  return false;
}

export function classifyReadOnlyShellCommand(command: string): ReadOnlyShellVerdict {
  if (!command.trim()) return { allowed: false, reason: '空命令', redirect: '请提供要执行的检查命令。' };
  // Reject shell expansion before tokenization, which otherwise hides executable substitutions.
  if (hasDynamicExpansion(command) || /\\\n/.test(command)) return { allowed: false, reason: '动态 shell 展开需要审核', redirect: RUN_SHELL };
  const refusal = checkSource(command);
  return refusal ? { allowed: false, ...refusal } : { allowed: true };
}
