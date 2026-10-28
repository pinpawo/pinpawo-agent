import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { createGitToolkit } from '../../../services/host/src/toolkits/git';
import { createGithubToolkit } from '../../../services/host/src/toolkits/github';
import { createShellToolDefinitions, createShellToolkit } from '../../../services/host/src/toolkits/shell';
import { classifyReadOnlyShellCommand } from '../../../services/host/src/toolkits/shell/readOnlyShell';
import { PosixShellRS } from '../../../services/host/src/toolkits/shellRS';

type ShellCall = { name: string; args: Record<string, unknown> };
type ExpectedCall = { names: readonly string[]; command: string };

/** git/gh reads run unreviewed in inspect_shell; these writes have no dedicated tool, so run_shell. */
const READ = ['inspect_shell'] as const;
const WRITE = ['run_shell'] as const;

const cases = [
  ['git-status-inspect', 'git status --short', READ, '查看当前工作区状态。'],
  ['git-log-inspect', 'git log -5 --oneline', READ, '查看最近五条提交。'],
  ['git-diff-inspect', 'git diff --stat', READ, '查看未暂存改动的统计。'],
  ['git-reset-run', 'git reset --hard HEAD', WRITE, '已确认丢弃所有已跟踪文件的本地改动，不需要备份。'],
  ['git-clean-run', 'git clean -fd', WRITE, '已确认删除全部未跟踪文件和目录，不需要保留。'],
  ['git-force-push-run', 'git push --force origin HEAD', WRITE, '已确认覆盖远端对应分支，允许强制推送。'],
  ['gh-pr-checks-inspect', 'gh pr checks 12', READ, '查看 PR 12 的 CI 检查状态。'],
  ['gh-pr-comment-run', 'gh pr comment 12 --body LGTM', WRITE, '已确认在 PR 12 下留言 LGTM。'],
] as const;

export const shellToolSelectionExamples = cases.map(([name, command, expectedTools, intent]) => ({
  name,
  inputs: {
    shell_tool_selection: true,
    task: `${intent}请执行 ${command}，然后简要报告结果。`,
    requested_command: command,
  },
  outputs: {
    expected_has_deliverable: true,
    expected_shell_call: { names: expectedTools, command },
    reason: 'The requested command must run through a path production would execute; the cheapest tool is a metric.',
  },
}));

const SHELL_TOOLS = ['inspect_shell', 'run_shell', 'start_process'];
const SEPARATOR = /\s*(?:&&|\|\||;|\|)\s*/;
/** Redirections to a descriptor or a sink, which do not change which command runs. */
const SINK_REDIRECT = /\s*\d*(?:&>>?|>>?|>\||[<>]&)\s*(?:\/dev\/null|\d+|-)(?=[\s;&|)]|$)/g;
/** Output-only git global options that do not change which command runs. */
const NEUTRAL_TOKENS = new Set(['--no-pager']);

/** The command a shell tool call would run. */
export function shellCallCommand(call: ShellCall) {
  return SHELL_TOOLS.includes(call.name) ? String(call.args.command ?? '').trim() : '';
}

const commandKey = (command: string) => command.trim().split(/\s+/)
  .filter((token) => !NEUTRAL_TOKENS.has(token)).sort().join(' ');

/** Whether the call runs `command`, alone or as one segment of a chain, in any flag order. */
export function callRunsCommand(call: ShellCall, command: string) {
  const expected = commandKey(command);
  return shellCallCommand(call).replace(SINK_REDIRECT, '').split(SEPARATOR)
    .some((segment) => commandKey(segment) === expected);
}

/** What production does with the call: refuse it, run it directly, or run it after review. */
export function productionDisposition(call: ShellCall): 'refused' | 'runs' | 'reviewed' {
  if (call.name === 'inspect_shell') return classifyReadOnlyShellCommand(shellCallCommand(call)).allowed ? 'runs' : 'refused';
  return 'reviewed';
}

/** gh has no network here: canned answers for the PR the cases name, an error for anything else. */
const GH_SHIM = `#!/bin/sh
case "$1 $2" in
  "pr checks") printf 'build\\tpass\\t1m12s\\thttps://github.com/acme/demo/actions/runs/101/job/201\\ntest\\tpass\\t2m40s\\thttps://github.com/acme/demo/actions/runs/101/job/202\\n' ;;
  "pr comment") echo "https://github.com/acme/demo/pull/12#issuecomment-3001" ;;
  "pr view") printf 'title:\\tAdd cart totals\\nstate:\\tOPEN\\nauthor:\\teval-bot\\nnumber:\\t12\\nurl:\\thttps://github.com/acme/demo/pull/12\\n' ;;
  "auth status") printf 'github.com\\n  Logged in to github.com account eval-bot (keyring)\\n' ;;
  "repo view") echo "acme/demo" ;;
  "--version "*) echo "gh version 2.60.0 (2024-10-10)" ;;
  *) echo "gh: no data for this command in the eval repository" >&2; exit 1 ;;
esac
`;

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.name=Eval Bot', '-c', 'user.email=eval@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: 'ignore',
  });
}

/**
 * A throwaway repository the cases' commands really run in: six pushed
 * commits on main, an unstaged edit, and untracked files. `origin` is a local
 * bare repository, so pushes stay on this machine.
 */
