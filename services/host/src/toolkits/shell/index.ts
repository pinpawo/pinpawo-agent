import {
  AuthorizationPolicies,
  defineToolkit,
  ReviewPolicies,
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import {
  executionScopedDefinitions,
  pickDefinitions,
  shellAvailability,
  shellRequirement,
  type ShellToolkitDependencies,
} from '../toolDefinitions';
import { createProcessTools, processOperationMetadata } from './processTools';
import {
  createInspectShellTool,
  createRunShellTool,
  createStartProcessTool,
  getCurrentTimeTool,
  normalizeShellAuthorizationInput,
  shellOperationMetadata,
} from './shellTools';

export const SHELL_TOOLKIT_NAME = 'shell';

const shellToolkitInstructions = [
  '你可以执行 shell 命令和托管长任务。',
  '短查询只查看不修改的（rg、grep、sed -n、cat、ls、find、wc、jq、git status/log/diff/show、gh pr view/diff/checks 等，可含 cd 与管道）用 inspect_shell，它免审批；不要把会修改状态的命令放进 inspect_shell。短命令需要写入、删除或内联执行时用 run_shell；安装依赖、完整构建、长测试和持续运行任务用 start_process。短查询优先 inspect_shell。',
  '搜索代码和文件用 inspect_shell 运行 rg：`rg -n \'pattern\' src` 搜内容，`rg --files -g \'*.ts\'` 找文件，`rg -l` 只列文件名；分析 JSON 用 inspect_shell 运行 jq。不要用 run_shell 或临时 Python 脚本做这些查询。',
  '查询当前时间优先使用 get_current_time；不要用 run_shell 包装 date 命令。',
  'run_shell 只作为兜底工具；不要用它替代已有的文件读写、移动、复制、下载或 HTTP 工具。',
  'run_shell / inspect_shell 超时会终止进程组，返回超时结果，不转后台。超时不回滚副作用；确认终止并检查已有结果后再决定是否用 start_process 重试。start_process 启动即返回进程 id，用 wait_process 跟进、terminate_process 终止、list_processes 找回当前会话任务；不要重复启动。',
  'git 和 GitHub（gh）的查询用 inspect_shell。工具列表里有 git_add、git_commit、git_push、gh_pr_create、gh_issue_create 时，暂存、提交、普通推送和创建 PR/issue 优先用它们，它们不需要审批；其他 git/gh 写操作（切换分支、stash、pull、rebase、评论、合并等）用 run_shell，和其他命令一样走审批。丢弃未提交改动、强推、删除分支或远端引用、合并 PR、删除、发布、改 secret/权限这类操作确是任务需要时再做，先确认影响范围。',
  '查看 PR、diff、评论、issue、CI 检查和运行日志用 inspect_shell 运行 gh（gh pr view/diff/checks、gh issue view、gh run view --log 等）；做代码 review、PR review 或 diff 审查时用 gh pr view 和 gh pr diff，不要用 browser 或 http_fetch 拉取 GitHub 页面或 diff。',
  '先看概览再按需读评论：`gh issue view N` 返回正文和评论数，`gh pr view N` 返回概览和描述，都不含评论正文；需要评论时再加 --comments，它一次返回全部评论。评论很多、只要一部分时用 `gh api \'repos/{owner}/{repo}/issues/N/comments?per_page=20&page=2\'` 翻页（PR 的评论也用 issues 接口），或用 `--json comments --jq \'.comments[-5:]\'` 取最近几条。gh api 输出是单行 JSON，用 --jq 只取需要的字段，例如 `--jq \'.[] | {author: .user.login, body}\'`。',
  'gh 不会弹交互提示：缺少必需参数时直接失败，例如 pr merge 要显式给出 --merge、--squash 或 --rebase；不要用 --web 打开浏览器。长正文用 --body-file。',
  '执行高风险 shell 命令时必须遵守 toolkit 的人类审批流程，不要绕过审批。',
  '修改后做必要验证：只读检查用 inspect_shell，跑测试或构建用 run_shell 或 start_process。',
];

export function createShellToolDefinitions({ shell }: ShellToolkitDependencies) {
  const inspectShell = createInspectShellTool(shell);
  const definitions = executionScopedDefinitions(
    [inspectShell, getCurrentTimeTool, createRunShellTool(shell), createStartProcessTool(shell), ...createProcessTools(shell)],
    { ...shellOperationMetadata, ...processOperationMetadata },
    {
      run_shell: ReviewPolicies.required({
        authorization: AuthorizationPolicies.exact({
          // Timeout does not change the command/cwd authorization scope.
          reuseAutoReview: true,
          subject: ({ input }) => normalizeShellAuthorizationInput(input),
        }),
      }),
      start_process: ReviewPolicies.required({
        authorization: AuthorizationPolicies.exact({
          reuseAutoReview: true,
          subject: ({ input }) => normalizeShellAuthorizationInput(input),
        }),
      }),
      // The process tools carry no review policy on purpose. They only address
      // processes an approved start_process already started in this same Agent
      // session, so waiting on one, listing them, or stopping one grants no
      // authority the command did not already have — the same reasoning that
      // leaves browser_close unreviewed.
    },
  );
  return { tools: definitions, inspection: pickDefinitions(definitions, [inspectShell, getCurrentTimeTool]) };
}

/** Commands and managed processes through ShellRS. */
export function createShellToolkit(deps: ShellToolkitDependencies): AgentToolkit {
  return defineToolkit({
    name: SHELL_TOOLKIT_NAME,
    description: '执行 shell 命令与托管长任务：免审批的检查命令、需审批的 run_shell / start_process、进程管理和当前时间。',
    tools: createShellToolDefinitions(deps).tools,
    instructions: shellToolkitInstructions.join('\n'),
    reviewGuidance: {
      allow: 'Local Git edits and ordinary pushes can be recovered. Comments, reviews, labels, PR/issue creation and edits, and CI reruns are ordinary GitHub collaboration, including through gh api write requests. Judge each command by its actual target and effect.',
      ask: 'Discarding uncommitted work (reset --hard, clean, checkout/restore over changes, stash drop/clear), force-deleting branches or deleting tags, shared-history rewrites (force push, remote ref deletion), merging PRs, deleting repositories, branches, releases or issues, publishing releases, and changing secrets, credentials, access or repository settings require human review.',
    },
    requires: shellRequirement,
    availability: shellAvailability(deps.shell),
  });
}
