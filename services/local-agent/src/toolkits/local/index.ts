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
import { downloadFileTool, httpFetchTool, networkOperationMetadata } from './networkTools';
import { jqQueryTool, jsonOperationMetadata } from './jsonTools';
import { gitTools, gitOperationMetadata } from './gitTools';
import { parsePatch, PatchParseError } from './applyPatch';
import { globSearchTool, grepSearchTool, searchOperationMetadata } from './searchTools';
import { ShellRuntime, type ShellRuntimeBinding } from './shellRuntime';
import {
  createProcessTools,
  processOperationMetadata,
  processTools,
} from './processTools';
import {
  createRunShellTool,
  getCurrentTimeTool,
  normalizeShellAuthorizationInput,
  runShellTool,
  shellOperationMetadata,
} from './shellTools';

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
  jqQueryTool,
  globSearchTool,
  grepSearchTool,
  httpFetchTool,
  downloadFileTool,
];

const bashToolkitTools: StructuredTool[] = [
  ...localUtilityTools,
  getCurrentTimeTool,
  runShellTool,
  ...processTools,
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
  '读取代码、Markdown、JSON、配置等可读文本时优先使用 view_file_chunk；read_file 只用于 PDF、Word、表格、图片等非文本文件的分析。',
  '优先使用语义具体的文件工具：view_file_chunk、read_file、jq_query、list_dir、glob_search、grep_search。',
  '分析 JSON 文件的结构、字段、分组或计数时优先使用 jq_query；不要用 run_shell 或临时 Python 脚本包装 jq。',
  '编辑已有文件一律使用 apply_patch（每次调用只更新一个已存在文件）；只有新建文件或完全重写整个文件时才用 write_file。',
  '查询当前时间优先使用 get_current_time；不要用 run_shell 包装 date 命令。',
  'run_shell 只作为兜底工具；不要用它替代已有的读写、移动、复制、下载或 HTTP 工具。',
  '命令超时不代表失败，它会转入后台并返回进程 id：用 wait_process 跟进进度，terminate_process 终止不再需要的命令，list_processes 查看本次执行启动的后台命令。不要因为超时就重复执行同一命令。',
  '常规 git 操作由 git toolkit 提供；不要用 run_shell 包装这些常规 git 操作。',
  '执行高风险 shell 命令时必须遵守 toolkit 的人类审批流程，不要绕过审批。',
  '修改文件前先读取现状；修改后优先用 validate_structured_file、grep_search 或 run_shell 做必要验证。',
];

const bashToolkitOperations = {
  ...fileOperationMetadata,
  ...searchOperationMetadata,
  ...networkOperationMetadata,
  ...jsonOperationMetadata,
  ...shellOperationMetadata,
  ...processOperationMetadata,
};

const gitToolkitInstructions = [
  '你可以使用 git_status、git_diff、git_log、git_branch、git_show、git_add、git_commit、git_push 处理本地 git 仓库和普通分支推送。',
  '你可以使用 gh_pr_create、gh_pr_view、gh_pr_comments、gh_pr_diff、gh_issue_create、gh_issue_view、gh_issue_comments、gh_read_content 创建或渐进式查看 GitHub PR/issue。',
  '先用 gh_pr_view 查看 PR 概览；只有确实需要 review 或评论时才用 gh_pr_comments。',
  '先用 gh_issue_view 查看 issue 正文和评论总数；只有确实需要评论时才用 gh_issue_comments 小页翻阅；它返回文件交付时用 gh_read_content 分块读取。',
  '查看状态、diff、历史和提交内容时优先使用这些 git 工具，不要用 run_shell 包装 git 命令。',
  '做代码 review、PR review 或 diff 审查时，优先使用 gh_pr_view 和 gh_pr_diff；不要用 browser 或 http_fetch 拉取 GitHub PR 页面/diff。',
  'git_add 必须显式传 pathspecs；不要隐式暂存整个仓库。',
  'git_commit 只创建本地提交；需要推送时继续使用 git_push。git_push 不支持 force push 或删除远端引用。',
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

export function createBashToolkit(tools: StructuredTool[] = bashToolkitTools): AgentToolkit {
  const reviews = {
    write_file: ReviewPolicies.localMutation({ authorization: 'exact' }),
    apply_patch: ReviewPolicies.localMutation({
      authorization: {
        authorize: authorizeApplyPatch,
      },
    }),
    move_path: ReviewPolicies.localMutation({ authorization: 'exact' }),
    copy_path: ReviewPolicies.localMutation({ authorization: 'exact' }),
    mkdir_path: ReviewPolicies.localMutation({ authorization: 'exact' }),
    http_fetch: ReviewPolicies.externalAccess({ authorization: 'exact' }),
    download_file: ReviewPolicies.externalAccess({ authorization: 'exact' }),
    run_shell: ReviewPolicies.commandExecution({
      authorization: AuthorizationPolicies.exact({
        subject: ({ input }) => normalizeShellAuthorizationInput(input),
      }),
    }),
    // The process tools carry no review policy on purpose. They only address
    // processes this same execution already started through an approved
    // run_shell, so waiting on one, listing them, or stopping one grants no
    // authority the command did not already have — the same reasoning that
    // leaves browser_close unreviewed.
  };
  return defineToolkit({
    name: 'bash',
    description: '本地文件读写、目录操作、代码搜索、补丁应用、HTTP 下载，以及受控 shell 命令执行。',
    tools: createToolDefinitions(tools, bashToolkitOperations, reviews),
    instructions: bashToolkitInstructions.join('\n'),
    reviewGuidance: {
      allow: 'A shell invocation is an execution mechanism, so its risk comes from the concrete command and scope. Treat commands as eligible for automatic authorization when their effects are clear and limited, including read-only inspection of explicitly named non-sensitive paths outside the current workspace, and scoped build, test, typecheck, lint, format, inspection, other reversible development operations, or deletion of explicitly named non-sensitive files or clearly bounded generated artifacts inside the current workspace.',
      ask: 'Require human authorization when a command has broad or unclear effects, deletes recursively with broad or unclear target scope, deletes outside the current workspace, deletes user data or sensitive files, elevates privileges, changes permissions or system services, installs or executes untrusted software, exposes credentials or data, publishes or deploys artifacts, or rewrites shared version-control history.',
    },
    runtime: {
      start: () => {
        const root = new ShellRuntime();
        root.start();
        return root;
      },
      resolve: (root, context) => (root as ShellRuntime).resolve(context.execution),
      bindTools: (binding) => {
        const shell = binding as ShellRuntimeBinding;
        // The framework matches bound tools to the static inventory by
        // position, so this must return the whole list in order. Only the
        // process-aware tools get a bound implementation; the rest are handed
        // back as they are.
        const bound = new Map<string, StructuredTool>(
          [createRunShellTool(shell), ...createProcessTools(shell)]
            .map((item) => [item.name, item]),
        );
        return tools.map((staticTool) => bound.get(staticTool.name) ?? staticTool);
      },
      stop: async (root) => { await (root as ShellRuntime).stop(); },
    },
  });
}

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
  });
}
