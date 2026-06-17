import type { StructuredTool } from '@langchain/core/tools';
import {
  defineToolkit,
  ReviewPolicies,
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import { createOperationRegistryFromToolkits } from '../../events/operationRegistry';
import type { LocalAgentPlugin } from '../../pluginLoader';
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
import { downloadFileTool, httpFetchTool, networkOperationMetadata } from './networkTools';
import { readPdfTool, pdfOperationMetadata } from './pdfTools';
import { gitTools, gitOperationMetadata } from './gitTools';
import { globSearchTool, grepSearchTool, searchOperationMetadata } from './searchTools';
import { runShellTool, shellOperationMetadata } from './shellTools';

const localUtilityTools: StructuredTool[] = [
  readFileTool,
  readPdfTool,
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
  runShellTool,
];

const coreLocalTools: StructuredTool[] = [
  ...localUtilityTools,
  ...gitTools,
  runShellTool,
];

const bashToolkitInstructions = [
  '你可以使用本地文件、搜索、下载和 shell 工具完成任务。',
  '读取代码、Markdown、JSON、配置等可读文本时优先使用 view_file_chunk；读取 PDF 时使用 read_pdf；read_file 只用于 Word、表格、图片等其他非文本文件的分析。',
  '优先使用语义具体的文件工具：view_file_chunk、read_file、list_dir、glob_search、grep_search。',
  '编辑已有文件一律使用 apply_patch（V4A 上下文补丁，支持一次修改多个文件）；只有新建文件或完全重写整个文件时才用 write_file。',
  'run_shell 只作为兜底工具；不要用它替代已有的读写、移动、复制、下载或 HTTP 工具。',
  '常规 git 操作由 git toolkit 提供；不要用 run_shell 包装这些常规 git 操作。',
  '执行高风险 shell 命令时必须遵守 toolkit 的人类审批流程，不要绕过审批。',
  '修改文件前先读取现状；修改后优先用 validate_structured_file、grep_search 或 run_shell 做必要验证。',
];

const bashToolkitOperations = {
  ...fileOperationMetadata,
  ...pdfOperationMetadata,
  ...searchOperationMetadata,
  ...networkOperationMetadata,
  ...shellOperationMetadata,
};

const gitToolkitInstructions = [
  '你可以使用 git_status、git_diff、git_log、git_branch、git_show、git_add、git_commit 处理本地 git 仓库。',
  '查看状态、diff、历史和提交内容时优先使用这些 git 工具，不要用 run_shell 包装 git 命令。',
  'git_add 必须显式传 pathspecs；不要隐式暂存整个仓库。',
  'git_commit 只创建本地提交，不会 push。',
];

export function createBashToolkit(tools: StructuredTool[] = bashToolkitTools): AgentToolkit {
  return {
    name: 'bash',
    description: '本地文件读写、目录操作、代码搜索、补丁应用、HTTP 下载，以及受控 shell 命令执行。',
    tools,
    instructions: bashToolkitInstructions,
    operations: bashToolkitOperations,
    policy: {
      toolReview: {
        write_file: ReviewPolicies.localMutation(),
        apply_patch: ReviewPolicies.localMutation(),
        move_path: ReviewPolicies.localMutation(),
        copy_path: ReviewPolicies.localMutation(),
        mkdir_path: ReviewPolicies.localMutation(),
        http_fetch: ReviewPolicies.externalAccess(),
        download_file: ReviewPolicies.externalAccess(),
        run_shell: ReviewPolicies.commandExecution(),
      },
    },
  };
}

export function createGitToolkit(): AgentToolkit {
  return defineToolkit({
    name: 'git',
    description: '本地 git 仓库查看、暂存和本地提交工具。',
    tools: gitTools,
    instructions: gitToolkitInstructions,
    operations: gitOperationMetadata,
    policy: {
      toolReview: {
        git_add: ReviewPolicies.localMutation(),
        git_commit: ReviewPolicies.localMutation(),
      },
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
