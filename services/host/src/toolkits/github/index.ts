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
  '其他 GitHub 操作用 gh 命令：查看 PR、diff、评论、issue、CI 检查和运行日志（gh pr view/diff/checks、gh issue view --comments、gh run view --log 等）用 inspect_shell；评论、review、编辑、关闭、合并等写操作用 run_shell，会走审批；合并、删除、发布、改 secret/权限确是任务需要时再做。',
  '做代码 review、PR review 或 diff 审查时，用 inspect_shell 运行 gh pr view 和 gh pr diff；不要用 browser 或 http_fetch 拉取 GitHub PR 页面或 diff。',
  '先看概览再按需读评论：`gh issue view N` 返回正文和评论数，`gh pr view N` 返回概览和描述，都不含评论正文；需要评论时再加 --comments，它一次返回全部评论。评论很多、只要一部分时用 `gh api \'repos/{owner}/{repo}/issues/N/comments?per_page=20&page=2\'` 翻页（PR 的评论也用 issues 接口），或用 `--json comments --jq \'.comments[-5:]\'` 取最近几条。gh api 输出是单行 JSON，用 --jq 只取需要的字段，例如 `--jq \'.[] | {author: .user.login, body}\'`。',
  '输出超过上限时只保留开头和结尾，截断标记里给出完整输出文件的路径；需要中间内容时用 view_file_chunk 或 inspect_shell 的 rg 读该文件，不要重跑命令。',
  'inspect_shell、run_shell 属于 shell toolkit。当前可用工具里没有它们时，就只能创建 PR 和 issue；需要查看或其他 GitHub 操作时直接说明缺少 shell toolkit，不要改用 browser、http_fetch 等其他工具绕过。',
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
