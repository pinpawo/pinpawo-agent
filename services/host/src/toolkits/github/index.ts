import { defineToolkit, type AgentToolkit } from '@pinpawo/pet-agent';
import {
  executionScopedDefinitions,
  shellAvailability,
  shellRequirement,
  type ShellToolkitDependencies,
} from '../toolDefinitions';
import { createGithubTools, githubOperationMetadata } from './githubTools';

export const GITHUB_TOOLKIT_NAME = 'github';

const githubToolkitInstructions = [
  '创建 PR 用 gh_pr_create，创建 issue 用 gh_issue_create：标题和正文作为结构化参数传入，不需要在命令行里转义长正文。两者直接执行，不需要审批。',
  '其他 GitHub 操作用 gh 命令：查看 PR、diff、评论、issue、CI 检查和运行日志（gh pr view/diff/checks、gh issue view --comments、gh run view --log 等）用 inspect_shell；评论、review、编辑、关闭、合并等写操作用 run_shell，日常协作直接执行，合并、删除、发布、改 secret/权限要审批。',
  '做代码 review、PR review 或 diff 审查时，用 inspect_shell 运行 gh pr view 和 gh pr diff；不要用 browser 或 http_fetch 拉取 GitHub PR 页面或 diff。',
];

/** GitHub PR and issue creation through the gh CLI on ShellRS. */
export function createGithubToolkit(deps: ShellToolkitDependencies): AgentToolkit {
  return defineToolkit({
    name: GITHUB_TOOLKIT_NAME,
    description: '创建 GitHub PR 和 issue；其他 GitHub 操作通过 shell 运行 gh。',
    tools: executionScopedDefinitions(createGithubTools(deps.shell).githubTools, githubOperationMetadata, {}),
    instructions: githubToolkitInstructions.join('\n'),
    requires: shellRequirement,
    availability: shellAvailability(deps.shell),
  });
}
