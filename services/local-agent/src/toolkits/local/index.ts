import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { StructuredTool } from '@langchain/core/tools';
import {
  ARTIFACT_DISCOVERY_LIST_TOOL_NAME,
  ARTIFACT_DISCOVERY_READ_TOOL_NAME,
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  AuthorizationPolicies,
  defineToolkit,
  ReviewPolicies,
  type AgentToolkit,
  type CapabilityArtifactStore,
  type NamedStructuredTool,
  type ToolOperationMetadata,
  type ToolAutoAuthorizationContext,
  type ToolReviewPolicy,
} from '@pinpawo/pet-agent';
import {
  applyPatchTool,
  copyPathTool,
  listDirTool,
  mkdirPathTool,
  movePathTool,
  readFileTool,
  statPathTool,
  validateStructuredFileTool,
  viewFileChunkTool,
  writeFileTool,
  fileOperationMetadata,
} from './fileTools';
import { createArtifactDiscoveryTools } from './artifactDiscoveryTools';
import {
  downloadFileTool,
  httpFetchTool,
  networkOperationMetadata,
  normalizeHttpFetchAuthorizationInput,
} from './networkTools';
import { createGitTools, gitOperationMetadata } from './gitTools';
import { parsePatch, PatchParseError } from './applyPatch';
import {
  createProcessTools,
  processOperationMetadata,
} from './processTools';
import {
  createRunShellTool,
  createStartProcessTool,
  getCurrentTimeTool,
  normalizeShellAuthorizationInput,
  createInspectShellTool,
  shellOperationMetadata,
} from './shellTools';
import { withExecutionWorkdir } from './executionContext';
import { SHELL_RS_REQUIREMENT, type ShellRS } from './shellRS';

export {
  SHELL_RS_CONTRACT,
  SHELL_RS_REQUIREMENT,
  SHELL_RS_VERSION,
  ShellRSError,
  type ShellCommand,
  type ShellExecRequest,
  type ShellExecResult,
  type ShellProcessOutput,
  type ShellProcessSnapshot,
  type ShellRS,
} from './shellRS';
export {
  PosixShellRS,
  type PosixShellRSOptions,
  type ShellManagedProcess,
} from './posixShellRS';
export { ShellRSClient, type ShellRSClientOptions } from './shellRSClient';

const localUtilityTools: StructuredTool[] = [
  readFileTool,
  viewFileChunkTool,
  statPathTool,
  writeFileTool,
  applyPatchTool,
  validateStructuredFileTool,
  movePathTool,
  copyPathTool,
  mkdirPathTool,
  listDirTool,
  httpFetchTool,
  downloadFileTool,
];

function createBashToolkitTools(shell: ShellRS): StructuredTool[] {
  return [
    createInspectShellTool(shell),
    ...localUtilityTools,
    getCurrentTimeTool,
    createRunShellTool(shell),
    createStartProcessTool(shell),
    ...createProcessTools(shell),
  ];
}

function createProjectInspectionTools(shell: ShellRS): readonly NamedStructuredTool[] {
  return [
    readFileTool,
    viewFileChunkTool,
    statPathTool,
    listDirTool,
    // Searching and JSON queries go through the RS like any other command.
    createInspectShellTool(shell),
    getCurrentTimeTool,
    ...createGitTools(shell).gitInspectionTools,
  ];
}

/** Shell-dependent Toolkits depend on exactly one ShellRS, under this key. */
const shellRequirement = Object.freeze({ shell: SHELL_RS_REQUIREMENT });

function executionScoped(tools: readonly StructuredTool[]) {
  return tools.map((toolItem) => withExecutionWorkdir(toolItem as NamedStructuredTool));
}

function shellAvailability(shell: ShellRS) {
  return async () => await shell.status();
}

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

