import { closeSync, cpSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tool } from '@langchain/core/tools';
import type { ToolkitOperationMetadata } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { tryStat } from './fileSystemUtils';
import {
  applyChunksToContent,
  parsePatch,
  type PatchOperation,
} from './applyPatch';
import {
  okOutputPathSummary,
  pathInputSummary,
  readBoolean,
  readJsonRecord,
  readNumber,
  readRecord,
  readString,
  sourceDestinationInputSummary,
} from '../operationMetadata';
import { resolveUserPath } from './pathUtils';

const capabilityManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  color: z.string().min(1),
  defaultEnabled: z.boolean(),
  builtIn: z.boolean(),
  comingSoon: z.boolean().optional(),
});

function formatStat(path: string) {
  const stat = statSync(path);
  return JSON.stringify({
    path,
    type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    ctime: stat.ctime.toISOString(),
  });
}

const MAX_FILE_DIFF_PREVIEW_CHARS = 6_000;
const TEXT_FILE_SAMPLE_BYTES = 8_192;

function truncateForOperationDetails(content: string) {
  if (content.length <= MAX_FILE_DIFF_PREVIEW_CHARS) {
    return content;
  }
  return `${content.slice(0, MAX_FILE_DIFF_PREVIEW_CHARS)}\n[truncated ${(content.length - MAX_FILE_DIFF_PREVIEW_CHARS).toString()} chars]`;
}


