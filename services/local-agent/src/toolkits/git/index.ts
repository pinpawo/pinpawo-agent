import type { StructuredTool } from '@langchain/core/tools';
import {
  defineToolkit,
  ReviewPolicies,
  type AgentToolkit,
  type ToolOperationMetadata,
  type ToolReviewPolicy,
} from '@pinpawo/pet-agent';
import { gitOperationMetadata, gitTools } from './gitTools';
import { bindToolToExecutionWorkdir } from '../local/workdirBinding';

function createToolDefinitions(
  tools: readonly StructuredTool[],
  operations: Record<string, ToolOperationMetadata> = {},
  reviews: Record<string, ToolReviewPolicy> = {},
) {
  return tools.map((toolItem) => ({
    tool: toolItem,
    operation: operations[toolItem.name],
    review: reviews[toolItem.name],
  }));
}

const gitToolkitInstructions = [
  '你可以使用 git_status、git_diff、git_log、git_branch、git_show、git_add、git_commit、git_push 处理本地 git 仓库和普通分支推送。',
  '你可以使用 gh_pr_create、gh_pr_view、gh_pr_comments、gh_pr_diff、gh_issue_create、gh_issue_list、gh_issue_view、gh_issue_comments、gh_read_content 创建或渐进式查看 GitHub PR/issue。',
  '先用 gh_pr_view 查看 PR 概览；只有确实需要 review 或评论时才用 gh_pr_comments。',
  '先用 gh_issue_view 查看 issue 正文和评论总数；只有确实需要评论时才用 gh_issue_comments 小页翻阅；它返回文件交付时用 gh_read_content 分块读取。',
  '查看状态、diff、历史和提交内容时优先使用这些 git 工具，不要用 run_shell 包装 git 命令。',
  '做代码 review、PR review 或 diff 审查时，优先使用 gh_pr_view 和 gh_pr_diff；不要用 browser 或 http_fetch 拉取 GitHub PR 页面/diff。',
  'git_add 必须显式传 pathspecs；不要隐式暂存整个仓库。',
  'git_commit 只创建本地提交；需要推送时继续使用 git_push。git_push 不支持 force push 或删除远端引用。',
];

export function createGitToolkit(): AgentToolkit {
  const reviews = {
    git_add: ReviewPolicies.localMutation({ authorization: 'exact' }),
    git_commit: ReviewPolicies.localMutation({ authorization: 'exact' }),
    git_push: ReviewPolicies.externalAccess({ authorization: 'exact' }),
    gh_pr_create: ReviewPolicies.externalAccess({ authorization: 'exact' }),
    gh_issue_create: ReviewPolicies.externalAccess({ authorization: 'exact' }),
  };
  return defineToolkit({
    name: 'git',
    description: '本地 git 仓库查看、暂存、提交和普通推送，以及 GitHub PR/issue 创建与查看工具。',
    tools: createToolDefinitions(gitTools, gitOperationMetadata, reviews),
    instructions: gitToolkitInstructions.join('\n'),
    reviewGuidance: {
      allow: 'Treat routine, scoped version-control collaboration as eligible for automatic authorization, including staging files, creating a local commit, a normal non-force push, and creating a pull request or issue.',
      ask: 'Require human authorization for destructive worktree or history changes, force pushes, deleting branches or tags, merging a pull request, changing repository settings or access, managing secrets, deleting or closing remote resources, and publishing packages or releases.',
    },
    runtime: {
      start: () => undefined,
      bindTools: (_binding, context) => gitTools.map((toolItem) => (
        bindToolToExecutionWorkdir(toolItem, context.execution.workdir)
      )),
    },
  });
}