export function createArtifactDiscoveryToolkit(params: {
  store: CapabilityArtifactStore;
  threadId: string;
}): AgentToolkit {
  return defineToolkit({
    name: ARTIFACT_DISCOVERY_TOOLKIT_NAME,
    description: '只读列出并读取当前 thread 的 capability artifacts。',
    tools: createToolDefinitions(createArtifactDiscoveryTools(params), {
      [ARTIFACT_DISCOVERY_LIST_TOOL_NAME]: {
        title: '列出历史产物',
      },
      [ARTIFACT_DISCOVERY_READ_TOOL_NAME]: {
        title: '读取历史产物',
      },
    }),
  });
}

const bashToolkitInstructions = [
  '你可以使用本地文件、搜索、下载和 shell 工具完成任务。',
  '短查询只查看不修改的（grep、sed -n、cat、ls、find、wc、git log/status/diff 等，可含 cd 与管道）用 inspect_shell，它免审批；短命令需要写入、删除、推送或内联执行时用 run_shell；安装依赖、完整构建、长测试和持续运行任务用 start_process。短查询优先 inspect_shell。',
  '读取代码、Markdown、JSON、配置等可读文本时优先使用 view_file_chunk；read_file 只用于 PDF、Word、表格、图片等非文本文件的分析。',
  '优先使用语义具体的文件工具：view_file_chunk、read_file、list_dir。',
  '搜索代码和文件用 inspect_shell 运行 rg：`rg -n \'pattern\' src` 搜内容，`rg --files -g \'*.ts\'` 找文件，`rg -l` 只列文件名；分析 JSON 用 inspect_shell 运行 jq。不要用 run_shell 或临时 Python 脚本做这些查询。',
  '编辑已有文件一律使用 apply_patch（每次调用只更新一个已存在文件）；只有新建文件或完全重写整个文件时才用 write_file。',
  '查询当前时间优先使用 get_current_time；不要用 run_shell 包装 date 命令。',
  '联网取内容优先用 http_fetch：静态页面、REST API、RSS、天气或汇率这类公开接口一次请求即可拿到结果，不要为此逐步驱动浏览器。只有确实需要登录态、页面交互或 JS 动态渲染时才用浏览器。同一站点首次获批后，后续同源同方法的请求不再重复审批。',
  'run_shell 只作为兜底工具；不要用它替代已有的读写、移动、复制、下载或 HTTP 工具。',
  'run_shell / inspect_shell 超时会终止进程组，返回超时结果，不转后台。超时不回滚副作用；确认终止并检查已有结果后再决定是否用 start_process 重试。start_process 启动即返回进程 id，用 wait_process 跟进、terminate_process 终止、list_processes 找回当前会话任务；不要重复启动。',
  '常规 git 操作由 git toolkit 提供；不要用 run_shell 包装这些常规 git 操作。',
  '执行高风险 shell 命令时必须遵守 toolkit 的人类审批流程，不要绕过审批。',
  '修改文件前先读取现状；修改后优先用 validate_structured_file、inspect_shell 或 run_shell 做必要验证。',
];

const bashToolkitOperations = {
  ...fileOperationMetadata,
  ...networkOperationMetadata,
  ...shellOperationMetadata,
  ...processOperationMetadata,
};

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

const projectInspectionInstructions = [
  '你的目标是只读探索当前项目及其关联的 GitHub 事实，并交付足以支持后续规划的证据摘要。',
  '根据当前目标选择范围最小、语义最直接的文件、搜索、Git 或 GitHub 工具。',
  '读取代码、Markdown、JSON 与配置时优先使用 view_file_chunk；read_file 用于图片、PDF、Word、表格等非文本内容。',
  '先从目录、搜索或列表结果定位候选，再读取与目标直接相关的内容。搜索用 inspect_shell 运行 rg（例如 `rg -n \'pattern\'`、`rg --files -g \'*.ts\'`），JSON 用 jq。',
  '交付物包含已确认事实、关键来源、仍存在的不确定性，以及后续规划可直接使用的边界。',
];

function isWithinPath(root: string, target: string) {
  const relativePath = relative(root, target);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath));
}

