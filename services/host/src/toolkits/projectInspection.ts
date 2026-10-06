import { defineToolkit, type AgentToolkit } from '@pinpawo/pet-agent';
import { createFileToolDefinitions } from './files';
import { createGitToolDefinitions } from './git';
import { createGithubToolDefinitions } from './github';
import { createShellToolDefinitions } from './shell';
import { shellAvailability, shellRequirement, type ShellToolkitDependencies } from './toolDefinitions';

export const PROJECT_INSPECTION_TOOLKIT_NAME = 'project-inspection';

const projectInspectionInstructions = [
  '你的目标是只读探索当前项目及其关联的 GitHub 事实，并交付足以支持后续规划的证据摘要。',
  '根据当前目标选择范围最小、语义最直接的文件、搜索、Git 或 GitHub 工具。',
  '读取代码、Markdown、JSON 与配置时优先使用 view_file_chunk；read_file 用于图片、PDF、Word、表格等非文本内容。',
  '先从目录、搜索或列表结果定位候选，再读取与目标直接相关的内容。搜索用 inspect_shell 运行 rg（例如 `rg -n \'pattern\'`、`rg --files -g \'*.ts\'`），JSON 用 jq。',
  '交付物包含已确认事实、关键来源、仍存在的不确定性，以及后续规划可直接使用的边界。',
];

/**
 * The read-only composition of files, shell, git and github. Each of those
 * Toolkits declares its own read-only subset beside its tools, so a new read
 * tool joins here without a second list to keep in sync.
 */
export function createProjectInspectionToolkit(deps: ShellToolkitDependencies): AgentToolkit {
  const tools = [
    createFileToolDefinitions(),
    createShellToolDefinitions(deps),
    createGitToolDefinitions(deps),
    createGithubToolDefinitions(deps),
  ].flatMap(({ inspection }) => inspection);
  const reviewed = tools.filter((definition) => definition.review);
  if (reviewed.length > 0) {
    throw new Error(`project-inspection must not include reviewed tools: ${reviewed.map((definition) => definition.tool.name).join(', ')}`);
  }
  return defineToolkit({
    name: PROJECT_INSPECTION_TOOLKIT_NAME,
    description: '只读探索本地项目、Git 历史与 GitHub PR/issue，形成可用于规划的事实证据。',
    tools,
    instructions: projectInspectionInstructions.join('\n'),
    requires: shellRequirement,
    availability: shellAvailability(deps.shell),
  });
}
