import { tool } from '@langchain/core/tools';
import { createGitToolkit } from '../../../services/host/src/toolkits/git';
import { createGitTools, gitShellCallNeedsReview } from '../../../services/host/src/toolkits/git/gitTools';
import { createGithubToolkit } from '../../../services/host/src/toolkits/github';
import { createGithubTools, ghShellCallNeedsReview } from '../../../services/host/src/toolkits/github/githubTools';
import { createShellToolkit } from '../../../services/host/src/toolkits/shell';
import { classifyReadOnlyShellCommand } from '../../../services/host/src/toolkits/shell/readOnlyShell';
import { createInspectShellTool, createRunShellTool, createStartProcessTool } from '../../../services/host/src/toolkits/shell/shellTools';
import type { ShellRS } from '../../../services/host/src/toolkits/shellRS/shellRS';

type ShellCall = { name: string; args: Record<string, unknown> };
type ExpectedCall = { names: readonly string[]; command: string };

/** Reads are cheapest through either unreviewed tool; writes through the permissioned one. */
const READ_GIT = ['inspect_shell', 'git_shell'] as const;
const READ_GH = ['inspect_shell', 'gh_shell'] as const;

const cases = [
  ['git-status-inspect', 'git status --short', READ_GIT, '查看当前工作区状态。'],
  ['git-log-inspect', 'git log -5 --oneline', READ_GIT, '查看最近五条提交。'],
  ['git-diff-inspect', 'git diff --stat', READ_GIT, '查看未暂存改动的统计。'],
  ['git-reset-run', 'git reset --hard HEAD', ['git_shell'], '已确认丢弃所有已跟踪文件的本地改动，不需要备份。'],
  ['git-clean-run', 'git clean -fd', ['git_shell'], '已确认删除全部未跟踪文件和目录，不需要保留。'],
  ['git-force-push-run', 'git push --force origin HEAD', ['git_shell'], '已确认覆盖远端对应分支，允许强制推送。'],
  ['gh-pr-checks-inspect', 'gh pr checks 12', READ_GH, '查看 PR 12 的 CI 检查状态。'],
  ['gh-pr-comment-run', 'gh pr comment 12 --body LGTM', ['gh_shell'], '已确认在 PR 12 下留言 LGTM。'],
] as const;

export const shellToolSelectionExamples = cases.map(([name, command, expectedTools, intent]) => ({
  name,
  inputs: {
    shell_tool_selection: true,
    task: `${intent}请执行 ${command}，然后简要报告结果。`,
    shell_outputs: { [command]: 'Requested command completed successfully (controlled fixture output).' },
  },
  outputs: {
    expected_has_deliverable: true,
    expected_shell_call: { names: expectedTools, command },
    reason: 'The requested command must run through a path production would execute; the cheapest tool is a metric.',
  },
}));

const SHELL_TOOLS = ['inspect_shell', 'run_shell', 'start_process'];
const SEPARATOR = /\s*(?:&&|\|\||;|\|)\s*/;
/** Output-only git global options that do not change which command runs. */
const NEUTRAL_TOKENS = new Set(['--no-pager']);

/** The command a call would run, comparable across shell-string and argv tools. */
export function shellCallCommand(call: ShellCall) {
  if (SHELL_TOOLS.includes(call.name)) return String(call.args.command ?? '').trim();
  const program = call.name === 'git_shell' ? 'git' : call.name === 'gh_shell' ? 'gh' : null;
  const args = Array.isArray(call.args.args) ? call.args.args.map(String) : [];
  return program ? [program, ...args].join(' ') : '';
}

const commandKey = (command: string) => command.trim().split(/\s+/)
  .filter((token) => !NEUTRAL_TOKENS.has(token)).sort().join(' ');

/** Whether the call runs `command`, alone or as one segment of a chain, in any flag order. */
export function callRunsCommand(call: ShellCall, command: string) {
  const expected = commandKey(command);
  return shellCallCommand(call).split(SEPARATOR).some((segment) => commandKey(segment) === expected);
}

/** What production does with the call: refuse it, run it directly, or run it after review. */
export function productionDisposition(call: ShellCall): 'refused' | 'runs' | 'reviewed' {
  if (call.name === 'inspect_shell') return classifyReadOnlyShellCommand(shellCallCommand(call)).allowed ? 'runs' : 'refused';
  if (call.name === 'git_shell') return gitShellCallNeedsReview(call.args) ? 'reviewed' : 'runs';
  if (call.name === 'gh_shell') return ghShellCallNeedsReview(call.args) ? 'reviewed' : 'runs';
  return 'reviewed';
}

const unavailable = new Proxy({} as ShellRS, {
  get() { throw new Error('Shell selection eval must never access a real executor'); },
});

/** Production descriptions, schemas, toolkit instructions and inspect_shell admission; execution is mocked. */
export function buildShellSelectionMockTools(outputs: Record<string, unknown> = {}) {
  const calls: ShellCall[] = [];
  const gitTools = [
    ...createGitTools(unavailable).gitTools.filter((item) => item.name === 'git_shell'),
    ...createGithubTools(unavailable).githubTools.filter((item) => item.name === 'gh_shell'),
  ];
  const definitions = [createInspectShellTool(unavailable), createRunShellTool(unavailable),
    createStartProcessTool(unavailable), ...gitTools];
  const tools = definitions.map((definition) => tool(async (args: Record<string, unknown>) => {
    const call = { name: definition.name, args };
    calls.push(call);
    if (call.name === 'inspect_shell') {
      // Same refusal text the production tool returns.
      const verdict = classifyReadOnlyShellCommand(shellCallCommand(call));
      if (!verdict.allowed) return `Error: inspect_shell 不执行该命令（${verdict.reason}）。${verdict.redirect}`;
    }
    const recorded = Object.entries(outputs).find(([command]) => callRunsCommand(call, command));
    return String(recorded?.[1] ?? 'Controlled fixture: no command was executed.');
  }, { name: definition.name, description: definition.description, schema: definition.schema }));
  const promptSections = [createShellToolkit({ shell: unavailable }), createGitToolkit({ shell: unavailable }),
    createGithubToolkit({ shell: unavailable })].map((toolkit) => ({
    id: `toolkit:${toolkit.name}`,
    owner: toolkit.name,
    content: toolkit.instructions as string,
  }));
  return { tools, calls, promptSections, readFile: (_path: string) => null };
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

/** Metric: the requested command used the cheapest tool, and read cases stayed on unreviewed tools. */
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
    reviews, refusals };
}
