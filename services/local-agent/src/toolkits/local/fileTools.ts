import { closeSync, cpSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { tool } from '@langchain/core/tools';
import { type ToolOperationMetadata } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { tryStat } from './fileSystemUtils';
import {
  applyChunksToContentPartially,
  PatchApplyError,
  PatchParseError,
  parsePatch,
  type FailedChunk,
  type PatchChunk,
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
export const VIEW_FILE_CHUNK_MAX_BYTES = 50_000;
// Covers the controlled footer and the blank-line separator before it.
const VIEW_FILE_CHUNK_FOOTER_RESERVE_BYTES = 1_000;

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

export type TextFileChunkLimitReason = 'byte_limit' | 'line_too_long';

export type TextFileChunkResult = {
  content: string;
  startLine: number;
  endLine: number;
  nextStartLine: number | null;
  totalLines: number;
  hasMore: boolean;
  returnedChars: number;
  returnedBytes: number;
  limitReason: TextFileChunkLimitReason | null;
  truncatedLine: number | null;
  maxBytes: number;
};

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, 'utf-8');
}

function truncateUtf8(value: string, maxBytes: number) {
  if (utf8Bytes(value) <= maxBytes) return value;
  if (maxBytes <= 0) return '';

  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(codePoints.slice(0, middle).join('')) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return codePoints.slice(0, low).join('');
}

export function formatTextFileChunkFooter(result: TextFileChunkResult) {
  if (result.limitReason === 'line_too_long') {
    return `[lines ${result.startLine}-${result.endLine} of ${result.totalLines}; incomplete: line ${result.truncatedLine} cannot fit within ${result.maxBytes}-byte result limit; nextStartLine=unavailable because this tool cannot resume within a line; use grep_search to locate an anchor or a byte-range reader]`;
  }

  const continuation = result.hasMore
    ? `nextStartLine=${result.nextStartLine}`
    : 'complete';
  const limit = result.limitReason === 'byte_limit'
    ? `; stopped at ${result.maxBytes}-byte limit`
    : '';
  return `[lines ${result.startLine}-${result.endLine} of ${result.totalLines}; ${continuation}${limit}]`;
}

export function formatTextFileChunkResult(result: TextFileChunkResult) {
  return `${result.content}\n\n${formatTextFileChunkFooter(result)}`;
}

