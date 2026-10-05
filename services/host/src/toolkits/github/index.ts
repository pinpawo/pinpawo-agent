import { defineToolkit, ReviewPolicies, type AgentToolkit } from '@pinpawo/pet-agent';
import {
  executionScopedDefinitions,
  pickDefinitions,
  shellAvailability,
  shellRequirement,
  type ShellToolkitDependencies,
} from '../toolDefinitions';
import { createGithubTools, ghShellCallNeedsReview, githubOperationMetadata } from './githubTools';

export const GITHUB_TOOLKIT_NAME = 'github';

const githubToolkitInstructions = [
  '你可以使用 gh_pr_create、gh_pr_view、gh_pr_comments、gh_pr_diff、gh_issue_create、gh_issue_list、gh_issue_view、gh_issue_comments、gh_read_content 创建或渐进式查看 GitHub PR/issue。',
  '先用 gh_pr_view 查看 PR 概览；只有确实需要 review 或评论时才用 gh_pr_comments。',
  '先用 gh_issue_view 查看 issue 正文和评论总数；只有确实需要评论时才用 gh_issue_comments 小页翻阅；它返回文件交付时用 gh_read_content 分块读取。',
  '专用工具没有覆盖的 GitHub 操作（pr checks/list、run 日志、评论、review、关闭、编辑、api 等）用 gh_shell；查询和日常协作直接执行，只有合并、删除、发布、改 secret/权限的操作要审批。这类操作确是任务需要时再做，先确认影响范围。',
  '做代码 review、PR review 或 diff 审查时，优先使用 gh_pr_view 和 gh_pr_diff；不要用 browser 或 http_fetch 拉取 GitHub PR 页面/diff。不要用 run_shell 包装 gh 命令。',
  'gh_pr_create、gh_issue_create 直接执行，不需要审批。',
];

export function createGithubToolDefinitions({ shell }: ShellToolkitDependencies) {
  const { githubTools, githubInspectionTools } = createGithubTools(shell);
  // Dedicated tools run unreviewed like everyday gh_shell collaboration; only
  // the risky forms of gh_shell are reviewed.
  const base = ReviewPolicies.required({ authorization: 'exact' });
  const definitions = executionScopedDefinitions(githubTools, githubOperationMetadata, {
    gh_shell: ReviewPolicies.custom({
      ...base,
      request: (ctx) => (ghShellCallNeedsReview(ctx.input) ? base.request(ctx) : null),
    }),
  });
  return { tools: definitions, inspection: pickDefinitions(definitions, githubInspectionTools) };
}

/** GitHub through the gh CLI on ShellRS. */
export function createGithubToolkit(deps: ShellToolkitDependencies): AgentToolkit {
  return defineToolkit({
    name: GITHUB_TOOLKIT_NAME,
    description: 'GitHub PR/issue 的创建与查看，以及按操作审批的 gh_shell。',
    tools: createGithubToolDefinitions(deps).tools,
    instructions: githubToolkitInstructions.join('\n'),
    reviewGuidance: {
      allow: 'Comments, reviews, PR/issue creation and edits, and CI reruns are ordinary collaboration; assess the actual target and effect.',
      ask: 'Merging PRs, deleting repositories, releases or issues, publishing releases, secrets, credentials and access changes, and write API calls require human review.',
    },
    requires: shellRequirement,
    availability: shellAvailability(deps.shell),
  });
}
