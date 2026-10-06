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
  '短查询只查看不修改的（rg、grep、sed -n、cat、ls、find、wc、jq、git log/status/diff 等，可含 cd 与管道）用 inspect_shell，它免审批；不要把会修改状态的命令放进 inspect_shell。短命令需要写入、删除或内联执行时用 run_shell；安装依赖、完整构建、长测试和持续运行任务用 start_process。短查询优先 inspect_shell。',
  '搜索代码和文件用 inspect_shell 运行 rg：`rg -n \'pattern\' src` 搜内容，`rg --files -g \'*.ts\'` 找文件，`rg -l` 只列文件名；分析 JSON 用 inspect_shell 运行 jq。不要用 run_shell 或临时 Python 脚本做这些查询。',
  '查询当前时间优先使用 get_current_time；不要用 run_shell 包装 date 命令。',
  'run_shell 只作为兜底工具；不要用它替代已有的文件读写、移动、复制、下载或 HTTP 工具。',
  'run_shell / inspect_shell 超时会终止进程组，返回超时结果，不转后台。超时不回滚副作用；确认终止并检查已有结果后再决定是否用 start_process 重试。start_process 启动即返回进程 id，用 wait_process 跟进、terminate_process 终止、list_processes 找回当前会话任务；不要重复启动。',
  'git 和 GitHub 操作由 git、github toolkit 提供（git_*、git_shell、gh_*、gh_shell），写操作在那里按操作审批；不要用 run_shell 或 inspect_shell 执行 git/gh 写操作，只有当前没有对应 toolkit 时才用 run_shell。',
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
    requires: shellRequirement,
    availability: shellAvailability(deps.shell),
  });
}
