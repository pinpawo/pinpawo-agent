import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, resolve } from 'node:path';
import { tool } from '@langchain/core/tools';
import type { ToolkitOperationMetadata } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { config } from '../../config';
import { tryStat } from './fileSystemUtils';
import {
  okOutputPathSummary,
  pathInputSummary,
  readBoolean,
  readJsonRecord,
  readNumber,
  readRecord,
  readString,
  sourceDestinationInputSummary,
} from '../../plugins/operationMetadata';
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
      const content = readFileSync(resolveUserPath(path), 'utf-8');
      return content.slice(0, 8000);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'read_file',
    description: '读取本地文件内容。path 支持绝对路径或相对路径（相对于当前工作目录）。',
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
      const filePath = resolveUserPath(path);
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? Math.min(start + 199, lines.length));
      if (end < start) {
        return `Error: invalid line range ${start}-${end}`;
      }
      return lines
        .slice(start - 1, end)
        .map((line, index) => `${start + index}: ${line}`)
        .join('\n');
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

export const updateFileTool = tool(
  async ({ path, find, replace, replaceAll }: {
    path: string;
    find: string;
    replace: string;
    replaceAll?: boolean;
  }) => {
    try {
      const filePath = resolveUserPath(path);
      const original = readFileSync(filePath, 'utf-8');

      if (!find) {
        return 'Error: find must not be empty';
      }

      const matches = original.split(find).length - 1;
      if (matches === 0) {
        return `Error: target text not found in ${filePath}`;
      }

      const next = replaceAll
        ? original.split(find).join(replace)
        : original.replace(find, replace);

      writeFileSync(filePath, next, 'utf-8');

      return JSON.stringify({
        ok: true,
        path: filePath,
        replaced: replaceAll ? matches : 1,
        replaceAll: Boolean(replaceAll),
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'update_file',
    description: '更新本地文件中的已有内容。适合把文件里某一段文本替换成新文本；默认只替换首个匹配，传 replaceAll=true 可替换全部匹配。如果修改的是 JSON、manifest.json、package.json、tsconfig.json 等结构化文件，修改后应继续调用 validate_structured_file。',
    schema: z.object({
      path: z.string().describe('目标文件路径'),
      find: z.string().describe('要查找的原始文本，不能为空'),
      replace: z.string().describe('替换后的新文本'),
      replaceAll: z.boolean().optional().describe('是否替换全部匹配；默认 false'),
    }),
  },
);

export const multiEditTool = tool(
  async ({ path, edits }: {
    path: string;
    edits: Array<{ find: string; replace: string; replaceAll?: boolean }>;
  }) => {
    try {
      const filePath = resolveUserPath(path);
      let content = readFileSync(filePath, 'utf-8');
      let totalReplaced = 0;

      for (const edit of edits) {
        if (!edit.find) {
          return 'Error: edit.find must not be empty';
        }
        const matches = content.split(edit.find).length - 1;
        if (matches === 0) {
          return `Error: target text not found in ${filePath}: ${edit.find.slice(0, 80)}`;
        }
        content = edit.replaceAll
          ? content.split(edit.find).join(edit.replace)
          : content.replace(edit.find, edit.replace);
        totalReplaced += edit.replaceAll ? matches : 1;
      }

      writeFileSync(filePath, content, 'utf-8');
      return JSON.stringify({
        ok: true,
        path: filePath,
        edits: edits.length,
        replaced: totalReplaced,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'multi_edit',
    description: '对同一个文件执行多组文本替换。适合一次完成多个局部更新，减少反复读写。如果目标是结构化文件，完成后应继续调用 validate_structured_file。',
    schema: z.object({
      path: z.string().describe('目标文件路径'),
      edits: z.array(z.object({
        find: z.string().describe('要查找的原始文本'),
        replace: z.string().describe('替换后的新文本'),
        replaceAll: z.boolean().optional().describe('是否替换全部匹配；默认 false'),
      })).min(1).describe('要依次执行的编辑列表'),
    }),
  },
);

export const applyFilePatchTool = tool(
  async ({ path, hunks }: {
    path: string;
    hunks: Array<{
      oldText: string;
      newText: string;
      replaceAll?: boolean;
      expectedOccurrences?: number;
    }>;
  }) => {
    try {
      const filePath = resolveUserPath(path);
      let content = readFileSync(filePath, 'utf-8');
      const applied: Array<{
        index: number;
        replaced: number;
        replaceAll: boolean;
      }> = [];

      for (let index = 0; index < hunks.length; index += 1) {
        const hunk = hunks[index];
        if (!hunk || !hunk.oldText) {
          return `Error: hunks[${index}] oldText must not be empty`;
        }

        const matches = content.split(hunk.oldText).length - 1;
        if (matches === 0) {
          return `Error: patch hunk ${index} not found in ${filePath}`;
        }
        if (typeof hunk.expectedOccurrences === 'number' && matches !== hunk.expectedOccurrences) {
          return `Error: patch hunk ${index} expected ${hunk.expectedOccurrences} matches but found ${matches} in ${filePath}`;
        }

        const replaceAll = Boolean(hunk.replaceAll);
        content = replaceAll
          ? content.split(hunk.oldText).join(hunk.newText)
          : content.replace(hunk.oldText, hunk.newText);

        applied.push({
          index,
          replaced: replaceAll ? matches : 1,
          replaceAll,
        });
      }

      writeFileSync(filePath, content, 'utf-8');
      return JSON.stringify({
        ok: true,
        path: filePath,
        hunks: applied,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'apply_file_patch',
    description: '用一组严格的文本 patch 更新文件。每个 hunk 都要求 oldText 精确命中；可设置 expectedOccurrences 防止文件漂移时误改。适合像 Claude Code/Codex 一样做最小补丁式更新。如果补丁修改的是结构化文件，完成后应继续调用 validate_structured_file。',
    schema: z.object({
      path: z.string().describe('目标文件路径'),
      hunks: z.array(z.object({
        oldText: z.string().describe('要精确匹配的原始文本块'),
        newText: z.string().describe('替换后的新文本块'),
        replaceAll: z.boolean().optional().describe('是否替换全部匹配；默认 false'),
        expectedOccurrences: z.number().int().positive().optional().describe('期望匹配次数；若实际不符则直接报错'),
      })).min(1).describe('按顺序应用的一组文本 patch'),
    }),
  },
);

export const applyUnifiedPatchTool = tool(
  async ({ patch, cwd, strip, dryRun }: {
    patch: string;
    cwd?: string;
    strip?: number;
    dryRun?: boolean;
  }) => {
    let tempDir: string | null = null;
    try {
      const patchText = patch.trim();
      if (!patchText) {
        return 'Error: patch must not be empty';
      }

      const targetDir = cwd ? resolveUserPath(cwd) : config.workdir;
      const targetStat = tryStat(targetDir);
      if (!targetStat?.isDirectory()) {
        return `Error: patch cwd must be an existing directory: ${targetDir}`;
      }

      tempDir = mkdtempSync(resolve(tmpdir(), 'pinpawo-patch-'));
      const patchFile = resolve(tempDir, 'change.patch');
      writeFileSync(patchFile, patchText.endsWith('\n') ? patchText : `${patchText}\n`, 'utf-8');

      const patchArgs = [
        '--batch',
        '--forward',
        `-p${Math.max(0, strip ?? 0)}`,
        '-i',
        patchFile,
        '-d',
        targetDir,
      ];
      if (dryRun) {
        patchArgs.unshift('--dry-run');
      }

      const output = execFileSync('patch', patchArgs, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return JSON.stringify({
        ok: true,
        cwd: targetDir,
        strip: Math.max(0, strip ?? 0),
        dryRun: Boolean(dryRun),
        output: output.trim() || null,
      });
    } catch (err) {
      const message = err instanceof Error
        ? ('stderr' in err && typeof (err as { stderr?: unknown }).stderr === 'string'
          ? (err as { stderr: string }).stderr.trim() || err.message
          : err.message)
        : String(err);
      return `Error: ${message}`;
    } finally {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  },
  {
    name: 'apply_unified_patch',
    description: '应用 unified diff / patch 到一个目录。适合多文件或更复杂的块级修改。默认在当前 workdir 执行 patch，可传 cwd 指定目标目录；可传 strip 控制 -p 层级，传 dryRun=true 先验证不落盘。若 patch 涉及 JSON、manifest.json、package.json、tsconfig.json 等结构化文件，应用后应继续调用 validate_structured_file 检查结果。',
    schema: z.object({
      patch: z.string().describe('unified diff / patch 文本'),
      cwd: z.string().optional().describe('应用 patch 的目标目录；默认当前 workdir'),
      strip: z.number().int().min(0).optional().describe('传给 patch 的 -p 层级；默认 0'),
      dryRun: z.boolean().optional().describe('是否只做 dry-run 校验，不实际写入'),
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
    description: '验证结构化文件内容。当前支持 JSON 语法检查，以及 capability_manifest 这类 schema 校验。适合在 write_file / update_file / apply_file_patch 之后单独执行验证。',
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

export const fileToolOperations: Record<string, ToolkitOperationMetadata> = {
  read_file: {
    kind: 'file.read',
    title: '读文件',
    summarizeInput: pathInputSummary,
  },
  view_file_chunk: {
    kind: 'file.chunk.read',
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
    kind: 'file.stat',
    title: '看属性',
    summarizeInput: pathInputSummary,
  },
  write_file: {
    kind: 'file.write',
    title: '写文件',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      if (!target) return null;
      const safePath = resolveUserPath(target);
      return {
        target: safePath,
        summary: readBoolean(record, 'append') ? 'append' : 'write',
        details: {
          append: readBoolean(record, 'append') ?? false,
          before: readFileContentPreview(safePath),
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
  update_file: {
    kind: 'file.update',
    title: '改文件',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      if (!target) return null;
      const safePath = resolveUserPath(target);
      return {
        target: safePath,
        summary: readBoolean(record, 'replaceAll') ? 'replace_all' : 'replace',
        details: {
          find: readString(record, 'find'),
          replace: readString(record, 'replace') ? '[provided]' : undefined,
          before: readFileContentPreview(safePath),
        },
      };
    },
    summarizeOutput: (output) => {
      const record = readJsonRecord(output);
      return mergeOperationOutputSummary(
        readString(record, 'path'),
        {
          replaced: readNumber(record, 'replaced'),
          replaceAll: readBoolean(record, 'replaceAll'),
        },
      );
    },
  },
  multi_edit: {
    kind: 'file.multi_edit',
    title: '批量修改',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      const rawEdits = record?.edits;
      const edits = Array.isArray(rawEdits) ? rawEdits.length : undefined;
      if (!target) return null;
      const safePath = resolveUserPath(target);
      return {
        target: safePath,
        details: {
          edits,
          before: readFileContentPreview(safePath),
        },
      };
    },
    summarizeOutput: (output) => {
      const record = readJsonRecord(output);
      return mergeOperationOutputSummary(
        readString(record, 'path'),
        { edits: readNumber(record, 'edits') },
      );
    },
  },
  apply_file_patch: {
    kind: 'file.patch',
    title: '应用补丁',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      const rawHunks = record?.hunks;
      const hunks = Array.isArray(rawHunks) ? rawHunks.length : undefined;
      if (!target) return null;
      const safePath = resolveUserPath(target);
      return {
        target: safePath,
        details: {
          hunks,
          before: readFileContentPreview(safePath),
        },
      };
    },
    summarizeOutput: (output) => {
      const record = readJsonRecord(output);
      return mergeOperationOutputSummary(
        readString(record, 'path'),
        { hunks: readNumber(record, 'hunks') },
      );
    },
  },
  apply_unified_patch: {
    kind: 'patch.apply',
    title: '应用 diff',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'cwd');
      const patch = readString(record, 'patch');
      return {
        target,
        details: {
          strip: readNumber(record, 'strip') ?? 0,
          dryRun: readBoolean(record, 'dryRun') ?? false,
          patch: patch ? truncateForOperationDetails(patch) : undefined,
        },
      };
    },
    summarizeOutput: (output) => okOutputPathSummary(output, 'cwd'),
  },
  validate_structured_file: {
    kind: 'file.validate',
    title: '验证结构',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      return target ? { target, details: { schema: readString(record, 'schema') } } : null;
    },
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
  move_path: {
    kind: 'path.move',
    title: '移动文件',
    summarizeInput: sourceDestinationInputSummary,
    summarizeOutput: (output) => okOutputPathSummary(output, 'destination'),
  },
  copy_path: {
    kind: 'path.copy',
    title: '复制文件',
    summarizeInput: sourceDestinationInputSummary,
    summarizeOutput: (output) => okOutputPathSummary(output, 'destination'),
  },
  mkdir_path: {
    kind: 'directory.create',
    title: '建目录',
    summarizeInput: pathInputSummary,
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
  list_dir: {
    kind: 'directory.list',
    title: '列目录',
    summarizeInput: pathInputSummary,
  },
};
