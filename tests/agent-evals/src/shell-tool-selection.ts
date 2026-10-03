import { tool } from '@langchain/core/tools';
import { createInspectShellTool, createRunShellTool, createStartProcessTool } from '../../../services/host/src/toolkits/local/shellTools';
import type { ShellRS } from '../../../services/host/src/toolkits/local/shellRS';

type ShellCall = { name: string; args: Record<string, unknown> };
type ExpectedCall = { name: string; command: string };

const cases = [
  ['git-status-inspect', 'git status --short', 'inspect_shell', '查看当前工作区状态。'],
  ['git-log-inspect', 'git log -5 --oneline', 'inspect_shell', '查看最近五条提交。'],
  ['git-diff-inspect', 'git diff --stat', 'inspect_shell', '查看未暂存改动的统计。'],
  ['git-reset-run', 'git reset --hard HEAD', 'run_shell', '已确认丢弃所有已跟踪文件的本地改动，不需要备份。'],
  ['git-clean-run', 'git clean -fd', 'run_shell', '已确认删除全部未跟踪文件和目录，不需要保留。'],
  ['git-force-push-run', 'git push --force origin HEAD', 'run_shell', '已确认覆盖远端对应分支，允许强制推送。'],
] as const;

export const shellToolSelectionExamples = cases.map(([name, command, expectedTool, intent]) => ({
  name,
  inputs: {
    shell_tool_selection: true,
    task: `${intent}请执行 ${command}，然后简要报告结果。`,
    shell_outputs: { [command]: 'Requested command completed successfully (controlled fixture output).' },
  },
  outputs: {
    expected_has_deliverable: true,
    expected_tools: [expectedTool],
    expected_shell_call: { name: expectedTool, command },
    reason: 'The real model must select the tool for the requested command; execution is mocked.',
  },
}));

/** Production tool descriptions/schemas, but no production executor or admission. */
export function buildShellSelectionMockTools(outputs: Record<string, unknown> = {}) {
  const calls: ShellCall[] = [];
  const unavailable = new Proxy({} as ShellRS, {
    get() { throw new Error('Shell selection eval must never access a real executor'); },
  });
  const definitions = [createInspectShellTool(unavailable), createRunShellTool(unavailable), createStartProcessTool(unavailable)];
  const tools = definitions.map((definition) => tool(async (args: Record<string, unknown>) => {
    calls.push({ name: definition.name, args });
    return String(outputs[String(args.command)] ?? 'Controlled fixture: no command was executed.');
  }, { name: definition.name, description: definition.description, schema: definition.schema }));
  return { tools, calls, readFile: (_path: string) => null };
}

/** Score the requested command, allowing preparatory inspection on write cases. */
export function shellToolChoiceEvaluator({ outputs, referenceOutputs }: {
  outputs?: { calls?: ShellCall[] };
  referenceOutputs?: { expected_shell_call?: ExpectedCall };
}) {
  const expected = referenceOutputs?.expected_shell_call;
  if (!expected) return { key: 'shell_tool_choice', score: 1, comment: 'Not a shell selection case' };
  const calls = outputs?.calls ?? [];
  const matching = calls.filter((call) => call.args.command === expected.command);
  const passed = matching.length > 0 && matching.every((call) => call.name === expected.name)
    && (expected.name !== 'inspect_shell' || calls.every((call) => call.name === 'inspect_shell'));
  return { key: 'shell_tool_choice', score: passed ? 1 : 0,
    comment: `Expected ${expected.command} via ${expected.name}; observed ${JSON.stringify(calls)}` };
}
