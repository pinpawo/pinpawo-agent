import { defineToolkit, ReviewPolicies, type AgentToolkit } from '@pinpawo/pet-agent';
import {
  executionScopedDefinitions,
  pickDefinitions,
  shellAvailability,
  shellRequirement,
  type ShellToolkitDependencies,
} from '../toolDefinitions';
import { createGitTools, gitOperationMetadata, gitShellCallNeedsReview } from './gitTools';

export const GIT_TOOLKIT_NAME = 'git';

const gitToolkitInstructions = [
  '你可以使用 git_status、git_diff、git_log、git_branch、git_show、git_add、git_commit、git_push 处理本地 git 仓库和普通分支推送。',
  '专用工具没有覆盖的 git 操作用 git_shell；查询和日常操作直接执行，只有会丢数据或改写共享历史的操作要审批。这类操作确是任务需要时再做，先确认影响范围，能保留数据时优先用可恢复的做法。',
  '查看状态、diff、历史和提交内容时优先使用这些 git 工具；需要管道组合的只读查询可以用 inspect_shell。不要用 run_shell 包装 git 命令。',
  'git_add 必须显式传 pathspecs；不要隐式暂存整个仓库。',
  'git_commit 只创建本地提交；需要推送时继续使用 git_push。git_push 不支持 force push 或删除远端引用，确有需要时用 git_shell，会走审批。git_add、git_commit、git_push 直接执行，不需要审批。',
];

export function createGitToolDefinitions({ shell }: ShellToolkitDependencies) {
  const { gitTools, gitInspectionTools } = createGitTools(shell);
  // Dedicated tools exclude dangerous forms by schema (no force push, no
  // implicit `git add .`), so they run unreviewed like everyday git_shell
  // writes. Only the risky forms of git_shell are reviewed.
  const base = ReviewPolicies.required({ authorization: 'exact' });
  const definitions = executionScopedDefinitions(gitTools, gitOperationMetadata, {
    git_shell: ReviewPolicies.custom({
      ...base,
      request: (ctx) => (gitShellCallNeedsReview(ctx.input) ? base.request(ctx) : null),
    }),
  });
  return { tools: definitions, inspection: pickDefinitions(definitions, gitInspectionTools) };
}

/** The local git repository through ShellRS. */
export function createGitToolkit(deps: ShellToolkitDependencies): AgentToolkit {
  return defineToolkit({
    name: GIT_TOOLKIT_NAME,
    description: '本地 git 仓库的查看、暂存、提交、推送，以及按操作审批的 git_shell。',
    tools: createGitToolDefinitions(deps).tools,
    instructions: gitToolkitInstructions.join('\n'),
    reviewGuidance: {
      allow: 'Local Git edits and ordinary pushes can be recovered; assess the actual target and effect.',
      ask: 'Discarding uncommitted work (reset --hard, clean, checkout/restore over changes, stash drop/clear), force-deleting branches or deleting tags, and shared-history rewrites (force push, remote ref deletion) require human review.',
    },
    requires: shellRequirement,
    availability: shellAvailability(deps.shell),
  });
}