export function readTextFileChunkResult({
  path,
  startLine,
  endLine,
  maxBytes: configuredMaxBytes,
}: {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}): TextFileChunkResult {
  const content = readUtf8TextFile(path);
  const lines = content.split('\n');
  const start = Math.max(1, startLine ?? 1);
  const totalLines = lines.length;
  if (start > totalLines) {
    throw new Error(`startLine ${start} is outside the file; totalLines=${totalLines}`);
  }
  const requestedEnd = endLine ?? start + 199;
  if (requestedEnd < start) {
    throw new Error(`invalid line range ${start}-${requestedEnd}; totalLines=${totalLines}`);
  }
  const end = Math.min(totalLines, requestedEnd);
  const maxBytes = Math.max(1, configuredMaxBytes ?? VIEW_FILE_CHUNK_MAX_BYTES);
  const bodyMaxBytes = Math.max(0, maxBytes - VIEW_FILE_CHUNK_FOOTER_RESERVE_BYTES);

  const selectedLines: string[] = [];
  let selectedBytes = 0;
  let limitReason: TextFileChunkLimitReason | null = null;

  const makeResult = (
    returnedEndLine: number,
    body: string,
    reason: TextFileChunkLimitReason | null,
    line: number | null,
  ): TextFileChunkResult => {
    const hasMore = reason === 'line_too_long' || returnedEndLine < totalLines;
    return {
      content: body,
      startLine: start,
      endLine: returnedEndLine,
      nextStartLine: reason === 'line_too_long'
        ? null
        : hasMore
          ? returnedEndLine + 1
          : null,
      totalLines,
      hasMore,
      returnedChars: body.length,
      returnedBytes: utf8Bytes(body),
      limitReason: reason,
      truncatedLine: line,
      maxBytes,
    };
  };

  const makeTruncatedLineResult = (lineNumber: number): TextFileChunkResult => {
    const formattedLine = `${lineNumber}: ${lines[lineNumber - 1] ?? ''}`;
    const ellipsis = ' …';
    const truncated = truncateUtf8(
      formattedLine,
      Math.max(0, bodyMaxBytes - utf8Bytes(ellipsis)),
    );
    const body = bodyMaxBytes >= utf8Bytes(ellipsis)
      ? `${truncated}${ellipsis}`
      : truncateUtf8(formattedLine, bodyMaxBytes);
    return makeResult(lineNumber, body, 'line_too_long', lineNumber);
  };

  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    const formattedLine = `${lineNumber}: ${lines[lineNumber - 1] ?? ''}`;
    const lineBytes = utf8Bytes(formattedLine);
    const candidateBytes = selectedBytes + (selectedLines.length > 0 ? 1 : 0) + lineBytes;
    if (candidateBytes > bodyMaxBytes) {
      if (selectedLines.length > 0) {
        limitReason = 'byte_limit';
        break;
      }
      return makeTruncatedLineResult(lineNumber);
    }
    selectedLines.push(formattedLine);
    selectedBytes = candidateBytes;
  }

  const chunkContent = selectedLines.join('\n');
  const returnedEndLine = start + selectedLines.length - 1;
  return makeResult(returnedEndLine, chunkContent, limitReason, null);
}