function authorizeApplyPatch(ctx: ToolAutoAuthorizationContext) {
  if (!ctx.workdir) return false;
  const input = ctx.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const patch = 'patch' in input ? input.patch : undefined;
  if (typeof patch !== 'string') return false;

  let target: string;
  try {
    const requestedPath = parsePatch(patch).path;
    target = isAbsolute(requestedPath)
      ? requestedPath
      : resolve(ctx.workdir, requestedPath);
  } catch (error) {
    // The executor uses the same parser before performing any filesystem
    // mutation. Invalid V4A is therefore safe to run: execution will disclose
    // the parse failure to the model without changing a file.
    if (error instanceof PatchParseError) return true;
    return false;
  }

  try {
    const realWorkdir = realpathSync(ctx.workdir);
    const realTarget = realpathSync(target);
    return statSync(realTarget).isFile() && isWithinPath(realWorkdir, realTarget);
  } catch {
    return false;
  }
}

export type ShellToolkitDependencies = Readonly<{
  /** The ShellRS instance the Host selected for this Toolkit. */
  shell: ShellRS;
}>;

export function createBashToolkit(deps: ShellToolkitDependencies): AgentToolkit {
  const { shell } = deps;
  const reviews = {
    write_file: ReviewPolicies.localMutation({ authorization: 'exact' }),
    apply_patch: ReviewPolicies.localMutation({
      canAutoApprove: authorizeApplyPatch,
    }),
    move_path: ReviewPolicies.localMutation({ authorization: 'exact' }),
    copy_path: ReviewPolicies.localMutation({ authorization: 'exact' }),
    mkdir_path: ReviewPolicies.localMutation({ authorization: 'exact' }),
    http_fetch: ReviewPolicies.externalAccess({
      authorization: AuthorizationPolicies.exact({
        // Same origin and method stay within the approved scope.
        reuseAutoReview: true,
        subject: ({ input }) => normalizeHttpFetchAuthorizationInput(input),
      }),
    }),
    download_file: ReviewPolicies.externalAccess({ authorization: 'exact' }),
    run_shell: ReviewPolicies.commandExecution({
      authorization: AuthorizationPolicies.exact({
        // Timeout does not change the command/cwd authorization scope.
        reuseAutoReview: true,
        subject: ({ input }) => normalizeShellAuthorizationInput(input),
      }),
    }),
    start_process: ReviewPolicies.commandExecution({
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
  };
  return defineToolkit({
    name: 'bash',
    description: '本地文件读写、目录操作、代码搜索、补丁应用、HTTP 下载，以及受控 shell 命令执行。',
    tools: createToolDefinitions(
      executionScoped(createBashToolkitTools(shell)),
      bashToolkitOperations,
      reviews,
    ),
    instructions: bashToolkitInstructions.join('\n'),
    requires: shellRequirement,
    availability: shellAvailability(shell),
  });
}

export function createProjectInspectionToolkit(deps: ShellToolkitDependencies): AgentToolkit {
  const operations = {
    ...fileOperationMetadata,
    ...networkOperationMetadata,
    ...shellOperationMetadata,
    ...gitOperationMetadata,
  };
  return defineToolkit({
    name: 'project-inspection',
    description: '只读探索本地项目、Git 历史与 GitHub PR/issue，形成可用于规划的事实证据。',
    tools: createToolDefinitions(
      executionScoped(createProjectInspectionTools(deps.shell)),
      operations,
    ),
    instructions: projectInspectionInstructions.join('\n'),
    requires: shellRequirement,
    availability: shellAvailability(deps.shell),
  });
}

export function createGitToolkit(deps: ShellToolkitDependencies): AgentToolkit {
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
    tools: createToolDefinitions(
      executionScoped(createGitTools(deps.shell).gitTools),
      gitOperationMetadata,
      reviews,
    ),
    instructions: gitToolkitInstructions.join('\n'),
    reviewGuidance: {
      allow: 'Local Git edits and ordinary remote collaboration can be recoverable; assess the actual target and effect.',
      ask: 'Shared-history rewrites, access changes, and releases require human review.',
    },
    requires: shellRequirement,
    availability: shellAvailability(deps.shell),
  });
}
