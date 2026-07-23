import type { StructuredTool } from '@langchain/core/tools';
import {
  ARTIFACT_DISCOVERY_LIST_DIR_TOOL_NAME,
  ARTIFACT_DISCOVERY_VIEW_FILE_CHUNK_TOOL_NAME,
  defineToolkit,
  ReviewPolicies,
  type AgentToolkit,
  type ToolOperationMetadata,
  type ToolReviewPolicy,
} from '@pinpawo/pet-agent';
import { createOperationRegistryFromToolkits } from '../../events/operationRegistry';
import type { LocalAgentPlugin } from '../../pluginLoader';
import {
  applyPatchTool,
  copyPathTool,
  createArtifactDiscoveryFileTools,
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
import { downloadFileTool, httpFetchTool, networkOperationMetadata } from './networkTools';
import { gitTools, gitOperationMetadata } from './gitTools';
import { globSearchTool, grepSearchTool, searchOperationMetadata } from './searchTools';
import { getCurrentTimeTool, runShellTool, shellOperationMetadata } from './shellTools';

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
  globSearchTool,
  grepSearchTool,
  httpFetchTool,
  downloadFileTool,
];

const bashToolkitTools: StructuredTool[] = [
  ...localUtilityTools,
  getCurrentTimeTool,
  runShellTool,
];

const coreLocalTools: StructuredTool[] = [
  ...localUtilityTools,
  ...gitTools,
  getCurrentTimeTool,
  runShellTool,
];

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

export function createArtifactDiscoveryToolkit(root: string): AgentToolkit {
  return defineToolkit({
    name: 'artifact_discovery',
    description: '只读列出并分块读取当前 thread 的 capability artifacts。',
    tools: createToolDefinitions(createArtifactDiscoveryFileTools(root), {
      [ARTIFACT_DISCOVERY_LIST_DIR_TOOL_NAME]: fileOperationMetadata.list_dir,
      [ARTIFACT_DISCOVERY_VIEW_FILE_CHUNK_TOOL_NAME]: fileOperationMetadata.view_file_chunk,
    }),
  });
}

const bashToolkitInstructions = [
  '你可以使用本地文件、搜索、下载和 shell 工具完成任务。',
  '读取代码、Markdown、JSON、配置等可读文本时优先使用 view_file_chunk；read_file 只用于 PDF、Word、表格、图片等非文本文件的分析。',
  '优先使用语义具体的文件工具：view_file_chunk、read_file、list_dir、glob_search、grep_search。',
  '编辑已有文件一律使用 apply_patch（V4A 上下文补丁，支持一次修改多个文件）；只有新建文件或完全重写整个文件时才用 write_file。',
  '查询当前时间优先使用 get_current_time；不要用 run_shell 包装 date 命令。',
  'run_shell 只作为兜底工具；不要用它替代已有的读写、移动、复制、下载或 HTTP 工具。',
  '常规 git 操作由 git toolkit 提供；不要用 run_shell 包装这些常规 git 操作。',
  '执行高风险 shell 命令时必须遵守 toolkit 的人类审批流程，不要绕过审批。',
  '修改文件前先读取现状；修改后优先用 validate_structured_file、grep_search 或 run_shell 做必要验证。',
];

const bashToolkitOperations = {
  ...fileOperationMetadata,
  ...searchOperationMetadata,
  ...networkOperationMetadata,
  ...shellOperationMetadata,
};

const gitToolkitInstructions = [
  '你可以使用 git_status、git_diff、git_log、git_branch、git_show、git_add、git_commit、git_push 处理本地 git 仓库和普通分支推送。',
  '你可以使用 gh_pr_create、gh_pr_view、gh_pr_diff、gh_issue_create、gh_issue_view、gh_issue_comments、gh_read_content 创建或渐进式查看 GitHub PR/issue。',
  '先用 gh_issue_view 查看 issue 正文和评论总数；只有确实需要评论时才用 gh_issue_comments 小页翻阅；它返回文件交付时用 gh_read_content 分块读取。',
  '查看状态、diff、历史和提交内容时优先使用这些 git 工具，不要用 run_shell 包装 git 命令。',
  '做代码 review、PR review 或 diff 审查时，优先使用 gh_pr_view 和 gh_pr_diff；不要用 browser 或 http_fetch 拉取 GitHub PR 页面/diff。',
  'git_add 必须显式传 pathspecs；不要隐式暂存整个仓库。',
  'git_commit 只创建本地提交；需要推送时继续使用 git_push。git_push 不支持 force push 或删除远端引用。',
];

export function createBashToolkit(tools: StructuredTool[] = bashToolkitTools): AgentToolkit {
  const reviews = {
    write_file: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
    apply_patch: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
    move_path: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
    copy_path: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
    mkdir_path: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
    http_fetch: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
    download_file: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
    run_shell: ReviewPolicies.commandExecution({ authorization: 'exact_args' }),
  };
  return defineToolkit({
    name: 'bash',
    description: '本地文件读写、目录操作、代码搜索、补丁应用、HTTP 下载，以及受控 shell 命令执行。',
    tools: createToolDefinitions(tools, bashToolkitOperations, reviews),
    instructions: bashToolkitInstructions.join('\n'),
    reviewGuidance: {
      allow: 'A shell invocation is an execution mechanism, so its risk comes from the concrete command and scope. Treat commands confined to the current workspace as eligible for automatic authorization when their effects are clear and limited, such as build, test, typecheck, lint, format, inspection, other reversible development operations, and deletion of explicitly named non-sensitive files inside the current workspace.',
      ask: 'Ask when a command has broad or unclear effects, deletes recursively, deletes outside the current workspace, deletes user data or sensitive files, elevates privileges, changes permissions or system services, installs or executes untrusted software, exposes credentials or data, publishes or deploys artifacts, or rewrites shared version-control history.',
    },
  });
}

export function createGitToolkit(): AgentToolkit {
  const reviews = {
    git_add: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
    git_commit: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
    git_push: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
    gh_pr_create: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
    gh_issue_create: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
  };
  return defineToolkit({
    name: 'git',
    description: '本地 git 仓库查看、暂存、提交和普通推送，以及 GitHub PR/issue 创建与查看工具。',
    tools: createToolDefinitions(gitTools, gitOperationMetadata, reviews),
    instructions: gitToolkitInstructions.join('\n'),
    reviewGuidance: {
      allow: 'Treat routine, scoped version-control collaboration as eligible for automatic authorization, including staging files, creating a local commit, a normal non-force push, and creating a pull request or issue.',
      ask: 'Ask for destructive worktree or history changes, force pushes, deleting branches or tags, merging a pull request, changing repository settings or access, managing secrets, deleting or closing remote resources, and publishing packages or releases.',
    },
  });
}

export const localToolOperationRegistry = createOperationRegistryFromToolkits([
  createBashToolkit(),
  createGitToolkit(),
]);

let cachedCoreLocalTools: StructuredTool[] | null = null;

export async function loadCoreLocalTools(): Promise<StructuredTool[]> {
  if (cachedCoreLocalTools) {
    return cachedCoreLocalTools;
  }

  cachedCoreLocalTools = coreLocalTools;

  return cachedCoreLocalTools;
}

export const localPlugin: LocalAgentPlugin = {
  name: 'local-cli',
};
