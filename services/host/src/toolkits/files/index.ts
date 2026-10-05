import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  defineToolkit,
  ReviewPolicies,
  type AgentToolkit,
  type ToolAutoAuthorizationContext,
} from '@pinpawo/pet-agent';
import { executionScopedDefinitions, pickDefinitions } from '../toolDefinitions';
import { parsePatch, PatchParseError } from './applyPatch';
import {
  applyPatchTool,
  copyPathTool,
  fileOperationMetadata,
  listDirTool,
  mkdirPathTool,
  movePathTool,
  readFileTool,
  statPathTool,
  validateStructuredFileTool,
  viewFileChunkTool,
  writeFileTool,
} from './fileTools';

export const FILES_TOOLKIT_NAME = 'files';

const fileTools = [
  readFileTool,
  viewFileChunkTool,
  statPathTool,
  listDirTool,
  validateStructuredFileTool,
  writeFileTool,
  applyPatchTool,
  movePathTool,
  copyPathTool,
  mkdirPathTool,
];

/** The read-only subset, composed into project-inspection. */
const fileInspectionTools = [readFileTool, viewFileChunkTool, statPathTool, listDirTool, validateStructuredFileTool];

const filesToolkitInstructions = [
  '你可以读取、编辑、移动和复制工作区文件。',
  '读取代码、Markdown、JSON、配置等可读文本时优先使用 view_file_chunk；read_file 只用于 PDF、Word、表格、图片等非文本文件的分析。',
  '优先使用语义具体的文件工具：view_file_chunk、read_file、list_dir、stat_path。',
  '编辑已有文件一律使用 apply_patch（每次调用只更新一个已存在文件）；只有新建文件或完全重写整个文件时才用 write_file。',
  '修改文件前先读取现状；修改结构化文件后用 validate_structured_file 验证。',
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

export function createFileToolDefinitions() {
  const definitions = executionScopedDefinitions(fileTools, fileOperationMetadata, {
    write_file: ReviewPolicies.required({ authorization: 'exact' }),
    apply_patch: ReviewPolicies.required({ canAutoApprove: authorizeApplyPatch }),
    move_path: ReviewPolicies.required({ authorization: 'exact' }),
    copy_path: ReviewPolicies.required({ authorization: 'exact' }),
    mkdir_path: ReviewPolicies.required({ authorization: 'exact' }),
  });
  return { tools: definitions, inspection: pickDefinitions(definitions, fileInspectionTools) };
}

/** Workspace files. Runs in the Host process, so it needs no RS and is always available. */
export function createFilesToolkit(): AgentToolkit {
  return defineToolkit({
    name: FILES_TOOLKIT_NAME,
    description: '工作区文件的读取、编辑、移动、复制和结构化校验。',
    tools: createFileToolDefinitions().tools,
    instructions: filesToolkitInstructions.join('\n'),
  });
}