export function readTextFileChunk(input: {
  path: string;
  startLine?: number;
  endLine?: number;
}) {
  return formatTextFileChunkResult(readTextFileChunkResult(input));
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
  const source = sourcePath;
  const destination = destinationPath;
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
      const stat = statSync(path);
      if (!stat.isFile()) {
        return `Error: read_file expects a file path, got ${stat.isDirectory() ? 'directory' : 'non-file'}: ${path}`;
      }

      const extension = extname(path).toLowerCase();
      if (looksLikeUtf8Text(readFileSample(path))) {
        return `Error: ${path} is a readable UTF-8 text file; use view_file_chunk for line-numbered text reading.`;
      }

      return JSON.stringify({
        ok: false,
        path,
        type: 'document_or_binary',
        extension: extension || null,
        size: stat.size,
        readableAsText: false,
        reason: 'No document reader is registered for this non-text file.',
        recommendation: 'Install or enable a document/image reader toolkit that can handle this file type.',
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
    description: `按行读取文件片段，返回带行号正文以及实际范围、总行数和 nextStartLine/complete。默认最多 200 行，单次模型可见结果最多 ${VIEW_FILE_CHUNK_MAX_BYTES} 字节。`,
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
      return formatStat(path);
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
      if (createDirs ?? true) {
        mkdirSync(dirname(path), { recursive: true });
      }
      writeFileSync(path, content, {
        encoding: 'utf-8',
        flag: append ? 'a' : 'w',
      });
      return JSON.stringify({
        ok: true,
        path,
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
    path,
    content,
    append: readBoolean(record, 'append') ?? false,
    createDirs: readBoolean(record, 'createDirs') ?? true,
  };
}

interface ResolvedPatchWrite {
  targetPath: string;
  nextContent: string;
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
  '使用补丁修改一个已存在的本地文件。每次调用只允许一个文件 update；建议每次只提交少量修改块，并按文件中的先后顺序排列。新增或完全重写用 write_file，移动用 move_path；删除文件不属于本工具。',
  'patch 只接受 V4A，不接受或转换 Unified Diff。必须使用 *** Begin Patch / *** End Patch 包裹。',
  'V4A 最小结构为：*** Begin Patch、*** Update File: <path>、@@ <可选唯一 anchor>、以空格/-/+开头的 diff 行、*** End Patch；每个 hunk 都必须显式写 @@ 并至少包含一条变更行。',
  '完整补丁先通过语法解析，再按书写顺序逐块定位和应用；前面成功块对文件的修改会成为后续块看到的内容。某块匹配失败时，其他成功块仍会写入；语法错误不会写入任何块。',
  '修改前先读取文件现状，并提供足以唯一定位修改位置的上下文。重复文本应增加唯一 anchor 或更多上下文，必要时拆成单独调用；工具不会自动重新生成补丁或循环重试失败块。',
  'V4A 用 appliedHunks 返回成功块编号以节省 token；failedHunks 返回失败块的原始 diff、错误和相近上下文。',
  '如果修改的是 JSON、manifest.json、package.json、tsconfig.json 等结构化文件，完成后应继续调用 validate_structured_file。整文件新建或完全重写可以直接用 write_file。',
].join('\n');

function chunkDiffText(chunk: PatchChunk) {
  return [
    chunk.anchor ? `@@ ${chunk.anchor}` : '@@',
    ...chunk.lines.map((line) => {
      if (line.kind === 'added') return `+${line.text}`;
      if (line.kind === 'removed') return `-${line.text}`;
      return ` ${line.text}`;
    }),
    ...(chunk.isEndOfFile ? ['*** End of File'] : []),
  ].join('\n');
}

function failedChunkOutput(chunk: FailedChunk, source: PatchChunk) {
  return {
    hunk: chunk.hunk,
    diff: chunkDiffText(source),
    code: chunk.code,
    message: chunk.message.split('\n')[0] ?? chunk.message,
    ...(chunk.closest ? { closest: chunk.closest } : {}),
    ...(chunk.matches ? { matches: chunk.matches } : {}),
  };
}

function patchFailureOutput(
  error: unknown,
  phase: 'parse' | 'match' | 'write',
) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PatchParseError || error instanceof PatchApplyError) {
    return JSON.stringify({
      ok: false,
      ...error.details,
      message,
    });
  }
  return JSON.stringify({
    ok: false,
    phase,
    code: phase === 'write' ? 'write_failed' : 'patch_failed',
    message,
  });
}

function patchTargetError(code: string, message: string, path: string) {
  return new PatchApplyError(message, {
    code,
    phase: 'match',
    path,
  });
}

export const applyPatchTool = tool(
  async ({ patch }: { patch: string }) => {
    let phase: 'parse' | 'match' | 'write' = 'parse';
    try {
      const update = parsePatch(patch);
      phase = 'match';

      const targetPath = update.path;
      const stat = tryStat(targetPath);
      if (!stat?.isFile()) {
        throw patchTargetError(
          'target_not_found',
          `Update File target is not an existing file: ${targetPath}`,
          update.path,
        );
      }
      const original = readUtf8TextFile(targetPath);
      const result = applyChunksToContentPartially(
        update.path,
        original,
        update.chunks,
        { requireUniqueContext: true },
      );
      const write: ResolvedPatchWrite = {
        targetPath,
        nextContent: result.content,
        chunksApplied: result.chunks.length,
        fuzz: worstFuzz(result.chunks),
      };

      const failures: FailedChunk[] = result.failures;
      const appliedHunks = result.chunks.map((chunk) => chunk.hunk);
      const failedHunks = failures.map((failure) =>
        failedChunkOutput(failure, update.chunks[failure.hunk - 1]!));

      if (failures.length > 0 && result.chunks.length === 0) {
        const primaryFailure = failures[0];
        return JSON.stringify({
          ok: false,
          partial: false,
          phase: 'match',
          code: failures.length === 1
            ? primaryFailure?.code
            : 'all_patch_chunks_failed',
          message: `Applied 0 of ${update.chunks.length.toString()} V4A hunks; ${failures.length.toString()} failed.`,
          file: {
            path: write.targetPath,
            chunks: 0,
          },
          appliedHunks,
          failedHunks,
        });
      }

      // All successful chunks are committed with one atomic file replacement.
      phase = 'write';
      atomicWriteFile(write.targetPath, write.nextContent);
      const file = {
        path: write.targetPath,
        chunks: write.chunksApplied,
        ...(write.fuzz !== 'exact' ? { fuzz: write.fuzz } : {}),
      };

      if (failures.length > 0) {
        return JSON.stringify({
          ok: false,
          partial: true,
          phase: 'match',
          code: 'partial_patch_applied',
          message: `Applied ${result.chunks.length.toString()} of ${update.chunks.length.toString()} V4A hunks; ${failures.length.toString()} failed.`,
          file,
          appliedHunks,
          failedHunks,
        });
      }

      return JSON.stringify({
        ok: true,
        file,
        appliedHunks,
      });
    } catch (err) {
      return patchFailureOutput(err, phase);
    }
  },
  {
    name: 'apply_patch',
    description: APPLY_PATCH_DESCRIPTION,
    schema: z.object({
      patch: z.string().describe('只更新一个已存在文件的 V4A 补丁；使用完整 envelope，并以 @@ hunk 明确分块'),
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
      const content = readFileSync(path, 'utf-8');
      const detectedFormat = format && format !== 'auto'
        ? format
        : extname(path).toLowerCase() === '.json'
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
            path,
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
        path,
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
      const sourceStat = statSync(source);
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
        renameSync(source, targetPath);
      } catch (err) {
        const isCrossDevice = err instanceof Error
          && 'code' in err
          && (err as NodeJS.ErrnoException).code === 'EXDEV';

        if (!isCrossDevice) {
          throw err;
        }

        cpSync(source, targetPath, {
          recursive: sourceStat.isDirectory(),
          force: overwrite ?? false,
          errorOnExist: !(overwrite ?? false),
        });
        rmSync(source, { recursive: sourceStat.isDirectory(), force: true });
      }

      return JSON.stringify({
        ok: true,
        source,
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
      const sourceStat = statSync(source);
      const targetPath = resolveCopyTarget(source, destination);

      if (createDirs ?? true) {
        mkdirSync(dirname(targetPath), { recursive: true });
      }

      const targetStat = tryStat(targetPath);
      if (targetStat && !overwrite) {
        return `Error: destination already exists: ${targetPath}`;
      }

      cpSync(source, targetPath, {
        recursive: sourceStat.isDirectory(),
        force: overwrite ?? false,
        errorOnExist: !(overwrite ?? false),
      });

      return JSON.stringify({
        ok: true,
        source,
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
      mkdirSync(path, { recursive: recursive ?? true });
      return JSON.stringify({
        ok: true,
        path,
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
      const entries = readdirSync(path);
      const lines = entries.map((name) => {
        try {
          const stat = statSync(resolve(path, name));
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

export const fileOperationMetadata: Record<string, ToolOperationMetadata> = {
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
      return {
        target,
        summary: readBoolean(record, 'append') ? 'append' : 'write',
        details: {
          append: readBoolean(record, 'append') ?? false,
          createDirs: readBoolean(record, 'createDirs') ?? true,
          before: isAbsolute(target) ? readFileContentPreview(target) : undefined,
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
      let file: { path: string } | undefined;
      let target: string | undefined;
      try {
        const update = parsePatch(patch);
        file = { path: update.path };
        target = file.path;
      } catch {
        // Unparseable patch still gets a raw preview below.
      }
      return {
        target,
        summary: file ? 'update' : undefined,
        details: {
          file,
          patch: truncateForOperationDetails(patch),
        },
      };
    },
    summarizeOutput: (output) => {
      const record = readJsonRecord(output);
      const file = record?.file;
      if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
      const target = 'path' in file && typeof file.path === 'string' ? file.path : undefined;
      if (!target) return null;
      return {
        target,
        details: {
          file,
          after: readFileContentPreview(target),
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
