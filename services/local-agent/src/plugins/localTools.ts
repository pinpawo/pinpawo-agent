import type { StructuredTool } from '@langchain/core/tools';
import {
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import { createOperationRegistryFromToolkits } from '../events/operationRegistry';
import type { LocalAgentPlugin } from '../pluginLoader';
import {
  applyFilePatchTool,
  applyUnifiedPatchTool,
  copyPathTool,
  listDirTool,
  mkdirPathTool,
  movePathTool,
  multiEditTool,
  readFileTool,
  statPathTool,
  updateFileTool,
  validateStructuredFileTool,
  viewFileChunkTool,
  writeFileTool,
  fileToolOperations,
} from './localTools/fileTools';
import { downloadFileTool, httpFetchTool, networkToolOperations } from './localTools/networkTools';
import { gitCommitReviewPolicy, gitTools, gitToolOperations } from './localTools/gitTools';
import { globSearchTool, grepSearchTool, searchToolOperations } from './localTools/searchTools';
import { runShellTool, shellReviewPolicy, shellToolOperations } from './localTools/shellTools';

const coreLocalPluginTools: StructuredTool[] = [
  readFileTool,
  viewFileChunkTool,
  statPathTool,
  writeFileTool,
  updateFileTool,
  multiEditTool,
  applyFilePatchTool,
  applyUnifiedPatchTool,
  validateStructuredFileTool,
  movePathTool,
  copyPathTool,
  mkdirPathTool,
  listDirTool,
  globSearchTool,
  grepSearchTool,
  httpFetchTool,
  downloadFileTool,
  ...gitTools,
  runShellTool,
];

const bashToolkitInstructions = [
  '你可以使用本地文件、搜索、下载和 shell 工具完成任务。',
  '优先使用语义具体的文件工具：read_file、view_file_chunk、list_dir、glob_search、grep_search、update_file、apply_file_patch。',
  'run_shell 只作为兜底工具；不要用它替代已有的读写、移动、复制、下载或 HTTP 工具。',
  'git_status、git_diff、git_log、git_branch、git_show、git_add、git_commit 是首选 git 工具；不要用 run_shell 包装这些常规 git 操作。',
  'git_commit 只创建本地提交，不会 push；远端写操作仍需单独通过审批流程处理。',
  '执行高风险 shell 命令时必须遵守 toolkit 的人类审批流程，不要绕过审批。',
  '修改文件前先读取现状；修改后优先用 validate_structured_file、grep_search 或 run_shell 做必要验证。',
];

const bashToolkitOperations = {
  ...fileToolOperations,
  ...searchToolOperations,
  ...networkToolOperations,
  ...gitToolOperations,
  ...shellToolOperations,
};

const gitToolkitInstructions = [
  '你可以使用 git_status、git_diff、git_log、git_branch、git_show、git_add、git_commit 处理本地 git 仓库。',
  '查看状态、diff、历史和提交内容时优先使用这些 git 工具，不要用 run_shell 包装 git 命令。',
  'git_add 必须显式传 pathspecs；不要隐式暂存整个仓库。',
  'git_commit 只创建本地提交，不会 push。',
];

export function createBashToolkit(tools: StructuredTool[] = coreLocalPluginTools): AgentToolkit {
  return {
    name: 'bash',
    description: '本地文件读写、目录操作、代码搜索、补丁应用、HTTP 下载，以及受控 shell 命令执行。',
    tools,
    instructions: bashToolkitInstructions,
    operations: bashToolkitOperations,
    policy: {
      toolReview: {
        git_commit: gitCommitReviewPolicy,
        run_shell: shellReviewPolicy,
      },
    },
  };
}

export function createGitToolkit(): AgentToolkit {
  return {
    name: 'git',
    description: '本地 git 仓库查看、暂存和本地提交工具。',
    tools: gitTools,
    instructions: gitToolkitInstructions,
    operations: gitToolOperations,
    policy: {
      toolReview: {
        git_commit: gitCommitReviewPolicy,
      },
    },
  };
}

export const localToolOperationRegistry = createOperationRegistryFromToolkits([
  createBashToolkit(),
  createGitToolkit(),
]);

let cachedLocalPluginTools: StructuredTool[] | null = null;

export async function loadLocalPluginTools(): Promise<StructuredTool[]> {
  if (cachedLocalPluginTools) {
    return cachedLocalPluginTools;
  }

  cachedLocalPluginTools = coreLocalPluginTools;

  return cachedLocalPluginTools;
}

export const localPlugin: LocalAgentPlugin = {
  name: 'local-cli',
};