export function createShellSelectionRepo() {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-shell-eval-'));
  const repo = join(root, 'demo');
  const bin = join(root, 'bin');
  git(root, 'init', '-q', '--bare', 'remote.git');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'));
  const files = ['README.md', 'src/cart.ts', 'src/price.ts', 'src/tax.ts', 'src/format.ts', 'src/index.ts'];
  for (const [index, file] of files.entries()) {
    writeFileSync(join(repo, file), `// ${file}\nexport const step${index} = ${index};\n`);
    git(repo, 'add', file);
    git(repo, 'commit', '-q', '-m', `Add ${file}`);
  }
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  writeFileSync(join(repo, 'src/cart.ts'), '// src/cart.ts\nexport const step1 = 1;\nexport const total = 42;\n');
  writeFileSync(join(repo, 'notes.txt'), 'scratch notes\n');
  mkdirSync(join(repo, 'tmp'));
  writeFileSync(join(repo, 'tmp/out.log'), 'log\n');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), GH_SHIM);
  chmodSync(join(bin, 'gh'), 0o755);
  return { repo, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Production review outcome for a call the eval's reviewer rejects. */
function rejected(name: string, args: Record<string, unknown>) {
  return JSON.stringify({
    ok: false, cancelled: true, source: 'human_reject', toolName: name, toolkitName: 'shell',
    reason: 'tool call rejected by user', input: args, retryable: false,
    guidance: 'Follow the user rejection and any updated direction. Do not retry this exact tool call unless the user explicitly asks for it.',
  });
}

/**
 * The production shell Toolkit running in a throwaway repository. Reviewed
 * calls are approved when they only read or run the confirmed command, the
 * way review settles these cases; anything else is rejected.
 */
export function buildShellSelectionMockTools(requestedCommand?: string) {
  const calls: ShellCall[] = [];
  const { repo, bin, cleanup } = createShellSelectionRepo();
  const shell = new PosixShellRS({ commandDir: bin });
  const config = {
    context: {
      executionScope: { threadId: 'shell-eval', taskId: 'task-1', runId: 'run-1', delegationId: 'delegation-1', workdir: repo },
    },
  };
  const approves = (call: ShellCall) => classifyReadOnlyShellCommand(shellCallCommand(call)).allowed
    || (requestedCommand !== undefined && callRunsCommand(call, requestedCommand));
  const tools = createShellToolDefinitions({ shell }).tools.map(({ tool: definition, review }) => tool(
    async (args: Record<string, unknown>) => {
      const call = { name: definition.name, args };
      calls.push(call);
      if (review && !approves(call)) return rejected(definition.name, args);
      return definition.invoke(args, config);
    },
    { name: definition.name, description: definition.description, schema: definition.schema },
  ));
  const promptSections = [createShellToolkit({ shell }), createGitToolkit({ shell }), createGithubToolkit({ shell })]
    .map((toolkit) => ({
    id: `toolkit:${toolkit.name}`,
    owner: toolkit.name,
    content: toolkit.instructions as string,
  }));
  return {
    tools,
    calls,
    promptSections,
    workdir: repo,
    readFile: (_path: string) => null,
    dispose: async () => {
      await shell.dispose();
      cleanup();
    },
  };
}

/** Outcome: the requested command ran through a path production would execute. */
export function requestedCommandExecutedEvaluator({ outputs, referenceOutputs }: {
  outputs?: { calls?: ShellCall[] };
  referenceOutputs?: { expected_shell_call?: ExpectedCall };
}) {
  const expected = referenceOutputs?.expected_shell_call;
  if (!expected) return { key: 'requested_command_executed', score: 1, comment: 'Not a shell selection case' };
  const calls = outputs?.calls ?? [];
  const executed = calls.some((call) => callRunsCommand(call, expected.command) && productionDisposition(call) !== 'refused');
  return { key: 'requested_command_executed', score: executed ? 1 : 0,
    comment: `Expected ${expected.command} to run; observed ${JSON.stringify(calls)}` };
}

/** Metric: the requested command used the expected tool, and read cases stayed on unreviewed tools. */
export function shellToolChoiceEvaluator({ outputs, referenceOutputs }: {
  outputs?: { calls?: ShellCall[] };
  referenceOutputs?: { expected_shell_call?: ExpectedCall };
}) {
  const expected = referenceOutputs?.expected_shell_call;
  if (!expected) return { key: 'shell_tool_choice', score: 1, comment: 'Not a shell selection case' };
  const calls = outputs?.calls ?? [];
  const matching = calls.filter((call) => callRunsCommand(call, expected.command));
  const readCase = expected.names.includes('inspect_shell');
  const passed = matching.length > 0 && matching.every((call) => expected.names.includes(call.name))
    && (!readCase || calls.every((call) => expected.names.includes(call.name)));
  const reviews = calls.filter((call) => productionDisposition(call) === 'reviewed').length;
  const refusals = calls.filter((call) => productionDisposition(call) === 'refused').length;
  return { key: 'shell_tool_choice', score: passed ? 1 : 0,
    comment: `Expected ${expected.command} via ${expected.names.join(' or ')}; ${reviews} review(s), ${refusals} refusal(s) in production`,
    readCase, reviews, refusals };
}