function readFileContentPreview(filePath: string) {
  try {
    return truncateForOperationDetails(readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function readFileSample(filePath: string) {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(TEXT_FILE_SAMPLE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, TEXT_FILE_SAMPLE_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function countOccurrences(value: string, pattern: RegExp) {
  return value.match(pattern)?.length ?? 0;
}

function looksLikeUtf8Text(buffer: Buffer) {
  if (buffer.length === 0) return true;
  if (buffer.includes(0)) return false;

  const decoded = buffer.toString('utf-8');
  const replacementChars = countOccurrences(decoded, /\uFFFD/g);
  if (replacementChars > Math.max(1, decoded.length * 0.01)) {
    return false;
  }

  const controlChars = countOccurrences(decoded, /[\x00-\x08\x0B\x0C\x0E-\x1F]/g);
  return controlChars <= Math.max(2, decoded.length * 0.02);
}

function readUtf8TextFile(filePath: string) {
  if (!looksLikeUtf8Text(readFileSample(filePath))) {
    throw new Error('not a UTF-8 text file; use read_file for document analysis');
  }
  return readFileSync(filePath, 'utf-8');
}

export function readTextFileChunkResult({
  path,
  startLine,
  endLine,
  maxChars,
}: {
  path: string;
  startLine?: number;
  endLine?: number;
  maxChars?: number;
}) {
  const filePath = resolveUserPath(path);
  const content = readUtf8TextFile(filePath);
  const lines = content.split('\n');
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, endLine ?? Math.min(start + 199, lines.length));
  if (end < start) {
    throw new Error(`invalid line range ${start}-${end}`);
  }

  const selectedLines: string[] = [];
  let selectedChars = 0;
  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    const formattedLine = `${lineNumber}: ${lines[lineNumber - 1] ?? ''}`;
    const nextChars = selectedChars + (selectedLines.length > 0 ? 1 : 0) + formattedLine.length;
    if (maxChars !== undefined && nextChars > maxChars) {
      if (selectedLines.length === 0) {
        throw new Error(`line ${lineNumber} exceeds the ${maxChars}-character chunk budget`);
      }
      break;
    }
    selectedLines.push(formattedLine);
    selectedChars = nextChars;
  }

  const chunkContent = selectedLines.join('\n');
  const returnedEndLine = start + selectedLines.length - 1;
  const hasMore = returnedEndLine < lines.length;
  return {
    content: chunkContent,
    startLine: start,
    endLine: returnedEndLine,
    nextStartLine: hasMore ? returnedEndLine + 1 : null,
    totalLines: lines.length,
    hasMore,
    returnedChars: chunkContent.length,
  };
}

export function readTextFileChunk(input: {
  path: string;
  startLine?: number;
  endLine?: number;
}) {
  return readTextFileChunkResult(input).content;
}

function mergeOperationOutputSummary(
  target: string | undefined,
  details?: Record<string, unknown>,
) {
  if (!target) return null;
  const after = readFileContentPreview(target);
  return {
    target,
    ...(details ? { details: { ...details, after } } : {}),
  } satisfies ReturnType<typeof okOutputPathSummary> | null;
}

function resolveMoveTarget(sourcePath: string, destinationPath: string) {
  const source = resolveUserPath(sourcePath);
  const destination = resolveUserPath(destinationPath);
  const destinationStat = tryStat(destination);
  return destinationStat?.isDirectory()
    ? resolve(destination, basename(source))
    : destination;
}

function resolveCopyTarget(sourcePath: string, destinationPath: string) {
  return resolveMoveTarget(sourcePath, destinationPath);
}

export const readFileTool = tool(
  async ({ path }: { path: string }) => {
    try {
      const filePath = resolveUserPath(path);
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return `Error: read_file expects a file path, got ${stat.isDirectory() ? 'directory' : 'non-file'}: ${filePath}`;
      }

      const extension = extname(filePath).toLowerCase();
      if (looksLikeUtf8Text(readFileSample(filePath))) {
        return `Error: ${filePath} is a readable UTF-8 text file; use view_file_chunk for line-numbered text reading.`;
      }

      return JSON.stringify({
        ok: false,
        path: filePath,
        type: 'document_or_binary',
        extension: extension || null,
        size: stat.size,
        readableAsText: false,
        reason: 'No document reader is registered for this non-text file.',
        recommendation: 'Install or enable a document/image reader plugin or toolset that can handle this file type.',
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'read_file',
    description: '分析非 UTF-8 文本的本地文档或二进制文件。普通代码、Markdown、JSON、配置等可读文本请优先使用 view_file_chunk；只有 view_file_chunk 判断不是可读文本，或已知目标是 PDF、Word、表格、图片等非文本文件时才使用。',
    schema: z.object({ path: z.string().describe('文件路径') }),
  },
);

export const viewFileChunkTool = tool(
  async ({ path, startLine, endLine }: {
    path: string;
    startLine?: number;
    endLine?: number;
  }) => {
    try {
      return readTextFileChunk({ path, startLine, endLine });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'view_file_chunk',
    description: '按行读取文件片段。适合查看大文件的局部内容，返回带行号的文本。',
    schema: z.object({
      path: z.string().describe('文件路径'),
      startLine: z.number().int().positive().optional().describe('起始行号，默认 1'),
      endLine: z.number().int().positive().optional().describe('结束行号，默认最多返回 200 行'),
    }),
  },
);

export const statPathTool = tool(
  async ({ path }: { path: string }) => {
    try {
      const resolvedPath = resolveUserPath(path);
      return formatStat(resolvedPath);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'stat_path',
    description: '查看文件或目录元信息。返回类型、大小、修改时间等。',
    schema: z.object({
      path: z.string().describe('文件或目录路径'),
    }),
  },
);

export const writeFileTool = tool(
  async ({ path, content, append, createDirs }: {
    path: string;
    content: string;
    append?: boolean;
    createDirs?: boolean;
  }) => {
    try {
      const filePath = resolveUserPath(path);
      if (createDirs ?? true) {
        mkdirSync(dirname(filePath), { recursive: true });
      }
      writeFileSync(filePath, content, {
        encoding: 'utf-8',
        flag: append ? 'a' : 'w',
      });
      return JSON.stringify({
        ok: true,
        path: filePath,
        mode: append ? 'append' : 'write',
        bytes: Buffer.byteLength(content, 'utf-8'),
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'write_file',
    description: '写入本地文本文件。适合直接创建或覆盖文件内容；如需追加，传 append=true。默认会自动创建父目录。如果写入的是 JSON、manifest.json、package.json、tsconfig.json 等结构化文件，写完后应继续调用 validate_structured_file 做结构校验。',
    schema: z.object({
      path: z.string().describe('目标文件路径；支持绝对路径或相对路径'),
      content: z.string().describe('要写入的文本内容'),
      append: z.boolean().optional().describe('是否以追加模式写入；默认 false 表示覆盖'),
      createDirs: z.boolean().optional().describe('是否自动创建父目录；默认 true'),
    }),
  },
);

type WriteFileAction = {
  path: string;
  content: string;
  append: boolean;
  createDirs: boolean;
};

type ApplyPatchAction = {
  patch: string;
};

function normalizeWriteFileAction(input: unknown): WriteFileAction {
  const record = readRecord(input);
  const path = readString(record, 'path');
  const content = readString(record, 'content');
  if (!path) {
    throw new Error('write_file requires a path');
  }
  if (content === undefined) {
    throw new Error('write_file requires content');
  }
  return {
    path: resolveUserPath(path),
    content,
    append: readBoolean(record, 'append') ?? false,
    createDirs: readBoolean(record, 'createDirs') ?? true,
  };
}

function normalizeApplyPatchAction(input: unknown): ApplyPatchAction {
  const record = readRecord(input);
  const patch = readString(record, 'patch');
  if (!patch || !patch.trim()) {
    throw new Error('apply_patch requires a patch');
  }
  return { patch };
}

interface ResolvedPatchWrite {
  operation: PatchOperation;
  absolutePath: string;
  moveToPath: string | null;
  nextContent: string | null;
  before: string | undefined;
  chunksApplied: number;
  fuzz: 'exact' | 'ignore-trailing-whitespace' | 'ignore-whitespace';
}

function worstFuzz(chunks: Array<{ fuzz: ResolvedPatchWrite['fuzz'] }>): ResolvedPatchWrite['fuzz'] {
  if (chunks.some((chunk) => chunk.fuzz === 'ignore-whitespace')) return 'ignore-whitespace';
  if (chunks.some((chunk) => chunk.fuzz === 'ignore-trailing-whitespace')) return 'ignore-trailing-whitespace';
  return 'exact';
}

function atomicWriteFile(filePath: string, content: string) {
  const tempPath = `${filePath}.pinpawo-patch-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tempPath, content, 'utf-8');
  try {
    renameSync(tempPath, filePath);
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}

const APPLY_PATCH_DESCRIPTION = [
  '编辑本地文件的唯一补丁工具，使用 V4A patch 格式：靠上下文行定位（绝不使用行号），一次调用可以新增、修改、删除、移动多个文件。',
  '格式：',
  '*** Begin Patch',
  '*** Update File: <相对或绝对路径>',
  '@@ <可选的定位锚点，如函数签名>',
  ' 上下文行（前缀一个空格，原样保留）',
  '-要删除的行',
  '+要新增的行',
  '*** End Patch',
  '其他指令：`*** Add File: <path>`（其后每行都以 + 开头）；`*** Delete File: <path>`；`*** Update File:` 之后可跟 `*** Move to: <newpath>` 重命名；补丁触及文件末尾时在该块末尾加 `*** End of File`。',
  '规则：每个修改块前后各带 2-3 行上下文；同一文件内多个不相邻的修改块用 @@ 分隔；上下文必须与文件现状一致（允许少量空白差异，会自动容错）。',
  '修改前先用 view_file_chunk 查看现状；若补丁报"context not found"，重新读取文件后基于最新内容重试。',
  '如果修改的是 JSON、manifest.json、package.json、tsconfig.json 等结构化文件，完成后应继续调用 validate_structured_file。整文件新建或完全重写可以直接用 write_file。',
].join('\n');

export const applyPatchTool = tool(
  async ({ patch }: { patch: string }) => {
    try {
      const operations = parsePatch(patch);

      const writes: ResolvedPatchWrite[] = operations.map((operation) => {
        if (operation.type === 'add') {
          const absolutePath = resolveUserPath(operation.path);
          if (tryStat(absolutePath)) {
            throw new Error(`Add File target already exists: ${absolutePath}`);
          }
          return {
            operation,
            absolutePath,
            moveToPath: null,
            nextContent: operation.content,
            before: undefined,
            chunksApplied: 0,
            fuzz: 'exact',
          };
        }

        if (operation.type === 'delete') {
          const absolutePath = resolveUserPath(operation.path);
          const stat = tryStat(absolutePath);
          if (!stat?.isFile()) {
            throw new Error(`Delete File target is not an existing file: ${absolutePath}`);
          }
          return {
            operation,
            absolutePath,
            moveToPath: null,
            nextContent: null,
            before: readFileContentPreview(absolutePath),
            chunksApplied: 0,
            fuzz: 'exact',
          };
        }

        const absolutePath = resolveUserPath(operation.path);
        const stat = tryStat(absolutePath);
        if (!stat?.isFile()) {
          throw new Error(`Update File target is not an existing file: ${absolutePath}`);
        }
        const original = readUtf8TextFile(absolutePath);
        const result = applyChunksToContent(operation.path, original, operation.chunks);
        const moveToPath = operation.moveTo ? resolveUserPath(operation.moveTo) : null;
        if (moveToPath && moveToPath !== absolutePath && tryStat(moveToPath)) {
          throw new Error(`Move to target already exists: ${moveToPath}`);
        }
        return {
          operation,
          absolutePath,
          moveToPath,
          nextContent: result.content,
          before: truncateForOperationDetails(original),
          chunksApplied: result.chunks.length,
          fuzz: worstFuzz(result.chunks),
        };
      });

      // All operations validated; now touch the filesystem.
      const files = writes.map((write) => {
        if (write.operation.type === 'add') {
          mkdirSync(dirname(write.absolutePath), { recursive: true });
          atomicWriteFile(write.absolutePath, write.nextContent ?? '');
          return { path: write.absolutePath, type: 'add' as const };
        }
        if (write.operation.type === 'delete') {
          rmSync(write.absolutePath);
          return { path: write.absolutePath, type: 'delete' as const };
        }
        const targetPath = write.moveToPath ?? write.absolutePath;
        if (write.moveToPath && write.moveToPath !== write.absolutePath) {
          mkdirSync(dirname(write.moveToPath), { recursive: true });
          rmSync(write.absolutePath);
        }
        atomicWriteFile(targetPath, write.nextContent ?? '');
        return {
          path: targetPath,
          type: write.moveToPath && write.moveToPath !== write.absolutePath
            ? 'move' as const
            : 'update' as const,
          chunks: write.chunksApplied,
          ...(write.fuzz !== 'exact' ? { fuzz: write.fuzz } : {}),
        };
      });

      return JSON.stringify({ ok: true, files });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'apply_patch',
    description: APPLY_PATCH_DESCRIPTION,
    schema: z.object({
      patch: z.string().describe('完整的 V4A patch 文本，必须以 *** Begin Patch 开头、*** End Patch 结尾'),
    }),
  },
);

export const validateStructuredFileTool = tool(
  async ({ path, format, schema }: {
    path: string;
    format?: 'auto' | 'json';
    schema?: 'none' | 'capability_manifest';
  }) => {
    try {
      const filePath = resolveUserPath(path);
      const content = readFileSync(filePath, 'utf-8');
      const detectedFormat = format && format !== 'auto'
        ? format
        : extname(filePath).toLowerCase() === '.json'
          ? 'json'
          : 'json';

      if (detectedFormat !== 'json') {
        return `Error: unsupported structured format: ${detectedFormat}`;
      }

      const parsed = JSON.parse(content) as unknown;
      let schemaWarnings: string[] = [];
      if (schema === 'capability_manifest') {
        const result = capabilityManifestSchema.safeParse(parsed);
        if (!result.success) {
          return JSON.stringify({
            ok: false,
            path: filePath,
            format: detectedFormat,
            schema: schema ?? 'none',
            error: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '),
          });
        }
        if (result.data.builtIn !== false) {
          schemaWarnings = ['用户 capability manifest 建议写 builtIn: false'];
        }
      }

      return JSON.stringify({
        ok: true,
        path: filePath,
        format: detectedFormat,
        schema: schema ?? 'none',
        warnings: schemaWarnings,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'validate_structured_file',
    description: '验证结构化文件内容。当前支持 JSON 语法检查，以及 capability_manifest 这类 schema 校验。适合在 write_file / apply_patch 之后单独执行验证。',
    schema: z.object({
      path: z.string().describe('要验证的文件路径'),
      format: z.enum(['auto', 'json']).optional().describe('结构格式；默认 auto，目前实际支持 json'),
      schema: z.enum(['none', 'capability_manifest']).optional().describe('可选 schema 校验类型'),
    }),
  },
);

export const movePathTool = tool(
  async ({ source, destination, overwrite, createDirs }: {
    source: string;
    destination: string;
    overwrite?: boolean;
    createDirs?: boolean;
  }) => {
    try {
      const sourcePath = resolveUserPath(source);
      const sourceStat = statSync(sourcePath);
      const targetPath = resolveMoveTarget(source, destination);

      if (createDirs ?? true) {
        mkdirSync(dirname(targetPath), { recursive: true });
      }

      const targetStat = tryStat(targetPath);
      if (targetStat) {
        if (!overwrite) {
          return `Error: destination already exists: ${targetPath}`;
        }
        rmSync(targetPath, { recursive: true, force: true });
      }

      try {
        renameSync(sourcePath, targetPath);
      } catch (err) {
        const isCrossDevice = err instanceof Error
          && 'code' in err
          && (err as NodeJS.ErrnoException).code === 'EXDEV';

        if (!isCrossDevice) {
          throw err;
        }

        cpSync(sourcePath, targetPath, {
          recursive: sourceStat.isDirectory(),
          force: overwrite ?? false,
          errorOnExist: !(overwrite ?? false),
        });
        rmSync(sourcePath, { recursive: sourceStat.isDirectory(), force: true });
      }

      return JSON.stringify({
        ok: true,
        source: sourcePath,
        destination: targetPath,
        type: sourceStat.isDirectory() ? 'directory' : 'file',
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'move_path',
    description: '移动本地文件或目录。优先用于文件/目录搬迁，包括普通目录、外接磁盘和已挂载的 SMB/网络共享卷；跨卷移动会自动复制后删除源路径。若 destination 是已存在目录，则会移动到该目录下并保留原名称。默认不覆盖目标；如需覆盖，传 overwrite=true。',
    schema: z.object({
      source: z.string().describe('源文件或目录路径'),
      destination: z.string().describe('目标路径；可以是目标文件路径，也可以是已存在目录'),
      overwrite: z.boolean().optional().describe('目标已存在时是否覆盖；默认 false'),
      createDirs: z.boolean().optional().describe('是否自动创建目标父目录；默认 true'),
    }),
  },
);

export const copyPathTool = tool(
  async ({ source, destination, overwrite, createDirs }: {
    source: string;
    destination: string;
    overwrite?: boolean;
    createDirs?: boolean;
  }) => {
    try {
      const sourcePath = resolveUserPath(source);
      const sourceStat = statSync(sourcePath);
      const targetPath = resolveCopyTarget(source, destination);

      if (createDirs ?? true) {
        mkdirSync(dirname(targetPath), { recursive: true });
      }

      const targetStat = tryStat(targetPath);
      if (targetStat && !overwrite) {
        return `Error: destination already exists: ${targetPath}`;
      }

      cpSync(sourcePath, targetPath, {
        recursive: sourceStat.isDirectory(),
        force: overwrite ?? false,
        errorOnExist: !(overwrite ?? false),
      });

      return JSON.stringify({
        ok: true,
        source: sourcePath,
        destination: targetPath,
        type: sourceStat.isDirectory() ? 'directory' : 'file',
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'copy_path',
    description: '复制本地文件或目录。优先用于文件/目录复制，包括普通目录、外接磁盘和已挂载的 SMB/网络共享卷。若 destination 是已存在目录，则复制到该目录下并保留原名称。默认不覆盖目标；如需覆盖，传 overwrite=true。',
    schema: z.object({
      source: z.string().describe('源文件或目录路径'),
      destination: z.string().describe('目标路径；可以是目标文件路径，也可以是已存在目录'),
      overwrite: z.boolean().optional().describe('目标已存在时是否覆盖；默认 false'),
      createDirs: z.boolean().optional().describe('是否自动创建目标父目录；默认 true'),
    }),
  },
);

export const mkdirPathTool = tool(
  async ({ path, recursive }: { path: string; recursive?: boolean }) => {
    try {
      const targetPath = resolveUserPath(path);
      mkdirSync(targetPath, { recursive: recursive ?? true });
      return JSON.stringify({
        ok: true,
        path: targetPath,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'mkdir_path',
    description: '创建本地目录。默认递归创建父目录。',
    schema: z.object({
      path: z.string().describe('要创建的目录路径'),
      recursive: z.boolean().optional().describe('是否递归创建；默认 true'),
    }),
  },
);

export const listDirTool = tool(
  async ({ path }: { path: string }) => {
    try {
      const dirPath = resolveUserPath(path);
      const entries = readdirSync(dirPath);
      const lines = entries.map((name) => {
        try {
          const stat = statSync(resolve(dirPath, name));
          return `${stat.isDirectory() ? 'd' : 'f'} ${name}`;
        } catch {
          return `? ${name}`;
        }
      });
      return lines.join('\n') || '(empty)';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'list_dir',
    description: '列出目录内容。返回每个条目的类型（d=目录, f=文件）和名称。',
    schema: z.object({ path: z.string().describe('目录路径，默认 "." 表示当前目录') }),
  },
);

function resolveArtifactDiscoveryPath(root: string, inputPath: string) {
  const rootPath = resolveUserPath(root);
  const targetPath = resolve(rootPath, inputPath || '.');
  const relativePath = relative(rootPath, targetPath);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error('path must stay inside the current thread artifact root');
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(rootPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('current thread has no artifacts');
    }
    throw err;
  }
  const canonicalTarget = realpathSync(targetPath);
  const canonicalRelativePath = relative(canonicalRoot, canonicalTarget);
  if (
    canonicalRelativePath === '..'
    || canonicalRelativePath.startsWith(`..${sep}`)
    || isAbsolute(canonicalRelativePath)
  ) {
    throw new Error('path must stay inside the current thread artifact root');
  }
  return canonicalTarget;
}

export function createArtifactDiscoveryFileTools(root: string) {
  const scopedListDirTool = tool(
    async ({ path }: { path: string }) => {
      try {
        return await listDirTool.invoke({
          path: resolveArtifactDiscoveryPath(root, path),
        });
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : err}`;
      }
    },
    {
      name: 'list_dir',
      description: '列出当前 thread artifact 根目录内的目录内容。',
      schema: z.object({ path: z.string().describe('artifact 根目录或其内部目录路径') }),
    },
  );
  const scopedViewFileChunkTool = tool(
    async ({ path, startLine, endLine }: {
      path: string;
      startLine?: number;
      endLine?: number;
    }) => {
      try {
        return await viewFileChunkTool.invoke({
          path: resolveArtifactDiscoveryPath(root, path),
          startLine,
          endLine,
        });
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : err}`;
      }
    },
    {
      name: 'view_file_chunk',
      description: '按行读取当前 thread artifact 根目录内的文本文件片段。',
      schema: z.object({
        path: z.string().describe('artifact 根目录内的文件路径'),
        startLine: z.number().int().positive().optional().describe('起始行号，默认 1'),
        endLine: z.number().int().positive().optional().describe('结束行号，默认最多返回 200 行'),
      }),
    },
  );

  return [scopedListDirTool, scopedViewFileChunkTool];
}

export const fileOperationMetadata: Record<string, ToolkitOperationMetadata> = {
  read_file: {
    title: '析文档',
    summarizeInput: pathInputSummary,
  },
  view_file_chunk: {
    title: '看片段',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      const startLine = readNumber(record, 'startLine');
      const endLine = readNumber(record, 'endLine');
      return target ? { target, details: { startLine, endLine } } : null;
    },
  },
  stat_path: {
    title: '看属性',
    summarizeInput: pathInputSummary,
  },
  write_file: {
    title: '写文件',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      const content = readString(record, 'content');
      if (!target) return null;
      const safePath = resolveUserPath(target);
      return {
        target: safePath,
        summary: readBoolean(record, 'append') ? 'append' : 'write',
        details: {
          append: readBoolean(record, 'append') ?? false,
          createDirs: readBoolean(record, 'createDirs') ?? true,
          before: readFileContentPreview(safePath),
          afterPreview: content === undefined ? undefined : truncateForOperationDetails(content),
        },
      };
    },
    summarizeOutput: (output) => {
      const record = readJsonRecord(output);
      return mergeOperationOutputSummary(
        readString(record, 'path'),
        { mode: readString(record, 'mode') },
      );
    },
  },
  apply_patch: {
    title: '应用补丁',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const patch = readString(record, 'patch');
      if (!patch) return null;
      let files: Array<{ path: string; type: string }> = [];
      let target: string | undefined;
      try {
        const operations = parsePatch(patch);
        files = operations.map((operation) => ({ path: resolveUserPath(operation.path), type: operation.type }));
        target = files[0]?.path;
      } catch {
        // Unparseable patch still gets a raw preview below.
      }
      return {
        target,
        summary: files.length > 1 ? `${files.length.toString()} files` : files[0]?.type,
        details: {
          files: files.length > 0 ? files : undefined,
          patch: truncateForOperationDetails(patch),
        },
      };
    },
    summarizeOutput: (output) => {
      const record = readJsonRecord(output);
      const rawFiles = record?.files;
      if (!Array.isArray(rawFiles)) return null;
      const files = rawFiles.filter((file): file is Record<string, unknown> => Boolean(file) && typeof file === 'object');
      const target = files.map((file) => file.path).find((path): path is string => typeof path === 'string');
      if (!target) return null;
      return {
        target,
        details: {
          files,
          after: files.length === 1 ? readFileContentPreview(target) : undefined,
        },
      };
    },
  },
  validate_structured_file: {
    title: '验证结构',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      return target ? { target, details: { schema: readString(record, 'schema') } } : null;
    },
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
  move_path: {
    title: '移动文件',
    summarizeInput: sourceDestinationInputSummary,
    summarizeOutput: (output) => okOutputPathSummary(output, 'destination'),
  },
  copy_path: {
    title: '复制文件',
    summarizeInput: sourceDestinationInputSummary,
    summarizeOutput: (output) => okOutputPathSummary(output, 'destination'),
  },
  mkdir_path: {
    title: '建目录',
    summarizeInput: pathInputSummary,
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
  list_dir: {
    title: '列目录',
    summarizeInput: pathInputSummary,
  },
};
